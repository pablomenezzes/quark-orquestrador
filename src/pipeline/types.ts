import type { LeadRepo } from '../identity/resolve-lead.js';

export type SourceTipo = 'elementor' | 'vercel' | 'lovable' | 'fillout' | 'meta_form';

export type SourceRow = {
  id: string;
  slug: string;
  tipo: SourceTipo;
  produto: 'rh' | 'clinic' | null;
  token_hash: string;
  ativo: boolean;
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

export type IngestResponse = { status: number; body: Record<string, unknown> };

export type IngestDeps = {
  store: Store;
  /** Fixo em true nesta fase: não existe caminho de execução real. */
  shadowMode: boolean;
  now?: () => Date;
  log?: { error: (msg: string, extra?: unknown) => void };
};
