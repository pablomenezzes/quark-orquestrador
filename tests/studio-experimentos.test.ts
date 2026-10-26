import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createStudioServer } from '../studio/server';
import { PainelInvalido, PainelNotFound } from '../studio/lib/painel-repo';
import { somaDias, ZERO, type CanalId, type DadosMonitor, type Soma } from '../studio/lib/monitor';
import { lerDadosEscopo, lerDetalheEscopo, normalizarCampanha, normalizarCampanhas, normalizarPagina } from '../studio/lib/experimentos-escopo';
import { acompanhavel, calcularProgresso, calibracaoPor, desfechoDe, documentacaoValida, METRICAS_EXP, montarRelatorio, PgExperimentosRepo, rotuloEscopo, validarEntrada, valorMetrica, type Experimento, type ExperimentosRepo } from '../studio/lib/experimentos';

const soma = (o: Partial<Soma>): Soma => ({ ...ZERO, ...o });
const vazio = (): Record<CanalId, Map<string, Soma>> => ({ google: new Map(), meta: new Map(), social: new Map(), organico: new Map() });
const dias = (de: string, ate: string) => { const o: string[] = []; for (let d = de; d <= ate; d = somaDias(d, 1)) o.push(d); return o; };
/** Meta Ads com o mesmo dia repetido em todo o intervalo. */
const meta = (d: Record<CanalId, Map<string, Soma>>, de: string, ate: string, s: Partial<Soma>) => { for (const dia of dias(de, ate)) d.meta.set(dia, soma(s)); };

const base = { canal: 'meta', metrica: 'leads', meta: 300, linhaBase: null, investimento: null, inicio: '2026-10-01', fim: '2026-10-30', status: 'rodando' } as const;
const HOJE = '2026-10-11'; // dias completos: 01 a 10 (10 de 30 dias)

describe('Experimentos: cadastro validado', () => {
  const ok = { titulo: 'Diagnóstico', produto: 'rh', metrica: 'cpl', meta: 50, inicio: '2026-10-01', fim: '2026-10-30' };
  it('aceita um cadastro mínimo e só devolve campos válidos', () => {
    expect(validarEntrada({ ...ok, canal: 'meta', iceImpacto: 8 }, 'criar')).toMatchObject({ titulo: 'Diagnóstico', canal: 'meta', iceImpacto: 8 });
  });
  it('exige só o título: o resto (inclusive a métrica chave) pode vir depois', () => {
    expect(validarEntrada({ titulo: 'Ideia solta' }, 'criar')).toEqual({ titulo: 'Ideia solta' });
    expect(() => validarEntrada({}, 'criar')).toThrow(/falta titulo/);
  });
  it('rejeita valores fora do catálogo', () => {
    expect(() => validarEntrada({ ...ok, metrica: 'inventada' }, 'criar')).toThrow(/métrica inválida/);
    expect(() => validarEntrada({ ...ok, produto: 'outro' }, 'criar')).toThrow(/produto/);
    expect(() => validarEntrada({ ...ok, canal: 'tv' }, 'criar')).toThrow(/canal inválido/);
    expect(() => validarEntrada({ ...ok, iceImpacto: 11 }, 'criar')).toThrow(/1 a 10/);
    expect(() => validarEntrada({ ...ok, investimento: -5 }, 'criar')).toThrow(/negativo/);
    expect(() => validarEntrada({ ...ok, inicio: '2026-02-30' }, 'criar')).toThrow(/início/);
    expect(() => validarEntrada({ ...ok, tipo: 'outro' }, 'criar')).toThrow(/tipo inválido/);
    expect(() => validarEntrada({ ...ok, avaliacao: 'talvez' }, 'criar')).toThrow(/avaliação inválida/);
    expect(() => validarEntrada({ ...ok, status: 'pausado' }, 'criar')).toThrow(/status inválido/);
    expect(() => validarEntrada({ ...ok, fim: '2026-09-01' }, 'criar')).toThrow(/antes do início/);
    expect(() => validarEntrada({ ...ok, meta: '50' }, 'criar')).toThrow(/número/);
  });
  it('custo exige canal com verba: Social e Orgânico não têm investimento', () => {
    expect(() => validarEntrada({ ...ok, canal: 'social' }, 'criar')).toThrow(/depende de investimento/);
    expect(validarEntrada({ ...ok, canal: 'social', metrica: 'leads' }, 'criar').canal).toBe('social');
    // na edição vale o conjunto: trocar só o canal de um experimento de CPL também é recusado
    expect(() => validarEntrada({ canal: 'organico' }, 'editar', { produto: 'rh', canal: 'meta', metrica: 'cpl', meta: 50, inicio: '2026-10-01', fim: '2026-10-30' })).toThrow(/depende de investimento/);
  });
  it('na edição, o fim é conferido contra o início que já existe', () => {
    expect(() => validarEntrada({ fim: '2026-09-15' }, 'editar', { produto: 'rh', canal: 'meta', metrica: 'cpl', meta: 50, inicio: '2026-10-01', fim: '2026-10-30' })).toThrow(/antes do início/);
  });
  it('métrica chave e meta andam juntas; limpar a métrica limpa a meta', () => {
    expect(() => validarEntrada({ titulo: 'x', metrica: 'cpl' }, 'criar')).toThrow(/informe a meta/);
    expect(() => validarEntrada({ titulo: 'x', meta: 3 }, 'criar')).toThrow(/escolha a métrica/);
    expect(validarEntrada({ metrica: null }, 'editar', { produto: 'rh', canal: 'meta', metrica: 'cpl', meta: 50, inicio: null, fim: null })).toMatchObject({ metrica: null, meta: null, linhaBase: null });
  });
  it('aceita os campos de documentação do experimento', () => {
    const v = validarEntrada({ titulo: 'x', tipo: 'ideia', responsavel: ' Dimitri ', areaImpacto: 'CRO', resultadoEsperado: 'Mais leads', avaliacao: 'sucesso', evidencias: 'link', status: 'bloqueado', inicio: null, fim: null }, 'criar');
    expect(v).toMatchObject({ tipo: 'ideia', responsavel: 'Dimitri', areaImpacto: 'CRO', resultadoEsperado: 'Mais leads', avaliacao: 'sucesso', status: 'bloqueado', inicio: null, fim: null });
  });
  it('todas as métricas do catálogo têm rótulo, formato e direção', () => {
    for (const m of METRICAS_EXP) { expect(m.rotulo.length).toBeGreaterThan(1); expect(['int', 'brl', 'brl2', 'pct']).toContain(m.formato); expect(['subir', 'descer']).toContain(m.melhor); }
    expect(new Set(METRICAS_EXP.map((m) => m.id)).size).toBe(METRICAS_EXP.length);
  });
});

