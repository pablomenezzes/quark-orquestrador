import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { BI_ANALISES, PgBiRepo, type BiFiltros } from '../../studio/lib/bi';
import { connect, hasDbConfig } from './helpers';

/**
 * Números do BI provados com negócios FICTÍCIOS (dentro de uma transação desfeita), lidos pelo papel orq_panel de verdade.
 * Os negócios do cenário principal são de 2099 (nunca se misturam com os reais); a curva de safra usa 2025 isolada pelo
 * pipeline fictício. Pulado até a migration 0011 (analytics.negocios_bi) ser aplicada.
 */
let client: pg.Client | null = null;
let ready = false;
if (hasDbConfig) {
  client = await connect();
  ready = (await client.query(`select to_regclass('analytics.negocios_bi') is not null as ok`)).rows[0].ok === true;
  if (!ready) await client.end();
}
const run = describe.skipIf(!ready);

const F: BiFiltros = { de: '2099-01-01', ate: '2099-12-31' };
// Chaves falsas, todas MAIORES que as reais (a visão escolhe max(field_key) entre campos de mesmo nome), para o teste não depender dos campos reais
const K = { fonte: `${'f'.repeat(39)}a`, tipo: `${'f'.repeat(39)}b`, faixaColab: `${'f'.repeat(39)}c`, faixaSaude: `${'f'.repeat(39)}d`, canalRd: `${'f'.repeat(39)}e`, utm: `${'f'.repeat(39)}g` };

