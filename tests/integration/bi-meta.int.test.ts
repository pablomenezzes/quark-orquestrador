import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { PgBiRepo, type BiFiltros } from '../../studio/lib/bi';
import { connect, hasDbConfig } from './helpers';

/**
 * Página "Meta Ads" do BI provada com dados FICTÍCIOS de 2099 (transação desfeita), lidos pelo papel orq_panel:
 * investimento e desempenho por anúncio, funil dos negócios ligados (pelo Ad_id e por campanha + nome), custo por etapa, vídeo,
 * DOR/Mensagem e cobertura da ligação. Pulado até a migration 0018 (mkt.meta_ligacao) ser aplicada.
 */
let client: pg.Client | null = null;
let ready = false;
if (hasDbConfig) {
  client = await connect();
  ready = (await client.query(`select to_regclass('mkt.meta_ligacao') is not null as ok`)).rows[0].ok === true;
  if (!ready) await client.end();
}
const run = describe.skipIf(!ready);

const F: BiFiltros = { de: '2099-01-01', ate: '2099-12-31' };
const P = 'f'.repeat(39);
const K = { ad: `${P}1`, adset: `${P}2`, camp: `${P}3`, lead: `${P}4`, form: `${P}5`, ucamp: `${P}6`, ucont: `${P}7`, uterm: `${P}8`, umed: `${P}9`, fonte: `${P}a` };
const NOMES: Array<[keyof typeof K, string]> = [['ad', 'Meta Ad_id'], ['adset', 'Meta Adset_id'], ['camp', 'Meta Campaign_id'], ['lead', 'Meta Lead_id'], ['form', 'Meta Form_id'], ['ucamp', 'UTM CAMPAIGN'], ['ucont', 'UTM Content'], ['uterm', 'UTM Term'], ['umed', 'UTM Medium']];
const CONTA = '999000000000000011', C1 = '120999999999991001', S1 = '120999999999991011', A1 = '120999999999991021', A2 = '120999999999991022';