describe('Experimentos: acompanhamento automático (métrica de contagem)', () => {
  const d = vazio();
  meta(d, '2026-09-01', '2026-09-30', { leads: 6, invest: 300 }); // período anterior: 180 leads
  meta(d, '2026-10-01', '2026-10-10', { leads: 8, invest: 400 }); // 10 dias completos: 80 leads, R$ 4.000
  it('usa só dias completos (até ontem) e a linha de base automática do mesmo número de dias antes', () => {
    const p = calcularProgresso({ ...base, investimento: 9000 }, { diario: d }, HOJE);
    expect(p.dadosAte).toBe('2026-10-10');
    expect(p.diasCompletos).toBe(10);
    expect(p.totalDias).toBe(30);
    expect(p.atual).toBe(80);
    expect(p.linhaBase).toBe(180); // 30 dias antes do início
    expect(p.linhaBaseAuto).toBe(true);
    expect(p.esperado).toBeCloseTo(100, 6); // 300 × 10/30
    expect(p.atingimento).toBeCloseTo(80 / 300, 6);
    expect(p.projecao).toBeCloseTo(240, 6);
    expect(p.estado).toBe('atencao'); // 26,7% do caminho contra 33,3% do prazo: 6,7 pontos atrás
  });
  it('o gasto vem do investimento do canal e o orçamento adiantado é sinalizado', () => {
    const p = calcularProgresso({ ...base, investimento: 5000 }, { diario: d }, HOJE);
    expect(p.gasto).toBe(4000);
    expect(p.usoOrcamento).toBeCloseTo(0.8, 6);
    expect(p.orcamentoAdiantado).toBe(true); // 80% do orçamento com 33% do prazo
    expect(calcularProgresso({ ...base, investimento: 50_000 }, { diario: d }, HOJE).orcamentoAdiantado).toBe(false);
  });
  it('linha de base combinada vale mais que a automática', () => {
    const p = calcularProgresso({ ...base, linhaBase: 150 }, { diario: d }, HOJE);
    expect(p.linhaBase).toBe(150);
    expect(p.linhaBaseAuto).toBe(false);
  });
  it('estados: atingida, em linha, abaixo do previsto, poucos dias, ainda não começou e cancelado', () => {
    expect(calcularProgresso({ ...base, meta: 60 }, { diario: d }, HOJE).estado).toBe('atingida');
    expect(calcularProgresso({ ...base, meta: 250 }, { diario: d }, HOJE).estado).toBe('em_linha'); // 32% do caminho, 33% do prazo
    expect(calcularProgresso({ ...base, meta: 900 }, { diario: d }, HOJE).estado).toBe('fora');
    expect(calcularProgresso(base, { diario: d }, '2026-10-03').estado).toBe('cedo'); // 2 dias completos
    const antes = calcularProgresso(base, { diario: d }, '2026-10-01');
    expect(antes.estado).toBe('nao_iniciou');
    expect(antes.serie).toEqual([]);
    expect(calcularProgresso({ ...base, status: 'cancelado' }, { diario: d }, HOJE).estado).toBe('cancelado');
  });
  it('depois do fim, o resultado fica parado no último dia do experimento', () => {
    const p = calcularProgresso({ ...base, inicio: '2026-10-01', fim: '2026-10-05' }, { diario: d }, '2026-10-20');
    expect(p.dadosAte).toBe('2026-10-05');
    expect(p.diasCompletos).toBe(5);
    expect(p.atual).toBe(40);
    expect(p.decorrido).toBe(1);
  });
  it('a curva real é acumulada dia a dia e a prevista cresce em linha reta até a meta', () => {
    const p = calcularProgresso(base, { diario: d }, HOJE);
    expect(p.serie).toHaveLength(10);
    expect(p.serie[0]).toMatchObject({ dia: '2026-10-01', real: 8 });
    expect(p.serie[9]).toMatchObject({ dia: '2026-10-10', real: 80 });
    expect(p.serie[9]!.esperado).toBeCloseTo(100, 6);
    expect(p.trajetoria).toEqual({ v0: 0, v1: 300 });
  });
});

describe('Experimentos: acompanhamento automático (métrica de custo)', () => {
  const d = vazio();
  meta(d, '2026-09-01', '2026-09-30', { leads: 2, invest: 160 }); // CPL anterior R$ 80
  meta(d, '2026-10-01', '2026-10-10', { leads: 3, invest: 160 }); // CPL do teste R$ 53,33
  const cpl = { ...base, metrica: 'cpl', meta: 50 };
  it('a trajetória parte da linha de base e o atingimento é o caminho andado até a meta', () => {
    const p = calcularProgresso(cpl, { diario: d }, HOJE);
    expect(p.linhaBase).toBeCloseTo(80, 6);
    expect(p.atual).toBeCloseTo(160 / 3, 6);
    expect(p.trajetoria).toEqual({ v0: 80, v1: 50 });
    expect(p.esperado).toBeCloseTo(70, 6); // 80 − 30 × 10/30
    expect(p.atingimento).toBeCloseTo((160 / 3 - 80) / (50 - 80), 6); // 0,889
    expect(p.estado).toBe('em_linha');
    expect(p.projecao).toBeNull(); // projeção só existe para contagens
  });
  it('bater a meta de custo é ficar igual ou abaixo dela', () => {
    expect(calcularProgresso({ ...cpl, meta: 55 }, { diario: d }, HOJE).estado).toBe('atingida');
  });
  it('custo do total usa os leads dos canais pagos e não existe sem investimento', () => {
    const t = vazio();
    meta(t, '2026-10-01', '2026-10-10', { leads: 4, mql: 2, reunioes: 1, invest: 100 });
    for (const dia of dias('2026-10-01', '2026-10-10')) t.organico.set(dia, soma({ leads: 50 }));
    const j = { de: '2026-10-01', ate: '2026-10-10', dias: 10 };
    expect(valorMetrica({ diario: t }, 'total', 'cpl', j)).toBeCloseTo(25, 6); // 1.000 ÷ 40 leads pagos (os 500 orgânicos não entram)
    expect(valorMetrica({ diario: t }, 'total', 'cpmql', j)).toBeCloseTo(50, 6);
    expect(valorMetrica({ diario: t }, 'total', 'cpreuniao', j)).toBeCloseTo(100, 6);
    expect(valorMetrica({ diario: t }, 'organico', 'cpl', j)).toBeNull();
    expect(valorMetrica({ diario: t }, 'organico', 'leads', j)).toBe(500);
  });
  it('sem dado no período, não inventa resultado', () => {
    const p = calcularProgresso(cpl, { diario: vazio() }, HOJE);
    expect(p.atual).toBeNull();
    expect(p.estado).toBe('sem_dados');
  });
});

