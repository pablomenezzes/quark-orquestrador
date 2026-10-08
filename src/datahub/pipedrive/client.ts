import type { FieldEntity } from '../parse.js';

/**
 * Cliente do Pipedrive SOMENTE LEITURA (regra 7 do Data Hub).
 *
 * Por construção: a única chamada de rede é `requestOnce`, que usa o método de leitura fixo; a classe não
 * expõe nenhuma operação de escrita; e testes automáticos provam as duas coisas (inclusive lendo este arquivo).
 * Documentação consultada em 2026-10-05: API v2 com cursor (limite 500); usuários só na v1.
 */

export class PipedriveError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'rate_limited' | 'server' | 'client' | 'budget' | 'pagination',
  ) {
    super(message);
    this.name = 'PipedriveError';
  }
}

/** Aceita "quark", "quark.pipedrive.com" ou "https://quark.pipedrive.com/". Nunca sai de *.pipedrive.com. */
export function normalizeDomain(input: string): string {
  const s = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  if (!/^[a-z0-9][a-z0-9-]{0,62}(\.pipedrive\.com)?$/.test(s)) {
    throw new PipedriveError('Endereço da conta Pipedrive inválido: use só o nome (ex.: suaempresa) ou suaempresa.pipedrive.com.', 'client');
  }
  return s.endsWith('.pipedrive.com') ? s : `${s}.pipedrive.com`;
}

/** Unidades da cota diária por chamada (documentação oficial). Desconhecido = pessimista (20). */
const COST_RULES: Array<[RegExp, number]> = [
  [/^\/v1\/deals\/\d+\/flow$/, 40],
  [/^\/api\/v2\/deals\/archived$/, 20],
  [/^\/api\/v2\/deals\/\d+$/, 1],
  [/^\/api\/v2\/deals$/, 10],
  [/^\/api\/v2\/(pipelines|stages)$/, 5],
  [/^\/api\/v2\/(deal|person|organization|activity)Fields$/, 10],
  [/^\/api\/v2\/activities$/, 10],
  [/^\/v1\/users$/, 20],
];
export function costOf(path: string): number {
  for (const [re, c] of COST_RULES) if (re.test(path)) return c;
  return 20;
}

export type ClientOptions = {
  domain: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Pausa mínima entre requisições (padrão 200 ms = 5 por segundo, bem abaixo do limite do plano). */
  minIntervalMs?: number;
  maxRetries?: number;
  maxPages?: number;
  /** Teto de unidades gastas nesta rodada. */
  maxTokens?: number;
  /**
   * Fração da cota diária (de TODOS que usam a conta, inclusive o Make) que esta sincronização deve deixar livre.
   * Se, pelo cabeçalho da resposta, o que sobra do dia ficaria abaixo disso, a rodada para (erro `budget`) e continua depois.
   * Padrão 0,6: usa no máximo 40% da cota do dia (ops.sync_settings.max_share_tokens).
   */
  keepFreeShare?: number;
};

const PAGE = 500;

export type DealListKind = 'normal' | 'archived' | 'deleted';

export class PipedriveReadClient {
  private readonly host: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly maxPages: number;
  private readonly maxTokens: number;
  private readonly keepFreeShare: number;
  private dailyLimit: number | null = null;
  private dailyRemaining: number | null = null;
  private tokens = 0;
  private requests = 0;
  private rateLimited = 0;
  private lastAt = 0;

  constructor(o: ClientOptions) {
    this.host = normalizeDomain(o.domain);
    if (!o.apiToken) throw new PipedriveError('Token do Pipedrive ausente.', 'auth');
    this.token = o.apiToken;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.sleepFn = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.minIntervalMs = o.minIntervalMs ?? 200;
    this.maxRetries = o.maxRetries ?? 5;
    this.maxPages = o.maxPages ?? 1000;
    this.maxTokens = o.maxTokens ?? Number.POSITIVE_INFINITY;
    this.keepFreeShare = Math.min(Math.max(o.keepFreeShare ?? 0.6, 0), 1);
  }

  get usage() {
    return { tokens: this.tokens, requests: this.requests, rateLimited: this.rateLimited };
  }

  /** Última cota diária informada pelo Pipedrive (cabeçalhos x-daily-ratelimit-token-*). Null até a primeira resposta. */
  get daily() {
    return { limit: this.dailyLimit, remaining: this.dailyRemaining };
  }

