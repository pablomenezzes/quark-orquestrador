import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { connect, hasDbConfig } from './helpers';

/**
 * Privilégio mínimo do papel orq_chat provado no banco de verdade (transação desfeita, SET LOCAL ROLE).
 * Pulado até a migration 0012 ser aplicada.
 */
let client: pg.Client | null = null;
let ready = false;
if (hasDbConfig) {
  client = await connect();
  ready = (await client.query(`select count(*) = 1 as ok from pg_roles where rolname = 'orq_chat'`)).rows[0].ok === true;
  if (!ready) await client.end();
}
const run = describe.skipIf(!ready);

run('orq_chat (transação com rollback)', () => {
  const c = () => client!;
  async function tenta(sql: string): Promise<string> {
    await c().query('savepoint t');
    try {
      await c().query(sql);
      return 'NO_ERROR';
    } catch (e) {
      return (e as { code?: string }).code ?? 'UNKNOWN';
    } finally {
      await c().query('rollback to savepoint t');
    }
  }
  beforeAll(async () => {
    await c().query('begin');
    await c().query('set local role orq_chat');
  });
  afterAll(async () => {
    await c().query('reset role').catch(() => undefined);
    await c().query('rollback');
    await c().end();
  });

  it('lê as visões liberadas (colunas sem o título)', async () => {
    for (const sql of [
      `select deal_id, status, is_mql, fonte_id, fonte, canal_rd from analytics.negocios_bi limit 1`, `select deal_id, produto, criado_em from analytics.deals limit 1`,
      'select * from analytics.deals_resumo limit 1', 'select * from analytics.historico_etapas limit 1', 'select * from analytics.negocios_marcos limit 1',
      'select * from analytics.motivos_perda limit 1', 'select * from analytics.pipelines_etapas limit 1', 'select * from analytics.sync_saude limit 1', 'select * from analytics.campo_opcoes limit 1',
    ]) expect(await tenta(sql), sql).toBe('NO_ERROR');
  });

  it('NÃO lê o título do negócio (nome de pessoa), nem por select *', async () => {
    for (const sql of ['select titulo from analytics.negocios_bi', 'select titulo from analytics.deals', 'select * from analytics.negocios_bi limit 1', 'select * from analytics.deals limit 1']) {
      expect(await tenta(sql), sql).toBe('42501');
    }
  });

  it('NÃO lê pessoas, empresas, vínculos, usuários, campos livres nem nenhuma tabela interna', async () => {
    for (const sql of [
      'select * from analytics.pessoas', 'select * from analytics.organizacoes', 'select * from analytics.vinculos', 'select * from analytics.usuarios', 'select * from analytics.campos', 'select * from analytics.deal_campos',
      'select * from raw.pd_deals', 'select * from raw.pd_deal_flow', 'select * from crm.deals', 'select * from crm.persons', 'select email from crm.users', 'select * from core.leads', 'select * from orq.events', 'select * from ops.cfg_motivo_perda',
    ]) expect(await tenta(sql), sql).toBe('42501');
  });

  it('NÃO escreve nem cria nada, em lugar nenhum', async () => {
    for (const sql of [
      "update ops.cfg_status_contagem set conta_como_lead = true", 'delete from ops.cfg_motivo_perda', "insert into analytics.contagem_status values ('x', true)", 'truncate crm.deals',
      'create table analytics.invasora (x int)', 'create view analytics.invasora as select 1', 'create role invasor', 'alter role orq_chat superuser', 'drop view analytics.deals_resumo',
    ]) expect(await tenta(sql), sql).toBe('42501');
  });

  it('não é superusuário, não ignora RLS e tem limite de conexões', async () => {
    await c().query('reset role');
    const r = await c().query(`select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolconnlimit, rolconfig from pg_roles where rolname = 'orq_chat'`);
    expect(r.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolconnlimit: 3 });
    expect(r.rows[0].rolconfig).toEqual(expect.arrayContaining(['default_transaction_read_only=on', 'statement_timeout=20s']));
    await c().query('set local role orq_chat');
  });
});
