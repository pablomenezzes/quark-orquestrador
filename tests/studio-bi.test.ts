import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest, type Server } from 'node:http';
import { createStudioServer } from '../studio/server';
import { BI_ANALISES, BiNotFound, type BiFiltros, type BiRepo } from '../studio/lib/bi';

let server: Server;
let serverSem: Server;
let base: string;
let baseSem: string;
let dir: string;
const calls: Array<[string, BiFiltros]> = [];

const repo: BiRepo = {
  catalogo: () => [{ id: 'visao-geral', titulo: 'Visão geral', pergunta: 'Como estão?', como_ler: 'Leia assim.', largura: 'cheia' }],
  async opcoes() {
    return { pipelines: [{ pipeline_id: 1, pipeline: 'Funil RH', produto: 'rh' }], produtos: ['rh', 'clinic'], primeiro_negocio: '2019-01-01' };
  },
  async rodar(id, f) {
    if (id !== 'visao-geral') throw new BiNotFound('análise');
    calls.push([id, f]);
    return { grafico: { tipo: 'kpis', itens: [{ id: 'leads', rotulo: 'Leads', valor: 10, formato: 'int' }] }, tabela: { colunas: [{ id: 'a', rotulo: 'A', tipo: 'int' }], linhas: [{ a: 10 }] }, avisos: [] };
  },
};

