import { createHash } from 'node:crypto';

/**
 * Interpretação tolerante dos registros do Pipedrive.
 *
 * A documentação oficial não enumera os campos de cada registro, então estes leitores aceitam as variações
 * conhecidas (v1 e v2) e, quando falta algo, deixam `null`. O JSON original SEMPRE é guardado em `raw`,
 * então qualquer ajuste aqui pode ser reaplicado sem consultar o Pipedrive de novo.
 */

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** v2: RFC 3339. v1: "AAAA-MM-DD HH:MM:SS" em UTC. Qualquer outra coisa: null. */
export function toIso(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Hash do conteúdo, independente da ordem das chaves: serve para ignorar o que não mudou. */
export const payloadHash = (v: unknown): string => createHash('sha256').update(stableStringify(v)).digest('hex');

function idOf(p: Obj, label: string, field = 'id'): number {
  const v = p[field];
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  throw new ParseError(`${label}: ${field} ausente ou inválido`);
}

const textOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : null);

/** is_deleted (v2), active / active_flag / is_active (variações antigas). Sem informação: null. */
function activeOf(p: Obj): boolean | null {
  if (typeof p.is_deleted === 'boolean') return !p.is_deleted;
  for (const k of ['active', 'active_flag', 'is_active']) if (typeof p[k] === 'boolean') return p[k] as boolean;
  return null;
}

function requireObj(p: unknown, label: string): Obj {
  if (!isObj(p)) throw new ParseError(`${label}: registro não é um objeto`);
  return p;
}

export function parsePipeline(raw: unknown) {
  const p = requireObj(raw, 'pipeline');
  const nome = textOf(p.name);
  const pipeline_id = idOf(p, 'pipeline');
  if (!nome) throw new ParseError('pipeline: nome ausente');
  return {
    pipeline_id,
    nome,
    ordem: intOrNull(p.order_nr),
    ativo: activeOf(p),
    source_add_time: toIso(p.add_time),
    source_update_time: toIso(p.update_time),
  };
}

export function parseStage(raw: unknown) {
  const p = requireObj(raw, 'etapa');
  const stage_id = idOf(p, 'etapa');
  const pipeline_id = idOf(p, 'etapa', 'pipeline_id');
  const nome = textOf(p.name);
  if (!nome) throw new ParseError('etapa: nome ausente');
  return {
    stage_id,
    pipeline_id,
    nome,
    ordem: intOrNull(p.order_nr),
    probabilidade: intOrNull(p.deal_probability),
    ativo: activeOf(p),
    source_add_time: toIso(p.add_time),
    source_update_time: toIso(p.update_time),
  };
}

export function parseUser(raw: unknown) {
  const p = requireObj(raw, 'usuário');
  const email = textOf(p.email);
  return {
    user_id: idOf(p, 'usuário'),
    nome: textOf(p.name),
    email: email ? email.toLowerCase() : null,
    ativo: activeOf(p),
  };
}

/** Compara textos de motivo de perda sem se importar com maiúsculas, acentos soltos e espaços repetidos. */
export const normalizeReasonText = (s: string): string => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

/** Referência a pessoa/organização/usuário: número (v2), ou objeto com `value`/`id` (v1). */
function refId(v: unknown): number | null {
  if (isObj(v)) return intOrNull(v.value) ?? intOrNull(v.id);
  return intOrNull(v);
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Data sem hora ("AAAA-MM-DD") ou null. */
const dateOrNull = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim()) ? v.trim().slice(0, 10) : null);

/** O motivo de perda chega como texto; em alguns negócios veio como objeto. Devolve o texto e, se vier no objeto, o ID. */
function lostReasonOf(v: unknown): { texto: string | null; id: number | null } {
  if (typeof v === 'string') return { texto: textOf(v), id: null };
  if (isObj(v)) return { texto: textOf(v.label) ?? textOf(v.name) ?? textOf(v.value), id: intOrNull(v.id) };
  return { texto: null, id: null };
}

export type DealListOrigin = 'normal' | 'archived' | 'deleted';
const DEAL_STATUSES = ['open', 'won', 'lost'] as const;

/**
 * Negócio da API v2. `reasons` mapeia o texto normalizado do motivo de perda para o ID da opção (campo lost_reason).
 * Excluído: `is_deleted = true`, `status` nulo se o Pipedrive não disse open/won/lost, e o que ele disse em `status_original`.
 */
export function parseDeal(raw: unknown, origin: DealListOrigin, reasons: ReadonlyMap<string, number>, now: Date) {
  const p = requireObj(raw, 'negócio');
  const pipedrive_id = idOf(p, 'negócio');
  const statusOriginal = textOf(p.status)?.toLowerCase() ?? null;
  const deleted = origin === 'deleted' || p.is_deleted === true || statusOriginal === 'deleted';
  const reason = lostReasonOf(p.lost_reason);
  const motivo_perda_id = reason.id ?? (reason.texto ? (reasons.get(normalizeReasonText(reason.texto)) ?? null) : null);
  const custom = isObj(p.custom_fields) ? p.custom_fields : null;
  return {
    pipedrive_id,
    titulo: textOf(p.title),
    pipeline_id: intOrNull(p.pipeline_id),
    stage_id: intOrNull(p.stage_id),
    owner_id: refId(p.owner_id) ?? refId(p.user_id),
    person_id: refId(p.person_id),
    org_id: refId(p.org_id),
    moeda: textOf(p.currency),
    valor: numOrNull(p.value),
    status: statusOriginal && (DEAL_STATUSES as readonly string[]).includes(statusOriginal) ? statusOriginal : null,
    status_original: statusOriginal,
    motivo_perda: reason.texto,
    motivo_perda_id,
    created_at: toIso(p.add_time),
    updated_at: toIso(p.update_time),
    won_at: toIso(p.won_time),
    close_time: toIso(p.close_time),
    lost_time: toIso(p.lost_time),
    stage_change_time: toIso(p.stage_change_time),
    expected_close_date: dateOrNull(p.expected_close_date),
    origin: textOf(p.origin),
    origin_id: textOf(p.origin_id) ?? (typeof p.origin_id === 'number' ? String(p.origin_id) : null),
    channel: typeof p.channel === 'number' ? String(p.channel) : textOf(p.channel),
    channel_id: textOf(p.channel_id),
    is_archived: origin === 'archived' || p.is_archived === true,
    is_deleted: deleted,
    deleted_detected_at: deleted ? now.toISOString() : null,
    custom_fields: custom,
    source_add_time: toIso(p.add_time),
    source_update_time: toIso(p.update_time),
  };
}

export const FIELD_ENTITIES = ['deal', 'person', 'organization', 'activity'] as const;
export type FieldEntity = (typeof FIELD_ENTITIES)[number];

/** O ID do campo é o `field_code` (v2) ou `key` (v1): nos personalizados, um código de 40 caracteres. */
export function parseFieldDef(entity: FieldEntity, raw: unknown) {
  if (!(FIELD_ENTITIES as readonly string[]).includes(entity)) throw new ParseError(`definição de campo: entidade inválida (${String(entity)})`);
  const p = requireObj(raw, 'campo');
  const field_key = textOf(p.field_code) ?? textOf(p.key);
  if (!field_key) throw new ParseError('campo: field_code/key ausente');
  return {
    entity,
    field_key,
    nome: textOf(p.field_name) ?? textOf(p.name),
    tipo: textOf(p.field_type),
    opcoes: Array.isArray(p.options) ? p.options : null,
    ordem: intOrNull(p.order_nr),
  };
}
