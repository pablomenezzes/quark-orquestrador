import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { filtroTexto, lerDadosEscopo, lerDetalheEscopo, listarOpcoes, listarValoresCampo, normalizarFiltros, temEscopo, type Escopo } from '../studio/lib/experimentos-escopo';
import { lerCampos, origemDisponivel, validarRegras } from '../studio/lib/experimentos-regras';
import { PgExperimentosRepo, METRICAS_EXP, rotuloEscopo, validarEntrada } from '../studio/lib/experimentos';

const esc: Escopo & { produto: 'rh' } = { produto: 'rh', paginaHost: null, paginaCaminho: null, campanhas: [], identificadorConversao: null, escopoModo: 'todos', filtros: [], filtrosModo: 'todos' };
const sqlDe = () => { const sqls: Array<{ sql: string; params: unknown[] }> = []; const db = { query: async (sql: string, params: unknown[] = []) => { sqls.push({ sql: sql.replace(/\s+/g, ' '), params }); return { rows: [] }; } } as never; return { sqls, db }; };

describe('Filtros por campo do Pipedrive: cadastro', () => {
  it('normaliza: campo, operador e valor; tira repetidos; valor some em preenchido e vazio', () => {
    expect(normalizarFiltros([
      { campo: ' URL de Conversão ', operador: 'contem', valor: ' quarkrh-diagnostico ' },
      { campo: 'url de conversão', operador: 'contem', valor: 'QUARKRH-DIAGNOSTICO' },
      { campo: 'UTM Campaign', operador: 'vazio', valor: 'ignorado' },
    ])).toEqual([{ campo: 'URL de Conversão', operador: 'contem', valor: 'quarkrh-diagnostico' }, { campo: 'UTM Campaign', operador: 'vazio', valor: '' }]);
    expect(normalizarFiltros([])).toEqual([]);
  });
  it('recusa campo vazio, operador desconhecido, valor faltando ou grande demais, e mais de 10', () => {
    for (const ruim of [[{ campo: '', operador: 'igual', valor: 'x' }], [{ campo: 'a', operador: 'regex', valor: 'x' }], [{ campo: 'a', operador: 'igual', valor: '' }], [{ campo: 'a', operador: 'igual', valor: 'x'.repeat(301) }],
      [{ campo: 'c'.repeat(101), operador: 'igual', valor: 'x' }], 'texto', [5], Array.from({ length: 11 }, (_, i) => ({ campo: `c${i}`, operador: 'igual', valor: 'x' }))]) expect(normalizarFiltros(ruim), JSON.stringify(ruim)).toBeNull();
  });
  it('o cadastro aceita os filtros e o modo; recusa filtro inválido', () => {
    const v = validarEntrada({ titulo: 'x', filtros: [{ campo: 'UTM Campaign', operador: 'contem', valor: '[Growth][77]' }], filtrosModo: 'qualquer' }, 'criar');
    expect(v).toMatchObject({ filtros: [{ campo: 'UTM Campaign', operador: 'contem', valor: '[Growth][77]' }], filtrosModo: 'qualquer' });
    expect(() => validarEntrada({ titulo: 'x', filtros: [{ campo: '', operador: 'igual', valor: 'x' }] }, 'criar')).toThrow(/filtros inválidos/);
    expect(() => validarEntrada({ titulo: 'x', filtrosModo: 'talvez' }, 'criar')).toThrow(/filtrosModo/);
    expect(validarEntrada({ filtros: null }, 'editar')).toEqual({ filtros: [] });
  });
  it('filtro conta como escopo; custo (CPL) continua exigindo campanha', () => {
    expect(temEscopo({ filtros: [{ campo: 'a', operador: 'vazio', valor: '' }] })).toBe(true);
    expect(() => validarEntrada({ titulo: 'x', metrica: 'cpl', meta: 30, filtros: [{ campo: 'UTM Campaign', operador: 'contem', valor: 'x' }] }, 'criar')).toThrow(/só existe com uma campanha/);
    expect(validarEntrada({ titulo: 'x', metrica: 'leads', meta: 30, filtros: [{ campo: 'UTM Campaign', operador: 'contem', valor: 'x' }] }, 'criar').metrica).toBe('leads');
  });
  it('o rótulo mostra o campo, o operador e o valor, e como os filtros se juntam', () => {
    expect(filtroTexto({ campo: 'URL de Conversão', operador: 'contem', valor: 'diag' })).toBe('URL de Conversão contém "diag"');
    expect(filtroTexto({ campo: 'UTM Term', operador: 'vazio', valor: '' })).toBe('UTM Term está vazio');
    const r = rotuloEscopo({ paginaHost: null, paginaCaminho: null, campanhas: [], identificadorConversao: null, filtrosModo: 'qualquer', filtros: [{ campo: 'UTM Content', operador: 'igual', valor: 'AD1' }, { campo: 'UTM Term', operador: 'preenchido', valor: '' }] });
    expect(r).toEqual(['Filtros do Pipedrive (qualquer um): UTM Content é igual a "AD1"; UTM Term está preenchido']);
  });
});

