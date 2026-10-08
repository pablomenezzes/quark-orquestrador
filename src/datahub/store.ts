/** Contrato de armazenamento da sincronização (implementado sobre Postgres em pg-store.ts; em memória nos testes). */

export type RawKind = 'pipelines' | 'stages' | 'users' | 'field_defs';
export type CrmKind = 'pipeline' | 'stage' | 'user' | 'field_def';

export type RawRow = {
  /** ID de origem (como texto). Em definição de campo: `entidade|field_key`. */
  key: string;
  payload: unknown;
  payload_hash: string;
  source_add_time: string | null;
  source_update_time: string | null;
};

export type JobResult = {
  status: 'ok' | 'parcial' | 'erro';
  lidos: number;
  gravados: number;
  atualizados: number;
  ignorados: number;
  falhas: number;
  tokens_gastos: number;
  cursor_final?: unknown;
  erro?: string;
};

export type Checkpoint = {
  marca_dagua: string | null;
  cursor_atual: unknown;
  ultimo_sucesso_em: string | null;
  backfill_concluido: boolean;
};

/** Uma linha de negócio: o JSON original (raw) e as colunas normalizadas (crm). */
export type DealRow = {
  raw: RawRow & { origem_lista: 'normal' | 'archived' | 'deleted' };
  crm: Record<string, unknown>;
};

/** Extensão do armazenamento para os negócios (Entrega 2). */
export interface DealsStore extends DatahubStore {
  /** pipedrive_id -> hash do payload já guardado. */
  existingDealHashes(): Promise<Map<string, string>>;
  upsertDeals(rows: DealRow[]): Promise<void>;
  /** Texto normalizado do motivo de perda -> ID da opção (campo lost_reason das definições de campos). */
  lostReasonIds(): Promise<Map<string, number>>;
  getCheckpoint(entity: string): Promise<Checkpoint | null>;
}

/** Negócio que ainda precisa ter o histórico de etapas lido (ou relido, porque a etapa mudou). */
export type DealHistoryTask = { deal_id: number; created_at: string | null; stage_id: number | null; stage_change_time: string | null };

/** Extensão do armazenamento para o histórico de etapas (Entrega 5). */
export interface HistoryStore extends DatahubStore {
  /** Negócios sem nenhuma mudança de etapa: uma linha "entrou na criação", sem chamar a API. Devolve quantas linhas novas. */
  seedNoChangeHistory(range: { from: string; to: string }): Promise<number>;
  /** Fila de negócios com mudança de etapa ainda não lida (ou lida antes da última mudança). Abertos e ganhos primeiro. */
  pendingHistory(range: { from: string; to: string }): Promise<DealHistoryTask[]>;
  saveDealHistory(h: {
    deal_id: number;
    items: unknown[];
    items_hash: string;
    stage_change_time: string | null;
    rows: Array<{ stage_id: number; entrou_em: string; saiu_em: string | null; user_id: number | null; origem_dado: 'flow' | 'criacao' }>;
  }): Promise<void>;
}

export interface DatahubStore {
  /** key -> hash do payload já guardado (para ignorar o que não mudou). */
  existingHashes(kind: RawKind): Promise<Map<string, string>>;
  upsertRaw(kind: RawKind, rows: RawRow[]): Promise<void>;
  upsertCrm(kind: CrmKind, rows: Array<Record<string, unknown>>): Promise<void>;
  startJob(j: { entity: string; modo: 'backfill' | 'incremental'; origem: 'agendada' | 'manual' }): Promise<string>;
  finishJob(jobId: string, r: JobResult): Promise<void>;
  recordError(e: { job_id: string; entity: string; source_id?: string | number | null; mensagem: string; payload?: unknown }): Promise<void>;
  saveCheckpoint(
    entity: string,
    c: { marca_dagua?: string | null; cursor_atual?: unknown; ultimo_sucesso_em?: string; ultimo_job?: string; backfill_concluido?: boolean },
  ): Promise<void>;
  addApiUsage(dia: string, tokens: number, requisicoes: number, limite429: number): Promise<void>;
}
