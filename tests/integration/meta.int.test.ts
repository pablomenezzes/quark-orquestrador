import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { MetaStore } from '../../src/datahub/meta/meta-sync';
import { mapAdDia, mapAnuncio, mapCampanha, mapConjunto } from '../../src/datahub/meta/meta';
import { connect, hasDbConfig } from './helpers';

/**
 * Meta Ads (migration 0017), provado com dados FICTÍCIOS (transação desfeita), pelos papéis de verdade:
 * IDs de 18 dígitos sem perda, gravação idempotente (orq_sync), visões com nome e ID (orq_panel e orq_chat) e permissões.
 * Pulado até a migration 0017 (mkt.meta_ads_dia) ser aplicada.
 */
let client: pg.Client | null = null;
let ready = false;
let antes = '';
const contagens = async (c: pg.Client) =>
  JSON.stringify((await c.query(`select (select count(*) from mkt.meta_contas) a, (select count(*) from mkt.meta_campanhas) b, (select count(*) from mkt.meta_conjuntos) c, (select count(*) from mkt.meta_anuncios) d, (select count(*) from mkt.meta_ads_dia) e`)).rows[0]);
if (hasDbConfig) {
  client = await connect();
  ready = (await client.query(`select to_regclass('mkt.meta_ads_dia') is not null as ok`)).rows[0].ok === true;
  if (ready) antes = await contagens(client);
  else await client.end();
}
const run = describe.skipIf(!ready);

const CONTA = '999000000000000001';
const CAMP = '120999999999999991';
const CONJ = '120999999999999992';
const AD = '120999999999999993';

