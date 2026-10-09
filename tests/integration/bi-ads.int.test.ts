import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { PgBiRepo, type BiFiltros } from '../../studio/lib/bi';
import { connect, hasDbConfig } from './helpers';

/**
 * BI "Google Ads" (migration 0015) provado com dados FICTÍCIOS de 2099 (transação desfeita), lidos pelo papel orq_panel de verdade:
 * investimento (hoje via GA4), leads e funil da fonte Google ADS, custo por etapa, mês a mês, ROAS e o MRR.
 * Pulado até a migration 0015 (mkt.ga4_ads_dia) ser aplicada.
 */
let client: pg.Client | null = null;
let ready = false;
if (hasDbConfig) {
  client = await connect();
  ready = (await client.query(`select to_regclass('mkt.ga4_ads_dia') is not null as ok`)).rows[0].ok === true;
  if (!ready) await client.end();
}
const run = describe.skipIf(!ready);

const F: BiFiltros = { de: '2099-01-01', ate: '2099-12-31' };
const KF = `${'f'.repeat(39)}a`; // chave falsa MAIOR que as reais (a visão escolhe max(field_key) entre campos de mesmo nome)

run('BI Google Ads (transação com rollback)', () => {
  const c = () => client!;
  const repo = () => new PgBiRepo(c() as never);
  const exec = async (id: string, f: BiFiltros = F) => repo().rodar(id, f);
  const kpi = (r: Awaited<ReturnType<typeof exec>>, id: string) => (r.grafico as { itens: Array<{ id: string; valor: number | null }> }).itens.find((i) => i.id === id)!.valor;

  beforeAll(async () => {
    await c().query('begin');
    await c().query(`insert into crm.pipelines (pipeline_id, nome) values (940003, 'Funil Fictício Ads')`);
    await c().query(`insert into crm.stages (stage_id, pipeline_id, nome) values (952001, 940003, 'Lead fictício'), (952002, 940003, 'Agendado fictício'), (952003, 940003, 'SQL fictício')`);
    await c().query(`insert into ops.cfg_pipeline_produto (pipeline_id, produto) values (940003, 'rh')`);
    await c().query(`insert into ops.cfg_stage_marco (stage_id, marco) values (952002, 'reuniao'), (952003, 'sql')`);
    await c().query(`insert into crm.field_definitions (entity, field_key, nome, tipo, opcoes) values ('deal', $1, 'Fonte do Lead', 'enum', $2::jsonb)`, [
      KF,
      JSON.stringify([{ id: 901, label: 'Marketing [Google ADS]' }, { id: 902, label: 'Marketing [Meta ADS]' }]),
    ]);
    const D = [
      { id: 98200001, st: 'won', valor: 100, fonte: 901 }, // chegou em reunião agendada
      { id: 98200002, st: 'lost', valor: 50, fonte: 901 }, // chegou em SQL
      { id: 98200003, st: 'open', valor: 30, fonte: 901 },
      { id: 98200004, st: 'won', valor: 200, fonte: 901 },
      { id: 98200005, st: 'won', valor: 999, fonte: 902 }, // Meta: fora da página do Google Ads
    ];
    for (const d of D) {
      await c().query(
        `insert into crm.deals (pipedrive_id, pipeline_id, stage_id, owner_id, status, is_deleted, valor, created_at, close_time) values ($1, 940003, 952001, null, $2, false, $3, '2099-03-10T12:00:00Z', $4)`,
        [d.id, d.st, d.valor, d.st === 'won' ? '2099-03-20T12:00:00Z' : null],
      );
      await c().query(`insert into raw.pd_deals (source_id, payload, payload_hash) values ($1, $2::jsonb, 'h')`, [d.id, JSON.stringify({ id: d.id, custom_fields: { [KF]: d.fonte } })]);
    }
    const h = (deal: number, stage: number, t: string) =>
      c().query(`insert into crm.stage_history (deal_id, estagio, entrou_em, stage_id, origem_dado) values ($1, $2, $3, $4, 'flow')`, [deal, `e${stage}`, t, stage]);
    await h(98200001, 952001, '2099-03-10T12:00:00Z'); await h(98200001, 952002, '2099-03-11T12:00:00Z');
    await h(98200002, 952001, '2099-03-10T12:00:00Z'); await h(98200002, 952003, '2099-03-11T12:00:00Z');
    // custo (via GA4): março 200 em 1 dia e abril 100 (mês sem nenhum lead)
    await c().query(
      `insert into mkt.ga4_ads_dia (property_id, dia, campanha_id, campanha, custo, cliques, impressoes) values
        (9999, '2099-03-05', '77', 'Campanha Fictícia', 200, 100, 1000), (9999, '2099-04-02', '77', 'Campanha Fictícia', 100, 50, 500)`,
    );
    await c().query('set local role orq_panel');
  });
  afterAll(async () => {
    await c().query('reset role').catch(() => undefined);
    await c().query('rollback');
    await c().end();
  });

  it('visão geral: investimento, leads do funil, custo por etapa, CAC, ROAS e os KPIs de MRR', async () => {
    const r = await exec('ads-resumo');
    expect(kpi(r, 'invest')).toBe(300);
    expect(kpi(r, 'cliques')).toBe(150);
    expect(kpi(r, 'cpc')).toBe(2);
    expect(kpi(r, 'leads')).toBe(4); // o negócio da Meta fica de fora
    expect(kpi(r, 'mql')).toBe(4);
    expect(kpi(r, 'sql')).toBe(2); // reunião agendada conta como SQL (chegou em X ou além)
    expect(kpi(r, 'reuniao')).toBe(1);
    expect(kpi(r, 'proposta')).toBe(0);
    expect(kpi(r, 'ganhos')).toBe(2);
    expect(kpi(r, 'cpl')).toBe(75);
    expect(kpi(r, 'c_sql')).toBe(150);
    expect(kpi(r, 'c_reuniao')).toBe(300);
    expect(kpi(r, 'c_proposta')).toBeNull(); // ninguém chegou: não inventa custo
    expect(kpi(r, 'cac')).toBe(150);
    expect(kpi(r, 'roas')).toBe(1); // MRR ganho 300 ÷ investimento 300
    expect(kpi(r, 'mrr_criado')).toBe(380);
    expect(kpi(r, 'valor_ganho')).toBe(300);
    expect(kpi(r, 'mrr_perdido')).toBe(50);
    expect(kpi(r, 'mrr_aberto')).toBe(30);
    expect(kpi(r, 'ticket_ganho')).toBe(150);
    expect(r.avisos).toEqual([]);
  });

  it('funil e custo de cada etapa (passos condicionais, ordem das etapas)', async () => {
    const r = await exec('ads-funil-custos');
    const l = Object.fromEntries(r.tabela.linhas.map((x) => [x.etapa, x]));
    expect(l['Leads']).toMatchObject({ negocios: 4, custo: 75 });
    expect(l['Chegou em SQL']).toMatchObject({ negocios: 2, custo: 150 });
    expect(l['Chegou em Reunião Agendada']).toMatchObject({ negocios: 1, custo: 300 });
    expect(l['Chegou em proposta']).toMatchObject({ negocios: 0, custo: null });
    expect(l['Ganhos']).toMatchObject({ negocios: 2, custo: 150 });
    expect(Number(l['Chegou em SQL']!.pct_leads)).toBeCloseTo(0.5, 5);
    const g = r.grafico as { itens: Array<{ rotulo: string }> };
    expect(g.itens.map((i) => i.rotulo)).not.toContain('Chegou em proposta'); // sem custo, sem barra
  });

  it('mês a mês: o mês só com custo aparece (sem leads, custos em branco) e há o total do período', async () => {
    const r = await exec('ads-por-mes');
    const l = r.tabela.linhas;
    expect(l.map((x) => x.mes)).toEqual(['2099-03', '2099-04', 'Total do período']);
    expect(l[0]).toMatchObject({ invest: 200, cliques: 100, leads: 4, cpl: 50, cac: 100, mrr_criado: 380, valor: 300, ticket: 150 });
    expect(l[1]).toMatchObject({ invest: 100, leads: 0, cpl: null, cac: null });
    expect(l[2]).toMatchObject({ invest: 300, leads: 4, cpl: 75, roas: 1 });
    const g = r.grafico as { categorias: string[]; series: Array<{ valores: number[] }> };
    expect(g.categorias).toEqual(['2099-03', '2099-04']);
    expect(g.series[0]!.valores).toEqual([200, 100]);
  });

  it('leads e funil por mês, com as taxas sobre os leads do mês', async () => {
    const r = await exec('ads-leads-mes');
    expect(r.tabela.linhas).toHaveLength(1);
    expect(r.tabela.linhas[0]).toMatchObject({ mes: '2099-03', leads: 4, mql: 4, sql: 2, reuniao: 1, proposta: 0, ganhos: 2, perdidos: 1, abertos: 1 });
    expect(Number(r.tabela.linhas[0]!.psql)).toBeCloseTo(0.5, 5);
    expect(Number(r.tabela.linhas[0]!.taxa)).toBeCloseTo(2 / 3, 5);
  });

  it('o filtro de Fonte não vale na página do Google Ads (sempre a fonte Google ADS); período e produto valem', async () => {
    expect(kpi(await exec('ads-resumo', { ...F, fontes: ['999999'] }), 'leads')).toBe(4);
    const outroAno = await exec('ads-resumo', { de: '2098-01-01', ate: '2098-12-31' });
    expect(kpi(outroAno, 'leads')).toBe(0);
    expect(kpi(outroAno, 'invest')).toBe(0);
    expect(outroAno.avisos[0]).toMatch(/Não há custo do Google Ads/);
    expect(kpi(await exec('ads-resumo', { ...F, produto: 'clinic' }), 'leads')).toBe(0);
    expect((await exec('ads-resumo', { ...F, produto: 'clinic' })).avisos.join(' ')).toMatch(/custo do Google Ads é da conta toda/);
  });

  it('por campanha: custo somado, CPC e participação', async () => {
    const r = await exec('ads-campanhas');
    expect(r.tabela.linhas[0]).toMatchObject({ campanha: 'Campanha Fictícia', id: '77', custo: 300, cliques: 150, cpc: 2 });
    expect(Number(r.tabela.linhas[0]!.part)).toBe(1);
  });

  it('quando a API do Google Ads tiver dados num dia, ela vale no lugar do GA4 (os outros dias seguem no GA4)', async () => {
    await c().query('reset role');
    await c().query(`insert into mkt.gads_campanhas (customer_id, campaign_id, nome, status) values (9990000001, 77, 'Campanha Fictícia API', 'ENABLED')`);
    await c().query(`insert into mkt.gads_campanha_dia (customer_id, campaign_id, dia, impressoes, cliques, custo_micros, conversoes) values (9990000001, 77, '2099-03-05', 2000, 120, 250000000, 0)`);
    await c().query('set local role orq_panel');
    const l = (await exec('ads-por-mes')).tabela.linhas;
    expect(l[0]).toMatchObject({ mes: '2099-03', invest: 250, cliques: 120 }); // 250 da API, e não os 200 do GA4 do mesmo dia
    expect(l[1]).toMatchObject({ mes: '2099-04', invest: 100 }); // abril continua no GA4
  });

  it('o painel só lê: não grava o custo; o robô de carga grava; o conector do Claude lê a visão', async () => {
    const denied = async (sql: string) => {
      await c().query('savepoint d');
      try {
        await c().query(sql);
        return 'NO_ERROR';
      } catch (e) {
        return (e as { code?: string }).code ?? 'UNKNOWN';
      } finally {
        await c().query('rollback to savepoint d');
      }
    };
    expect(await denied(`insert into mkt.ga4_ads_dia (property_id, dia, campanha_id, campanha, custo, cliques, impressoes) values (9999,'2099-05-01','','',1,1,1)`)).toBe('42501');
    expect(await denied(`select * from mkt.ga4_ads_dia`)).toBe('42501');
    await c().query('reset role');
    await c().query('set local role orq_sync');
    const ins = `insert into mkt.ga4_ads_dia (property_id, dia, campanha_id, campanha, custo, cliques, impressoes) values (9999,'2099-05-01','88','Outra',5,1,10)
                 on conflict (property_id, dia, campanha_id, campanha) do update set custo = excluded.custo`;
    await c().query(ins);
    await c().query(ins); // idempotente
    expect((await c().query(`select count(*)::int as n from mkt.ga4_ads_dia where campanha_id = '88'`)).rows[0].n).toBe(1);
    await c().query('reset role');
    await c().query('set local role orq_chat');
    expect((await c().query(`select count(*)::int as n from analytics.ads_investimento_dia where dia >= '2099-01-01'`)).rows[0].n).toBeGreaterThan(0);
    expect(await denied(`insert into mkt.ga4_ads_dia (property_id, dia, campanha_id, campanha, custo, cliques, impressoes) values (9999,'2099-06-01','','',1,1,1)`)).toMatch(/42501|25006/);
    await c().query('reset role');
    await c().query('set local role orq_panel');
  });
});