run('BI Meta Ads (transação com rollback)', () => {
  const c = () => client!;
  const repo = () => new PgBiRepo(c() as never);
  const exec = async (id: string, f: BiFiltros = F) => repo().rodar(id, f);
  const kpi = (r: Awaited<ReturnType<typeof exec>>, id: string) => (r.grafico as { itens: Array<{ id: string; valor: number | null }> }).itens.find((i) => i.id === id)!.valor;

  beforeAll(async () => {
    await c().query('begin');
    await c().query(`insert into crm.pipelines (pipeline_id, nome) values (940005, 'Funil Fictício Meta')`);
    await c().query(`insert into crm.stages (stage_id, pipeline_id, nome) values (954001, 940005, 'Lead fictício'), (954002, 940005, 'Agendado fictício')`);
    await c().query(`insert into ops.cfg_pipeline_produto (pipeline_id, produto) values (940005, 'rh')`);
    await c().query(`insert into ops.cfg_stage_marco (stage_id, marco) values (954002, 'reuniao')`);
    for (const [k, nome] of NOMES) await c().query(`insert into crm.field_definitions (entity, field_key, nome, tipo) values ('deal', $1, $2, 'varchar')`, [K[k], nome]);
    await c().query(`insert into crm.field_definitions (entity, field_key, nome, tipo, opcoes) values ('deal', $1, 'Fonte do Lead', 'enum', $2::jsonb)`, [K.fonte, JSON.stringify([{ id: 901, label: 'Marketing [Meta ADS]' }, { id: 902, label: 'Marketing [Orgânico]' }])]);
    await c().query(`insert into mkt.meta_contas (conta_id, produto, nome) values ($1::bigint, 'rh', 'Conta Fictícia')`, [CONTA]);
    await c().query(`insert into mkt.meta_campanhas (campanha_id, conta_id, nome, nome_chave) values ($1::bigint, $2::bigint, 'Campanha Fictícia', mkt.chave_nome_meta('Campanha Fictícia'))`, [C1, CONTA]);
    await c().query(`insert into mkt.meta_conjuntos (conjunto_id, campanha_id, conta_id, nome, nome_chave) values ($1::bigint, $2::bigint, $3::bigint, 'Conjunto Fictício', 'conjuntofictício')`, [S1, C1, CONTA]);
    for (const [id, nome] of [[A1, 'AD Um'], [A2, 'AD Dois']]) {
      await c().query(`insert into mkt.meta_anuncios (anuncio_id, conjunto_id, campanha_id, conta_id, nome, nome_chave) values ($1::bigint, $2::bigint, $3::bigint, $4::bigint, $5, mkt.chave_nome_meta($5))`, [id, S1, C1, CONTA, nome]);
    }
    const dia = (ad: string, v: Record<string, number>) =>
      c().query(
        `insert into mkt.meta_ads_dia (anuncio_id, dia, conta_id, conjunto_id, campanha_id, gasto, impressoes, alcance, cliques, cliques_link, visitas_pagina, leads_meta, video_reproducoes, video_3s, video_p25, video_p50, video_p75, video_p95, video_p100, video_thruplay, video_tempo_medio)
         values ($1::bigint, '2099-03-05', $2::bigint, $3::bigint, $4::bigint, $5, $6, $6, $7, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [ad, CONTA, S1, C1, v.gasto, v.impr, v.cliques, v.visitas, v.leads, v.vplays, v.v3s, v.p25, v.p50, v.p75, v.p95, v.p100, v.thru, v.tempo ?? null],
      );
    await dia(A1, { gasto: 100, impr: 10000, cliques: 200, visitas: 150, leads: 10, vplays: 5000, v3s: 3000, p25: 2000, p50: 1000, p75: 500, p95: 300, p100: 200, thru: 800, tempo: 5 });
    await dia(A2, { gasto: 50, impr: 5000, cliques: 50, visitas: 0, leads: 0, vplays: 0, v3s: 0, p25: 0, p50: 0, p75: 0, p95: 0, p100: 0, thru: 0 });
    type D = { id: number; st: string; valor: number; fonte: number; ad?: string; camp?: string; uterm?: string };
    const D: D[] = [
      { id: 98500001, st: 'won', valor: 100, fonte: 901, ad: A1, uterm: 'AD Um' },
      { id: 98500002, st: 'lost', valor: 50, fonte: 901, ad: A1, uterm: 'AD Um' },
      { id: 98500003, st: 'open', valor: 30, fonte: 901, camp: C1, uterm: 'ad  dois' }, // campanha + nome
      { id: 98500004, st: 'open', valor: 0, fonte: 901 }, // Meta sem nada para ligar
      { id: 98500005, st: 'open', valor: 999, fonte: 902, ad: A1 }, // outra fonte: fora da página
    ];
    for (const d of D) {
      await c().query(`insert into crm.deals (pipedrive_id, pipeline_id, stage_id, owner_id, status, is_deleted, valor, created_at) values ($1, 940005, 954001, null, $2, false, $3, '2099-03-10T12:00:00Z')`, [d.id, d.st, d.valor]);
      const cf = { [K.fonte]: d.fonte, [K.ad]: d.ad ?? null, [K.camp]: d.camp ?? null, [K.uterm]: d.uterm ?? null };
      await c().query(`insert into raw.pd_deals (source_id, payload, payload_hash) values ($1, $2::jsonb, 'h')`, [d.id, JSON.stringify({ id: d.id, custom_fields: cf })]);
    }
    await c().query(`insert into crm.stage_history (deal_id, estagio, entrou_em, stage_id, origem_dado) values (98500001, 'e1', '2099-03-10T12:00:00Z', 954001, 'flow'), (98500001, 'e2', '2099-03-11T12:00:00Z', 954002, 'flow')`);
    // agrupamento dos criativos: "AD Um" = DOR e Mensagem fictícias
    await c().query(`insert into mkt.cri_dor (nome) values ('Dor Fictícia')`);
    await c().query(`insert into mkt.cri_mensagem (dor_id, nome) select id, 'Mensagem Fictícia' from mkt.cri_dor where nome = 'Dor Fictícia'`);
    await c().query(`insert into mkt.cri_mapa (termo_chave, dor_id, mensagem_id) select 'ad um', d.id, m.id from mkt.cri_dor d join mkt.cri_mensagem m on m.dor_id = d.id where d.nome = 'Dor Fictícia'`);
    await c().query('select crm.recalcular_deal_atributos(true)'); // a sincronizacao real faz isto depois dos negocios: as visoes do BI leem crm.deal_atributos
    await c().query(`select mkt.recalcular_ligacao_meta()`);
    await c().query('set local role orq_panel');
  });
  afterAll(async () => {
    await c().query('reset role').catch(() => undefined);
    await c().query('rollback');
    await c().end();
  });

  it('série no tempo: um ponto por dia com os componentes (gasto, impressões, cliques, leads da Meta e leads do Pipedrive)', async () => {
    const r = await exec('meta-serie');
    const g = r.grafico as { tipo: string; pontos: Array<Record<string, number | string>> };
    expect(g.tipo).toBe('serie');
    const d5 = g.pontos.find((p) => p.dia === '2099-03-05')!;
    expect(d5).toMatchObject({ gasto: 150, impressoes: 15000, cliques_link: 250, visitas: 150, leads_meta: 10, leads: 0 });
    expect(g.pontos.find((p) => p.dia === '2099-03-10')).toMatchObject({ gasto: 0, leads: 4 }); // negócios Meta ADS criados no dia 10 (o d5 é de outra fonte)
    expect(r.tabela.linhas.find((l) => l.dia === '2099-03-05')).toMatchObject({ cpm: 10, cpl_meta: 15, cpl: null });
    expect((await exec('meta-serie', { ...F, produto: 'clinic' })).grafico).toMatchObject({ pontos: [] });
  });

  it('visão geral: investimento, métricas calculadas das somas, funil, custos por etapa, CAC, ROAS e MRR', async () => {
    const r = await exec('meta-resumo');
    expect(kpi(r, 'invest')).toBe(150);
    expect(kpi(r, 'impressoes')).toBe(15000);
    expect(kpi(r, 'cliques_link')).toBe(250);
    expect(kpi(r, 'cpm')).toBeCloseTo(10, 5); // 150 ÷ 15000 × 1000
    expect(kpi(r, 'cpc')).toBeCloseTo(0.6, 5);
    expect(kpi(r, 'ctr')).toBeCloseTo(250 / 15000, 6);
    expect(kpi(r, 'connect')).toBeCloseTo(150 / 250, 6); // visitas ÷ cliques no link
    expect(kpi(r, 'hook')).toBeCloseTo(3000 / 10000, 6); // só impressões do anúncio com vídeo (o A2 não tem)
    expect(kpi(r, 'hold')).toBeCloseTo(800 / 3000, 6);
    expect(kpi(r, 'leads_meta')).toBe(10);
    expect(kpi(r, 'leads')).toBe(4); // d1 a d4 (o d5 é de outra fonte e fica de fora)
    expect(kpi(r, 'sql')).toBe(2 - 1); // só o d1 chegou na Reunião Agendada, que conta como SQL
    expect(kpi(r, 'reuniao')).toBe(1);
    expect(kpi(r, 'proposta')).toBe(0);
    expect(kpi(r, 'ganhos')).toBe(1);
    expect(kpi(r, 'cpl')).toBeCloseTo(37.5, 5);
    expect(kpi(r, 'c_sql')).toBe(150);
    expect(kpi(r, 'c_reuniao')).toBe(150);
    expect(kpi(r, 'c_proposta')).toBeNull(); // ninguém chegou: não inventa custo
    expect(kpi(r, 'cac')).toBe(150);
    expect(kpi(r, 'roas')).toBeCloseTo(100 / 150, 6);
    expect(kpi(r, 'mrr_criado')).toBe(180);
    expect(kpi(r, 'valor_ganho')).toBe(100);
    expect(kpi(r, 'mrr_perdido')).toBe(50);
    expect(kpi(r, 'mrr_aberto')).toBe(30);
    expect(kpi(r, 'ticket_ganho')).toBe(100);
    expect(r.avisos).toEqual([]);
  });

  it('funil e custo de cada etapa', async () => {
    const l = Object.fromEntries((await exec('meta-funil-custos')).tabela.linhas.map((x) => [x.etapa, x]));
    expect(l['Leads']).toMatchObject({ negocios: 4, custo: 37.5 });
    expect(l['Chegou em Reunião Agendada']).toMatchObject({ negocios: 1, custo: 150 });
    expect(l['Chegou em proposta']).toMatchObject({ negocios: 0, custo: null });
  });

  it('por anúncio: o gasto de cada um com os negócios ligados a ele (Ad_id e campanha + nome) e uma linha para os não ligados', async () => {
    const l = (await exec('meta-criativos')).tabela.linhas;
    expect(l.map((x) => x.nome)).toEqual(['Total do período', 'AD Um', 'AD Dois', '(negócios sem ligação a anúncio (criativo))']);
    expect(l[0]).toMatchObject({ gasto: 150, leads: 4, ganhos: 1 });
    expect(l[1]).toMatchObject({ id: A1, gasto: 100, leads: 2, ganhos: 1, cpl: 50, valor: 100, conjunto: 'Conjunto Fictício', campanha: 'Campanha Fictícia' });
    expect(l[2]).toMatchObject({ id: A2, gasto: 50, leads: 1, ganhos: 0, cpl: 50, mrr_aberto: 30 });
    expect(l[3]).toMatchObject({ leads: 1, gasto: 0, cpl: null });
  });

  it('por campanha e por conjunto', async () => {
    const camp = (await exec('meta-campanhas')).tabela.linhas;
    expect(camp[1]).toMatchObject({ id: C1, nome: 'Campanha Fictícia', gasto: 150, leads: 3, cpm: 10 });
    expect(camp[2]).toMatchObject({ leads: 1 }); // o d4 não tem ligação nenhuma
    expect((await exec('meta-conjuntos')).tabela.linhas[1]).toMatchObject({ id: S1, gasto: 150, leads: 3, campanha: 'Campanha Fictícia' });
  });

  it('vídeo: hook, hold, retenção por quartil e tempo médio; anúncio sem vídeo não aparece', async () => {
    const l = (await exec('meta-video')).tabela.linhas;
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ nome: 'AD Um', vplays: 5000, v3s: 3000, thru: 800, tempo: 5 });
    expect(Number(l[0]!.hook)).toBeCloseTo(0.3, 6);
    expect(Number(l[0]!.hold)).toBeCloseTo(800 / 3000, 6);
    expect([l[0]!.ret25, l[0]!.ret50, l[0]!.ret75, l[0]!.ret95, l[0]!.ret100].map((v) => Number(v))).toEqual([0.4, 0.2, 0.1, 0.06, 0.04]);
  });

  it('DOR e Mensagem: o investimento (pelo nome do anúncio) e os leads (pelo UTM Term) caem na mesma linha; o resto fica "em branco"', async () => {
    const l = Object.fromEntries((await exec('meta-dor')).tabela.linhas.map((x) => [x.nome, x]));
    expect(l['Dor Fictícia › Mensagem Fictícia']).toMatchObject({ gasto: 100, leads: 2, ganhos: 1, valor: 100 });
    expect(l['(em branco) › (em branco)']).toMatchObject({ gasto: 50, leads: 1 });
    expect((await exec('meta-modulo')).tabela.linhas.map((x) => x.nome)).toEqual(['(em branco)']);
  });

  it('cobertura da ligação por mês e método', async () => {
    const t = (await exec('meta-cobertura')).tabela.linhas[0]!;
    expect(t).toMatchObject({ mes: '2099-03', total: 5, ad_id: 3, 'campanha_id+nome': 1, sem_ligacao: 1 });
    expect(Number(t.pligado)).toBeCloseTo(4 / 5, 6);
  });

  it('o filtro de Fonte não vale (a página é sempre Meta ADS); período e produto valem', async () => {
    expect(kpi(await exec('meta-resumo', { ...F, fontes: ['999999'] }), 'leads')).toBe(4);
    const outro = await exec('meta-resumo', { de: '2098-01-01', ate: '2098-12-31' });
    expect(kpi(outro, 'invest')).toBe(0);
    expect(outro.avisos[0]).toMatch(/Não há dados da Meta/);
    expect(kpi(await exec('meta-resumo', { ...F, produto: 'clinic' }), 'invest')).toBe(0); // a conta fictícia é a de RH
  });
});