run('Meta Ads: estrutura e desempenho (transação com rollback)', () => {
  const c = () => client!;
  const store = () => new MetaStore(c() as never);
  async function denied(sql: string, params: unknown[] = []): Promise<string> {
    await c().query('savepoint d');
    try {
      await c().query(sql, params);
      return 'NO_ERROR';
    } catch (e) {
      return (e as { code?: string }).code ?? 'UNKNOWN';
    } finally {
      await c().query('rollback to savepoint d');
    }
  }
  const dia = (extra: Record<string, unknown> = {}) =>
    mapAdDia({ ad_id: AD, adset_id: CONJ, campaign_id: CAMP, date_start: '2099-03-05', spend: '10.50', impressions: '1000', reach: '800', clicks: '40', inline_link_clicks: '30',
      actions: [{ action_type: 'landing_page_view', value: '24' }, { action_type: 'lead', value: '3' }, { action_type: 'video_view', value: '300' }],
      video_play_actions: [{ action_type: 'video_view', value: '500' }], video_p25_watched_actions: [{ action_type: 'video_view', value: '200' }], video_p100_watched_actions: [{ action_type: 'video_view', value: '20' }],
      video_thruplay_watched_actions: [{ action_type: 'video_view', value: '90' }], video_avg_time_watched_actions: [{ action_type: 'video_view', value: '4.5' }], ...extra }, CONTA);

  beforeAll(async () => {
    await c().query('begin');
    await c().query('set local role orq_sync');
  });
  afterAll(async () => {
    await c().query('reset role').catch(() => undefined);
    await c().query('rollback');
    expect(await contagens(c())).toBe(antes); // nada do teste permanece
    await c().end();
  });

  it('o robô de carga grava a conta, a estrutura e o desempenho; IDs de 18 dígitos voltam idênticos', async () => {
    await store().conta({ conta_id: CONTA, produto: 'rh', nome: 'Conta Fictícia', moeda: 'BRL', fuso: 'America/Sao_Paulo' });
    await store().campanhas([mapCampanha({ id: CAMP, name: '[Growth][83] Campanha Fictícia', objective: 'OUTCOME_LEADS', effective_status: 'ACTIVE', daily_budget: '25000' }, CONTA)]);
    await store().conjuntos([mapConjunto({ id: CONJ, campaign_id: CAMP, name: '[Growth] [Público Fictício]', effective_status: 'ACTIVE', optimization_goal: 'LEAD_GENERATION' }, CONTA)]);
    await store().anuncios([mapAnuncio({ id: AD, adset_id: CONJ, campaign_id: CAMP, name: 'AD Fictício 1', effective_status: 'ACTIVE', creative: { id: '777000000000000001', name: 'Criativo', url_tags: 'utm_content={{ad.name}}' } }, CONTA)]);
    await store().desempenho([dia()]);
    const r = (await c().query(`select anuncio_id::text a, conjunto_id::text j, campanha_id::text p, conta_id::text c from mkt.meta_ads_dia where anuncio_id = $1::bigint`, [AD])).rows[0];
    expect(r).toEqual({ a: AD, j: CONJ, p: CAMP, c: CONTA });
    expect((await c().query(`select orcamento_diario::float8 as o, nome_chave from mkt.meta_campanhas where campanha_id = $1::bigint`, [CAMP])).rows[0]).toEqual({ o: 250, nome_chave: '[growth][83]campanhafictícia' });
  });

  it('gravar de novo atualiza em vez de duplicar (a Meta ajusta números por até 28 dias)', async () => {
    await store().desempenho([dia({ spend: '12.00', impressions: '1200' })]);
    await store().desempenho([dia({ spend: '12.00', impressions: '1200' })]);
    const r = (await c().query(`select count(*)::int n, max(gasto)::float8 g, max(impressoes) i from mkt.meta_ads_dia where anuncio_id = $1::bigint`, [AD])).rows[0];
    expect(r).toEqual({ n: 1, g: 12, i: 1200 });
    expect((await c().query(`select video_3s, video_reproducoes, video_p25, video_p100, video_thruplay, video_tempo_medio::float8 t, leads_meta, visitas_pagina from mkt.meta_ads_dia where anuncio_id = $1::bigint`, [AD])).rows[0])
      .toEqual({ video_3s: 300, video_reproducoes: 500, video_p25: 200, video_p100: 20, video_thruplay: 90, t: 4.5, leads_meta: 3, visitas_pagina: 24 });
  });

  it('anúncio que só aparece no desempenho (apagado na Meta) é detectado para ser buscado pelo ID', async () => {
    await store().desempenho([dia({ ad_id: '120999999999999994', date_start: '2099-03-06' })]);
    const f = await store().idsSemEstrutura(CONTA);
    expect(f.anuncios).toEqual(['120999999999999994']);
    expect(f.conjuntos).toEqual([]);
    expect(f.campanhas).toEqual([]);
  });

  it('checagem do banco: mesmo anúncio e dia nunca repete; produto só rh ou clinic', async () => {
    expect(await denied(`insert into mkt.meta_ads_dia (anuncio_id, dia, conta_id, gasto, impressoes, alcance, cliques, cliques_link, visitas_pagina, leads_meta, video_reproducoes, video_3s, video_p25, video_p50, video_p75, video_p95, video_p100, video_thruplay)
                         values ($1::bigint, '2099-03-05', $2::bigint, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)`, [AD, CONTA])).toBe('23505');
    expect(await denied(`insert into mkt.meta_contas (conta_id, produto) values (1, 'outro')`)).toBe('23514');
  });

  it('o Painel e o conector do Claude leem as visões (nome e ID juntos) e não escrevem', async () => {
    await c().query('reset role');
    for (const papel of ['orq_panel', 'orq_chat']) {
      await c().query(`set local role ${papel}`);
      const r = (await c().query(`select produto, campanha, conjunto, anuncio, anuncio_id::text a, gasto, video_3s from analytics.meta_desempenho_dia where anuncio_id = $1::bigint and dia = '2099-03-05'`, [AD])).rows[0];
      expect(r, papel).toMatchObject({ produto: 'rh', campanha: '[Growth][83] Campanha Fictícia', conjunto: '[Growth] [Público Fictício]', anuncio: 'AD Fictício 1', a: AD, gasto: 12, video_3s: 300 });
      expect((await c().query(`select anuncio, campanha_chave, objetivo, criativo_id::text from analytics.meta_anuncios where anuncio_id = $1::bigint`, [AD])).rows[0]).toMatchObject({ anuncio: 'AD Fictício 1', campanha_chave: '[growth][83]campanhafictícia', objetivo: 'OUTCOME_LEADS', criativo_id: '777000000000000001' });
      expect(await denied(`select * from mkt.meta_ads_dia`), papel).toBe('42501');
      expect(await denied(`insert into mkt.meta_contas (conta_id, produto) values (5, 'rh')`), papel).toMatch(/42501|25006/);
      await c().query('reset role');
    }
    await c().query('set local role orq_sync');
  });
});
