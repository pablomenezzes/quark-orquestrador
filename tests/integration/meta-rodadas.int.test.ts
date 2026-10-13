import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { connect, hasDbConfig } from './helpers';

/**
 * Migration 0019: controle de rodadas da Meta, configuração e crm.deal_atributos. Provado em transação desfeita, pelo papel orq_sync.
 * Pulado até a migration 0019 ser aplicada. No fim as contagens voltam ao início.
 */
let client: pg.Client | null = null;
let ready = false;
const contagens = async (c: pg.Client) =>
  JSON.stringify((await c.query(`select (select count(*) from mkt.meta_rodadas) r, (select count(*) from mkt.meta_trimestres) t, (select count(*) from crm.deal_atributos) a, (select count(*) from mkt.meta_ads_dia) d`)).rows[0]);
let antes = '';
if (hasDbConfig) {
  client = await connect();
  ready = (await client.query(`select to_regclass('mkt.meta_rodadas') is not null as ok`)).rows[0].ok === true;
  if (ready) antes = await contagens(client);
  else await client.end();
}
const run = describe.skipIf(!ready);

run('Meta: rodadas, configuração e atributos dos negócios (transação com rollback)', () => {
  const c = () => client!;
  const falha = async (sql: string, params: unknown[] = []) => {
    await c().query('savepoint s');
    try { await c().query(sql, params); await c().query('release savepoint s'); return false; }
    catch { await c().query('rollback to savepoint s'); return true; }
  };

  beforeAll(async () => { await c().query('begin'); });
  afterAll(async () => {
    await c().query('rollback');
    expect(await contagens(c())).toBe(antes);
    await c().end();
  });

  it('a configuração traz as duas contas e a lista fechada de ações', async () => {
    const contas = (await c().query(`select produto from ops.cfg_meta_conta order by produto`)).rows.map((r) => r.produto);
    expect(contas).toEqual(['clinic', 'rh']);
    const acoes = (await c().query(`select action_type from ops.cfg_meta_acao order by 1`)).rows.map((r) => r.action_type);
    expect(acoes).toEqual(['landing_page_view', 'lead', 'video_view']);
    expect((await c().query(`select dias_releitura from ops.cfg_meta_janela where situacao = 'corrente'`)).rows[0].dias_releitura).toBe(28);
  });

  it('simulação grava sem autorização; gravação exige autorização e simulação de origem', async () => {
    const sim = (await c().query(`insert into mkt.meta_rodadas (trimestre, conta_id, de, ate, modo, status) values ('2026-T3', 287516640670266, '2026-07-01', '2026-09-30', 'simulacao', 'simulada') returning rodada_id`)).rows[0].rodada_id;
    expect(await falha(`insert into mkt.meta_rodadas (trimestre, conta_id, de, ate, modo, status) values ('2026-T3', 287516640670266, '2026-07-01', '2026-09-30', 'gravacao', 'concluida')`)).toBe(true);
    expect(await falha(`insert into mkt.meta_rodadas (trimestre, conta_id, de, ate, modo, status, simulacao_de_origem) values ('2026-T3', 287516640670266, '2026-07-01', '2026-09-30', 'gravacao', 'concluida', $1)`, [sim])).toBe(true);
    expect(await falha(`insert into mkt.meta_rodadas (trimestre, conta_id, de, ate, modo, status, simulacao_de_origem, autorizacao) values ('2026-T3', 287516640670266, '2026-07-01', '2026-09-30', 'gravacao', 'concluida', $1, 'pode seguir')`, [sim])).toBe(false);
    expect(await falha(`insert into mkt.meta_rodadas (trimestre, conta_id, de, ate, modo, status) values ('2026-T3', 287516640670266, '2026-07-01', '2026-09-30', 'simulacao', 'concluida')`)).toBe(true);
    expect(await falha(`insert into mkt.meta_rodadas (trimestre, conta_id, de, ate, modo, status) values ('2026-3T', 287516640670266, '2026-07-01', '2026-09-30', 'simulacao', 'simulada')`)).toBe(true);
  });

  it('o orq_sync não apaga rodadas nem trimestres', async () => {
    await c().query('set local role orq_sync');
    const r1 = await falha(`delete from mkt.meta_rodadas`);
    const r2 = await falha(`delete from mkt.meta_trimestres`);
    await c().query('reset role');
    expect(r1).toBe(true);
    expect(r2).toBe(true);
  });

  it('o diário ganhou row_hash, rodada_id e revisao (padrão 0)', async () => {
    const cols = (await c().query(`select column_name, column_default from information_schema.columns where table_schema = 'mkt' and table_name = 'meta_ads_dia' and column_name in ('row_hash', 'rodada_id', 'revisao')`)).rows;
    expect(cols.map((r) => r.column_name).sort()).toEqual(['revisao', 'rodada_id', 'row_hash']);
    expect(cols.find((r) => r.column_name === 'revisao').column_default).toBe('0');
  });

  it('deal_atributos: recalcula um negócio fictício e só de novo quando o JSON muda', async () => {
    await c().query(`insert into crm.field_definitions (entity, field_key, nome, tipo) values ('deal', $1, 'Meta Ad_id', 'varchar')`, ['f'.repeat(39) + 'z']);
    const antesN = (await c().query(`select count(*)::int n from crm.deal_atributos`)).rows[0].n;
    const payload = { custom_fields: { ['f'.repeat(39) + 'z']: ' 123456789012345678 ' } };
    await c().query(`insert into raw.pd_deals (source_id, payload, payload_hash) values (98500001, $1::jsonb, 'h1')`, [JSON.stringify(payload)]);
    await c().query('select crm.recalcular_deal_atributos(true)');
    const a = (await c().query(`select meta_ad_id from crm.deal_atributos where deal_id = 98500001`)).rows[0];
    expect(a.meta_ad_id).toBe('123456789012345678');
    expect((await c().query(`select count(*)::int n from crm.deal_atributos`)).rows[0].n).toBeGreaterThan(antesN);
    expect((await c().query(`select crm.recalcular_deal_atributos(true) n`)).rows[0].n).toBe(0);
  }, 90_000);
});
