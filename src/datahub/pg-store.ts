import type { CrmKind, DatahubStore, JobResult, RawKind, RawRow } from './store.js';

type Q = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

const RAW_TABLE: Record<Exclude<RawKind, 'field_defs'>, string> = {
  pipelines: 'raw.pd_pipelines',
  stages: 'raw.pd_stages',
  users: 'raw.pd_users',
};

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

/** Armazenamento da sincronização sobre Postgres, com o papel orq_sync (sem DELETE em nada). */
export class PgDatahubStore implements DatahubStore {
  constructor(private readonly q: Q) {}

  async existingHashes(kind: RawKind): Promise<Map<string, string>> {
    const sql =
      kind === 'field_defs'
        ? `select (entity || '|' || field_key) as k, payload_hash from raw.pd_field_defs`
        : `select source_id::text as k, payload_hash from ${RAW_TABLE[kind]}`;
    const r = await this.q.query(sql);
    return new Map(r.rows.map((x: { k: string; payload_hash: string }) => [x.k, x.payload_hash]));
  }

  async upsertRaw(kind: RawKind, rows: RawRow[]): Promise<void> {
    for (const r of rows) {
      if (kind === 'field_defs') {
        const [entity, ...rest] = r.key.split('|');
        await this.q.query(
          `insert into raw.pd_field_defs (entity, field_key, payload, payload_hash)
           values ($1, $2, $3::jsonb, $4)
           on conflict (entity, field_key) do update set payload = excluded.payload, payload_hash = excluded.payload_hash, synced_at = now()`,
          [entity, rest.join('|'), JSON.stringify(r.payload), r.payload_hash],
        );
      } else {
        await this.q.query(
          `insert into ${RAW_TABLE[kind]} (source_id, payload, payload_hash, source_add_time, source_update_time)
           values ($1, $2::jsonb, $3, $4, $5)
           on conflict (source_id) do update set payload = excluded.payload, payload_hash = excluded.payload_hash,
             source_add_time = excluded.source_add_time, source_update_time = excluded.source_update_time, synced_at = now()`,
          [Number(r.key), JSON.stringify(r.payload), r.payload_hash, r.source_add_time, r.source_update_time],
        );
      }
    }
  }

  async upsertCrm(kind: CrmKind, rows: Array<Record<string, unknown>>): Promise<void> {
    for (const r of rows) {
      switch (kind) {
        case 'pipeline':
          await this.q.query(
            `insert into crm.pipelines (pipeline_id, nome, ordem, ativo, source_update_time)
             values ($1, $2, $3, $4, $5)
             on conflict (pipeline_id) do update set nome = excluded.nome, ordem = excluded.ordem, ativo = excluded.ativo,
               source_update_time = excluded.source_update_time, synced_at = now()`,
            [r.pipeline_id, r.nome, r.ordem, r.ativo, r.source_update_time],
          );
          break;
        case 'stage':
          await this.q.query(
            `insert into crm.stages (stage_id, pipeline_id, nome, ordem, probabilidade, ativo, source_update_time)
             values ($1, $2, $3, $4, $5, $6, $7)
             on conflict (stage_id) do update set pipeline_id = excluded.pipeline_id, nome = excluded.nome, ordem = excluded.ordem,
               probabilidade = excluded.probabilidade, ativo = excluded.ativo, source_update_time = excluded.source_update_time, synced_at = now()`,
            [r.stage_id, r.pipeline_id, r.nome, r.ordem, r.probabilidade, r.ativo, r.source_update_time],
          );
          break;
        case 'user':
          await this.q.query(
            `insert into crm.users (user_id, nome, email, ativo)
             values ($1, $2, $3, $4)
             on conflict (user_id) do update set nome = excluded.nome, email = excluded.email, ativo = excluded.ativo, synced_at = now()`,
            [r.user_id, r.nome, r.email, r.ativo],
          );
          break;
        case 'field_def':
          await this.q.query(
            `insert into crm.field_definitions (entity, field_key, nome, tipo, opcoes, ordem)
             values ($1, $2, $3, $4, $5::jsonb, $6)
             on conflict (entity, field_key) do update set nome = excluded.nome, tipo = excluded.tipo, opcoes = excluded.opcoes,
               ordem = excluded.ordem, synced_at = now()`,
            [r.entity, r.field_key, r.nome, r.tipo, r.opcoes == null ? null : JSON.stringify(r.opcoes), r.ordem],
          );
          break;
      }
    }
  }

