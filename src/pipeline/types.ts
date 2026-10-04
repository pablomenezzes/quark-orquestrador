import type { LeadRepo } from '../identity/resolve-lead.js';

export type SourceTipo = 'elementor' | 'vercel' | 'lovable' | 'fillout' | 'meta_form';

export type SourceRow = {
  id: string;
  slug: string;
  tipo: SourceTipo;
  produto: 'rh' | 'clinic' | null;
  token_hash: string;
  ativo: boolean;
  /** Origens permitidas para chamadas de navegador (ver src/security/origins.ts). */
  url?: string | null;
};

export type TouchpointInsert = {
  lead_id: string;
  source_id: string;
  event_id: string;
  canal: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  ad_id: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  fbp: string | null;
  fbc: string | null;
  ga_client_id: string | null;
  landing_url: string | null;
  referrer: string | null;
  occurred_at: string;
};

export type EventInsert = {
  lead_id: string | null;
  touchpoint_id: string | null;
  tipo: string;
  dados: Record<string, unknown>;
  payload_bruto: unknown;
  occurred_at: string;
};

export type DecisionInsert = {
  event_id: string | null;
  acao: string;
  modo: 'sombra' | 'real';
  status: 'pendente' | 'ok' | 'erro';
  erro: string | null;
};

/** Operações dentro de uma transação. Qualquer exceção desfaz tudo. */
export interface Tx {
  leads: LeadRepo;
  touchpointExists(eventId: string): Promise<boolean>;
  /** Devolve o id, ou null se o event_id já existia (conflito de unicidade). */
  insertTouchpoint(t: TouchpointInsert): Promise<string | null>;
  insertEvent(e: EventInsert): Promise<string>;
  insertDecision(d: DecisionInsert): Promise<string>;
}

export interface Store {
  findSourceBySlug(slug: string): Promise<SourceRow | null>;
  /**
   * Conta uma requisição no balde e devolve o total da janela atual (fora de qualquer transação do evento,
   * para o contador persistir mesmo se o resto falhar).
   */
  hit(bucket: string, windowSec: number): Promise<{ hits: number; resetInSec: number }>;
  /** Valores da coluna `url` das fontes ativas (brutos; quem consome extrai as origens). */
  listSourceUrls(): Promise<string[]>;
  withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export type IngestRequest = {
  /** Corpo já interpretado (JSON ou urlencoded). */
  body: unknown;
  query: Record<string, string | undefined>;
  /** Cabeçalhos em minúsculas. */
  headers: Record<string, string | undefined>;
  ip: string | null;
  bodyBytes?: number;
};

export type IngestResponse = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

export type IngestDeps = {
  store: Store;
  /** Fixo em true nesta fase: não existe caminho de execução real. */
  shadowMode: boolean;
  /**
   * Simulação: roda o pipeline inteiro dentro da transação e a DESFAZ no fim, devolvendo o que seria gravado.
   * Só pode ser ligado por código do servidor (Studio local e testes); o endpoint público nunca o liga.
   */
  dryRun?: boolean;
  /** Limite de requisições. Sem isto (Studio, testes antigos) nada é contado. */
  rateLimit?: { salt: string; config: import('../../config/rate-limits.js').RateLimitConfig };
  now?: () => Date;
  log?: { error: (msg: string, extra?: unknown) => void };
};