describe('Experimentos: desfecho e calibração', () => {
  it('desfecho: atingiu a partir de 100%, parcial a partir de 70%', () => {
    expect([1.2, 1, 0.8, 0.7, 0.69, null].map((x) => desfechoDe(x))).toEqual(['atingiu', 'atingiu', 'parcial', 'parcial', 'nao_atingiu', null]);
  });
  it('a calibração junta os concluídos por métrica, com a confiança média que tinham', () => {
    const c = calibracaoPor([
      { id: 1, metrica: 'cpl', status: 'concluido', desfecho: 'atingiu', iceConfianca: 9 },
      { id: 2, metrica: 'cpl', status: 'concluido', desfecho: 'nao_atingiu', iceConfianca: 7 },
      { id: 3, metrica: 'cpl', status: 'rodando', desfecho: null, iceConfianca: 5 },
      { id: 4, metrica: 'leads', status: 'concluido', desfecho: 'parcial', iceConfianca: null },
    ]);
    expect(c.find((x) => x.metrica === 'cpl')).toEqual({ metrica: 'cpl', total: 2, atingiu: 1, parcial: 0, confiancaMedia: 8 });
    expect(c.find((x) => x.metrica === 'leads')).toMatchObject({ total: 1, parcial: 1, confiancaMedia: null });
  });
});

describe('Experimentos: sem métrica, relatório e documentação', () => {
  const d = vazio();
  meta(d, '2026-09-24', '2026-09-30', { leads: 2, invest: 70 }); // 7 dias antes do teste
  meta(d, '2026-10-05', '2026-10-14', { leads: 4, invest: 100 }); // 05/10 é segunda-feira
  const exp = { canal: 'meta', metrica: 'leads', inicio: '2026-10-05', fim: '2026-10-11' } as const; // 7 dias, segunda a domingo
  it('ideia sem métrica, meta ou período não tem acompanhamento automático e não quebra', () => {
    const sem = { canal: 'total', metrica: null, meta: null, linhaBase: null, investimento: null, inicio: null, fim: null, status: 'backlog' } as const;
    expect(acompanhavel(sem)).toBe(false);
    expect(calcularProgresso(sem, { diario: d }, HOJE).estado).toBe('sem_metrica');
    expect(calcularProgresso({ ...sem, status: 'cancelado' }, { diario: d }, HOJE).estado).toBe('cancelado');
    expect(acompanhavel({ metrica: 'cpl', meta: 40, inicio: '2026-10-01', fim: '2026-10-30' })).toBe(true);
  });
  it('relatório: um dia por linha, semanas de segunda a domingo e o geral contra o período anterior', () => {
    const r = montarRelatorio({ ...exp, fim: '2026-10-19' }, { diario: d }, '2026-10-16'); // dados até 15/10 (quinta)
    expect(r.dadosAte).toBe('2026-10-15');
    expect(r.diario).toHaveLength(11);
    expect(r.diario[0]).toMatchObject({ rotulo: '2026-10-05', leads: 4, invest: 100, valor: 4 });
    expect(r.diario[10]).toMatchObject({ leads: 0, valor: 0 }); // 15/10 sem dado
    expect(r.semanal.map((x) => [x.rotulo, x.de, ate(x), x.leads])).toEqual([['Semana 1', '2026-10-05', '2026-10-11', 28], ['Semana 2', '2026-10-12', '2026-10-15', 12]]);
    expect(r.geral).toMatchObject({ de: '2026-10-05', ate: '2026-10-15', leads: 40, invest: 1000, cpl: 25 });
    expect(r.base).toMatchObject({ de: '2026-09-20', ate: '2026-10-04', leads: 14 }); // o teste dura 15 dias (05 a 19/10): a base são os 15 dias antes, 20/09 a 04/10
  });
  const ate = (x: { ate: string }) => x.ate;
  it('semana cortada no início quando o teste começa no meio dela; sem período não há relatório', () => {
    const r = montarRelatorio({ ...exp, inicio: '2026-10-07', fim: '2026-10-20' }, { diario: d }, '2026-10-14');
    expect(r.semanal[0]).toMatchObject({ de: '2026-10-07', ate: '2026-10-11', dias: 5 });
    expect(montarRelatorio({ canal: 'meta', metrica: null, inicio: null, fim: null }, { diario: d }, HOJE)).toMatchObject({ diario: [], semanal: [], geral: null, base: null });
    expect(montarRelatorio(exp, { diario: d }, '2026-10-05').diario).toEqual([]); // ainda não fechou nenhum dia
  });
  it('a documentação aceita texto formatado e SVG, mas recusa script, iframe e atributo de evento', () => {
    expect(documentacaoValida({ html: '<h1>Relatório</h1><svg viewBox="0 0 10 10"><rect width="3" height="3"/></svg>' })).toContain('<svg');
    for (const ruim of ['<script>alert(1)</script>', '<IFRAME src="x"></iframe>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>']) expect(() => documentacaoValida({ html: ruim })).toThrow(PainelInvalido);
    expect(() => documentacaoValida({ html: 'x'.repeat(400_001) })).toThrow(/limite/);
    expect(() => documentacaoValida({ html: 5 })).toThrow(PainelInvalido);
  });
});