  async startJob(j: { entity: string; modo: 'backfill' | 'incremental'; origem: 'agendada' | 'manual' }): Promise<string> {
    const r = await this.q.query(`insert into ops.sync_jobs (entity, modo, origem, status) values ($1, $2, $3, 'rodando') returning job_id`, [j.entity, j.modo, j.origem]);
    return r.rows[0].job_id;
  }

  async finishJob(jobId: string, r: JobResult): Promise<void> {
    await this.q.query(
      `update ops.sync_jobs set terminou_em = now(), status = $2, lidos = $3, gravados = $4, atualizados = $5, ignorados = $6,
         falhas = $7, tokens_gastos = $8, cursor_final = $9::jsonb, erro = $10 where job_id = $1`,
      [jobId, r.status, r.lidos, r.gravados, r.atualizados, r.ignorados, r.falhas, r.tokens_gastos, r.cursor_final == null ? null : JSON.stringify(r.cursor_final), r.erro ?? null],
    );
  }

  async recordError(e: { job_id: string; entity: string; source_id?: string | number | null; mensagem: string; payload?: unknown }): Promise<void> {
    await this.q.query(`insert into ops.sync_errors (job_id, entity, source_id, mensagem, payload) values ($1, $2, $3, $4, $5::jsonb)`, [
      e.job_id,
      e.entity,
      numOrNull(e.source_id),
      e.mensagem,
      e.payload === undefined ? null : JSON.stringify(e.payload),
    ]);
  }

  async saveCheckpoint(
    entity: string,
    c: { marca_dagua?: string | null; cursor_atual?: unknown; ultimo_sucesso_em?: string; ultimo_job?: string; backfill_concluido?: boolean },
  ): Promise<void> {
    await this.q.query(
      `insert into ops.sync_checkpoints (entity, marca_dagua, cursor_atual, ultimo_sucesso_em, ultimo_job, backfill_concluido)
       values ($1, $2, $3::jsonb, $4, $5, coalesce($6, false))
       on conflict (entity) do update set
         marca_dagua = coalesce(excluded.marca_dagua, ops.sync_checkpoints.marca_dagua),
         cursor_atual = coalesce(excluded.cursor_atual, ops.sync_checkpoints.cursor_atual),
         ultimo_sucesso_em = coalesce(excluded.ultimo_sucesso_em, ops.sync_checkpoints.ultimo_sucesso_em),
         ultimo_job = coalesce(excluded.ultimo_job, ops.sync_checkpoints.ultimo_job),
         backfill_concluido = coalesce($6, ops.sync_checkpoints.backfill_concluido)`,
      [entity, c.marca_dagua ?? null, c.cursor_atual == null ? null : JSON.stringify(c.cursor_atual), c.ultimo_sucesso_em ?? null, c.ultimo_job ?? null, c.backfill_concluido ?? null],
    );
  }

  async addApiUsage(dia: string, tokens: number, requisicoes: number, limite429: number): Promise<void> {
    await this.q.query(
      `insert into ops.api_usage_daily (dia, tokens_gastos, requisicoes, limite_429) values ($1, $2, $3, $4)
       on conflict (dia) do update set tokens_gastos = ops.api_usage_daily.tokens_gastos + excluded.tokens_gastos,
         requisicoes = ops.api_usage_daily.requisicoes + excluded.requisicoes, limite_429 = ops.api_usage_daily.limite_429 + excluded.limite_429`,
      [dia, tokens, requisicoes, limite429],
    );
  }
}
