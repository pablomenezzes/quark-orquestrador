import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createStudioServer } from '../studio/server';
import { METRICAS_EXP, PgExperimentosRepo, type ExperimentosRepo } from '../studio/lib/experimentos';
import { ZERO, type CanalId, type DadosMonitor, type Soma } from '../studio/lib/monitor';

const soma = (o: Partial<Soma>): Soma => ({ ...ZERO, ...o });
const dados = (): DadosMonitor => {
  const meta = new Map<string, Soma>();
  for (let k = 1; k <= 10; k++) meta.set(`2026-10-${String(k).padStart(2, '0')}`, soma({ leads: 8, invest: 400 }));
  return { diario: { google: new Map(), meta, social: new Map(), organico: new Map() } as Record<CanalId, Map<string, Soma>>, ontemMesmaHora: { google: ZERO, meta: ZERO, social: ZERO, organico: ZERO }, hora: '10:00', trafegoAte: null };
};
const linha = (o: Record<string, unknown> = {}) => ({ id: 5, titulo: 'T', tipo: 'experimento', produto: 'rh', canal: 'meta', metrica: 'leads', meta: 300, inicio: '2026-10-01', fim: '2026-10-30', status: 'rodando', criado_em: new Date(), atualizado_em: new Date('2026-10-01T10:00:00Z'), ...o });

function montar(rows: Array<Record<string, unknown>>, agora = { t: new Date('2026-10-11T15:00:00Z').getTime() }) {
  const consultas: string[] = [];
  const estado = { rows };
  const db = { query: async (sql: string) => { consultas.push(sql.replace(/\s+/g, ' ')); return { rows: /from mkt\.experimentos/.test(sql) ? estado.rows : [] }; } } as never;
  const leituras = { monitor: 0 };
  const repo = new PgExperimentosRepo(db, () => new Date(agora.t), async () => { leituras.monitor++; return dados(); });
  return { repo, consultas, leituras, agora, estado };
}

describe('Desempenho: lista rápida, resultados à parte e cache', () => {
  it('a lista rápida faz uma única consulta ao cadastro, não lê o Monitor e marca o resultado como "calculando"', async () => {
    const { repo, consultas, leituras } = montar([linha(), linha({ id: 6, status: 'backlog', metrica: null, meta: null })]);
    const l = await repo.listarBasico();
    expect(consultas).toHaveLength(1);
    expect(consultas[0]).toContain('from mkt.experimentos');
    expect(leituras.monitor).toBe(0);
    expect(l.experimentos).toHaveLength(2);
    expect(l.experimentos.every((e) => e.progresso.estado === 'carregando')).toBe(true);
    expect(l.metricas.length).toBe(METRICAS_EXP.length);
    expect(l.calibracao).toEqual([]);
  });
  it('os resultados chegam por experimento e batem com a lista completa', async () => {
    const { repo } = montar([linha()]);
    const p = await repo.progressos();
    const completa = await montar([linha()]).repo.listar();
    expect(p.hoje).toBe('2026-10-11');
    expect(p.progressos[5]).toEqual(completa.experimentos[0]!.progresso);
    expect(p.progressos[5]!.atual).toBe(80);
  });
  it('guarda os resultados por 2 minutos enquanto o cadastro não muda; "fresh" e a edição do cadastro refazem', async () => {
    const m = montar([linha()]);
    await m.repo.progressos();
    await m.repo.progressos();
    expect(m.leituras.monitor).toBe(1);
    m.agora.t += 119_000;
    await m.repo.progressos();
    expect(m.leituras.monitor).toBe(1);
    m.agora.t += 2_000; // passou de 2 minutos
    await m.repo.progressos();
    expect(m.leituras.monitor).toBe(2);
    await m.repo.progressos(true);
    expect(m.leituras.monitor).toBe(3);
    m.estado.rows = [linha({ atualizado_em: new Date('2026-10-11T14:59:00Z') })]; // o cadastro foi editado
    await m.repo.progressos();
    expect(m.leituras.monitor).toBe(4);
  });
  it('chamadas simultâneas dividem a mesma leitura e um erro não fica guardado', async () => {
    const m = montar([linha()]);
    await Promise.all([m.repo.progressos(), m.repo.progressos(), m.repo.progressos()]);
    expect(m.leituras.monitor).toBe(1);
    let falhas = 0;
    const db = { query: async (sql: string) => ({ rows: /from mkt\.experimentos/.test(sql) ? [linha()] : [] }) } as never;
    const repo = new PgExperimentosRepo(db, () => new Date('2026-10-11T15:00:00Z'), async () => { if (falhas++ === 0) throw new Error('banco fora'); return dados(); });
    await expect(repo.progressos()).rejects.toThrow('banco fora');
    expect((await repo.progressos()).progressos[5]!.atual).toBe(80); // a falha não ficou na guarda
  });
  it('as opções (várias visões) são guardadas por 15 minutos por produto e dividem a leitura', async () => {
    const consultas: string[] = [];
    const t = { v: new Date('2026-10-11T15:00:00Z').getTime() };
    const db = { query: async (sql: string) => { consultas.push(sql); return { rows: [] }; } } as never;
    const repo = new PgExperimentosRepo(db, () => new Date(t.v));
    await Promise.all([repo.opcoes('rh'), repo.opcoes('rh')]);
    const n1 = consultas.length;
    expect(n1).toBe(4); // páginas, campanhas, identificadores e campos: uma vez só
    await repo.opcoes('rh');
    expect(consultas.length).toBe(n1);
    await repo.opcoes('clinic'); // outro produto: outra leitura
    expect(consultas.length).toBe(n1 * 2);
    t.v += 15 * 60_000 + 1000;
    await repo.opcoes('rh');
    expect(consultas.length).toBe(n1 * 3);
  });
});