const mk = (bi: BiRepo | null) =>
  createStudioServer({ formsDir: join(dir, 'forms'), publicDir: join(dir, 'public'), trackingDir: join(dir, 'tracking'), sources: [], dbInfo: () => ({ connected: true }), submit: async () => ({ status: 200, body: {} }), bi });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'studio-bi-'));
  for (const d of ['forms', 'public', 'tracking']) mkdirSync(join(dir, d));
  for (const f of ['bi.html', 'index.html', 'form.html', 'painel.html']) writeFileSync(join(dir, 'public', f), `<h1>${f}</h1>`);
  server = mk(repo);
  serverSem = mk(null);
  await Promise.all([server, serverSem].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  baseSem = `http://127.0.0.1:${(serverSem.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await Promise.all([server, serverSem].map((s) => new Promise((r) => s.close(r))));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
});

const get = (p: string, b = base) => fetch(`${b}${p}`);

describe('BI: páginas e catálogo', () => {
  it('serve a página do BI', async () => {
    expect(await (await get('/bi')).text()).toContain('bi.html');
  });
  it('catálogo traz as análises, os pipelines e os produtos para os filtros', async () => {
    const j = await (await get('/api/bi/catalogo')).json();
    expect(j.analises[0]).toMatchObject({ id: 'visao-geral', titulo: 'Visão geral' });
    expect(j.pipelines[0]).toMatchObject({ pipeline_id: 1, produto: 'rh' });
    expect(j.produtos).toEqual(['rh', 'clinic']);
  });
});

describe('BI: rodar uma análise com filtros', () => {
  it('repassa o período e os filtros validados', async () => {
    const r = await get('/api/bi/analise/visao-geral?de=2026-01-01&ate=2026-10-08&produto=rh&pipeline=1');
    expect(r.status).toBe(200);
    expect((await r.json()).grafico.tipo).toBe('kpis');
    expect(calls).toEqual([['visao-geral', { de: '2026-01-01', ate: '2026-10-08', produto: 'rh', pipeline_id: 1 }]]);
  });
  it('só o período é obrigatório', async () => {
    await get('/api/bi/analise/visao-geral?de=2025-01-01&ate=2025-12-31');
    expect(calls[0]![1]).toEqual({ de: '2025-01-01', ate: '2025-12-31' });
  });
  it.each([
    '', 'de=2026-01-01', 'ate=2026-01-01', 'de=2026-1-1&ate=2026-12-31', 'de=2026-02-30&ate=2026-12-31', 'de=2026-13-01&ate=2026-12-31', 'de=abc&ate=2026-12-31',
    "de=2026-01-01&ate=2026-12-31';drop", 'de=2026-12-31&ate=2026-01-01',
    'de=2026-01-01&ate=2026-12-31&produto=outro', 'de=2026-01-01&ate=2026-12-31&produto=RH', 'de=2026-01-01&ate=2026-12-31&pipeline=abc', 'de=2026-01-01&ate=2026-12-31&pipeline=1;drop',
  ])('filtro inválido (%s) é recusado e nada é consultado', async (qs) => {
    expect((await get(`/api/bi/analise/visao-geral?${qs}`)).status).toBe(400);
    expect(calls).toEqual([]);
  });
  it('análise que não existe: 404; id com caracteres estranhos: 404', async () => {
    expect((await get('/api/bi/analise/nao-existe?de=2026-01-01&ate=2026-12-31')).status).toBe(404);
    for (const id of ['..%2F..', 'VISAO', 'a;b', 'x'.repeat(61)]) expect((await get(`/api/bi/analise/${id}?de=2026-01-01&ate=2026-12-31`)).status, id).toBe(404);
  });
});

describe('BI: só leitura e proteções', () => {
  it('não há como escrever: POST, PUT, DELETE e PATCH não passam', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const p of ['/api/bi/catalogo', '/api/bi/analise/visao-geral?de=2026-01-01&ate=2026-12-31']) {
        const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: '{}' });
        expect([404, 405], `${method} ${p}`).toContain(r.status);
      }
    }
    expect(calls).toEqual([]);
  });
  it('sem o banco do Painel configurado: 503 com explicação, e o resto do Studio segue', async () => {
    const r = await get('/api/bi/catalogo', baseSem);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe('bi_nao_configurado');
    expect(await (await get('/bi', baseSem)).text()).toContain('bi.html');
  });
  it('host estranho é barrado (anti DNS-rebinding)', async () => {
    const port = (server.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/api/bi/catalogo', headers: { host: 'site-malicioso.com' } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe('catálogo de análises (definição)', () => {
  it('cada análise tem id único, título, pergunta e como ler; ids seguros para a rota', () => {
    const ids = BI_ANALISES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of BI_ANALISES) {
      expect(a.id, a.id).toMatch(/^[a-z0-9-]{1,60}$/);
      expect(a.titulo.length).toBeGreaterThan(3);
      expect(a.pergunta.length).toBeGreaterThan(10);
      expect(a.como_ler.length).toBeGreaterThan(20);
      expect(['cheia', 'meia']).toContain(a.largura);
    }
  });
  it('só consultam visões de analytics: nunca raw, crm, core, orq nem ops', async () => {
    const consultas: string[] = [];
    const db = { query: async (sql: string) => (consultas.push(sql), { rows: [{ ano_criacao: 2026, pendentes: 0 }] }) };
    for (const a of BI_ANALISES) await a.rodar(db as never, { de: '2026-01-01', ate: '2026-12-31' }).catch(() => undefined);
    expect(consultas.length).toBeGreaterThan(5);
    for (const sql of consultas) {
      expect(sql, sql.slice(0, 80)).not.toMatch(/\b(raw|crm|core|orq|ops)\.[a-z_]+/);
      expect(sql, sql.slice(0, 80)).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|create)\b/i);
    }
  });
  it('os filtros entram sempre como parâmetros, nunca colados no SQL', async () => {
    const sqls: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: async (sql: string, params: unknown[] = []) => (sqls.push({ sql, params }), { rows: [{}] }) };
    const a = BI_ANALISES.find((x) => x.id === 'visao-geral')!;
    await a.rodar(db as never, { de: '2026-01-01', ate: '2026-12-31', produto: 'rh', pipeline_id: 7 });
    expect(sqls[0]!.params).toEqual(['2026-01-01', '2026-12-31', 'rh', 7]);
    expect(sqls[0]!.sql).not.toContain('2026-01-01');
    expect(sqls[0]!.sql).not.toContain("'rh'");
  });
});