  /**
   * Histórico de mudanças de um negócio (API v1, 40 unidades por página). Pede só `dealChange` (mudanças do negócio,
   * sem e-mails, atividades nem notas); o filtro reduz a resposta a poucos itens e cabe numa chamada na quase totalidade dos casos.
   */
  async getDealFlow(id: number): Promise<unknown[]> {
    if (!Number.isInteger(id) || id <= 0) throw new PipedriveError('ID de negócio inválido.', 'client');
    const out: unknown[] = [];
    let start = 0;
    for (let page = 0; page < 20; page++) {
      const body = await this.readJson(`/v1/deals/${id}/flow`, { items: 'dealChange', limit: '500', ...(start ? { start: String(start) } : {}) });
      out.push(...(Array.isArray(body.data) ? body.data : []));
      const pg = body.additional_data?.pagination;
      if (!pg?.more_items_in_collection) return out;
      start = Number(pg.next_start ?? start + 500);
    }
    throw new PipedriveError(`Histórico do negócio ${id} com mais de 20 páginas: paginação não terminou.`, 'pagination');
  }

  /** Um negócio pelo ID (1 unidade da cota). Usado só na conferência, para entender uma diferença. */
  async getDeal(id: number): Promise<unknown | null> {
    if (!Number.isInteger(id) || id <= 0) throw new PipedriveError('ID de negócio inválido.', 'client');
    try {
      const body = await this.readJson(`/api/v2/deals/${id}`, {});
      return body.data ?? null;
    } catch (e) {
      if (e instanceof PipedriveError && e.kind === 'client' && /HTTP 404/.test(e.message)) return null;
      throw e;
    }
  }

  /**
   * Uma página de negócios (API v2, cursor, 500 por página). `normal` = lista padrão; `archived` = arquivados
   * (desde 2025-07-15 não aparecem na lista padrão); `deleted` = excluídos nos últimos 30 dias (status=deleted).
   * Datas em RFC 3339. Devolve também o cursor da próxima página (null no fim).
   */
  async listDealsPage(
    kind: DealListKind,
    p: { updatedSince?: string | null; updatedUntil?: string | null; cursor?: string | null },
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const params: Record<string, string> = { limit: String(PAGE) };
    // O Pipedrive recusa milissegundos nestas datas (HTTP 400 "not a valid datetime"): AAAA-MM-DDTHH:MM:SSZ.
    const rfc = (s: string) => s.replace(/\.\d+Z$/, 'Z');
    if (p.updatedSince) params.updated_since = rfc(p.updatedSince);
    if (p.updatedUntil) params.updated_until = rfc(p.updatedUntil);
    if (p.cursor) params.cursor = p.cursor;
    if (kind === 'deleted') params.status = 'deleted';
    const body = await this.readJson(kind === 'archived' ? '/api/v2/deals/archived' : '/api/v2/deals', params);
    const next = body.additional_data?.next_cursor;
    return { items: Array.isArray(body.data) ? body.data : [], nextCursor: next ? String(next) : null };
  }

  async listPipelines(): Promise<unknown[]> {
    return this.listV2('/api/v2/pipelines');
  }
  async listStages(): Promise<unknown[]> {
    return this.listV2('/api/v2/stages');
  }
  /** Usuários só existem na API v1 (não descontinuada). */
  async listUsers(): Promise<unknown[]> {
    const out: unknown[] = [];
    let start = 0;
    for (let page = 0; page < this.maxPages; page++) {
      const body = await this.readJson('/v1/users', start ? { start: String(start) } : {});
      out.push(...(Array.isArray(body.data) ? body.data : []));
      const pg = body.additional_data?.pagination;
      if (!pg?.more_items_in_collection) return out;
      start = Number(pg.next_start ?? start + out.length);
    }
    throw new PipedriveError(`Mais de ${this.maxPages} páginas de usuários: paginação não terminou.`, 'pagination');
  }
  async listFieldDefs(entity: FieldEntity): Promise<unknown[]> {
    return this.listV2(`/api/v2/${entity}Fields`);
  }