run('BI (transação com rollback)', () => {
  const c = () => client!;
  const repo = () => new PgBiRepo(c() as never);
  const exec = async (id: string, f: BiFiltros = F) => repo().rodar(id, f);
  const kpi = (r: Awaited<ReturnType<typeof exec>>, id: string) => (r.grafico as { itens: Array<{ id: string; valor: number | null }> }).itens.find((i) => i.id === id)!.valor;
  const por = (r: Awaited<ReturnType<typeof exec>>, chave: string) => Object.fromEntries(r.tabela.linhas.map((l) => [String(l[chave]), l]));

  beforeAll(async () => {
    await c().query('begin');
    await c().query(`insert into crm.pipelines (pipeline_id, nome) values (940001, 'Funil Fictício BI')`);
    await c().query(`insert into crm.stages (stage_id, pipeline_id, nome) values (950001, 940001, 'Lead fictício'), (950002, 940001, 'Reunião fictícia'), (950003, 940001, 'Proposta fictícia'), (950004, 940001, 'SQL fictício')`);
    await c().query(`insert into crm.users (user_id, nome) values (960001, 'Vendedora A Fictícia'), (960002, 'Vendedor B Fictício')`);
    await c().query(`insert into ops.cfg_pipeline_produto (pipeline_id, produto) values (940001, 'rh')`);
    await c().query(`insert into ops.cfg_stage_marco (stage_id, marco) values (950002, 'reuniao'), (950003, 'proposta'), (950004, 'sql')`);
    const campo = (key: string, nome: string, tipo: string, opcoes: unknown[] | null) =>
      c().query(`insert into crm.field_definitions (entity, field_key, nome, tipo, opcoes) values ('deal', $1, $2, $3, $4::jsonb)`, [key, nome, tipo, opcoes ? JSON.stringify(opcoes) : null]);
    await campo(K.fonte, 'Fonte do Lead', 'enum', [{ id: 901, label: 'Origem Fictícia A' }]);
    await campo(K.tipo, 'Tipo do Lead', 'enum', [{ id: 9001, label: 'Marketing Fictício' }, { id: 9002, label: 'Outro Tipo Fictício' }]);
    await campo(K.faixaColab, 'Faixa de Colaboradores', 'enum', [{ id: 8001, label: 'Até 10 fictício' }]);
    await campo(K.faixaSaude, 'Faixa de profissionais da saúde', 'enum', [{ id: 7001, label: 'Até 2 fictício' }]);
    await campo(K.canalRd, 'Canal de origem RD', 'varchar', null);
    await campo(K.utm, 'UTM Source', 'varchar', null);

    type D = { id: number; st: string | null; del?: boolean; valor?: number; owner: number; mid?: number; mot?: string; fonte?: number; tipo?: number; faixa?: number; canal?: string; utm?: string; pessoa?: boolean; criado?: string; fechado?: string };
    const D: D[] = [
      { id: 97100001, st: 'open', owner: 960001, fonte: 901, tipo: 9001, faixa: 8001, canal: 'Busca orgânica', utm: 'google', pessoa: true },
      { id: 97100002, st: 'won', valor: 1000, owner: 960001, fonte: 901, tipo: 9001, faixa: 8001, canal: 'Busca orgânica', utm: '{{}}', pessoa: true, fechado: '2099-03-20T12:00:00Z' }, // UTM com modelo não preenchido
      { id: 97100003, st: 'lost', owner: 960001, mid: 398, mot: 'Lead Invalido', fonte: 901, tipo: 9001, faixa: 8001, canal: 'Anúncio', utm: 'undefined', pessoa: true }, // inválido: 398 tira do MQL
      { id: 97100004, st: 'lost', owner: 960001, mid: 24, mot: 'Achou o preço caro', fonte: 902, tipo: 9001, canal: 'Anúncio' },
      { id: 97100005, st: null, del: true, owner: 960001, fonte: 901, tipo: 9001 }, // excluído: fora dos leads (padrão)
      { id: 97100006, st: 'won', valor: 500, owner: 960002, fonte: 902, tipo: 9002, fechado: '2099-03-30T12:00:00Z' },
      { id: 97100007, st: 'lost', owner: 960002, mid: 24, mot: 'Achou o preço caro', canal: 'Desconhecido' }, // sem fonte, sem tipo, canal desconhecido
      // curva de safra: janeiro de 2025, só no pipeline fictício
      { id: 97200001, st: 'won', valor: 100, owner: 960001, fonte: 901, tipo: 9001, criado: '2025-01-10T12:00:00Z', fechado: '2025-01-15T12:00:00Z' }, // ganho em 5 dias (dentro de 1 mês)
      { id: 97200002, st: 'won', valor: 100, owner: 960001, fonte: 901, tipo: 9001, criado: '2025-01-10T12:00:00Z', fechado: '2025-02-24T12:00:00Z' }, // ganho em 45 dias (dentro de 2 meses)
      { id: 97200003, st: 'lost', owner: 960001, fonte: 901, tipo: 9001, criado: '2025-01-10T12:00:00Z', fechado: '2025-01-20T12:00:00Z' },
    ];
    for (const d of D) {
      await c().query(
        `insert into crm.deals (pipedrive_id, pipeline_id, stage_id, owner_id, status, is_deleted, valor, motivo_perda_id, motivo_perda, created_at, close_time, person_id, org_id)
         values ($1, 940001, 950001, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
        [d.id, d.owner, d.st, d.del ?? false, d.valor ?? 0, d.mid ?? null, d.mot ?? null, d.criado ?? '2099-03-10T12:00:00Z', d.fechado ?? null, d.pessoa ? 1 : null],
      );
      const cf: Record<string, unknown> = { [K.fonte]: d.fonte ?? null, [K.tipo]: d.tipo ?? null, [K.faixaColab]: d.faixa ?? null, [K.canalRd]: d.canal ?? null, [K.utm]: d.utm ?? null };
      await c().query(`insert into raw.pd_deals (source_id, payload, payload_hash) values ($1, $2::jsonb, 'h')`, [d.id, JSON.stringify({ id: d.id, custom_fields: cf })]);
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

  /* ---------- Visão geral (regras de contagem) ---------- */
  it('visão geral: leads, MQL, ganhos, taxa e valor seguem as regras (excluído fora; 398 tira do MQL)', async () => {
    const r = await exec('visao-geral');
    expect(kpi(r, 'leads')).toBe(6); // 7 menos o excluído
    expect(kpi(r, 'mql')).toBe(5); // 6 menos o perdido por 398
    expect(kpi(r, 'pct_mql')).toBeCloseTo(5 / 6, 5);
    expect(kpi(r, 'ganhos')).toBe(2);
    expect(kpi(r, 'perdidos')).toBe(3);
    expect(kpi(r, 'abertos')).toBe(1);
    expect(kpi(r, 'taxa_ganho')).toBeCloseTo(2 / 5, 5);
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

  it('motivos de perda e por responsável', async () => {
    const m = (await exec('motivos-perda')).tabela.linhas;
    expect(m[0]).toMatchObject({ motivo: 'Achou o preço caro', id: '24', qtd: 2, mql: 'não' });
    expect(m[1]).toMatchObject({ motivo: 'Lead Invalido', id: '398', qtd: 1, mql: 'sim' });
    const r = por(await exec('por-responsavel'), 'responsavel');
    expect(r['Vendedora A Fictícia']).toMatchObject({ leads: 4, ganhos: 1, perdidos: 2, abertos: 1, valor: 1000 });
    expect(r['Vendedor B Fictício']).toMatchObject({ leads: 2, ganhos: 1, perdidos: 1, valor: 500, taxa: 0.5 });
  });

  /* ---------- Filtros de Fonte e Tipo do Lead ---------- */
  it('filtro de Fonte: por ID da opção, com "branco" para o campo não preenchido', async () => {
    expect(kpi(await exec('visao-geral', { ...F, fontes: ['901'] }), 'leads')).toBe(3); // 1, 2, 3 (o excluído 5 não conta)
    expect(kpi(await exec('visao-geral', { ...F, fontes: ['901'] }), 'mql')).toBe(2); // o 3 é inválido
    expect(kpi(await exec('visao-geral', { ...F, fontes: ['902'] }), 'leads')).toBe(2); // 4 e 6
    expect(kpi(await exec('visao-geral', { ...F, fontes: ['branco'] }), 'leads')).toBe(1); // 7
    expect(kpi(await exec('visao-geral', { ...F, fontes: ['901', 'branco'] }), 'leads')).toBe(4);
    expect(kpi(await exec('visao-geral', { ...F, fontes: ['999999'] }), 'leads')).toBe(0);
  });

  it('filtro de Tipo do Lead e a combinação com a Fonte', async () => {
    expect(kpi(await exec('visao-geral', { ...F, tipos: ['9002'] }), 'leads')).toBe(1); // só o 6
    expect(kpi(await exec('visao-geral', { ...F, tipos: ['9002'] }), 'ganhos')).toBe(1);
    expect(kpi(await exec('visao-geral', { ...F, tipos: ['9001'] }), 'leads')).toBe(4); // 1, 2, 3, 4
    expect(kpi(await exec('visao-geral', { ...F, tipos: ['branco'] }), 'leads')).toBe(1); // 7
    expect(kpi(await exec('visao-geral', { ...F, fontes: ['902'], tipos: ['9001'] }), 'leads')).toBe(1); // só o 4
  });

  it('os filtros de Fonte e Tipo valem em TODAS as análises (nenhuma ignora)', async () => {
    for (const a of BI_ANALISES) {
      const r = await exec(a.id, { ...F, fontes: ['999999'], tipos: ['999999'] });
      const vazio = r.grafico.tipo === 'kpis'
        ? r.grafico.itens.every((i) => (i.formato === 'pct' ? i.valor === null : i.valor === 0))
        : r.grafico.tipo === 'colunas' ? r.grafico.categorias.length === 0
        : r.grafico.tipo === 'barras' ? r.grafico.itens.every((i) => i.valor === 0) || r.grafico.itens.length === 0 || a.id === 'qualidade-branco' || a.id === 'funil'
        : r.tabela.linhas.length === 0 || a.id === 'safra-ganhos';
      expect(vazio, `${a.id} deveria ficar vazia com uma fonte e um tipo que não existem`).toBe(true);
    }
  });

  /* ---------- Safra ---------- */
  it('safra: resumo por mês de criação, com ciclo mediano e taxa de ganho', async () => {
    const l = (await exec('safra-resumo')).tabela.linhas[0]!;
    expect(l).toMatchObject({ safra: '2099-03', leads: 6, ganhos: 2, perdidos: 3, abertos: 1, valor: 1500, ciclo: 15 }); // ciclos de 10 e 20 dias: mediana 15
    expect(Number(l.pmql)).toBeCloseTo(5 / 6, 5);
    expect(Number(l.taxa)).toBeCloseTo(2 / 5, 5);
    expect(Number(l.psql)).toBeCloseTo(1 / 6, 5);
  });

  it('safra: funil por safra (% dos leads que chegou em cada marco)', async () => {
    const g = (await exec('safra-funil')).grafico as { tipo: string; colunas: string[]; linhas: Array<{ rotulo: string; valores: Array<number | null> }> };
    expect(g.tipo).toBe('matriz');
    expect(g.linhas[0]!.rotulo).toBe('2099-03');
    expect(g.linhas[0]!.valores.map((v) => Math.round((v ?? 0) * 1000) / 1000)).toEqual([0.833, 0.167, 0.167, 0.167, 0.333]); // MQL, SQL, reunião, proposta, ganho (de 6 leads)
  });

  it('safra: curva de ganhos acumulados; safra que ainda não tem a idade fica em branco (não finge conversão)', async () => {
    const jan = (await exec('safra-ganhos', { de: '2025-01-01', ate: '2025-12-31', pipeline_id: 940001 })).grafico as { tipo: string; linhas: Array<{ rotulo: string; valores: Array<number | null> }> };
    expect(jan.linhas).toHaveLength(1);
    const v = jan.linhas[0]!.valores;
    expect(v[0]).toBeCloseTo(1 / 3, 5); // 1 dos 3 leads ganhou nos primeiros ~30 dias
    expect(v[1]).toBeCloseTo(2 / 3, 5); // 2 dos 3 até ~2 meses
    expect(v[5]).toBeCloseTo(2 / 3, 5); // e fica em 2/3: o terceiro foi perdido
    const futura = (await exec('safra-ganhos')).grafico as { linhas: Array<{ valores: Array<number | null> }> };
    expect(futura.linhas[0]!.valores.every((x) => x === null)).toBe(true); // 2099 ainda não aconteceu
  });

  /* ---------- Canais ---------- */
  it('canais: comparativo por fonte, com ID e nome da opção juntos', async () => {
    const p = por(await exec('canais-resumo'), 'fonte');
    expect(p['Origem Fictícia A']).toMatchObject({ id: '901', leads: 3, ganhos: 1 });
    expect(Number(p['Origem Fictícia A']!.pmql)).toBeCloseTo(2 / 3, 5);
    expect(Number(p['Origem Fictícia A']!.pinv)).toBeCloseTo(1 / 3, 5); // o 3 é inválido
    expect(p['902']).toMatchObject({ leads: 2, ganhos: 1, valor: 500, ticket: 500 }); // opção desconhecida aparece pelo ID
    expect(p['(sem fonte)']).toMatchObject({ leads: 1 });
  });

  it('canais por mês: cada fonte com a sua cor fixa; as demais juntas em "Outras fontes"', async () => {
    const g = (await exec('canais-por-mes')).grafico as { categorias: string[]; series: Array<{ id: string; nome: string; slot: number; valores: number[] }> };
    expect(g.categorias).toEqual(['2099-03']);
    expect(g.series).toEqual([{ id: 'outras', nome: 'Outras fontes', slot: 0, valores: [6] }]); // nenhuma das 4 fontes principais neste cenário
  });

  it('canais: detalhe por "Canal de origem RD"', async () => {
    const p = por(await exec('canais-rd'), 'canal');
    expect(p['Busca orgânica']).toMatchObject({ leads: 2, ganhos: 1 });
    expect(p['(em branco)']!.leads).toBe(1); // só o 6
    expect(p['Desconhecido']!.leads).toBe(1); // o 7
  });

  /* ---------- Qualidade ---------- */
  it('qualidade: indicadores (inválidos, perdidos, em branco por produto, sem pessoa)', async () => {
    const r = await exec('qualidade-kpis');
    expect(kpi(r, 'leads')).toBe(6);
    expect(kpi(r, 'pmql')).toBeCloseTo(5 / 6, 5);
    expect(kpi(r, 'pinv')).toBeCloseTo(1 / 6, 5); // só o perdido por 398
    expect(kpi(r, 'pperd')).toBeCloseTo(3 / 7, 5); // 3 perdidos em 7 negócios
    expect(kpi(r, 'psf')).toBeCloseTo(1 / 7, 5); // só o 7 sem fonte
    expect(kpi(r, 'pst')).toBeCloseTo(1 / 7, 5);
    expect(kpi(r, 'prh')).toBeCloseTo(4 / 7, 5); // RH: faixa de colaboradores em branco em 4 de 7
    expect(kpi(r, 'pcl')).toBeNull(); // não há negócio de Clínica neste cenário
    expect(kpi(r, 'ppe')).toBeCloseTo(4 / 7, 5);
    expect(kpi(r, 'pcd')).toBeCloseTo(1 / 7, 5); // canal de origem "Desconhecido": só o 7
    expect(kpi(r, 'pui')).toBeCloseTo(2 / 3, 5); // UTM inválido ({{}} e undefined) entre os 3 que têm UTM
  });

  it('qualidade: por fonte, por mês, inválidos e campos em branco', async () => {
    const f = por(await exec('qualidade-por-fonte'), 'fonte');
    expect(Number(f['Origem Fictícia A']!.pinv)).toBeCloseTo(1 / 3, 5);
    expect(Number(f['Origem Fictícia A']!.prh)).toBeCloseTo(1 / 4, 5); // RH com fonte A: 1,2,3,5; sem faixa: só o 5
    const g = (await exec('qualidade-por-mes')).grafico as { formato: string; series: Array<{ id: string; valores: number[] }> };
    expect(g.formato).toBe('pct');
    expect(g.series.find((s) => s.id === 'inv')!.valores[0]).toBeCloseTo(1 / 6, 5);
    const inv = (await exec('qualidade-invalidos')).tabela.linhas;
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ motivo: 'Lead Invalido', id: '398', qtd: 1 });
    expect(Number(inv[0]!.pct)).toBeCloseTo(1 / 6, 5);
    const b = por(await exec('qualidade-branco'), 'campo');
    expect(b['Fonte do Lead']).toMatchObject({ sem: 1, base: 7 });
    expect(b['Faixa de Colaboradores (só RH)']).toMatchObject({ sem: 4, base: 7 });
    expect(b['Faixa de profissionais da saúde (só Clínica)']).toMatchObject({ sem: 0, base: 0 });
    expect(b['Canal de origem RD = "Desconhecido"']).toMatchObject({ sem: 1, base: 7 });
    expect(b['UTM Source inválido ({{...}}, undefined, unknown), entre os preenchidos']).toMatchObject({ sem: 2, base: 3 });
  });

  /* ---------- Filtros gerais e catálogo ---------- */
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
      for (const f of [F, { ...F, produto: 'rh' as const }, { ...F, pipeline_id: 940001 }, { ...F, fontes: ['901', 'branco'], tipos: ['9001'] }]) {
        const r = await exec(a.id, f);
        expect(r.tabela.colunas.length, a.id).toBeGreaterThan(0);
        expect(Array.isArray(r.avisos), a.id).toBe(true);
      }
    }
  });

  it('as opções dos filtros vêm do banco: fontes e tipos com ID e nome, e a seleção fixa marcada', async () => {
    const o = await repo().opcoes();
    expect(o.pipelines.some((p) => p.pipeline_id === 940001 && p.produto === 'rh')).toBe(true);
    expect(o.primeiro_negocio).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const nomes = (l: Array<{ nome: string; padrao: boolean }>) => l.filter((x) => x.padrao).map((x) => x.nome).sort();
    expect(nomes(o.tipos)).toEqual(expect.arrayContaining(['Marketing'])); // seleção fixa do Tipo do Lead
    expect(o.fontes.every((x) => /^\d+$/.test(x.id))).toBe(true);
    expect(repo().catalogo().length).toBe(BI_ANALISES.length);
    expect(o.paginas.map((p) => p.id)).toEqual(['geral', 'safra', 'canais', 'qualidade']);
  });
});
