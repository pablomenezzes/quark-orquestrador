import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { BI_ANALISES, PgBiRepo } from '../../studio/lib/bi';
import { connect, hasDbConfig } from './helpers';

/**
 * Números do BI provados com negócios FICTÍCIOS criados em 2099 (dentro de uma transação desfeita), lidos pelo papel orq_panel
 * de verdade. Cenário: 7 negócios no pipeline fictício "RH"; as regras de MQL e de contagem são as do banco (D-36).
 */
let client: pg.Client | null = null;
let ready = false;
if (hasDbConfig) {
  client = await connect();
  ready = (await client.query(`select to_regclass('analytics.historico_etapas') is not null as ok`)).rows[0].ok === true;
  if (!ready) await client.end();
}
const run = describe.skipIf(!ready);

const F = { de: '2099-01-01', ate: '2099-12-31' };
const KEY = 'f'.repeat(40);

run('BI (transação com rollback)', () => {
  const c = () => client!;
  const repo = () => new PgBiRepo(c() as never);
  const exec = async (id: string, f: Parameters<PgBiRepo['rodar']>[1] = F) => repo().rodar(id, f);
  const kpi = (r: Awaited<ReturnType<typeof exec>>, id: string) => (r.grafico as { itens: Array<{ id: string; valor: number | null }> }).itens.find((i) => i.id === id)!.valor;

  beforeAll(async () => {
    await c().query('begin');
    await c().query(`insert into crm.pipelines (pipeline_id, nome) values (940001, 'Funil Fictício BI')`);
    await c().query(`insert into crm.stages (stage_id, pipeline_id, nome) values (950001, 940001, 'Lead fictício'), (950002, 940001, 'Reunião fictícia'), (950003, 940001, 'Proposta fictícia'), (950004, 940001, 'SQL fictício')`);
    await c().query(`insert into crm.users (user_id, nome) values (960001, 'Vendedora A Fictícia'), (960002, 'Vendedor B Fictício')`);
    await c().query(`insert into ops.cfg_pipeline_produto (pipeline_id, produto) values (940001, 'rh')`);
    await c().query(`insert into ops.cfg_stage_marco (stage_id, marco) values (950002, 'reuniao'), (950003, 'proposta'), (950004, 'sql')`);
    await c().query(`insert into crm.field_definitions (entity, field_key, nome, tipo, opcoes) values ('deal', $1, 'Fonte do Lead', 'enum', $2::jsonb)`, [KEY, JSON.stringify([{ id: 901, label: 'Origem Fictícia A' }])]);
    // 7 negócios: [id, status, is_deleted, valor, responsável, motivo_id, motivo, origem]
    const D: Array<[number, string | null, boolean, number, number, number | null, string | null, number]> = [
      [97100001, 'open', false, 0, 960001, null, null, 901],
      [97100002, 'won', false, 1000, 960001, null, null, 901],
      [97100003, 'lost', false, 0, 960001, 398, 'Lead Invalido', 901], // 398 tira do MQL
      [97100004, 'lost', false, 0, 960001, 24, 'Achou o preço caro', 902],
      [97100005, null, true, 0, 960001, null, null, 901], // excluído: fora da contagem de leads (padrão)
      [97100006, 'won', false, 500, 960002, null, null, 902],
      [97100007, 'lost', false, 0, 960002, 24, 'Achou o preço caro', 902],
    ];
    for (const [id, st, del, valor, owner, mid, mot, origem] of D) {
      await c().query(
        `insert into crm.deals (pipedrive_id, pipeline_id, stage_id, owner_id, status, is_deleted, valor, motivo_perda_id, motivo_perda, created_at)
         values ($1, 940001, 950001, $2, $3, $4, $5, $6, $7, '2099-03-10T12:00:00Z')`,
        [id, owner, st, del, valor, mid, mot],
      );
      await c().query(`insert into raw.pd_deals (source_id, payload, payload_hash) values ($1, $2::jsonb, 'h')`, [id, JSON.stringify({ id, custom_fields: { [KEY]: origem } })]);
    }
    // histórico: o 2 (ganho) passou por reunião e proposta; o 6 (ganho) só chegou em SQL
    const h = (deal: number, stage: number, t: string) =>
      c().query(`insert into crm.stage_history (deal_id, estagio, entrou_em, stage_id, origem_dado) values ($1, $2, $3, $4, 'flow')`, [deal, `e${stage}`, t, stage]);
    await h(97100002, 950001, '2099-03-10T12:00:00Z'); await h(97100002, 950002, '2099-03-11T12:00:00Z'); await h(97100002, 950003, '2099-03-12T12:00:00Z');
    await h(97100006, 950001, '2099-03-10T12:00:00Z'); await h(97100006, 950004, '2099-03-11T12:00:00Z');
    await c().query('set local role orq_panel');
  });
  afterAll(async () => {
    await c().query('reset role').catch(() => undefined);
    await c().query('rollback');
    await c().end();
  });

  it('visão geral: leads, MQL, ganhos, taxa e valor seguem as regras (excluído fora; 398 tira do MQL)', async () => {
    const r = await exec('visao-geral');
    expect(kpi(r, 'leads')).toBe(6); // 7 menos o excluído
    expect(kpi(r, 'mql')).toBe(5); // 6 menos o perdido por 398
    expect(kpi(r, 'pct_mql')).toBeCloseTo(5 / 6, 5);
    expect(kpi(r, 'ganhos')).toBe(2);
    expect(kpi(r, 'perdidos')).toBe(3);
    expect(kpi(r, 'abertos')).toBe(1);
    expect(kpi(r, 'taxa_ganho')).toBeCloseTo(2 / 5, 5); // 2 ganhos de 5 fechados
    expect(kpi(r, 'valor_ganho')).toBe(1500);
  });

  it('por mês: tudo cai no mês de criação (março de 2099)', async () => {
    const g = (await exec('por-mes')).grafico as { categorias: string[]; series: Array<{ id: string; valores: number[] }> };
    expect(g.categorias).toEqual(['2099-03']);
    expect(Object.fromEntries(g.series.map((s) => [s.id, s.valores[0]]))).toEqual({ leads: 6, mql: 5, ganhos: 2 });
  });

  it('funil: marcos pelo histórico; um ganho dado cedo continua contando em "chegou em"', async () => {
    const r = await exec('funil');
    const v = Object.fromEntries((r.grafico as { itens: Array<{ rotulo: string; valor: number }> }).itens.map((i) => [i.rotulo, i.valor]));
    expect(v).toEqual({ Leads: 6, MQL: 5, 'Chegou em SQL': 1, 'Chegou em reunião': 1, 'Chegou em proposta': 1, Ganhos: 2 });
  });

  it('motivos de perda: nome e ID juntos, marcando os que tiram do MQL', async () => {
    const r = await exec('motivos-perda');
    const linhas = r.tabela.linhas;
    expect(linhas[0]).toMatchObject({ motivo: 'Achou o preço caro', id: '24', qtd: 2, mql: 'não' });
    expect(linhas[1]).toMatchObject({ motivo: 'Lead Invalido', id: '398', qtd: 1, mql: 'sim' });
  });

  it('origem: ID e nome da opção juntos; opção desconhecida aparece pelo ID', async () => {
    const r = await exec('origem');
    const por = Object.fromEntries(r.tabela.linhas.map((l) => [String(l.origem), l]));
    expect(por['Origem Fictícia A']).toMatchObject({ id: '901', leads: 3, ganhos: 1, perdidos: 1, mql: 2 });
    expect(por['902']).toMatchObject({ leads: 3, ganhos: 1, perdidos: 2 });
  });

  it('por responsável: volume, ganhos e taxa de cada um', async () => {
    const r = await exec('por-responsavel');
    const por = Object.fromEntries(r.tabela.linhas.map((l) => [String(l.responsavel), l]));
    expect(por['Vendedora A Fictícia']).toMatchObject({ leads: 4, ganhos: 1, perdidos: 2, abertos: 1, valor: 1000 });
    expect(Number(por['Vendedora A Fictícia']!.taxa)).toBeCloseTo(1 / 3, 5);
    expect(por['Vendedor B Fictício']).toMatchObject({ leads: 2, ganhos: 1, perdidos: 1, valor: 500, taxa: 0.5 });
  });

  it('filtros: produto, pipeline e período recortam; fora do período dá zero', async () => {
    expect(kpi(await exec('visao-geral', { ...F, produto: 'rh' }), 'leads')).toBe(6);
    expect(kpi(await exec('visao-geral', { ...F, produto: 'clinic' }), 'leads')).toBe(0);
    expect(kpi(await exec('visao-geral', { ...F, pipeline_id: 940001 }), 'leads')).toBe(6);
    expect(kpi(await exec('visao-geral', { ...F, pipeline_id: 1 }), 'leads')).toBe(0);
    expect(kpi(await exec('visao-geral', { de: '2099-04-01', ate: '2099-12-31' }), 'leads')).toBe(0);
    expect(kpi(await exec('visao-geral', { de: '2099-03-10', ate: '2099-03-10' }), 'leads')).toBe(6); // o dia inteiro conta
  });

  it('todas as análises do catálogo rodam sem erro, com e sem filtros, e devolvem tabela', async () => {
    for (const a of BI_ANALISES) {
      for (const f of [F, { ...F, produto: 'rh' as const }, { ...F, pipeline_id: 940001 }]) {
        const r = await exec(a.id, f);
        expect(r.tabela.colunas.length, a.id).toBeGreaterThan(0);
        expect(Array.isArray(r.avisos), a.id).toBe(true);
      }
    }
  });

  it('o catálogo e as opções dos filtros vêm do banco', async () => {
    const o = await repo().opcoes();
    expect(o.pipelines.some((p) => p.pipeline_id === 940001 && p.produto === 'rh')).toBe(true);
    expect(o.primeiro_negocio).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(repo().catalogo().length).toBe(BI_ANALISES.length);
  });
});
