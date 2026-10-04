import { channelConfig } from '../../config/channel-rules.js';
import { parseElementor } from '../adapters/in/elementor.js';
import { AdapterError, isPlainObject, type AdapterResult } from '../adapters/in/errors.js';
import { parseVercel } from '../adapters/in/vercel.js';
import { deriveChannel } from '../channel/derive-channel.js';
import { contractSchema, type ContractEvent } from '../contract/schema.js';
import { resolveLead } from '../identity/resolve-lead.js';
import { normalizeEmail, normalizeLandingUrl, normalizePhone } from '../normalize/index.js';
import { hashToken, verifyToken } from '../security/verify-token.js';
import type { IngestDeps, IngestRequest, IngestResponse, SourceRow, SourceTipo, TouchpointInsert } from './types.js';

/** Tipos de evento que as fontes públicas podem enviar. Os deal_* vêm do Pipedrive (fase futura). */
const ALLOWED_EVENT_TYPES = new Set(['form_submit', 'diagnostico_iniciado', 'diagnostico_concluido']);
/** Fontes que não conseguem enviar cabeçalho: o token vai na URL (?token=). */
const QUERY_TOKEN_TIPOS = new Set<SourceTipo>(['elementor', 'fillout']);
/** O navegador do visitante fala direto com o endpoint: IP e user agent do request são dele. */
const BROWSER_DIRECT_TIPOS = new Set<SourceTipo>(['vercel', 'lovable']);
const ADAPTERS: Partial<Record<SourceTipo, (req: IngestRequest) => AdapterResult>> = {
  vercel: (req) => parseVercel(req.body),
  elementor: (req) => parseElementor(req.body, req.query),
};

const MAX_BODY_BYTES = 100_000;
const MAX_FUTURE_MS = 10 * 60 * 1000;
const DUMMY_HASH = hashToken('quark-dummy-token-para-tempo-constante');

class DuplicateEvent extends Error {}

const res = (status: number, body: Record<string, unknown>): IngestResponse => ({ status, body });
const unauthorized = () => res(401, { error: 'unauthorized' });
const nul = (v: string) => (v === '' ? null : v);

