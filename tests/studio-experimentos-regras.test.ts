import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CAMPOS, avaliar, camposUsados, criarMedidor, lerCampos, validarRegras, somaCampo, type CamposDia, type Regra, type Token } from '../studio/lib/experimentos-regras';
import { PgExperimentosRepo, METRICAS_EXP, validarEntrada, type DadosExp } from '../studio/lib/experimentos';
import { ZERO, type CanalId, type DadosMonitor, type Soma } from '../studio/lib/monitor';

const METRICAS = new Set(METRICAS_EXP.map((m) => m.id));
const num = (v: number): Token => ({ k: 'num', v });
const op = (v: '+' | '-' | '*' | '/'): Token => ({ k: 'op', v });
const campo = (v: string): Token => ({ k: 'campo', v });
const metrica = (v: string): Token => ({ k: 'metrica', v });
const escCompleto = { identificadorConversao: 'diag', paginaCaminho: '/diagnostico', paginaHost: 'quarkrh.com.br', campanhas: [{ id: '120219876543210987', nome: null }] };
const dia = (...d: Array<[string, number]>) => new Map<string, number>(d);

describe('Contabilização manual: contas', () => {
  const v = (t: Token) => (t.k === 'num' ? t.v : null);
  it('× e ÷ antes de + e −, da esquerda para a direita', () => {
    expect(avaliar([num(2), op('+'), num(3), op('*'), num(4)], v)).toBe(14);
    expect(avaliar([num(10), op('-'), num(6), op('/'), num(3)], v)).toBe(8);
    expect(avaliar([num(100), op('/'), num(4), op('/'), num(5)], v)).toBe(5);
    expect(avaliar([num(8)], v)).toBe(8);
    expect(avaliar([num(1), op('-'), num(2), op('-'), num(3)], v)).toBe(-4);
  });
  it('divisão por zero e termo sem valor dão nulo, nunca zero inventado', () => {
    expect(avaliar([num(5), op('/'), num(0)], v)).toBeNull();
    expect(avaliar([num(5), op('+'), campo('x')], v)).toBeNull();
    expect(avaliar([num(0), op('/'), num(0), op('+'), num(1)], v)).toBeNull();
  });
  it('soma o campo só dentro da janela', () => {
    const campos: CamposDia = new Map([['identificador.leads', dia(['2026-10-01', 3], ['2026-10-02', 4], ['2026-10-09', 100])]]);
    expect(somaCampo(campos, 'identificador.leads', { de: '2026-10-01', ate: '2026-10-05', dias: 5 })).toBe(7);
    expect(somaCampo(campos, 'inexistente', { de: '2026-10-01', ate: '2026-10-05', dias: 5 })).toBe(0);
  });
  it('o caso do Pablo: Leads = leads do identificador e CPL = investimento ÷ Leads', () => {
    const regras: Regra[] = [{ metrica: 'leads', formula: [campo('identificador.leads')] }, { metrica: 'cpl', formula: [campo('campanhas.invest'), op('/'), metrica('leads')] }];
    const campos: CamposDia = new Map([['identificador.leads', dia(['2026-10-01', 60], ['2026-10-02', 50])], ['campanhas.invest', dia(['2026-10-01', 1200], ['2026-10-02', 1311])]]);
    const medir = criarMedidor(regras, campos, () => 999);
    const j = { de: '2026-10-01', ate: '2026-10-02', dias: 2 };
    expect(medir('leads', j)).toBe(110);
    expect(medir('cpl', j)).toBeCloseTo(2511 / 110, 6); // total ÷ total
    expect(medir('mql', j)).toBeUndefined(); // sem regra: vale o automático
    expect(medir('cpl', { de: '2026-09-01', ate: '2026-09-02', dias: 2 })).toBeNull(); // sem leads no período: sem resultado
  });
  it('uma regra que cita métrica sem regra usa o cálculo automático dela', () => {
    const medir = criarMedidor([{ metrica: 'cpl', formula: [num(1000), op('/'), metrica('mql')] }], new Map(), (m) => (m === 'mql' ? 50 : null));
    expect(medir('cpl', { de: '2026-10-01', ate: '2026-10-02', dias: 2 })).toBe(20);
  });
  it('lista os campos usados, sem repetir', () => {
    expect(camposUsados([{ metrica: 'leads', formula: [campo('a.b'), op('+'), campo('a.b')] }, { metrica: 'cpl', formula: [campo('c.d')] }])).toEqual(['a.b', 'c.d']);
  });
});

