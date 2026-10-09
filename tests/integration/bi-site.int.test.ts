import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { PgBiRepo, type BiFiltros } from '../../studio/lib/bi';
import { connect, hasDbConfig } from './helpers';

/**
 * BI "Site e páginas" (migration 0014) provado com dados FICTÍCIOS de 2099 (dentro de uma transação desfeita), lidos pelo papel
 * orq_panel de verdade: tráfego do GA4, funil dos leads por URL de conversão e ligação por domínio + caminho.
 * Pulado até a migration 0014 (analytics.site_dia e negocios_url.host_url) ser aplicada.
 */
let client: pg.Client | null = null;
let ready = false;
if (hasDbConfig) {
  client = await connect();
  ready = (
    await client.query(
      `select to_regclass('analytics.site_dia') is not null
          and exists (select 1 from information_schema.columns where table_schema = 'analytics' and table_name = 'negocios_url' and column_name = 'host_url') as ok`,
    )
  ).rows[0].ok === true;
  if (!ready) await client.end();
}
const run = describe.skipIf(!ready);

const F: BiFiltros = { de: '2099-01-01', ate: '2099-12-31' };
// chaves falsas MAIORES que as reais (a visão escolhe max(field_key) entre campos de mesmo nome)
const K = { url: `${'f'.repeat(39)}h`, camp: `${'f'.repeat(39)}i`, midia: `${'f'.repeat(39)}j` };