  /** Paginação por cursor (API v2): segue `additional_data.next_cursor` até acabar. */
  private async listV2(path: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < this.maxPages; page++) {
      const params: Record<string, string> = { limit: String(PAGE) };
      if (cursor) params.cursor = cursor;
      const body = await this.readJson(path, params);
      out.push(...(Array.isArray(body.data) ? body.data : []));
      const next = body.additional_data?.next_cursor;
      if (!next) return out;
      cursor = String(next);
    }
    throw new PipedriveError(`Mais de ${this.maxPages} páginas em ${path}: a paginação não terminou.`, 'pagination');
  }

  private scrub(text: string): string {
    return text.split(this.token).join('***').slice(0, 300);
  }

  private backoff(attempt: number): number {
    return 500 * 2 ** attempt + Math.floor(Math.random() * 100);
  }

  /** Lê um endpoint com controle de teto, ritmo, repetição em 429/5xx e mensagens sem segredo. */
  private async readJson(path: string, params: Record<string, string>): Promise<any> {
    const cost = costOf(path);
    if (this.tokens + cost > this.maxTokens) {
      throw new PipedriveError(`Teto de unidades da rodada atingido (${this.tokens} de ${this.maxTokens}); a próxima chamada custaria ${cost}.`, 'budget');
    }
    if (this.dailyLimit && this.dailyRemaining != null && this.dailyRemaining - cost < this.dailyLimit * this.keepFreeShare) {
      throw new PipedriveError(
        `Parada para proteger a cota diária compartilhada: restam ${this.dailyRemaining} de ${this.dailyLimit} unidades hoje e esta sincronização só pode usar ${Math.round((1 - this.keepFreeShare) * 100)}% do dia. Continua na próxima rodada.`,
        'budget',
      );
    }
    const url = new URL(`https://${this.host}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    for (let attempt = 0; ; attempt++) {
      if (this.minIntervalMs > 0) {
        const wait = this.lastAt + this.minIntervalMs - Date.now();
        if (wait > 0) await this.sleepFn(wait);
      }
      let res: Response;
      try {
        res = await this.requestOnce(url.toString());
      } catch {
        if (attempt >= this.maxRetries) throw new PipedriveError('Falha de rede ao falar com o Pipedrive.', 'server');
        await this.sleepFn(this.backoff(attempt));
        continue;
      }
      this.lastAt = Date.now();
      this.requests++;
      const lim = Number(res.headers.get('x-daily-ratelimit-token-limit'));
      const rem = Number(res.headers.get('x-daily-ratelimit-token-remaining'));
      if (res.headers.get('x-daily-ratelimit-token-limit') && Number.isFinite(lim) && lim > 0) this.dailyLimit = lim;
      if (res.headers.get('x-daily-ratelimit-token-remaining') && Number.isFinite(rem) && rem >= 0) this.dailyRemaining = rem;

      if (res.status === 429) {
        this.rateLimited++;
        if (attempt >= this.maxRetries) throw new PipedriveError('O Pipedrive limitou as requisições (HTTP 429) e as tentativas acabaram.', 'rate_limited');
        const ra = Number(res.headers.get('retry-after'));
        await this.sleepFn(Number.isFinite(ra) && ra > 0 ? ra * 1000 : this.backoff(attempt));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new PipedriveError(`O Pipedrive recusou a credencial (HTTP ${res.status}). Confira o token e as permissões do usuário.`, 'auth');
      }
      if (res.status >= 500) {
        if (attempt >= this.maxRetries) throw new PipedriveError(`O Pipedrive respondeu com erro de servidor (HTTP ${res.status}).`, 'server');
        await this.sleepFn(this.backoff(attempt));
        continue;
      }

      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* corpo não é JSON */
      }
      if (!res.ok || !body || body.success === false) {
        const detail = typeof body?.error === 'string' ? body.error : '';
        throw new PipedriveError(this.scrub(`Pipedrive devolveu erro (HTTP ${res.status}) em ${path}${detail ? `: ${detail}` : ''}`), 'client');
      }
      this.tokens += cost;
      return body;
    }
  }

  /** Única chamada de rede deste arquivo. Método de leitura fixo, sem corpo, token só no cabeçalho. */
  private requestOnce(url: string): Promise<Response> {
    return this.fetchImpl(url, {
      method: 'GET',
      headers: { 'x-api-token': this.token, accept: 'application/json' },
    });
  }
}