describe('Contabilização manual: validação das regras', () => {
  it('aceita regras válidas e devolve só a estrutura conhecida', () => {
    const r = validarRegras([{ metrica: 'cpl', formula: [{ k: 'campo', v: 'campanhas.invest', lixo: 1 }, { k: 'op', v: '/' }, { k: 'metrica', v: 'leads' }] }], METRICAS, escCompleto);
    expect(r).toEqual([{ metrica: 'cpl', formula: [campo('campanhas.invest'), op('/'), metrica('leads')] }]);
    expect(validarRegras(null, METRICAS, escCompleto)).toEqual([]);
  });
  it('recusa métrica, campo, operação e número inválidos; fórmula que não alterna termo e operação', () => {
    const ruim = (regras: unknown, msg: RegExp) => expect(() => validarRegras(regras, METRICAS, escCompleto)).toThrow(msg);
    ruim([{ metrica: 'inventada', formula: [num(1)] }], /métrica inválida/);
    ruim([{ metrica: 'leads', formula: [campo('inventado.x')] }], /campo inválido/);
    ruim([{ metrica: 'leads', formula: [num(1), op('+')] }], /alternar termo e operação/);
    ruim([{ metrica: 'leads', formula: [] }], /alternar termo e operação/);
    ruim([{ metrica: 'leads', formula: [num(1), { k: 'op', v: '^' }, num(2)] }], /operação inválida/);
    ruim([{ metrica: 'leads', formula: [{ k: 'num', v: 'x' }] }], /número inválido/);
    ruim([{ metrica: 'leads', formula: [{ k: 'metrica', v: 'nao-existe' }] }], /métrica inválida/);
    ruim([{ metrica: 'leads', formula: [num(1)] }, { metrica: 'leads', formula: [num(2)] }], /mais de uma regra/);
    ruim('texto', /lista de até/);
    ruim(Array.from({ length: 21 }, () => ({ metrica: 'leads', formula: [num(1)] })), /lista de até/);
  });
  it('recusa regras que se referem uma à outra', () => {
    expect(() => validarRegras([{ metrica: 'leads', formula: [metrica('leads')] }], METRICAS, escCompleto)).toThrow(/se referem/);
    expect(() => validarRegras([{ metrica: 'leads', formula: [metrica('cpl')] }, { metrica: 'cpl', formula: [metrica('leads')] }], METRICAS, escCompleto)).toThrow(/leads → cpl → leads|cpl → leads → cpl/);
  });
  it('o campo só vale se o item do escopo existe', () => {
    expect(() => validarRegras([{ metrica: 'leads', formula: [campo('identificador.leads')] }], METRICAS, { campanhas: [] })).toThrow(/exige o identificador de conversão/);
    expect(() => validarRegras([{ metrica: 'cpl', formula: [campo('campanhas.invest')] }], METRICAS, { identificadorConversao: 'diag', campanhas: [] })).toThrow(/exige as campanhas/);
    expect(validarRegras([{ metrica: 'leads', formula: [campo('escopo.leads')] }], METRICAS, { paginaCaminho: '/x', campanhas: [] })).toHaveLength(1);
  });
  it('no cadastro: regras e contabilização são validadas; tirar um item do escopo que uma regra usa é recusado', () => {
    const base = { titulo: 'x', identificadorConversao: 'diag', campanhas: ['Diag (120219876543210987)'] };
    const regras = [{ metrica: 'leads', formula: [campo('identificador.leads')] }];
    expect(validarEntrada({ ...base, contabilizacao: 'manual', regras }, 'criar')).toMatchObject({ contabilizacao: 'manual', regras });
    expect(() => validarEntrada({ ...base, contabilizacao: 'talvez' }, 'criar')).toThrow(/contabilização inválida/);
    expect(() => validarEntrada({ titulo: 'x', regras }, 'criar')).toThrow(/exige o identificador/);
    const atual = { produto: 'rh' as const, canal: 'meta' as const, metrica: null, meta: null, inicio: null, fim: null, identificadorConversao: 'diag', campanhas: [], regras: regras as Regra[] };
    expect(() => validarEntrada({ identificadorConversao: null }, 'editar', atual)).toThrow(/saiu do escopo/);
    expect(validarEntrada({ titulo: 'novo nome' }, 'editar', atual)).toEqual({ titulo: 'novo nome' });
  });
  it('o catálogo de campos tem rótulo, grupo e formato, sem repetição', () => {
    expect(new Set(CAMPOS.map((c) => c.id)).size).toBe(CAMPOS.length);
    for (const c of CAMPOS) { expect(c.rotulo.length).toBeGreaterThan(3); expect(['int', 'brl']).toContain(c.formato); expect(c.id.startsWith(`${c.origem}.`)).toBe(true); }
  });
});