run('BI Site e páginas (transação com rollback)', () => {
  const c = () => client!;
  const repo = () => new PgBiRepo(c() as never);
  const exec = async (id: string, f: BiFiltros = F) => repo().rodar(id, f);
  const kpi = (r: Awaited<ReturnType<typeof exec>>, id: string) => (r.grafico as { itens: Array<{ id: string; valor: number | null }> }).itens.find((i) => i.id === id)!.valor;

  beforeAll(async () => {
    await c().query('begin');
    await c().query(`insert into crm.pipelines (pipeline_id, nome) values (940002, 'Funil Fictício Site')`);
    await c().query(`insert into crm.stages (stage_id, pipeline_id, nome) values (951001, 940002, 'Lead fictício'), (951002, 940002, 'Reunião fictícia'), (951003, 940002, 'SQL fictício')`);
    await c().query(`insert into ops.cfg_pipeline_produto (pipeline_id, produto) values (940002, 'rh')`);
    await c().query(`insert into ops.cfg_stage_marco (stage_id, marco) values (951002, 'reuniao'), (951003, 'sql')`);
    for (const [k, nome] of [[K.url, 'URL de Conversão'], [K.camp, 'UTM CAMPAIGN'], [K.midia, 'UTM Medium']] as const) {
      await c().query(`insert into crm.field_definitions (entity, field_key, nome, tipo) values ('deal', $1, $2, 'varchar')`, [k, nome]);
    }
    const D: Array<{ id: number; st: string; mid?: number; url?: string }> = [
      { id: 98100001, st: 'won', url: 'https://www.QuarkRH.com.br/lp-teste/?utm_source=x#topo' },
      { id: 98100002, st: 'lost', mid: 24, url: 'quarkrh.com.br/lp-teste' },
      { id: 98100003, st: 'open', url: 'https://quarkrh.com.br/lp-teste/' },
      { id: 98100004, st: 'open', url: 'https://quarkclinic.com.br/lp-teste' },
      { id: 98100005, st: 'open', url: 'quarkrh: software de gestão de pessoas' }, // texto livre: não é URL
      { id: 98100006, st: 'open' }, // sem URL
    ];
    for (const d of D) {
      await c().query(
        `insert into crm.deals (pipedrive_id, pipeline_id, stage_id, owner_id, status, is_deleted, valor, motivo_perda_id, created_at)
         values ($1, 940002, 951001, null, $2, false, 0, $3, '2099-03-10T12:00:00Z')`,
        [d.id, d.st, d.mid ?? null],
      );
      await c().query(`insert into raw.pd_deals (source_id, payload, payload_hash) values ($1, $2::jsonb, 'h')`, [d.id, JSON.stringify({ id: d.id, custom_fields: { [K.url]: d.url ?? null } })]);
    }
    const h = (deal: number, stage: number, t: string) =>
      c().query(`insert into crm.stage_history (deal_id, estagio, entrou_em, stage_id, origem_dado) values ($1, $2, $3, $4, 'flow')`, [deal, `e${stage}`, t, stage]);
    await h(98100001, 951001, '2099-03-10T12:00:00Z'); await h(98100001, 951002, '2099-03-11T12:00:00Z'); // ganho que passou por reunião
    await h(98100003, 951001, '2099-03-10T12:00:00Z'); await h(98100003, 951003, '2099-03-11T12:00:00Z'); // aberto que chegou em SQL

    // GA4 fictício: 2 dias de totais, páginas de entrada (com e sem "www." e barra final) e um evento com regra
    await c().query(
      `insert into mkt.ga4_dia (property_id, dia, sessoes, usuarios_ativos, usuarios_novos, sessoes_engajadas, visualizacoes) values
        (9999, '2099-03-05', 1000, 400, 300, 600, 2500), (9999, '2099-03-06', 500, 200, 100, 250, 1000)`,
    );
    await c().query(
      `insert into mkt.ga4_sessoes_dia (property_id, dia, host, landing_page, fonte, midia, campanha, sessoes, usuarios_novos, sessoes_engajadas, visualizacoes) values
        (9999, '2099-03-05', 'www.quarkrh.com.br', '/lp-teste/', 'fonte-fake', 'midia-fake', '', 100, 60, 50, 150),
        (9999, '2099-03-05', 'quarkrh.com.br', '/lp-teste', 'fonte-fake', 'midia-fake', '', 50, 20, 25, 70),
        (9999, '2099-03-06', 'quarkrh.com.br', '/outra-fake', 'outra-fake', 'midia-fake', '', 10, 5, 4, 12)`,
    );
    await c().query(`insert into mkt.ga4_eventos_dia (property_id, dia, host, pagina, evento, eventos, usuarios) values (9999, '2099-03-05', 'quarkrh.com.br', '/lp-teste', 'form_fake_site', 7, 6)`);
    await c().query(`insert into mkt.conversao_regras (nome, tipo, evento, url_modo) values ('regra fictícia do site', 'lead', 'form_fake_site', 'qualquer')`);
    await c().query('set local role orq_panel');
  });
  afterAll(async () => {
    await c().query('reset role').catch(() => undefined);
    await c().query('rollback');
    await c().end();
  });

  it('host_url: domínio sem "www.", minúsculas; texto que não é URL vira nulo', async () => {
    await c().query('reset role');
    const casos: Array<[string | null, string | null]> = [
      ['https://www.QuarkRH.com.br/x?y=1', 'quarkrh.com.br'],
      ['quarkrh.com.br/lp', 'quarkrh.com.br'],
      ['http://lp2.quarkrh.com.br', 'lp2.quarkrh.com.br'],
      ['https://quarkrh-diagnostico.lovable.app/a#b', 'quarkrh-diagnostico.lovable.app'],
      ['quarkrh: software de gestão de pessoas', null],
      [' https:', null],
      ['ifempty(;https://x.com)', null],
      ['', null],
      [null, null],
    ];
    for (const [u, esperado] of casos) expect((await c().query(`select mkt.host_url($1) as h`, [u])).rows[0].h, String(u)).toBe(esperado);
    await c().query('set local role orq_panel');
  });

  it('negocios_url: as colunas antigas continuam e ganhou host_url e url_valida', async () => {
    const r = (await c().query(`select deal_id, caminho_url, tem_url, host_url, url_valida from analytics.negocios_url where deal_id between 98100001 and 98100006 order by deal_id`)).rows;
    expect(r.map((x) => [Number(x.deal_id), x.host_url, x.caminho_url, x.url_valida])).toEqual([
      [98100001, 'quarkrh.com.br', '/lp-teste', true],
      [98100002, 'quarkrh.com.br', '/lp-teste', true],
      [98100003, 'quarkrh.com.br', '/lp-teste', true],
      [98100004, 'quarkclinic.com.br', '/lp-teste', true],
      [98100005, null, 'quarkrh: software de gestão de pessoas', false],
      [98100006, null, '/', false],
    ]);
    expect(r[4]!.tem_url).toBe(true);
    expect(r[5]!.tem_url).toBe(false);
  });

  it('resumo: sessões, novos usuários, ativos por dia (média), engajamento e páginas por sessão', async () => {
    const r = await exec('site-resumo');
    expect(kpi(r, 'sessoes')).toBe(1500);
    expect(kpi(r, 'novos')).toBe(400);
    expect(kpi(r, 'ativos')).toBe(300); // média de 400 e 200
    expect(kpi(r, 'views')).toBe(3500);
    expect(kpi(r, 'engaj')).toBeCloseTo(850 / 1500, 5);
    expect(r.avisos).toEqual([]);
  });

  it('resumo: compara com o período anterior do mesmo tamanho', async () => {
    const r = await exec('site-resumo', { de: '2099-03-06', ate: '2099-03-06' });
    expect(kpi(r, 'sessoes')).toBe(500);
    const l = r.tabela.linhas.find((x) => x.indicador === 'Sessões (acessos)')!;
    expect(l.anterior).toBe('1.000');
    expect(Number(l.variacao)).toBeCloseTo(-0.5, 5);
  });

  it('sem dados do GA4 no período: zera e avisa', async () => {
    const r = await exec('site-resumo', { de: '2098-01-01', ate: '2098-01-31' });
    expect(kpi(r, 'sessoes')).toBe(0);
    expect(r.avisos[0]).toMatch(/Não há dados do Google Analytics/);
  });

  it('acessos: dia a dia em períodos curtos, mês a mês nos longos', async () => {
    const d = (await exec('site-acessos', { de: '2099-03-01', ate: '2099-03-31' })).grafico as { categorias: string[]; series: Array<{ id: string; valores: number[] }> };
    expect(d.categorias).toEqual(['2099-03-05', '2099-03-06']);
    expect(d.series.find((s) => s.id === 'sessoes')!.valores).toEqual([1000, 500]);
    expect(d.series.find((s) => s.id === 'novos')!.valores).toEqual([300, 100]);
    const m = (await exec('site-acessos')).grafico as { categorias: string[]; series: Array<{ id: string; valores: number[] }> };
    expect(m.categorias).toEqual(['2099-03']);
    expect(m.series[0]!.valores).toEqual([1500]);
  });

  it('páginas: "www." e barra final se juntam; ordenadas por sessões, com a parte do total', async () => {
    const l = (await exec('site-paginas')).tabela.linhas;
    expect(l[0]).toMatchObject({ pagina: 'quarkrh.com.br/lp-teste', sessoes: 150, novos: 80 });
    expect(Number(l[0]!.part)).toBeCloseTo(150 / 1500, 5);
    expect(Number(l[0]!.engaj)).toBeCloseTo(75 / 150, 5);
    expect(l[1]).toMatchObject({ pagina: 'quarkrh.com.br/outra-fake', sessoes: 10 });
  });

  it('fontes e conversões do site (regra do Painel)', async () => {
    const f = (await exec('site-fontes')).tabela.linhas;
    expect(f[0]).toMatchObject({ fonte: 'fonte-fake', midia: 'midia-fake', sessoes: 150 });
    const cv = await exec('site-conversoes');
    expect(cv.tabela.linhas).toEqual([expect.objectContaining({ regra: 'regra fictícia do site', evento: 'form_fake_site', eventos: 7, usuarios: 6 })]);
  });

  it('funil por URL: domínios separados, leads, marcos e taxas de passo condicionais', async () => {
    const r = await exec('site-url-funil');
    const l = r.tabela.linhas;
    expect(l[0]).toMatchObject({ pagina: 'Total (leads com URL de conversão válida)', leads: 4, ganhos: 1, perdidos: 1 });
    const rh = l.find((x) => x.pagina === 'quarkrh.com.br/lp-teste')!;
    expect(rh).toMatchObject({ leads: 3, mql: 3, sql: 2, reuniao: 1, proposta: 0, ganhos: 1, perdidos: 1, sessoes: 150 });
    expect(Number(rh.visita_lead)).toBeCloseTo(3 / 150, 5); // leads ÷ sessões da mesma página
    expect(Number(rh.p_sql)).toBeCloseTo(2 / 3, 5); // dos MQL, os que chegaram em SQL
    expect(Number(rh.p_reuniao)).toBeCloseTo(1 / 2, 5);
    expect(Number(rh.p_proposta)).toBe(0); // 1 chegou em reunião e nenhum em proposta: 0%, não "sem base"
    expect(Number(rh.taxa_ganho)).toBeCloseTo(1 / 2, 5);
    expect(Number(rh.lead_ganho)).toBeCloseTo(1 / 3, 5);
    const cl = l.find((x) => x.pagina === 'quarkclinic.com.br/lp-teste')!;
    expect(cl).toMatchObject({ leads: 1, sessoes: null }); // domínio que o GA4 não mede: sem sessões
    expect(cl.visita_lead).toBeNull();
    expect(r.avisos[0]).toMatch(/4 de 6 leads/);
    expect(r.avisos[0]).toMatch(/1 têm um texto que não é URL/);
  });

  it('funil por URL: os filtros de produto e período valem; sem leads no filtro não há linhas', async () => {
    expect((await exec('site-url-funil', { ...F, produto: 'clinic' })).tabela.linhas).toEqual([]);
    expect((await exec('site-url-funil', { de: '2098-01-01', ate: '2098-12-31' })).tabela.linhas).toEqual([]);
    expect((await exec('site-url-funil', { ...F, fontes: ['999999'] })).tabela.linhas).toEqual([]);
  });

  it('o conector do Claude (orq_chat) lê o tráfego e o caminho da URL, nunca o título do negócio', async () => {
    await c().query('reset role');
    await c().query('set local role orq_chat');
    expect((await c().query(`select count(*)::int as n from analytics.site_dia where property_id = 9999`)).rows[0].n).toBe(2);
    await c().query(`select host_url, url_valida from analytics.negocios_url limit 1`);
    await c().query('savepoint s');
    await expect(c().query(`select titulo from analytics.negocios_url`)).rejects.toThrow();
    await c().query('rollback to savepoint s');
    await c().query('reset role');
    await c().query('set local role orq_panel');
  });
});
