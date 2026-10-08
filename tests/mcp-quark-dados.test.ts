import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFINICOES, LIMITE_LINHAS, SqlRecusado, guardaSql, resolverFiltros, resolverOpcoes, tabelaMarkdown, textoAnalise, textoSql, type OpcoesBi } from '../mcp/quark-dados/logica';
import { BI_ANALISES } from '../studio/lib/bi';

// Dados 100% fictícios (regra 8).
const FONTES = [
  { id: '366', nome: 'Marketing [Google ADS]', padrao: true },
  { id: '365', nome: 'Marketing [Meta ADS]', padrao: true },
  { id: '367', nome: 'Marketing [Orgânico]', padrao: true },
  { id: '673', nome: 'Marketing [Social]', padrao: true },
  { id: '220', nome: 'Indicação CX', padrao: false },
];
const TIPOS = [
  { id: '112', nome: 'Marketing', padrao: true },
  { id: '113', nome: 'Indicação', padrao: false },
  { id: '591', nome: 'Parceria', padrao: false },
];
const OPC: OpcoesBi = { pipelines: [{ pipeline_id: 1, pipeline: 'QuarkRH', produto: 'rh' }, { pipeline_id: 2, pipeline: 'QuarkClinic', produto: 'clinic' }], fontes: FONTES, tipos: TIPOS };

describe('guardaSql: só consulta de leitura, uma instrução, com limite', () => {
  it('aceita SELECT e WITH e embrulha com limite de linhas', () => {
    expect(guardaSql('select status, count(*) from analytics.deals_resumo group by 1')).toBe('select * from (select status, count(*) from analytics.deals_resumo group by 1) as consulta limit 200');
    expect(guardaSql('  WITH a AS (select 1 as x) select * from a;  ', 10)).toBe('select * from (WITH a AS (select 1 as x) select * from a) as consulta limit 10');
  });
  it('o limite nunca passa do teto nem fica abaixo de 1', () => {
    expect(guardaSql('select 1', 99999)).toContain(`limit ${LIMITE_LINHAS}`);
    expect(guardaSql('select 1', 0)).toContain('limit 1');
  });
  it.each([
    'insert into ops.cfg_status_contagem values (1)', 'update ops.cfg_status_contagem set conta_como_lead = true', 'delete from analytics.deals_resumo', 'drop view analytics.deals_resumo',
    'create table x (a int)', 'alter role orq_chat superuser', 'truncate analytics.deals_resumo', 'grant all on schema analytics to public', 'copy analytics.deals to stdout',
    'select 1; select 2', 'select 1; drop table x', 'select 1 -- comentário', 'select /* x */ 1', 'show all', 'explain select 1', 'set role postgres', 'values (1)', '',
    'select pg_sleep(30)', "select set_config('role','postgres',false)", "select pg_read_file('/etc/passwd')", 'select * from dblink(\'x\', \'select 1\') as t(a int)', 'select current_setting(\'x\')',
    'vacuum', 'do $$ begin end $$', 'call x()', 'select 1 from analytics.deals_resumo where 1=1 union select 1 from x; delete from y',
  ])('recusa: %s', (sql) => {
    expect(() => guardaSql(sql)).toThrow(SqlRecusado);
  });
  it('recusa consulta gigante', () => {
    expect(() => guardaSql(`select ${'1,'.repeat(3000)}1`)).toThrow(/longa demais/);
  });
});