describe('Contabilização manual: leitura dos campos e repositório', () => {
  const esc = { produto: 'rh' as const, paginaHost: 'quarkrh.com.br', paginaCaminho: '/diagnostico', campanhas: [{ id: '120219876543210987', nome: null }], identificadorConversao: "x'); drop table crm.deals; --", escopoModo: 'todos' as const };
  it('lê só os campos pedidos, cada origem com o seu critério, SQL parametrizado e só visões de analytics', async () => {
    const sqls: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: async (sql: string, params: unknown[] = []) => {
      sqls.push({ sql: sql.replace(/\s+/g, ' '), params });
      if (/count\(\*\)::int as negocios/.test(sql)) return { rows: [{ dia: '2026-10-02', negocios: 5, leads: 4, mql: 2 }] };
      if (/meta_desempenho_dia/.test(sql)) return { rows: [{ dia: '2026-10-02', gasto: 120, impressoes: 900, cliques: 30, leads_meta: 6 }] };
      return { rows: [] };
    } } as never;
    const c = await lerCampos(db, esc, ['identificador.leads', 'campanhas.invest'], '2026-09-01');
    expect(c.get('identificador.leads')!.get('2026-10-02')).toBe(4);
    expect(c.get('campanhas.invest')!.get('2026-10-02')).toBe(120);
    expect(c.has('campanhas.cliques')).toBe(false); // só o que as regras usam
    const negocios = sqls.find((s) => s.sql.includes('negocios_bi'))!;
    expect(negocios.sql).toContain('conversoes_pipe_negocios'); // a origem "identificador" filtra só pelo identificador
    expect(negocios.sql).not.toContain('negocios_meta');
    expect(negocios.sql).not.toContain('negocios_url');
    expect(negocios.params).toEqual(['2026-09-01', 'rh', "x'); drop table crm.deals; --"]);
    expect(sqls.map((s) => s.sql).join(' ')).not.toMatch(/\b(crm|mkt|raw|orq)\./);
  });
  it('o arquivo das regras só consulta visões de analytics', () => {
    const fonte = readFileSync(new URL('../studio/lib/experimentos-regras.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(fonte).not.toMatch(/\b(from|join)\s+(crm|mkt|raw|orq)\./);
  });

  const soma = (o: Partial<Soma>): Soma => ({ ...ZERO, ...o });
  it('o repositório aplica as regras: progresso, relatório e linhas do funil seguem a contabilização manual', async () => {
    const meta = new Map<string, Soma>();
    for (let k = 1; k <= 10; k++) meta.set(`2026-10-${String(k).padStart(2, '0')}`, soma({ leads: 2, invest: 100 })); // o automático diria 2 leads por dia
    const dadosEscopo = (): DadosMonitor => ({ diario: { google: new Map(), meta, social: new Map(), organico: new Map() } as Record<CanalId, Map<string, Soma>>, ontemMesmaHora: { google: ZERO, meta: ZERO, social: ZERO, organico: ZERO }, hora: '10:00', trafegoAte: null });
    const campos: CamposDia = new Map([['identificador.leads', dia(...Array.from({ length: 10 }, (_, k): [string, number] => [`2026-10-${String(k + 1).padStart(2, '0')}`, 11]))], ['campanhas.invest', dia(...Array.from({ length: 10 }, (_, k): [string, number] => [`2026-10-${String(k + 1).padStart(2, '0')}`, 250]))]]);
    const regras: Regra[] = [{ metrica: 'leads', formula: [campo('identificador.leads')] }, { metrica: 'cpl', formula: [campo('campanhas.invest'), op('/'), metrica('leads')] }];
    const linha = { id: 5, titulo: 'T', tipo: 'experimento', produto: 'rh', canal: 'meta', metrica: 'cpl', meta: 20, inicio: '2026-10-01', fim: '2026-10-30', status: 'rodando', identificador_conversao: 'diag', contabilizacao: 'manual', regras, criado_em: new Date(), atualizado_em: new Date() };
    const db = { query: async (sql: string) => ({ rows: /from mkt\.experimentos/.test(sql) ? [linha] : [{ documentacao: null }] }) } as never;
    const lidos: string[][] = [];
    const repo = new PgExperimentosRepo(db, () => new Date('2026-10-11T15:00:00Z'), async () => dadosEscopo(), async () => dadosEscopo(), async () => null as never, async (_d, _e, ids) => { lidos.push([...ids]); return campos; });
    const l = await repo.listar();
    expect(lidos).toEqual([['identificador.leads', 'campanhas.invest']]);
    expect(l.experimentos[0]!.progresso.atual).toBeCloseTo(2500 / 110, 6); // investimento ÷ leads pelas regras (o automático daria 100 ÷ 2 = 50)
    expect(l.campos.length).toBe(CAMPOS.length);
    const r = await repo.relatorio(5);
    expect(r.relatorio.geral).toMatchObject({ leads: 110, valor: expect.closeTo(2500 / 110, 6) });
    expect(r.relatorio.diario[0]).toMatchObject({ leads: 11, cpl: expect.closeTo(250 / 11, 6) });
    // automática: as mesmas linhas, sem regra
    const auto = new PgExperimentosRepo({ query: async (sql: string) => ({ rows: /from mkt\.experimentos/.test(sql) ? [{ ...linha, contabilizacao: 'automatica' }] : [] }) } as never, () => new Date('2026-10-11T15:00:00Z'), async () => dadosEscopo(), async () => dadosEscopo());
    expect((await auto.listar()).experimentos[0]!.progresso.atual).toBe(50);
  });
  it('o tipo DadosExp aceita dados sem medidor (automático)', () => {
    const d: DadosExp = { diario: { google: new Map(), meta: new Map(), social: new Map(), organico: new Map() } };
    expect(d.medir).toBeUndefined();
  });
});