describe('Filtros por campo do Pipedrive: leitura', () => {
  it('cada operador vira uma condição sobre analytics.deal_campos, com campo e valor como parâmetros', async () => {
    const { sqls, db } = sqlDe();
    await lerDadosEscopo(db, { ...esc, filtros: [
      { campo: 'URL de Conversão', operador: 'contem', valor: "x'); drop table crm.deals; --" }, { campo: 'UTM Campaign', operador: 'igual', valor: 'A' }, { campo: 'UTM Content', operador: 'comeca', valor: 'B' },
      { campo: 'UTM Term', operador: 'termina', valor: 'C' }, { campo: 'Fonte do Lead', operador: 'preenchido', valor: '' }, { campo: 'Cargo (Negócio)', operador: 'vazio', valor: '' },
    ] }, '10:00', '2026-09-01');
    const s = sqls[0]!;
    expect(s.sql).not.toContain('drop table');
    expect(s.params).toEqual(['2026-09-01', 'rh', 'URL de Conversão', "x'); drop table crm.deals; --", 'UTM Campaign', 'A', 'UTM Content', 'B', 'UTM Term', 'C', 'Fonte do Lead', 'Cargo (Negócio)']);
    expect(s.sql).toContain("position(lower($4::text) in lower(coalesce(c.valor_legivel, c.valor #>> '{}'))) > 0");
    expect(s.sql).toContain("= lower($6::text)");
    expect(s.sql).toContain("starts_with(lower(coalesce(c.valor_legivel, c.valor #>> '{}')), lower($8::text))");
    expect(s.sql).toContain("right(lower(coalesce(c.valor_legivel, c.valor #>> '{}')), length(lower($10::text))) = lower($10::text)");
    expect(s.sql).toMatch(/not exists \(select c\.deal_id from analytics\.deal_campos c where lower\(c\.nome_pipedrive\) = lower\(\$12::text\) and c\.deal_id = d\.deal_id/);
    expect(s.sql).not.toMatch(/\b(crm|mkt|raw|orq)\./);
  });
  it('os filtros se juntam em E (todos) ou OU (qualquer)', async () => {
    const f = [{ campo: 'A', operador: 'igual' as const, valor: '1' }, { campo: 'B', operador: 'igual' as const, valor: '2' }];
    const e = sqlDe(); await lerDadosEscopo(e.db, { ...esc, filtros: f, filtrosModo: 'todos' }, '10:00', '2026-09-01');
    const ou = sqlDe(); await lerDadosEscopo(ou.db, { ...esc, filtros: f, filtrosModo: 'qualquer' }, '10:00', '2026-09-01');
    expect(e.sqls[0]!.sql).toMatch(/\(d\.deal_id in \(.*\) and d\.deal_id in \(.*\)\)/);
    expect(ou.sqls[0]!.sql).toMatch(/\(d\.deal_id in \(.*\) or d\.deal_id in \(.*\)\)/);
  });
  it('no modo "campanha só para o investimento", os filtros definem os negócios e a campanha só traz a mídia', async () => {
    const { sqls, db } = sqlDe();
    await lerDadosEscopo(db, { ...esc, escopoModo: 'campanha_so_investimento', campanhas: [{ id: '120219876543210987', nome: null }], filtros: [{ campo: 'UTM Campaign', operador: 'contem', valor: '77' }] }, '10:00', '2026-09-01');
    expect(sqls[0]!.sql).not.toContain('negocios_meta');
    expect(sqls[0]!.sql).toContain('analytics.deal_campos');
    expect(sqls.find((x) => x.sql.includes('meta_desempenho_dia'))!.params).toEqual(['2026-09-01', ['120219876543210987']]);
  });
  it('o detalhe traz a contagem dos filtros sozinhos na conferência', async () => {
    const db = { query: async (sql: string) => ({ rows: /^select count\(\*\)::int as n from analytics\.negocios_bi d where/.test(sql.trim()) ? [{ n: 77 }] : [] }) } as never;
    const d = await lerDetalheEscopo(db, { ...esc, filtros: [{ campo: 'UTM Campaign', operador: 'contem', valor: 'x' }] }, '2026-10-01', '2026-10-10');
    expect(d.conferencia.porFiltros).toBe(77);
    expect(d.conferencia.porIdentificador).toBeNull();
    const sem = await lerDetalheEscopo(db, esc, '2026-10-01', '2026-10-10');
    expect(sem.conferencia.porFiltros).toBeNull();
  });
  it('lista os campos do Pipedrive e os valores mais comuns de um campo, parametrizado', async () => {
    const sqls: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: async (sql: string, params: unknown[] = []) => {
      sqls.push({ sql: sql.replace(/\s+/g, ' '), params });
      if (/group by 1 order by n desc, v/.test(sql)) return { rows: [{ v: 'AD1', n: 901 }, { v: null, n: 3 }] };
      if (/from analytics\.campos where entity = 'deal'/.test(sql)) return { rows: [{ nome: 'UTM Term' }] };
      return { rows: [] };
    } } as never;
    expect((await listarOpcoes(db, 'rh')).camposPipe).toEqual([{ nome: 'UTM Term' }]); // do catálogo de campos, sem contar valores (contar levava 11 s)
    expect(sqls.some((x) => x.sql.includes('analytics.deal_campos') && x.sql.includes('count(distinct c.deal_id)') && !x.sql.includes('group by 1 order by n desc, v'))).toBe(false);
    expect(await listarValoresCampo(db, 'UTM Term', 'rh', "a'b")).toEqual([{ valor: 'AD1', negocios: 901 }]);
    const v = sqls.find((x) => x.sql.includes('order by n desc, v'))!;
    expect(v.params).toEqual(['UTM Term', 'rh', "a'b"]);
    expect(v.sql).not.toContain("a'b");
    expect(sqls.map((x) => x.sql).join(' ')).not.toMatch(/\b(crm|mkt|raw|orq)\./);
  });
  it('o repositório valida o pedido de valores', async () => {
    const repo = new PgExperimentosRepo({ query: async () => ({ rows: [] }) } as never);
    await expect(repo.valores('', 'rh')).rejects.toThrow(/campo inválido/);
    await expect(repo.valores('UTM Term', 'outro')).rejects.toThrow(/produto/);
    expect(await repo.valores('UTM Term', 'rh')).toEqual([]);
  });
});