describe('Experimentos: escopo (página de destino, campanha e identificador de conversão)', () => {
  it('normaliza a página: endereço completo, só o caminho ou texto inválido', () => {
    expect(normalizarPagina('https://www.QuarkRH.com.br/Blog/Post/?utm=1#x')).toEqual({ host: 'quarkrh.com.br', caminho: '/blog/post' });
    expect(normalizarPagina('quarkrh.com.br')).toEqual({ host: 'quarkrh.com.br', caminho: '/' });
    expect(normalizarPagina('/diagnostico/')).toEqual({ host: null, caminho: '/diagnostico' });
    expect(normalizarPagina('isto nao e pagina')).toBeNull();
    expect(normalizarPagina('   ')).toBeNull();
  });
  it('campanha: "nome (id)" e só o id viram id; qualquer outro texto vira nome (o id fica como texto: passa de 2^53)', () => {
    expect(normalizarCampanha('Black Friday RH (120219876543210987)')).toEqual({ id: '120219876543210987', nome: 'Black Friday RH' });
    expect(normalizarCampanha('120219876543210987')).toEqual({ id: '120219876543210987', nome: null });
    expect(normalizarCampanha('[GROWTH][80] Diagnóstico')).toEqual({ id: null, nome: '[GROWTH][80] Diagnóstico' });
    expect(normalizarCampanha(' ')).toBeNull();
  });
  it('o cadastro aceita os três campos, limpa com vazio e recusa página inválida', () => {
    const v = validarEntrada({ titulo: 'x', paginaDestino: 'https://quarkrh.com.br/diagnostico/', campanhas: ['Diag (120219876543210987)'], identificadorConversao: ' Diagnóstico RH ' }, 'criar');
    expect(v).toMatchObject({ paginaHost: 'quarkrh.com.br', paginaCaminho: '/diagnostico', campanhas: [{ id: '120219876543210987', nome: 'Diag' }], identificadorConversao: 'Diagnóstico RH' });
    expect(validarEntrada({ paginaDestino: '', campanhas: null, identificadorConversao: '' }, 'editar')).toMatchObject({ paginaHost: null, paginaCaminho: null, campanhas: [], identificadorConversao: null });
    expect(() => validarEntrada({ titulo: 'x', paginaDestino: 'sem dominio' }, 'criar')).toThrow(/página de destino inválida/);
  });
  it('custo exige campanha da Meta quando há escopo; contagem vale com qualquer escopo', () => {
    expect(() => validarEntrada({ titulo: 'x', metrica: 'cpl', meta: 30, paginaDestino: '/diagnostico' }, 'criar')).toThrow(/só existe com uma campanha/);
    expect(() => validarEntrada({ titulo: 'x', metrica: 'cpl', meta: 30, identificadorConversao: 'Diagnóstico' }, 'criar')).toThrow(/só existe com uma campanha/);
    expect(validarEntrada({ titulo: 'x', metrica: 'cpl', meta: 30, campanhas: ['Diag'], canal: 'social' }, 'criar').metrica).toBe('cpl'); // com campanha, o canal deixa de importar
    expect(validarEntrada({ titulo: 'x', metrica: 'leads', meta: 30, paginaDestino: '/diagnostico' }, 'criar').metrica).toBe('leads');
    // na edição vale o conjunto
    expect(() => validarEntrada({ metrica: 'cpl' }, 'editar', { produto: 'rh', canal: 'meta', metrica: 'leads', meta: 50, inicio: null, fim: null, paginaCaminho: '/x' })).toThrow(/só existe com uma campanha/);
  });
  const esc = { produto: 'rh' as const, paginaHost: null as string | null, paginaCaminho: null as string | null, campanhas: [] as Array<{ id: string | null; nome: string | null }>, identificadorConversao: null as string | null };
  it('lê só a fatia: negócios do escopo, gasto da campanha e SQL parametrizado', async () => {
    const sqls: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: async (sql: string, params: unknown[] = []) => { sqls.push({ sql: sql.replace(/\s+/g, ' '), params }); return { rows: /meta_desempenho_dia/.test(sql) ? [{ dia: '2026-10-02', gasto: 100, impressoes: 5000, cliques: 80 }] : /group by 1 *$|group by 1$/.test(sql.trim()) && /criado_em/.test(sql) ? [{ dia: '2026-10-02', leads: 4, mql: 2 }] : [] }; } } as never;
    const d = await lerDadosEscopo(db, { ...esc, campanhas: [{ id: '120219876543210987', nome: null }], identificadorConversao: "x'); drop table crm.deals; --", paginaHost: 'quarkrh.com.br', paginaCaminho: '/diagnostico' }, '10:00', '2026-09-01');
    const todos = sqls.map((s) => s.sql).join(' ');
    expect(todos).not.toContain('drop table');
    expect(sqls[0]!.params).toEqual(['2026-09-01', 'rh', ['120219876543210987'], "x'); drop table crm.deals; --", '/diagnostico', 'quarkrh.com.br']);
    expect(todos).toContain('analytics.negocios_meta');
    expect(todos).toContain('analytics.conversoes_pipe_negocios');
    expect(todos).toContain('analytics.negocios_url');
    expect(todos).not.toContain('site_paginas_dia'); // com campanha, o topo é a mídia da campanha, não as visitas da página
    expect(d.diario.meta.get('2026-10-02')).toMatchObject({ leads: 4, mql: 2, invest: 100, impressoes: 5000, cliques: 80, leadsT: 4 });
    expect(d.diario.google.size + d.diario.social.size + d.diario.organico.size).toBe(0);
  });
  it('várias campanhas: lista sem repetição, limite, ids e nomes; e a leitura soma todas (qualquer uma delas)', async () => {
    expect(normalizarCampanhas(['A (120219876543210987)', '120219876543210987', 'B (120219876543210988)', 'Só nome', 'só nome', ' ', '[GROWTH][81]'])).toEqual([
      { id: '120219876543210987', nome: 'A' }, { id: '120219876543210988', nome: 'B' }, { id: null, nome: 'Só nome' }, { id: null, nome: '[GROWTH][81]' },
    ]);
    expect(normalizarCampanhas(Array.from({ length: 80 }, (_, i) => `Campanha ${i}`))).toHaveLength(40);
    expect(() => validarEntrada({ titulo: 'x', campanhas: 'não é lista' }, 'criar')).toThrow(/lista de até 40/);
    expect(() => validarEntrada({ titulo: 'x', campanhas: [5] }, 'criar')).toThrow(/lista de até 40/);
    const sqls: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: async (sql: string, params: unknown[] = []) => { sqls.push({ sql: sql.replace(/\s+/g, ' '), params }); return { rows: /meta_desempenho_dia/.test(sql) ? [{ dia: '2026-10-02', gasto: 250, impressoes: 9000, cliques: 150 }] : [] }; } } as never;
    const d = await lerDadosEscopo(db, { ...esc, campanhas: [{ id: '120219876543210987', nome: 'A' }, { id: '120219876543210988', nome: 'B' }, { id: null, nome: 'Só Nome' }] }, '10:00', '2026-09-01');
    expect(sqls[0]!.params).toEqual(['2026-09-01', 'rh', ['120219876543210987', '120219876543210988'], ['só nome']]);
    expect(sqls[0]!.sql).toContain('campanha_id = any($3::bigint[]) or lower(campanha) = any($4::text[])');
    const gasto = sqls.find((x) => x.sql.includes('meta_desempenho_dia'))!;
    expect(gasto.params).toEqual(['2026-09-01', ['120219876543210987', '120219876543210988'], ['só nome']]);
    expect(gasto.sql).toContain('(campanha_id = any($2::bigint[]) or lower(campanha) = any($3::text[]))');
    expect(d.diario.meta.get('2026-10-02')).toMatchObject({ invest: 250, impressoes: 9000, cliques: 150 }); // o gasto das campanhas vem somado
  });
  it('modos de combinação: todos (E), qualquer (OU) e campanha só para o investimento', async () => {
    const rodar = async (modo: 'todos' | 'qualquer' | 'campanha_so_investimento') => {
      const sqls: Array<{ sql: string; params: unknown[] }> = [];
      const db = { query: async (sql: string, params: unknown[] = []) => { sqls.push({ sql: sql.replace(/\s+/g, ' '), params }); return { rows: [] }; } } as never;
      await lerDadosEscopo(db, { ...esc, escopoModo: modo, campanhas: [{ id: '120219876543210987', nome: null }], identificadorConversao: 'diag', paginaCaminho: '/diagnostico' }, '10:00', '2026-09-01');
      return { negocios: sqls[0]!, gasto: sqls.find((x) => x.sql.includes('meta_desempenho_dia'))! };
    };
    const e = await rodar('todos');
    expect(e.negocios.sql).toContain(') and d.deal_id in (select deal_id from analytics.conversoes_pipe_negocios');
    expect(e.negocios.sql).toContain(') and d.deal_id in (select deal_id from analytics.negocios_url');
    expect(e.negocios.sql).not.toContain(' or d.deal_id in');
    const ou = await rodar('qualquer');
    expect(ou.negocios.sql).toContain(') or d.deal_id in (select deal_id from analytics.conversoes_pipe_negocios');
    expect(ou.negocios.sql).not.toContain(') and d.deal_id in');
    const so = await rodar('campanha_so_investimento');
    expect(so.negocios.sql).not.toContain('negocios_meta'); // a campanha não filtra negócios
    expect(so.negocios.params).toEqual(['2026-09-01', 'rh', 'diag', '/diagnostico']);
    expect(so.gasto.sql).toContain('meta_desempenho_dia'); // mas o investimento continua sendo o dela
    expect(so.gasto.params).toEqual(['2026-09-01', ['120219876543210987']]);
    // sem página nem identificador, a campanha volta a filtrar os negócios
    const sqls: string[] = [];
    await lerDadosEscopo({ query: async (sql: string) => { sqls.push(sql); return { rows: [] }; } } as never, { ...esc, escopoModo: 'campanha_so_investimento', campanhas: [{ id: '120219876543210987', nome: null }] }, '10:00', '2026-09-01');
    expect(sqls[0]).toContain('negocios_meta');
  });
  it('o cadastro valida o modo do escopo', () => {
    expect(validarEntrada({ titulo: 'x', escopoModo: 'campanha_so_investimento' }, 'criar').escopoModo).toBe('campanha_so_investimento');
    expect(() => validarEntrada({ titulo: 'x', escopoModo: 'outro' }, 'criar')).toThrow(/escopoModo inválido/);
  });
  it('detalhe dos negócios: lê funil, perfil, perdas, safra, criativos e conferência só das visões de analytics, com SQL parametrizado', async () => {
    const sqls: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: async (sql: string, params: unknown[] = []) => {
      sqls.push({ sql: sql.replace(/\s+/g, ' '), params });
      if (/count\(\*\)::int as n \$|^select count\(\*\)::int as n from/i.test(sql.trim())) return { rows: [{ n: 42 }] };
      if (/to_char\(date_trunc\('week'/.test(sql)) return { rows: [{ k: '2026-10-05', n: 10, abertos: 2, ganhos: 3, perdidos: 5 }] };
      if (/d\.faixa_colab as k/.test(sql)) return { rows: [{ k: '25 - 100', n: 7, abertos: 1, ganhos: 1, perdidos: 5 }] };
      if (/d\.faixa_saude as k/.test(sql)) return { rows: [{ k: null, n: 3, abertos: 0, ganhos: 0, perdidos: 3 }] };
      if (/Cargo \(Negócio\)/.test(sql)) return { rows: [{ k: 'Analista de RH', n: 5, abertos: 0, ganhos: 1, perdidos: 4 }] };
      if (/as funil/.test(sql)) return { rows: [{ funil: 'QuarkRH', k: 'Conexão [Prospect]', n: 6, abertos: 1, ganhos: 0, perdidos: 5 }] };
      if (/motivo_perda as k/.test(sql)) return { rows: [{ k: 'Sem Contato Estabelecido', n: 4 }] };
      if (/meta_desempenho_dia/.test(sql)) return { rows: [{ anuncio: 'Criativo A', gasto: 100, impressoes: 1000, cliques: 20, leads_meta: 5 }] };
      if (/negocios_meta m join analytics\.negocios_bi/.test(sql)) return { rows: [{ anuncio: 'Criativo A', n: 2, ganhos: 1 }] };
      if (/count\(\*\) filter \(where d\.conta_como_lead\)/.test(sql)) return { rows: [{ n: 12, abertos: 3, ganhos: 2, perdidos: 7, leads: 11 }] };
      if (/m\.metodo/.test(sql)) return { rows: [{ k: 'sem_ligacao', n: 9 }] };
      if (/d\.deal_id::text as id/.test(sql)) return { rows: [{ id: '777', titulo: 'Lead A', etapa: 'Agendado', status: 'open', criado: '2026-10-07' }] };
      return { rows: [] };
    } } as never;
    const d = await lerDetalheEscopo(db, { ...esc, campanhas: [{ id: '120219876543210987', nome: null }], identificadorConversao: "x'); drop table crm.deals; --" }, '2026-10-01', '2026-10-25');
    expect(d).toMatchObject({ de: '2026-10-01', ate: '2026-10-25', negocios: 12, leads: 11, status: { abertos: 3, ganhos: 2, perdidos: 7 }, modo: 'todos' });
    expect(d.etapas[0]).toMatchObject({ funil: 'QuarkRH', rotulo: 'Conexão [Prospect]', n: 6 });
    expect(d.faixaColab[0]).toMatchObject({ rotulo: '25 - 100', ganhos: 1 });
    expect(d.faixaSaude).toEqual([]); // só "(em branco)": a quebra some
    expect(d.cargos[0]!.rotulo).toBe('Analista de RH');
    expect(d.motivosPerda).toEqual([{ rotulo: 'Sem Contato Estabelecido', n: 4 }]);
    expect(d.safra[0]).toMatchObject({ semana: '2026-10-05', ganhos: 3 });
    expect(d.criativos[0]).toMatchObject({ anuncio: 'Criativo A', gasto: 100, leadsMeta: 5, negocios: 2, ganhos: 1 });
    expect(d.conferencia).toMatchObject({ porIdentificador: 42, porPagina: null, porCampanhas: 42, ligacaoMeta: [{ metodo: 'sem_ligacao', n: 9 }] });
    expect(d.amostra[0]).toEqual({ id: 777, titulo: 'Lead A', etapa: 'Agendado', status: 'open', criado: '2026-10-07' });
    const todos = sqls.map((x) => x.sql).join(' ');
    expect(todos).not.toContain('drop table');
    expect(sqls.some((x) => x.params.includes("x'); drop table crm.deals; --"))).toBe(true);
    // o papel do painel só lê o schema analytics: nenhuma consulta pode tocar crm, mkt, raw ou orq
    expect(todos).not.toMatch(/\b(crm|mkt|raw|orq)\./);
  });
  it('o arquivo do escopo só consulta as visões de analytics (o papel do painel não lê crm nem mkt)', () => {
    const fonte = readFileSync(new URL('../studio/lib/experimentos-escopo.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(fonte).not.toMatch(/\b(from|join)\s+(crm|mkt|raw|orq)\./);
  });
  it('só página: o topo são as visualizações dela no GA4 e não há investimento', async () => {
    const sqls: string[] = [];
    const db = { query: async (sql: string) => { sqls.push(sql); return { rows: /site_paginas_dia/.test(sql) ? [{ dia: '2026-10-02', v: 300 }] : [] }; } } as never;
    const d = await lerDadosEscopo(db, { ...esc, paginaCaminho: '/diagnostico' }, '10:00', '2026-09-01');
    expect(sqls.some((s) => s.includes('meta_desempenho_dia'))).toBe(false);
    expect(d.diario.meta.get('2026-10-02')).toMatchObject({ sessoes: 300, invest: 0 });
  });
  it('o repositório lê a fatia do experimento com escopo e o Monitor para o resto, e calcula o real sobre a fatia', async () => {
    const linhaE = (o: Record<string, unknown>) => ({ id: 5, titulo: 'T', tipo: 'experimento', produto: 'rh', canal: 'social', metrica: 'leads', meta: 100, inicio: '2026-10-01', fim: '2026-10-10', status: 'rodando', criado_em: new Date(), atualizado_em: new Date(), ...o });
    const rows = [linhaE({ id: 5, identificador_conversao: 'Diagnóstico RH' }), linhaE({ id: 6 })];
    const db = { query: async (sql: string) => ({ rows: /from mkt\.experimentos/.test(sql) ? rows : [] }) } as never;
    const fatia: Record<CanalId, Map<string, Soma>> = { google: new Map(), meta: new Map(), social: new Map(), organico: new Map() };
    for (const dia of dias('2026-10-01', '2026-10-10')) fatia.meta.set(dia, soma({ leads: 3 }));
    const lidosEscopo: string[] = [];
    const repo = new PgExperimentosRepo(db, () => new Date('2026-10-11T15:00:00Z'),
      async () => ({ diario: vazio(), ontemMesmaHora: { google: ZERO, meta: ZERO, social: ZERO, organico: ZERO }, hora: '10:00', trafegoAte: null }),
      async (_db, e) => { lidosEscopo.push(String(e.identificadorConversao)); return { diario: fatia, ontemMesmaHora: { google: ZERO, meta: ZERO, social: ZERO, organico: ZERO }, hora: '10:00', trafegoAte: null }; });
    const l = await repo.listar();
    expect(lidosEscopo).toEqual(['Diagnóstico RH']);
    expect(l.experimentos.find((e) => e.id === 5)!.progresso.atual).toBe(30); // o REAL da fatia, não o do canal (que está vazio)
    expect(l.experimentos.find((e) => e.id === 6)!.progresso.atual).toBe(0); // sem escopo, vale o canal (vazio no teste)
    expect(rotuloEscopo(l.experimentos[0]!)).toEqual(['Identificador Diagnóstico RH']);
  });
});

describe('Experimentos: repositório (banco simulado)', () => {
  const linha = (o: Record<string, unknown> = {}) => ({ id: 5, titulo: 'T', hipotese: null, produto: 'rh', canal: 'meta', metrica: 'leads', meta: 300, linha_base: null, investimento: null, inicio: '2026-10-01', fim: '2026-10-30', status: 'rodando', ice_impacto: 8, ice_confianca: 6, ice_facilidade: 7, ice_score: 7, valor_final: null, atingimento_final: null, desfecho: null, aprendizado: null, criado_em: new Date('2026-10-01T10:00:00Z'), atualizado_em: new Date('2026-10-01T10:00:00Z'), ...o });
  const dados = (): DadosMonitor => { const diario = vazio(); meta(diario, '2026-10-01', '2026-10-10', { leads: 8, invest: 400 }); return { diario, ontemMesmaHora: { google: ZERO, meta: ZERO, social: ZERO, organico: ZERO }, hora: '10:00', trafegoAte: null }; };
  const montar = (rows: Array<Record<string, unknown>>) => {
    const sqls: Array<{ sql: string; params: unknown[] }> = [];
    const lidos: Array<{ produto: string; desde: string }> = [];
    const db = { query: async (sql: string, params: unknown[] = []) => {
      sqls.push({ sql: sql.replace(/\s+/g, ' '), params });
      if (/^\s*insert into mkt\.experimentos/i.test(sql)) return { rows: [{ id: 5 }] };
      if (/^\s*update mkt\.experimentos/i.test(sql)) return { rows: [] };
      if (/^s*update mkt.experimentos set documentacao/i.test(sql)) return { rows: [{ atualizado_em: new Date('2026-10-11T15:00:00Z') }] };
      return { rows: sql.includes('where id = $1') ? rows.filter((r) => r.id === params[0]) : rows };
    } } as never;
    const repo = new PgExperimentosRepo(db, () => new Date('2026-10-11T15:00:00Z'), async (_db, _hoje, _hora, produto, desde) => { lidos.push({ produto, desde }); return dados(); });
    return { repo, sqls, lidos };
  };

  it('lista com o progresso calculado sozinho, lendo os dados uma vez por produto desde o início da linha de base', async () => {
    const { repo, lidos } = montar([linha(), linha({ id: 6, inicio: '2026-10-05', fim: '2026-10-14' }), linha({ id: 7, produto: 'clinic', status: 'cancelado' })]);
    const l = await repo.listar();
    expect(l.hoje).toBe('2026-10-11');
    expect(l.experimentos).toHaveLength(3);
    expect(l.experimentos[0]!.progresso.atual).toBe(80);
    expect(lidos).toEqual([{ produto: 'rh', desde: '2026-09-01' }]); // 30 dias antes de 01/10 (o início de linha de base mais antigo); o cancelado não força leitura
    expect(l.experimentos[2]!.progresso.estado).toBe('cancelado');
    expect(l.metricas.length).toBe(METRICAS_EXP.length);
  });
  it('cria com SQL parametrizado, sem montar texto com o que o usuário digitou', async () => {
    const { repo, sqls } = montar([linha()]);
    const e = await repo.criar({ titulo: "x'); drop table mkt.experimentos; --", produto: 'rh', canal: 'meta', metrica: 'leads', meta: 300, inicio: '2026-10-01', fim: '2026-10-30' });
    expect(e.id).toBe(5);
    const ins = sqls.find((s) => /insert into/i.test(s.sql))!;
    expect(ins.sql).not.toContain('drop table');
    expect(ins.params).toContain("x'); drop table mkt.experimentos; --");
  });
  it('grava a lista de campanhas como JSON (e lê a campanha única antiga da 0024 como lista de uma)', async () => {
    const { repo, sqls } = montar([linha({ id: 5, campanha_id: '120219876543210987', campanha_nome: 'Antiga' })]);
    await repo.criar({ titulo: 'x', campanhas: ['A (120219876543210987)', 'B'] });
    const ins = sqls.find((x) => /insert into/i.test(x.sql))!;
    expect(ins.params).toContain(JSON.stringify([{ id: '120219876543210987', nome: 'A' }, { id: null, nome: 'B' }]));
    expect((await repo.listar()).experimentos[0]!.campanhas).toEqual([{ id: '120219876543210987', nome: 'Antiga' }]);
  });
  it('recusa entrada inválida antes de tocar o banco e avisa quando o experimento não existe', async () => {
    const { repo, sqls } = montar([linha()]);
    await expect(repo.criar({ titulo: '' })).rejects.toThrow(PainelInvalido);
    expect(sqls).toHaveLength(0);
    await expect(repo.atualizar(99, { titulo: 'novo' })).rejects.toThrow(PainelNotFound);
  });
  it('ao concluir, grava a fotografia do resultado (valor, atingimento e desfecho)', async () => {
    const { repo, sqls } = montar([linha({ meta: 80, fim: '2026-10-10' })]);
    await repo.atualizar(5, { status: 'concluido' });
    const up = sqls.find((s) => /^update mkt\.experimentos/i.test(s.sql))!;
    expect(up.sql).toContain('valor_final');
    expect(up.sql).toContain('desfecho');
    expect(up.params).toEqual(expect.arrayContaining(['concluido', 80, 1, 'atingiu']));
  });
  it('ideia sem métrica não força leitura de dados e conclui sem fotografia', async () => {
    const { repo, sqls, lidos } = montar([linha({ metrica: null, meta: null, inicio: null, fim: null, status: 'backlog' })]);
    const l = await repo.listar();
    expect(l.experimentos[0]!.progresso.estado).toBe('sem_metrica');
    expect(lidos).toEqual([]);
    await repo.atualizar(5, { status: 'concluido' });
    expect(sqls.find((x) => /^update/i.test(x.sql))!.sql).not.toContain('valor_final');
  });
  it('o relatório traz o detalhe dos negócios só quando há escopo e período', async () => {
    const detalhe = { negocios: 7 } as never;
    const montarComDetalhe = (rows: Array<Record<string, unknown>>) => {
      const db = { query: async (sql: string, params: unknown[] = []) => ({ rows: sql.includes('where id = $1') ? rows.filter((r) => r.id === params[0]) : rows }) } as never;
      const chamadas: string[] = [];
      const repo = new PgExperimentosRepo(db, () => new Date('2026-10-11T15:00:00Z'), async () => dados(), async () => dados(), async (_d, _e, de, ate) => { chamadas.push(`${de}..${ate}`); return detalhe; });
      return { repo, chamadas };
    };
    const a = montarComDetalhe([linha({ identificador_conversao: 'diag' })]);
    expect((await a.repo.relatorio(5)).detalhe).toBe(detalhe);
    expect(a.chamadas).toEqual(['2026-10-01..2026-10-10']); // até o último dia completo
    const b = montarComDetalhe([linha()]);
    expect((await b.repo.relatorio(5)).detalhe).toBeNull();
    expect(b.chamadas).toEqual([]);
    const c = montarComDetalhe([linha({ identificador_conversao: 'diag', inicio: null, fim: null, metrica: null, meta: null })]);
    expect((await c.repo.relatorio(5)).detalhe).toBeNull();
  });
  it('relatório devolve a documentação salva; salvar grava só a documentação, parametrizada', async () => {
    const { repo, sqls } = montar([linha({ documentacao: '<h1>x</h1>' })]);
    const r = await repo.relatorio(5);
    expect(r.relatorio.diario).toHaveLength(10);
    expect(r.experimento.progresso.atual).toBe(80);
    await repo.salvarDocumentacao(5, { html: "<p>o'brien</p>" });
    const up = sqls.find((x) => /set documentacao/i.test(x.sql))!;
    expect(up.sql).not.toContain('brien');
    expect(up.params).toEqual(["<p>o'brien</p>", 5]);
    await expect(repo.salvarDocumentacao(5, { html: '<script>x</script>' })).rejects.toThrow(PainelInvalido);
  });
  it('edição simples não fotografa nada', async () => {
    const { repo, sqls } = montar([linha()]);
    await repo.atualizar(5, { titulo: 'Novo nome' });
    expect(sqls.find((s) => /^update/i.test(s.sql))!.sql).not.toContain('valor_final');
  });
});

describe('Experimentos: API do Studio e página', () => {
  let server: Server; let semRepo: Server; let base: string; let baseSem: string; let dir: string;
  const chamadas: string[] = [];
  const repo: ExperimentosRepo = {
    async listar() { chamadas.push('listar'); return { hoje: '2026-10-11', metricas: METRICAS_EXP, canais: [] as never, tipos: [] as never, experimentos: [], calibracao: [] }; },
    async relatorio(id) { chamadas.push(`relatorio:${id}`); return { id } as never; },
    async opcoes(produto) { chamadas.push(`opcoes:${produto ?? ''}`); return { paginas: [], campanhas: [], identificadores: [] }; },
    async salvarDocumentacao(id, b) { chamadas.push(`doc:${id}`); documentacaoValida(b); return { id, atualizadoEm: 'x' }; },
    async criar(b) { chamadas.push('criar'); validarEntrada(b, 'criar'); return { id: 1 } as never; },
    async atualizar(id, b) { chamadas.push(`atualizar:${id}`); validarEntrada(b, 'editar'); return { id } as never; },
  };
  const mk = (experimentos: ExperimentosRepo | null) => createStudioServer({ formsDir: join(dir, 'forms'), publicDir: join(dir, 'public'), trackingDir: join(dir, 'tracking'), sources: [], dbInfo: () => ({ connected: true }), submit: async () => ({ status: 200, body: {} }), experimentos });
  const json = (method: string, corpo: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'studio-exp-'));
    for (const d of ['forms', 'public', 'tracking']) mkdirSync(join(dir, d));
    writeFileSync(join(dir, 'public', 'experimentos.html'), '<h1>experimentos.html</h1>');
    server = mk(repo); semRepo = mk(null);
    await Promise.all([server, semRepo].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    baseSem = `http://127.0.0.1:${(semRepo.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await Promise.all([server, semRepo].map((s) => new Promise((r) => s.close(r)))); rmSync(dir, { recursive: true, force: true }); });

  it('serve a página, lista, cria e edita; sem DELETE', async () => {
    expect(await (await fetch(`${base}/experimentos`)).text()).toContain('experimentos.html');
    expect((await fetch(`${base}/api/experimentos`)).status).toBe(200);
    const ok = { titulo: 'T', produto: 'rh', metrica: 'cpl', meta: 50, inicio: '2026-10-01', fim: '2026-10-30' };
    expect((await fetch(`${base}/api/experimentos`, json('POST', ok))).status).toBe(201);
    expect((await fetch(`${base}/api/experimentos/7`, json('PUT', { titulo: 'Outro' }))).status).toBe(200);
    expect((await fetch(`${base}/api/experimentos/opcoes?produto=rh`)).status).toBe(200);
    expect((await fetch(`${base}/api/experimentos/opcoes`, json('POST', {}))).status).toBe(405);
    expect((await fetch(`${base}/api/experimentos/7/relatorio`)).status).toBe(200);
    expect((await fetch(`${base}/api/experimentos/7/documentacao`, json('PUT', { html: '<p>ok</p>' }))).status).toBe(200);
    expect((await fetch(`${base}/api/experimentos/7/documentacao`, json('PUT', { html: '<script>x</script>' }))).status).toBe(400);
    expect((await fetch(`${base}/api/experimentos/7/relatorio`, json('PUT', {}))).status).toBe(405);
    expect((await fetch(`${base}/api/experimentos/7/documentacao`)).status).toBe(405);
    expect(chamadas).toEqual(['listar', 'criar', 'atualizar:7', 'opcoes:rh', 'relatorio:7', 'doc:7', 'doc:7']);
    expect((await fetch(`${base}/api/experimentos/7`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })).status).toBe(405);
    expect((await fetch(`${base}/api/experimentos`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })).status).toBe(405);
    expect((await fetch(`${base}/api/experimentos/abc`, json('PUT', {}))).status).toBe(404);
  });
  it('entrada inválida volta como 400 com o motivo em português', async () => {
    const r = await fetch(`${base}/api/experimentos`, json('POST', { titulo: 'T', produto: 'rh', metrica: 'inventada', meta: 1, inicio: '2026-10-01', fim: '2026-10-02' }));
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toContain('métrica inválida');
  });
  it('sem o papel do painel, a API explica o que falta (503)', async () => {
    const r = await fetch(`${baseSem}/api/experimentos`);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe('experimentos_nao_configurado');
  });
  it('a página segue a marca, só lê e grava em /api/experimentos e nunca manda SQL', () => {
    const html = readFileSync(new URL('../studio/public/experimentos.html', import.meta.url), 'utf8');
    expect(html).toContain('Red+Hat+Display');
    expect(html).toContain('#EA8C0C');
    expect(html).not.toMatch(/#F76B00|#C96501|Arial|Roboto|Inter\b/);
    expect(html).not.toMatch(/(?<![-\w])color:\s*(var\(--m-laranja\)|#EA8C0C)/i); // laranja só em preenchimento, nunca em texto
    const js = readFileSync(new URL('../studio/public/experimentos.js', import.meta.url), 'utf8');
    expect(js).toContain('/api/experimentos');
    expect(js).not.toMatch(/\b(select|insert into|delete from|drop table)\b[^`'"]*\bfrom\b/i);
    expect(readFileSync(new URL('../studio/public/nav.js', import.meta.url), 'utf8')).toContain("'/experimentos'");
    // documentação: editor e relatório moram em módulo próprio, também sem SQL
    const doc = readFileSync(new URL('../studio/public/experimentos-doc.js', import.meta.url), 'utf8');
    expect(doc).toContain('/documentacao');
    expect(doc).toContain('/relatorio');
    expect(doc).toContain('window.print');
    expect(doc).not.toMatch(/\b(select|insert into|delete from|drop table)\b[^`'"]*\bfrom\b/i);
    expect(html).toContain('@media print');
    expect(html).toContain('id="v-kanban"');
  });
});
