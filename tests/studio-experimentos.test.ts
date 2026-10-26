import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createStudioServer } from '../studio/server';
import { PainelInvalido, PainelNotFound } from '../studio/lib/painel-repo';
import { somaDias, ZERO, type CanalId, type DadosMonitor, type Soma } from '../studio/lib/monitor';
import { calcularProgresso, calibracaoPor, desfechoDe, METRICAS_EXP, PgExperimentosRepo, validarEntrada, valorMetrica, type Experimento, type ExperimentosRepo } from '../studio/lib/experimentos';

const soma = (o: Partial<Soma>): Soma => ({ ...ZERO, ...o });
const vazio = (): Record<CanalId, Map<string, Soma>> => ({ google: new Map(), meta: new Map(), social: new Map(), organico: new Map() });
const dias = (de: string, ate: string) => { const o: string[] = []; for (let d = de; d <= ate; d = somaDias(d, 1)) o.push(d); return o; };
/** Meta Ads com o mesmo dia repetido em todo o intervalo. */
const meta = (d: Record<CanalId, Map<string, Soma>>, de: string, ate: string, s: Partial<Soma>) => { for (const dia of dias(de, ate)) d.meta.set(dia, soma(s)); };

const base = { canal: 'meta', metrica: 'leads', meta: 300, linhaBase: null, orcamento: null, inicio: '2026-10-01', fim: '2026-10-30', status: 'rodando' } as const;
const HOJE = '2026-10-11'; // dias completos: 01 a 10 (10 de 30 dias)

describe('Experimentos: cadastro validado', () => {
  const ok = { titulo: 'Diagnóstico', produto: 'rh', metrica: 'cpl', meta: 50, inicio: '2026-10-01', fim: '2026-10-30' };
  it('aceita um cadastro mínimo e só devolve campos válidos', () => {
    expect(validarEntrada({ ...ok, canal: 'meta', iceImpacto: 8 }, 'criar')).toMatchObject({ titulo: 'Diagnóstico', canal: 'meta', iceImpacto: 8 });
  });
  it('exige os campos do cadastro e rejeita valores fora do catálogo', () => {
    expect(() => validarEntrada({ titulo: 'x' }, 'criar')).toThrow(PainelInvalido);
    expect(() => validarEntrada({ ...ok, metrica: 'inventada' }, 'criar')).toThrow(/métrica inválida/);
    expect(() => validarEntrada({ ...ok, produto: 'outro' }, 'criar')).toThrow(/produto/);
    expect(() => validarEntrada({ ...ok, canal: 'tv' }, 'criar')).toThrow(/canal inválido/);
    expect(() => validarEntrada({ ...ok, iceImpacto: 11 }, 'criar')).toThrow(/1 a 10/);
    expect(() => validarEntrada({ ...ok, orcamento: -5 }, 'criar')).toThrow(/negativo/);
    expect(() => validarEntrada({ ...ok, inicio: '2026-02-30' }, 'criar')).toThrow(/início/);
    expect(() => validarEntrada({ ...ok, fim: '2026-09-01' }, 'criar')).toThrow(/antes do início/);
    expect(() => validarEntrada({ ...ok, meta: '50' }, 'criar')).toThrow(/número/);
  });
  it('custo exige canal com verba: Social e Orgânico não têm investimento', () => {
    expect(() => validarEntrada({ ...ok, canal: 'social' }, 'criar')).toThrow(/depende de investimento/);
    expect(validarEntrada({ ...ok, canal: 'social', metrica: 'leads' }, 'criar').canal).toBe('social');
    // na edição vale o conjunto: trocar só o canal de um experimento de CPL também é recusado
    expect(() => validarEntrada({ canal: 'organico' }, 'editar', { produto: 'rh', canal: 'meta', metrica: 'cpl', inicio: '2026-10-01', fim: '2026-10-30' })).toThrow(/depende de investimento/);
  });
  it('na edição, o fim é conferido contra o início que já existe', () => {
    expect(() => validarEntrada({ fim: '2026-09-15' }, 'editar', { produto: 'rh', canal: 'meta', metrica: 'cpl', inicio: '2026-10-01', fim: '2026-10-30' })).toThrow(/antes do início/);
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
    const p = calcularProgresso({ ...base, orcamento: 9000 }, { diario: d }, HOJE);
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
    const p = calcularProgresso({ ...base, orcamento: 5000 }, { diario: d }, HOJE);
    expect(p.gasto).toBe(4000);
    expect(p.usoOrcamento).toBeCloseTo(0.8, 6);
    expect(p.orcamentoAdiantado).toBe(true); // 80% do orçamento com 33% do prazo
    expect(calcularProgresso({ ...base, orcamento: 50_000 }, { diario: d }, HOJE).orcamentoAdiantado).toBe(false);
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

describe('Experimentos: repositório (banco simulado)', () => {
  const linha = (o: Record<string, unknown> = {}) => ({ id: 5, titulo: 'T', hipotese: null, produto: 'rh', canal: 'meta', metrica: 'leads', meta: 300, linha_base: null, orcamento: null, inicio: '2026-10-01', fim: '2026-10-30', status: 'rodando', ice_impacto: 8, ice_confianca: 6, ice_facilidade: 7, ice_score: 7, valor_final: null, atingimento_final: null, desfecho: null, aprendizado: null, criado_em: new Date('2026-10-01T10:00:00Z'), atualizado_em: new Date('2026-10-01T10:00:00Z'), ...o });
  const dados = (): DadosMonitor => { const diario = vazio(); meta(diario, '2026-10-01', '2026-10-10', { leads: 8, invest: 400 }); return { diario, ontemMesmaHora: { google: ZERO, meta: ZERO, social: ZERO, organico: ZERO }, hora: '10:00', trafegoAte: null }; };
  const montar = (rows: Array<Record<string, unknown>>) => {
    const sqls: Array<{ sql: string; params: unknown[] }> = [];
    const lidos: Array<{ produto: string; desde: string }> = [];
    const db = { query: async (sql: string, params: unknown[] = []) => {
      sqls.push({ sql: sql.replace(/\s+/g, ' '), params });
      if (/^\s*insert into mkt\.experimentos/i.test(sql)) return { rows: [{ id: 5 }] };
      if (/^\s*update mkt\.experimentos/i.test(sql)) return { rows: [] };
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
    async listar() { chamadas.push('listar'); return { hoje: '2026-10-11', metricas: METRICAS_EXP, canais: [] as never, experimentos: [], calibracao: [] }; },
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
    expect(chamadas).toEqual(['listar', 'criar', 'atualizar:7']);
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
  });
});