describe('Desempenho: rotas e tela', () => {
  const chamadas: string[] = [];
  const vazio = { hoje: 'x', metricas: METRICAS_EXP, canais: [] as never, tipos: [] as never, campos: [] as never, experimentos: [], calibracao: [] };
  const base = {
    async listar() { chamadas.push('listar'); return vazio; },
    async criar() { return { id: 1 } as never; }, async atualizar(id: number) { return { id } as never; }, async relatorio(id: number) { return { id } as never; },
    async salvarDocumentacao(id: number) { return { id, atualizadoEm: 'x' }; }, async opcoes() { return { paginas: [], campanhas: [], identificadores: [], camposPipe: [] }; }, async valores() { return []; },
  };
  const repoRapido = {
    ...base,
    async listarBasico() { chamadas.push('basico'); return vazio; },
    async progressos(fresh?: boolean) { chamadas.push(`progresso:${fresh ? 'fresh' : 'normal'}`); return { hoje: 'x', progressos: {} }; },
  } as ExperimentosRepo;
  let a: Server, b: Server, ua: string, ub: string, dir: string;
  const mk = (experimentos: ExperimentosRepo) => createStudioServer({ formsDir: join(dir, 'f'), publicDir: join(dir, 'p'), trackingDir: join(dir, 't'), sources: [], dbInfo: () => ({ connected: true }), submit: async () => ({ status: 200, body: {} }), experimentos } as never);
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'studio-perf-'));
    for (const d of ['f', 'p', 't']) mkdirSync(join(dir, d));
    a = mk(repoRapido); b = mk(base as ExperimentosRepo);
    await Promise.all([a, b].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    ua = `http://127.0.0.1:${(a.address() as AddressInfo).port}`; ub = `http://127.0.0.1:${(b.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await Promise.all([a, b].map((s) => new Promise((r) => s.close(r)))); rmSync(dir, { recursive: true, force: true }); });

  it('?rapido=1 devolve só o cadastro; sem o parâmetro, tudo junto como antes; /progresso aceita fresh', async () => {
    await fetch(`${ua}/api/experimentos?rapido=1`);
    await fetch(`${ua}/api/experimentos`);
    await fetch(`${ua}/api/experimentos/progresso`);
    await fetch(`${ua}/api/experimentos/progresso?fresh=1`);
    expect(chamadas).toEqual(['basico', 'listar', 'progresso:normal', 'progresso:fresh']);
    expect((await fetch(`${ua}/api/experimentos/progresso`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ua }, body: '{}' })).status).toBe(405);
  });
  it('um repositório sem a lista rápida continua funcionando (cai em listar) e /progresso responde 404', async () => {
    chamadas.length = 0;
    expect((await fetch(`${ub}/api/experimentos?rapido=1`)).status).toBe(200);
    expect(chamadas).toEqual(['listar']);
    expect((await fetch(`${ub}/api/experimentos/progresso`)).status).toBe(404);
  });
  it('a página pede o cadastro primeiro, calcula os resultados depois e busca as opções só ao abrir a ficha', () => {
    const js = readFileSync(new URL('../studio/public/experimentos.js', import.meta.url), 'utf8');
    expect(js).toContain("api('/api/experimentos?rapido=1')");
    expect(js).toContain('/api/experimentos/progresso');
    expect(js).toContain('garantirOpcoes');
    expect(js).toMatch(/function abrirFicha\(id\) \{ garantirOpcoes\(\);/);
    const corpoCarregar = js.slice(js.indexOf('async function carregar(fresh'), js.indexOf('async function carregarProgresso'));
    expect(corpoCarregar).not.toContain('carregarOpcoes'); // não busca mais as opções a cada carregamento
    expect(js).toContain('carregar(true)'); // "Atualizar agora" ignora a guarda
    expect(readFileSync(new URL('../api/studio.ts', import.meta.url), 'utf8')).toContain('max: 2');
  });
});

describe('Conexões do banco: limite do papel do painel', () => {
  it('a migration sobe o limite do papel e o app usa poucas conexões por instância e solta as ociosas', () => {
    const mig = readFileSync(new URL('../supabase/migrations/0032_papel_painel_mais_conexoes.sql', import.meta.url), 'utf8');
    expect(mig).toMatch(/alter role orq_panel connection limit 15;/);
    const api = readFileSync(new URL('../api/studio.ts', import.meta.url), 'utf8');
    expect(api).toMatch(/max: 2, idleTimeoutMillis: 10_000/);
    expect(readFileSync(new URL('../studio/main.ts', import.meta.url), 'utf8')).toMatch(/connectionString: painelUrl, max: 2, idleTimeoutMillis: 10_000/);
  });
  it('"too many connections" (53300) vira 503 com instrução, não internal_error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-conn-'));
    for (const d of ['f', 'p', 't']) mkdirSync(join(dir, d));
    const repo = { async listar() { throw Object.assign(new Error('too many connections for role "orq_panel"'), { code: '53300' }); } } as unknown as ExperimentosRepo;
    const s = createStudioServer({ formsDir: join(dir, 'f'), publicDir: join(dir, 'p'), trackingDir: join(dir, 't'), sources: [], dbInfo: () => ({ connected: true }), submit: async () => ({ status: 200, body: {} }), experimentos: repo } as never);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/experimentos`);
    expect(r.status).toBe(503);
    const corpo = await r.json();
    expect(corpo.error).toBe('banco_ocupado');
    expect(corpo.detail).toMatch(/Aguarde alguns segundos/);
    expect(JSON.stringify(corpo)).not.toContain('orq_panel');
    await new Promise((ok) => s.close(ok));
    rmSync(dir, { recursive: true, force: true });
  });
});