export async function ingest(req: IngestRequest, deps: IngestDeps): Promise<IngestResponse> {
  // Nesta fase não existe caminho de execução real.
  if (!deps.shadowMode) return res(500, { error: 'real_mode_not_implemented' });
  if (req.bodyBytes !== undefined && req.bodyBytes > MAX_BODY_BYTES) return res(413, { error: 'payload_too_large' });

  // 1. Fonte e token (mesma resposta para fonte inexistente, inativa e token errado)
  const body = req.body;
  const slug = req.query.source || (isPlainObject(body) && typeof body.source_slug === 'string' ? body.source_slug : '');
  const source = slug ? await deps.store.findSourceBySlug(slug) : null;
  const token =
    req.headers['x-quark-token'] || (source && QUERY_TOKEN_TIPOS.has(source.tipo) ? req.query.token : undefined);
  const tokenOk = verifyToken(token, source?.token_hash ?? DUMMY_HASH);
  if (!source || !source.ativo || !tokenOk) return unauthorized();

  // 2. Adaptador de entrada
  const adapter = ADAPTERS[source.tipo];
  if (!adapter) return res(501, { error: 'adapter_not_implemented', tipo: source.tipo });
  let adapted: AdapterResult;
  try {
    adapted = adapter(req);
  } catch (e) {
    if (e instanceof AdapterError) return res(400, { error: 'invalid_payload', detail: e.message });
    throw e;
  }

  // 3. Honeypot: bot. Responde como sucesso para não dar pista, e não grava nada.
  if (adapted.honeypot) return res(200, { ok: true, discarded: true });

  // 4. Contrato (seção 7)
  const parsed = contractSchema.safeParse({ ...adapted.candidate, source_slug: source.slug });
  if (!parsed.success) {
    return res(400, {
      error: 'invalid_payload',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const c = parsed.data;
  if (!ALLOWED_EVENT_TYPES.has(c.event_type)) {
    return res(400, { error: 'invalid_payload', issues: [{ path: 'event_type', message: 'tipo não aceito por esta fonte' }] });
  }

  // 5. Normalização, canal e gravação em modo sombra
  const now = (deps.now ?? (() => new Date()))();
  try {
    const out = await deps.store.withTransaction(async (tx) => {
      if (await tx.touchpointExists(c.event_id)) return { duplicate: true as const };

      const a = c.attribution;
      const emailNorm = normalizeEmail(c.contact.email);
      const phoneE164 = normalizePhone(c.contact.phone);
      const canal = deriveChannel({
        source_tipo: source.tipo,
        utm_source: a.utm_source,
        utm_medium: a.utm_medium,
        gclid: a.gclid,
        gbraid: a.gbraid,
        wbraid: a.wbraid,
        referrer: a.referrer,
      });
      const occurredAt = resolveOccurredAt(c.occurred_at, now);

      const lead = await resolveLead(
        {
          lead_id: c.lead_id,
          email_norm: emailNorm,
          phone_e164: phoneE164,
          nome: nul(c.contact.name),
          empresa: nul(c.contact.company),
          porte: c.contact.company_size,
          cargo: nul(c.contact.role),
          produto: source.produto,
        },
        tx.leads,
      );

      const touchpoint: TouchpointInsert = {
        lead_id: lead.lead_id,
        source_id: source.id,
        event_id: c.event_id,
        canal,
        utm_source: nul(a.utm_source),
        utm_medium: nul(a.utm_medium),
        utm_campaign: nul(a.utm_campaign),
        utm_term: nul(a.utm_term),
        utm_content: nul(a.utm_content),
        ad_id: nul(a.ad_id),
        gclid: nul(a.gclid),
        gbraid: nul(a.gbraid),
        wbraid: nul(a.wbraid),
        fbp: nul(a.fbp),
        fbc: nul(a.fbc),
        ga_client_id: nul(a.ga_client_id),
        landing_url: normalizeLandingUrl(a.landing_url),
        referrer: nul(a.referrer),
        occurred_at: occurredAt,
      };
      const touchpointId = await tx.insertTouchpoint(touchpoint);
      if (!touchpointId) throw new DuplicateEvent(); // corrida: outro request gravou o mesmo event_id

      const eventId = await tx.insertEvent({
        lead_id: lead.lead_id,
        touchpoint_id: touchpointId,
        tipo: c.event_type,
        dados: eventData(c, source, req, lead.matched_by),
        payload_bruto: body,
        occurred_at: occurredAt,
      });

      await tx.insertDecision({
        event_id: eventId,
        acao: 'pendente_motor_regras', // o motor de regras nasce na Fase 4
        modo: 'sombra',
        status: 'ok',
        erro: null,
      });
      return { duplicate: false as const, lead_id: lead.lead_id, event_id: eventId, canal, created: lead.created };
    });

    if (out.duplicate) return res(200, { ok: true, duplicate: true });
    return res(200, { ok: true, duplicate: false, modo: 'sombra', lead_id: out.lead_id, event_id: out.event_id, canal: out.canal });
  } catch (e) {
    if (e instanceof DuplicateEvent) return res(200, { ok: true, duplicate: true });
    return recordFailure(e, c, body, deps);
  }
}

/** Seção 16: toda função do caminho crítico registra a decisão, inclusive em erro. */
async function recordFailure(err: unknown, c: ContractEvent, body: unknown, deps: IngestDeps): Promise<IngestResponse> {
  const message = err instanceof Error ? err.message : String(err);
  deps.log?.error('ingest: falha ao processar evento', { event_id: c.event_id, message });
  try {
    await deps.store.withTransaction(async (tx) => {
      const eventId = await tx.insertEvent({
        lead_id: null,
        touchpoint_id: null,
        tipo: c.event_type,
        dados: { erro_ingestao: true, source_slug: c.source_slug, event_id: c.event_id },
        payload_bruto: body,
        occurred_at: (deps.now ?? (() => new Date()))().toISOString(),
      });
      await tx.insertDecision({ event_id: eventId, acao: 'ingestao', modo: 'sombra', status: 'erro', erro: message.slice(0, 1000) });
    });
  } catch (e2) {
    deps.log?.error('ingest: falha também ao registrar o erro', { event_id: c.event_id, message: String(e2) });
  }
  // 500 para a fonte tentar de novo; como nenhum touchpoint foi gravado, a retentativa não vira duplicada.
  return res(500, { error: 'internal_error' });
}

function resolveOccurredAt(value: string | undefined, now: Date): string {
  if (!value) return now.toISOString();
  const t = Date.parse(value);
  if (Number.isNaN(t) || t > now.getTime() + MAX_FUTURE_MS) return now.toISOString();
  return new Date(t).toISOString();
}

function eventData(c: ContractEvent, source: SourceRow, req: IngestRequest, matchedBy: string): Record<string, unknown> {
  const browserDirect = BROWSER_DIRECT_TIPOS.has(source.tipo);
  return {
    form_id: nul(c.form_id),
    lp_id: nul(c.lp_id),
    source_slug: source.slug,
    contact: { name: nul(c.contact.name), company: nul(c.contact.company), role: nul(c.contact.role), company_size: c.contact.company_size },
    answers: c.answers,
    consent: c.consent, // LGPD: consentimento registrado em cada evento
    fbclid: nul(c.attribution.fbclid),
    first_touch: c.first_touch,
    lead_match: matchedBy,
    // Vercel/Lovable: o request é do visitante. Elementor: o request é do servidor do Elementor, então vale o que o script colheu.
    ip: browserDirect ? req.ip : null,
    user_agent: browserDirect ? req.headers['user-agent'] ?? null : nul(c.attribution.user_agent),
  };
}
