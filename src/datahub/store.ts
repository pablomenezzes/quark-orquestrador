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
