import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { connect, hasDbConfig, schemaReady, snapshot, TABLES } from './helpers';

/**
 * Testes de integração do schema. Regra 5 (seção 4): tudo roda dentro de uma transação
 * que termina em ROLLBACK, e a contagem de linhas ao final tem de ser igual à do início.
 * Pulados sem SUPABASE_DB_URL / SUPABASE_PROJECT_REF, ou antes das migrations serem aplicadas.
 */
let client: pg.Client | null = null;
let before: Record<string, number> = {};
let ready = false;

if (hasDbConfig) {
  client = await connect();
  ready = await schemaReady(client);
  if (ready) before = await snapshot(client);
  else await client.end();
}

const run = describe.skipIf(!ready);

run('schema (transação com rollback)', () => {
  const c = () => client!;
  const uniq = () => crypto.randomUUID();

  beforeAll(async () => {
    await c().query('begin');
  });

  afterAll(async () => {
    await c().query('rollback');
    const after = await snapshot(c());
    await c().end();
    // Nenhum dado de teste pode permanecer.
    expect(after).toEqual(before);
  });

  /** Executa um comando que deve falhar e devolve o SQLSTATE, sem abortar a transação. */
  async function fails(sql: string, params: unknown[] = []): Promise<string> {
    await c().query('savepoint s');
    try {
      await c().query(sql, params);
      return 'NO_ERROR';
    } catch (e) {
      return (e as { code?: string }).code ?? 'UNKNOWN';
    } finally {
      await c().query('rollback to savepoint s');
    }
  }

  async function newLead(): Promise<string> {
    const r = await c().query(`insert into core.leads (email_norm) values ($1) returning id`, [`it-${uniq()}@teste.invalid`]);
    return r.rows[0].id;
  }

  async function newEvent(leadId: string): Promise<string> {
    const r = await c().query(
      `insert into orq.events (lead_id, tipo, occurred_at) values ($1, 'form_submit', now()) returning id`,
      [leadId],
    );
    return r.rows[0].id;
  }

  it('RLS está ativo em todas as tabelas', async () => {
    for (const t of TABLES) {
      const r = await c().query(`select relrowsecurity from pg_class where oid = $1::regclass`, [t]);
      expect(r.rows[0].relrowsecurity, t).toBe(true);
    }
  });

  it('anon e authenticated não têm acesso a nenhuma tabela', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const t of TABLES) {
        for (const priv of ['select', 'insert', 'update', 'delete']) {
          const r = await c().query(`select has_table_privilege($1, $2, $3) as ok`, [role, t, priv]);
          expect(r.rows[0].ok, `${role} ${priv} ${t}`).toBe(false);
        }
      }
    }
  });

  it('service_role não tem UPDATE, DELETE nem TRUNCATE em orq.events, mas pode ler e inserir', async () => {
    const q = async (p: string) => (await c().query(`select has_table_privilege('service_role','orq.events',$1) as ok`, [p])).rows[0].ok;
    expect(await q('select')).toBe(true);
    expect(await q('insert')).toBe(true);
    expect(await q('update')).toBe(false);
    expect(await q('delete')).toBe(false);
    expect(await q('truncate')).toBe(false);
  });

  it('orq.events é imutável: UPDATE, DELETE e TRUNCATE são bloqueados (mesmo para o dono)', async () => {
    const eventId = await newEvent(await newLead());
    expect(await fails(`update orq.events set tipo = 'x' where id = $1`, [eventId])).toBe('23001');
    expect(await fails(`delete from orq.events where id = $1`, [eventId])).toBe('23001');
    expect(await fails(`truncate orq.events`)).toBe('23001');
    const r = await c().query(`select tipo from orq.events where id = $1`, [eventId]);
    expect(r.rows[0].tipo).toBe('form_submit');
  });

  it('e-mail e telefone de lead são únicos', async () => {
    const email = `it-${uniq()}@teste.invalid`;
    const phone = `+55119${Math.floor(10000000 + Math.random() * 89999999)}`;
    await c().query(`insert into core.leads (email_norm, phone_e164) values ($1, $2)`, [email, phone]);
    expect(await fails(`insert into core.leads (email_norm) values ($1)`, [email])).toBe('23505');
    expect(await fails(`insert into core.leads (phone_e164) values ($1)`, [phone])).toBe('23505');
  });

  it('idempotência: touchpoints.event_id é único', async () => {
    const src = await c().query(
      `insert into orq.sources (slug, tipo, token_hash) values ($1, 'vercel', 'hash-teste') returning id`,
      [`it-${uniq()}`],
    );
    const eid = `ev-${uniq()}`;
    await c().query(`insert into orq.touchpoints (source_id, event_id, occurred_at) values ($1, $2, now())`, [src.rows[0].id, eid]);
    expect(await fails(`insert into orq.touchpoints (source_id, event_id, occurred_at) values ($1, $2, now())`, [src.rows[0].id, eid])).toBe('23505');
  });

  it('updated_at é atualizado em core.leads', async () => {
    const id = await newLead();
    await c().query(`update core.leads set updated_at = now() - interval '1 day' where id = $1`, [id]);
    await c().query(`update core.leads set nome = 'X' where id = $1`, [id]);
    const r = await c().query(`select (updated_at > now() - interval '1 minute') as fresh from core.leads where id = $1`, [id]);
    expect(r.rows[0].fresh).toBe(true);
  });

  it('constraints de domínio rejeitam valores inválidos', async () => {
    expect(await fails(`insert into core.leads (produto) values ('outro')`)).toBe('23514');
    expect(await fails(`insert into orq.sources (slug, tipo, token_hash) values ($1, 'zapier', 'h')`, [`it-${uniq()}`])).toBe('23514');
    expect(await fails(`insert into orq.rules (nome, prioridade, condicoes, acao) values ('r', 1, '{}', 'explodir')`)).toBe('23514');
    expect(await fails(`insert into orq.decisions (modo) values ('talvez')`)).toBe('23514');
    expect(await fails(`insert into orq.decisions (status) values ('quase')`)).toBe('23514');
  });

  it('decisão em modo sombra referencia o evento', async () => {
    const eventId = await newEvent(await newLead());
    const r = await c().query(
      `insert into orq.decisions (event_id, acao, modo, status) values ($1, 'ignorar', 'sombra', 'ok') returning id`,
      [eventId],
    );
    expect(r.rows[0].id).toBeTruthy();
    expect(await fails(`insert into orq.decisions (event_id) values ($1)`, [uniq()])).toBe('23503');
  });

  it('o schema public não ganhou tabelas', async () => {
    const now = await snapshot(c());
    expect(now['public.(tabelas)']).toBe(before['public.(tabelas)']);
  });
});