describe('Filtros por campo do Pipedrive: contabilização manual', () => {
  it('"filtros" é uma origem dos campos das regras e só vale com filtro no escopo', () => {
    const met = new Set(METRICAS_EXP.map((m) => m.id));
    const regras = [{ metrica: 'leads', formula: [{ k: 'campo', v: 'filtros.leads' }] }];
    expect(() => validarRegras(regras, met, { campanhas: [] })).toThrow(/exige ao menos um filtro/);
    expect(validarRegras(regras, met, { campanhas: [], filtros: [{ campo: 'a', operador: 'vazio', valor: '' }] })).toHaveLength(1);
    expect(origemDisponivel('filtros', {})).toBe(false);
    expect(origemDisponivel('escopo', { filtros: [{ campo: 'a', operador: 'vazio', valor: '' }] })).toBe(true);
  });
  it('o campo "do filtro" conta só pelos filtros, sem os outros critérios do escopo', async () => {
    const { sqls, db } = sqlDe();
    await lerCampos(db, { ...esc, identificadorConversao: 'diag', campanhas: [{ id: '120219876543210987', nome: null }], filtros: [{ campo: 'URL de Conversão', operador: 'contem', valor: 'diag' }] }, ['filtros.leads'], '2026-09-01');
    const negocios = sqls.find((x) => x.sql.includes('negocios_bi'))!;
    expect(negocios.sql).toContain('analytics.deal_campos');
    expect(negocios.sql).not.toContain('conversoes_pipe_negocios');
    expect(negocios.sql).not.toContain('negocios_meta');
    expect(negocios.params).toEqual(['2026-09-01', 'rh', 'URL de Conversão', 'diag']);
  });
});

describe('Filtros por campo do Pipedrive: tela e planilha', () => {
  it('a ficha tem atalhos para URL de Conversão e UTMs, escolha do campo e como juntar os filtros', () => {
    const js = readFileSync(new URL('../studio/public/experimentos.js', import.meta.url), 'utf8');
    for (const t of ['URL de Conversão', 'UTM Campaign', 'UTM Content', 'UTM Term', 'dl-campos-pipe', '/api/experimentos/valores', 'f-filtros-modo']) expect(js).toContain(t);
    expect(readFileSync(new URL('../studio/public/experimentos-doc.js', import.meta.url), 'utf8')).toContain('Filtros por campo do Pipedrive, sozinhos');
  });
});
