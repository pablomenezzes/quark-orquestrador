import { normalizeReasonText } from './parse.js';
import type { Checkpoint, CrmKind, DatahubStore, DealHistoryTask, DealRow, DealsStore, HistoryStore, JobResult, RawKind, RawRow } from './store.js';

type Q = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

const RAW_TABLE: Record<Exclude<RawKind, 'field_defs'>, string> = {
  pipelines: 'raw.pd_pipelines',
  stages: 'raw.pd_stages',
  users: 'raw.pd_users',
};

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

/** Armazenamento da sincronização sobre Postgres, com o papel orq_sync (sem DELETE em nada). */
export class PgDatahubStore implements DatahubStore, DealsStore, HistoryStore {
  constructor(private readonly q: Q) {}

  async seedNoChangeHistory(range: { from: string; to: string }): Promise<number> {
    const r = await this.q.query(
      `insert into crm.stage_history (deal_id, estagio, entrou_em, stage_id, origem_dado)
       select d.pipedrive_id, coalesce(s.nome, d.stage_id::text), d.created_at, d.stage_id, 'criacao'
         from crm.deals d left join crm.stages s on s.stage_id = d.stage_id
        where d.stage_change_time is null and d.created_at >= $1 and d.created_at < $2
          and d.created_at is not null and d.stage_id is not null and not d.is_deleted
       on conflict (deal_id, stage_id, entrou_em) do nothing`,
      [range.from, range.to],
    );
    return r.rowCount ?? 0;
  }

  async pendingHistory(range: { from: string; to: string }): Promise<DealHistoryTask[]> {
    const r = await this.q.query(
      `select d.pipedrive_id as deal_id, d.created_at, d.stage_id, d.stage_change_time
         from crm.deals d left join raw.pd_deal_flow f on f.deal_id = d.pipedrive_id
        where d.created_at >= $1 and d.created_at < $2 and not d.is_deleted and d.stage_change_time is not null
          and (f.deal_id is null or f.stage_change_time_vista is distinct from d.stage_change_time)
        order by case d.status when 'open' then 0 when 'won' then 1 else 2 end, d.created_at desc`,
      [range.from, range.to],
    );
    const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
    return r.rows.map((x: any) => ({ deal_id: Number(x.deal_id), created_at: iso(x.created_at), stage_id: x.stage_id == null ? null : Number(x.stage_id), stage_change_time: iso(x.stage_change_time) }));
  }

  async saveDealHistory(h: Parameters<HistoryStore['saveDealHistory']>[0]): Promise<void> {
    await this.q.query(
      `insert into raw.pd_deal_flow (deal_id, items, items_hash, stage_change_time_vista, lido_em)
       values ($1, $2::jsonb, $3, $4, now())
       on conflict (deal_id) do update set items = excluded.items, items_hash = excluded.items_hash,
         stage_change_time_vista = excluded.stage_change_time_vista, lido_em = now()`,
      [h.deal_id, JSON.stringify(h.items), h.items_hash, h.stage_change_time],
    );
    if (!h.rows.length) return;
    await this.q.query(
      `insert into crm.stage_history (deal_id, estagio, entrou_em, stage_id, saiu_em, user_id, origem_dado)
       select $1, coalesce(s.nome, x.stage_id::text), x.entrou_em, x.stage_id, x.saiu_em, x.user_id, x.origem_dado
         from jsonb_to_recordset($2::jsonb) as x(stage_id bigint, entrou_em timestamptz, saiu_em timestamptz, user_id bigint, origem_dado text)
         left join crm.stages s on s.stage_id = x.stage_id
       on conflict (deal_id, stage_id, entrou_em) do update set estagio = excluded.estagio, saiu_em = excluded.saiu_em,
         user_id = excluded.user_id, origem_dado = excluded.origem_dado`,
      [h.deal_id, JSON.stringify(h.rows)],
    );
  }

  async existingDealHashes(): Promise<Map<string, string>> {
    const r = await this.q.query(`select source_id::text as k, payload_hash from raw.pd_deals`);
    return new Map(r.rows.map((x: { k: string; payload_hash: string }) => [x.k, x.payload_hash]));
  }

