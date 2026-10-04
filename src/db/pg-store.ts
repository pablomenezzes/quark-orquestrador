import type pg from 'pg';
import type { LeadRepo, LeadRow } from '../identity/resolve-lead.js';
import type { DecisionInsert, EventInsert, SourceRow, Store, TouchpointInsert, Tx } from '../pipeline/types.js';

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

const LEAD_COLS = 'id, email_norm, phone_e164, nome, empresa, porte, cargo, produto, status';
const FILLABLE = new Set(['email_norm', 'phone_e164', 'nome', 'empresa', 'porte', 'cargo', 'produto']);

function makeLeadRepo(q: Queryable): LeadRepo {
  const one = async (where: string, value: string): Promise<LeadRow | null> =>
    (await q.query(`select ${LEAD_COLS} from core.leads where ${where} = $1 limit 1`, [value])).rows[0] ?? null;
  return {
    findById: (id) => one('id', id),
    findByEmail: (e) => one('email_norm', e),
    findByPhone: (p) => one('phone_e164', p),
    async create(d) {
      const r = await q.query(
        `insert into core.leads (id, email_norm, phone_e164, nome, empresa, porte, cargo, produto)
         values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8)
         returning ${LEAD_COLS}`,
        [d.id ?? null, d.email_norm ?? null, d.phone_e164 ?? null, d.nome ?? null, d.empresa ?? null, d.porte ?? null, d.cargo ?? null, d.produto ?? null],
      );
      return r.rows[0];
    },
    async fillMissing(id, patch) {
      const keys = Object.keys(patch).filter((k) => FILLABLE.has(k));
      if (keys.length === 0) return;
      // Só preenche o que está vazio: nunca sobrescreve.
      const sets = keys.map((k, i) => `${k} = coalesce(${k}, $${i + 2})`).join(', ');
      await q.query(`update core.leads set ${sets} where id = $1`, [id, ...keys.map((k) => (patch as Record<string, unknown>)[k])]);
    },
  };
}

function makeTx(q: Queryable): Tx {
  return {
    leads: makeLeadRepo(q),
    async touchpointExists(eventId) {
      return (await q.query(`select 1 from orq.touchpoints where event_id = $1 limit 1`, [eventId])).rows.length > 0;
    },
    async insertTouchpoint(t: TouchpointInsert) {
      const r = await q.query(
        `insert into orq.touchpoints
           (lead_id, source_id, event_id, canal, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
            ad_id, gclid, gbraid, wbraid, fbp, fbc, ga_client_id, landing_url, referrer, occurred_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         on conflict (event_id) do nothing
         returning id`,
        [t.lead_id, t.source_id, t.event_id, t.canal, t.utm_source, t.utm_medium, t.utm_campaign, t.utm_term, t.utm_content,
         t.ad_id, t.gclid, t.gbraid, t.wbraid, t.fbp, t.fbc, t.ga_client_id, t.landing_url, t.referrer, t.occurred_at],
      );
      return r.rows[0]?.id ?? null;
    },
    async insertEvent(e: EventInsert) {
      const r = await q.query(
        `insert into orq.events (lead_id, touchpoint_id, tipo, dados, payload_bruto, occurred_at)
         values ($1, $2, $3, $4::jsonb, $5::jsonb, $6) returning id`,
        [e.lead_id, e.touchpoint_id, e.tipo, JSON.stringify(e.dados), JSON.stringify(e.payload_bruto ?? null), e.occurred_at],
      );
      return r.rows[0].id;
    },
    async insertDecision(d: DecisionInsert) {
      const r = await q.query(
        `insert into orq.decisions (event_id, rule_id, rule_versao, acao, modo, status, erro)
         values ($1, null, null, $2, $3, $4, $5) returning id`,
        [d.event_id, d.acao, d.modo, d.status, d.erro],
      );
      return r.rows[0].id;
    },
  };
}

async function findSource(q: Queryable, slug: string): Promise<SourceRow | null> {
  const r = await q.query(`select id, slug, tipo, produto, token_hash, ativo from orq.sources where slug = $1 limit 1`, [slug]);
  const row = r.rows[0];
  return row ? { ...row, ativo: row.ativo !== false } : null;
}

/** Store sobre Postgres. Em produção usa um Pool; nos testes, um client já dentro de BEGIN (savepoints). */
export class PgStore implements Store {
  private savepoints = 0;
  private constructor(
    private readonly pool: pg.Pool | null,
    private readonly client: Queryable | null,
  ) {}

  static fromPool(pool: pg.Pool) {
    return new PgStore(pool, null);
  }

  /** `client` já deve estar dentro de uma transação aberta pelo teste (que fará o ROLLBACK). */
  static fromOpenTransaction(client: Queryable) {
    return new PgStore(null, client);
  }

  findSourceBySlug(slug: string) {
    return findSource(this.pool ?? this.client!, slug);
  }

  async withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (this.client) {
      const sp = `sp_${++this.savepoints}`;
      await this.client.query(`savepoint ${sp}`);
      try {
        const out = await fn(makeTx(this.client));
        await this.client.query(`release savepoint ${sp}`);
        return out;
      } catch (e) {
        await this.client.query(`rollback to savepoint ${sp}`);
        throw e;
      }
    }
    const conn = await this.pool!.connect();
    try {
      await conn.query('begin');
      const out = await fn(makeTx(conn));
      await conn.query('commit');
      return out;
    } catch (e) {
      await conn.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      conn.release();
    }
  }
}