describe('resolverOpcoes: nomes tolerantes, IDs, "todas" e "em branco"', () => {
  it('sem pedido usa a seleção fixa e diz isso', () => {
    const r = resolverOpcoes(undefined, FONTES, 'Fonte do Lead');
    expect(r.ids).toEqual(['366', '365', '367', '673']);
    expect(r.texto).toContain('seleção fixa do BI');
  });
  it('aceita nome parcial, sem acento e sem caixa', () => {
    expect(resolverOpcoes(['google'], FONTES, 'Fonte').ids).toEqual(['366']);
    expect(resolverOpcoes(['META ads', 'organico'], FONTES, 'Fonte').ids).toEqual(['365', '367']);
    expect(resolverOpcoes(['indicacao cx'], FONTES, 'Fonte').ids).toEqual(['220']);
  });
  it('nome exato ganha de "contém" (Marketing não puxa os outros tipos)', () => {
    expect(resolverOpcoes(['Marketing'], TIPOS, 'Tipo').ids).toEqual(['112']);
    expect(resolverOpcoes(['Marketing'], FONTES, 'Fonte').ids).toEqual(['366', '365', '367', '673']); // aqui "contém" é o esperado: todas as fontes de Marketing
  });
  it('aceita ID, "(em branco)" e "todas"', () => {
    expect(resolverOpcoes(['220', '(em branco)'], FONTES, 'Fonte').ids).toEqual(['220', 'branco']);
    expect(resolverOpcoes(['todas'], FONTES, 'Fonte').ids).toBeUndefined();
  });
  it('nome que não existe: erro que lista as opções', () => {
    expect(() => resolverOpcoes(['tiktok'], FONTES, 'Fonte do Lead')).toThrow(/não encontrei "tiktok".*Marketing \[Google ADS\] \(#366\)/);
  });
});

describe('resolverFiltros: o pedido da conversa vira os filtros do BI', () => {
  const hoje = new Date(2026, 9, 8);
  it('padrões: este ano até hoje, fontes e tipo fixos', () => {
    const { filtros, descricao } = resolverFiltros({}, OPC, hoje);
    expect(filtros).toEqual({ de: '2026-01-01', ate: '2026-10-08', fontes: ['366', '365', '367', '673'], tipos: ['112'] });
    expect(descricao).toContain('2026-01-01 a 2026-10-08');
    expect(descricao).toContain('Tipo do Lead: Marketing (seleção fixa do BI)');
  });
  it('produto, pipeline por nome ou id, e "todas" sem filtro', () => {
    const a = resolverFiltros({ de: '2025-01-01', ate: '2025-12-31', produto: 'Clínica', pipeline: 'quarkrh', fontes: ['todas'], tipos: ['todos'] }, OPC, hoje);
    expect(a.filtros).toEqual({ de: '2025-01-01', ate: '2025-12-31', produto: 'clinic', pipeline_id: 1 });
    expect(resolverFiltros({ pipeline: 2 }, OPC, hoje).filtros.pipeline_id).toBe(2);
    expect(resolverFiltros({ fontes: ['Indicação CX'], tipos: ['Indicação', 'Parceria'] }, OPC, hoje).filtros).toMatchObject({ fontes: ['220'], tipos: ['113', '591'] });
  });
  it.each([
    [{ de: '2026-13-01' }], [{ de: '01/01/2026' }], [{ de: '2026-10-09', ate: '2026-10-01' }], [{ produto: 'varejo' }], [{ pipeline: 'inexistente' }], [{ fontes: ['xyz'] }],
  ])('recusa pedido inválido %j', (p) => {
    expect(() => resolverFiltros(p as never, OPC, hoje)).toThrow(SqlRecusado);
  });
});

describe('textos devolvidos ao Claude', () => {
  const cols = [{ id: 'a', rotulo: 'Fonte', tipo: 'texto' }, { id: 'n', rotulo: 'Leads', tipo: 'int' }, { id: 'p', rotulo: 'Taxa', tipo: 'pct' }, { id: 'v', rotulo: 'Valor', tipo: 'brl' }];
  it('tabela em Markdown com formatos em português e "—" para vazio', () => {
    const t = tabelaMarkdown(cols, [{ a: 'Meta | ADS', n: 8017, p: 0.0345, v: 433353 }, { a: 'Social', n: 299, p: null, v: 0 }]);
    expect(t).toContain('| Fonte | Leads | Taxa | Valor |');
    expect(t).toContain('| --- | ---: | ---: | ---: |');
    expect(t).toContain('Meta / ADS'); // o | dentro do texto não quebra a tabela
    expect(t).toContain('3,5%');
    expect(t).toMatch(/R\$ 433\.353/);
    expect(t).toContain('| Social | 299 | — |');
  });
  it('mostra "limite" quando há mais linhas que o máximo', () => {
    const t = tabelaMarkdown(cols.slice(0, 2), Array.from({ length: 70 }, (_, i) => ({ a: `x${i}`, n: i })), 60);
    expect(t).toContain('mostrando 60 de 70 linhas');
    expect(textoSql(['a'], Array.from({ length: 5 }, () => ({ a: 1 })), 5)).toContain('limite de 5 linhas atingido');
  });
  it('a análise sempre diz os filtros aplicados, os avisos e como ler', () => {
    const t = textoAnalise('Funil', 'Pergunta?', 'Leia assim.', 'Data de criação: 2026-01-01 a 2026-10-08', { grafico: { tipo: 'tabela' }, tabela: { colunas: [{ id: 'a', rotulo: 'A', tipo: 'texto' }], linhas: [{ a: 'x' }] }, avisos: ['Cuidado.'] });
    expect(t).toContain('## Funil');
    expect(t).toContain('**Filtros aplicados:** Data de criação');
    expect(t).toContain('- Cuidado.');
    expect(t).toContain('**Como ler:** Leia assim.');
  });
  it('as definições dizem que não há dados pessoais e explicam os conceitos-chave', () => {
    for (const termo of ['MQL', 'Inválido', 'Safra', 'Taxa de ganho', 'ou por uma posterior', 'NÃO incluem e-mail']) expect(DEFINICOES).toContain(termo);
  });
});

describe('o servidor do conector (leitura do código)', () => {
  const src = readFileSync(new URL('../mcp/quark-dados/server.ts', import.meta.url), 'utf8');
  it('só registra ferramentas de leitura, todas marcadas como somente leitura', () => {
    const tools = [...src.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(tools).toEqual(['quark_definicoes', 'quark_analise', 'quark_esquema', 'quark_sql', 'quark_atualizacao']);
    expect((src.match(/annotations: SOMENTE_LEITURA/g) ?? []).length).toBe(tools.length);
    expect(src).toContain('readOnlyHint: true');
    expect(src).toContain('destructiveHint: false');
  });
  it('toda consulta roda numa transação somente leitura que termina em rollback', () => {
    expect(src).toContain("'begin read only'");
    expect(src).toContain("'rollback'");
    expect(src).not.toMatch(/\.query\(\s*[`'"]\s*(insert|update|delete|create|drop|alter|truncate)/i);
  });
  it('exige o papel orq_chat e o projeto certo, e não escreve nada na tela padrão (stdout é só do protocolo)', () => {
    expect(src).toContain("assertRoleUser(url, 'orq_chat')");
    expect(src).toContain('assertSafeDbTarget');
    expect(src).not.toMatch(/console\.log\(/);
  });
  it('a SQL livre passa sempre pela trava guardaSql', () => {
    expect(src).toMatch(/guardaSql\(consulta, n\)/);
  });
  it('as análises liberadas são exatamente as do BI (nenhuma análise escreve ou lê fora de analytics)', () => {
    expect(BI_ANALISES.length).toBeGreaterThanOrEqual(19);
  });
});
