import { describe, it, expect, afterAll } from 'vitest';
import type pg from 'pg';
import { connect, hasDbConfig } from './helpers';

/**
 * Migration 0021: as visões do BI leem crm.deal_atributos, não o JSON bruto. Pulado até a migration ser aplicada.
 * Prova: nenhuma das três lê raw.pd_deals, o painel (orq_panel) continua lendo, e os negócios de deal_atributos cobrem os de raw.pd_deals.
 */
let client: pg.Client | null = null;
let ready = false;
if (hasDbConfig) {
  client = await connect();
  ready = (await client.query(`select pg_get_viewdef('analytics.negocios_url'::regclass) not like '%pd_deals%' as ok`)).rows[0].ok === true;
  if (!ready) await client.end();
}
const run = describe.skipIf(!ready);

run('visões do BI sobre crm.deal_atributos', () => {
  afterAll(async () => { await client!.end(); });
  it('nenhuma das três visões lê o JSON bruto', async () => {
    for (const v of ['negocios_bi', 'negocios_url', 'negocios_criativo']) {
      const d = (await client!.query(`select pg_get_viewdef('analytics.${v}'::regclass) d`)).rows[0].d as string;
      expect(d, v).not.toContain('pd_deals');
      expect(d, v).toContain('deal_atributos');
    }
  });
  it('deal_atributos cobre todos os negócios (a sincronização o atualiza logo depois dos negócios)', async () => {
    const r = (await client!.query(`select (select count(*) from raw.pd_deals)::int raw, (select count(*) from crm.deal_atributos)::int atr, (select count(*) from raw.pd_deals r where not exists (select 1 from crm.deal_atributos a where a.deal_id = r.source_id))::int sem`)).rows[0];
    expect(r.sem, `${r.sem} negócios sem atributos: rode select crm.recalcular_deal_atributos(true)`).toBe(0);
  });
  it('o painel (orq_panel) lê as visões e elas têm linhas', async () => {
    await client!.query('begin');
    await client!.query('set local role orq_panel');
    for (const v of ['negocios_bi', 'negocios_url', 'negocios_criativo', 'negocios_meta']) expect(Number((await client!.query(`select count(*) n from analytics.${v}`)).rows[0].n), v).toBeGreaterThan(0);
    await client!.query('rollback');
  });
});