  /** Grava em lotes (uma ida ao banco por 250 negócios, não uma por negócio). Nunca apaga. */
  async upsertDeals(rows: DealRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 250) {
      const chunk = rows.slice(i, i + 250);
      await this.q.query(
        `insert into raw.pd_deals (source_id, payload, payload_hash, source_add_time, source_update_time, origem_lista)
         select source_id, payload, payload_hash, source_add_time, source_update_time, origem_lista
         from jsonb_to_recordset($1::jsonb) as x(source_id bigint, payload jsonb, payload_hash text, source_add_time timestamptz, source_update_time timestamptz, origem_lista text)
         on conflict (source_id) do update set payload = excluded.payload, payload_hash = excluded.payload_hash,
           source_add_time = excluded.source_add_time, source_update_time = excluded.source_update_time,
           origem_lista = excluded.origem_lista, synced_at = now()`,
        [JSON.stringify(chunk.map((r) => ({ source_id: Number(r.raw.key), payload: r.raw.payload, payload_hash: r.raw.payload_hash, source_add_time: r.raw.source_add_time, source_update_time: r.raw.source_update_time, origem_lista: r.raw.origem_lista })))],
      );
      await this.q.query(
        `insert into crm.deals (pipedrive_id, pipeline_id, stage_id, owner_id, titulo, moeda, person_id, org_id, status, status_original, valor,
           motivo_perda, motivo_perda_id, created_at, updated_at, won_at, close_time, lost_time, stage_change_time, expected_close_date,
           origin, origin_id, channel, channel_id, is_archived, is_deleted, deleted_detected_at, synced_at)
         select pipedrive_id, pipeline_id, stage_id, owner_id, titulo, moeda, person_id, org_id, status, status_original, valor,
           motivo_perda, motivo_perda_id, created_at, updated_at, won_at, close_time, lost_time, stage_change_time, expected_close_date,
           origin, origin_id, channel, channel_id, is_archived, is_deleted, deleted_detected_at, now()
         from jsonb_to_recordset($1::jsonb) as x(pipedrive_id bigint, pipeline_id bigint, stage_id bigint, owner_id bigint, titulo text, moeda text,
           person_id bigint, org_id bigint, status text, status_original text, valor numeric, motivo_perda text, motivo_perda_id bigint,
           created_at timestamptz, updated_at timestamptz, won_at timestamptz, close_time timestamptz, lost_time timestamptz,
           stage_change_time timestamptz, expected_close_date date, origin text, origin_id text, channel text, channel_id text,
           is_archived boolean, is_deleted boolean, deleted_detected_at timestamptz)
         on conflict (pipedrive_id) do update set pipeline_id = excluded.pipeline_id, stage_id = excluded.stage_id, owner_id = excluded.owner_id,
           titulo = excluded.titulo, moeda = excluded.moeda, person_id = excluded.person_id, org_id = excluded.org_id, status = excluded.status,
           status_original = excluded.status_original, valor = excluded.valor, motivo_perda = excluded.motivo_perda,
           motivo_perda_id = excluded.motivo_perda_id, created_at = excluded.created_at, updated_at = excluded.updated_at,
           won_at = excluded.won_at, close_time = excluded.close_time, lost_time = excluded.lost_time,
           stage_change_time = excluded.stage_change_time, expected_close_date = excluded.expected_close_date, origin = excluded.origin,
           origin_id = excluded.origin_id, channel = excluded.channel, channel_id = excluded.channel_id, is_archived = excluded.is_archived,
           is_deleted = excluded.is_deleted,
           deleted_detected_at = case when excluded.is_deleted then coalesce(crm.deals.deleted_detected_at, excluded.deleted_detected_at) else null end,
           synced_at = now()`,
        [JSON.stringify(chunk.map((r) => r.crm))],
      );
    }
  }

  async lostReasonIds(): Promise<Map<string, number>> {
    const r = await this.q.query(`select opcoes from crm.field_definitions where entity = 'deal' and field_key = 'lost_reason'`);
    const out = new Map<string, number>();
    const opts = r.rows[0]?.opcoes;
    for (const o of Array.isArray(opts) ? opts : []) {
      const id = Number((o as { id?: unknown }).id);
      const label = (o as { label?: unknown }).label;
      if (Number.isInteger(id) && typeof label === 'string') out.set(normalizeReasonText(label), id);
    }
    return out;
  }

  async getCheckpoint(entity: string): Promise<Checkpoint | null> {
    const r = await this.q.query(`select marca_dagua, cursor_atual, ultimo_sucesso_em, backfill_concluido from ops.sync_checkpoints where entity = $1`, [entity]);
    const x = r.rows[0];
    if (!x) return null;
    const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
    return { marca_dagua: iso(x.marca_dagua), cursor_atual: x.cursor_atual ?? null, ultimo_sucesso_em: iso(x.ultimo_sucesso_em), backfill_concluido: x.backfill_concluido === true };
  }

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
