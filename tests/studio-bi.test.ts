import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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
  catalogo: () => [{ id: 'visao-geral', pagina: 'geral', titulo: 'Visão geral', pergunta: 'Como estão?', como_ler: 'Leia assim.', largura: 'cheia' }],
  async opcoes() {
    return {
      pipelines: [{ pipeline_id: 1, pipeline: 'Funil RH', produto: 'rh' }],
      produtos: ['rh', 'clinic'],
      primeiro_negocio: '2019-01-01',
      fontes: [{ id: '366', nome: 'Marketing [Google ADS]', padrao: true }, { id: '220', nome: 'Indicação CX', padrao: false }],
      tipos: [{ id: '112', nome: 'Marketing', padrao: true }],
      paginas: [{ id: 'geral', rotulo: 'Visão geral' }, { id: 'safra', rotulo: 'Safra' }, { id: 'canais', rotulo: 'Canais' }, { id: 'qualidade', rotulo: 'Qualidade' }],
    };
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
  for (const f of ['bi.html', 'index.html', 'inicio.html', 'form.html', 'painel.html']) writeFileSync(join(dir, 'public', f), `<h1>${f}</h1>`);
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

describe('menu único e páginas', () => {
  it('"/" é o Início (última atualização) e o Studio de testes passou para "/studio"', async () => {
    expect(await (await get('/')).text()).toContain('inicio.html');
    expect(await (await get('/studio')).text()).toContain('index.html');
    expect(await (await get('/bi')).text()).toContain('bi.html');
    expect(await (await get('/painel')).text()).toContain('painel.html');
  });
  it('as páginas do menu seguem a ordem: Início, BI, Painel de Dados e, por último, Studio (testes)', () => {
    const nav = readFileSync(new URL('../studio/public/nav.js', import.meta.url), 'utf8');
    const ordem = [...nav.matchAll(/\['(\w+)', '([^']+)', '(\/[^']*)'\]/g)].map((m) => [m[1], m[2], m[3]]);
    expect(ordem).toEqual([['inicio', 'Início', '/'], ['bi', 'BI', '/bi'], ['painel', 'Painel de Dados', '/painel'], ['studio', 'Studio (testes)', '/studio']]);
  });
  it('todas as páginas usam o mesmo menu (nav.js) e dizem em qual página estão', () => {
    const esperado: Record<string, string> = { 'inicio.html': 'inicio', 'bi.html': 'bi', 'painel.html': 'painel', 'index.html': 'studio' };
    for (const [arq, pagina] of Object.entries(esperado)) {
      const html = readFileSync(new URL(`../studio/public/${arq}`, import.meta.url), 'utf8');
      expect(html, arq).toContain(`data-pagina="${pagina}"`);
      expect(html, arq).toContain('/s/nav.js');
    }
  });
});

describe('BI: catálogo e opções dos filtros', () => {
  it('catálogo traz as análises, as páginas, os pipelines, as fontes e os tipos (com a seleção fixa marcada)', async () => {
    const j = await (await get('/api/bi/catalogo')).json();
    expect(j.analises[0]).toMatchObject({ id: 'visao-geral', pagina: 'geral', titulo: 'Visão geral' });
    expect(j.pipelines[0]).toMatchObject({ pipeline_id: 1, produto: 'rh' });
    expect(j.produtos).toEqual(['rh', 'clinic']);
    expect(j.paginas.map((p: { id: string }) => p.id)).toEqual(['geral', 'safra', 'canais', 'qualidade']);
    expect(j.fontes).toContainEqual({ id: '366', nome: 'Marketing [Google ADS]', padrao: true });
    expect(j.tipos[0]).toMatchObject({ nome: 'Marketing', padrao: true });
  });
});

describe('BI: rodar uma análise com filtros', () => {
  it('repassa o período e os filtros validados', async () => {
    const r = await get('/api/bi/analise/visao-geral?de=2026-01-01&ate=2026-10-08&produto=rh&pipeline=1');
    expect(r.status).toBe(200);
    expect((await r.json()).grafico.tipo).toBe('kpis');
    expect(calls).toEqual([['visao-geral', { de: '2026-01-01', ate: '2026-10-08', produto: 'rh', pipeline_id: 1 }]]);
  });
  it('Fonte e Tipo do Lead: aceita IDs de opção e "branco", separados por vírgula', async () => {
    const r = await get('/api/bi/analise/visao-geral?de=2026-01-01&ate=2026-10-08&fonte=366,365,branco&tipo=112');
    expect(r.status).toBe(200);
    expect(calls[0]![1]).toEqual({ de: '2026-01-01', ate: '2026-10-08', fontes: ['366', '365', 'branco'], tipos: ['112'] });
  });
  it('sem Fonte e Tipo no pedido, não há filtro (todas as opções)', async () => {
    await get('/api/bi/analise/visao-geral?de=2026-01-01&ate=2026-10-08');
    expect(calls[0]![1].fontes).toBeUndefined();
    expect(calls[0]![1].tipos).toBeUndefined();
  });
  it.each([
    'fonte=abc', 'fonte=366;drop', "fonte=366'", 'fonte=-1', 'fonte=1234567890', 'fonte=BRANCO', 'tipo=1.5', 'tipo=112,x', `fonte=${Array.from({ length: 41 }, (_, i) => i + 1).join(',')}`,
  ])('Fonte/Tipo inválido (%s) é recusado e nada é consultado', async (qs) => {
    expect((await get(`/api/bi/analise/visao-geral?de=2026-01-01&ate=2026-10-08&${qs}`)).status).toBe(400);
    expect(calls).toEqual([]);
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
  it('Fonte e Tipo também entram só como parâmetros (lista de IDs); "branco" vira "é nulo"', async () => {
    const sqls: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: async (sql: string, params: unknown[] = []) => (sqls.push({ sql, params }), { rows: [{}] }) };
    await BI_ANALISES.find((x) => x.id === 'visao-geral')!.rodar(db as never, { de: '2026-01-01', ate: '2026-12-31', fontes: ['366', '365', 'branco'], tipos: ['112'] });
    expect(sqls[0]!.params).toEqual(['2026-01-01', '2026-12-31', ['366', '365'], ['112']]);
    expect(sqls[0]!.sql).toMatch(/d\.fonte_id = any\(\$3::text\[\]\) or d\.fonte_id is null/);
    expect(sqls[0]!.sql).toMatch(/d\.tipo_id = any\(\$4::text\[\]\)/);
    expect(sqls[0]!.sql).not.toContain('366');
  });
  it('as quatro páginas têm análises e cada análise pertence a uma página conhecida', () => {
    const paginas = new Set(BI_ANALISES.map((a) => a.pagina));
    expect([...paginas].sort()).toEqual(['canais', 'geral', 'qualidade', 'safra']);
    expect(BI_ANALISES.filter((a) => a.pagina === 'safra').length).toBeGreaterThanOrEqual(3);
    expect(BI_ANALISES.filter((a) => a.pagina === 'canais').length).toBeGreaterThanOrEqual(3);
    expect(BI_ANALISES.filter((a) => a.pagina === 'qualidade').length).toBeGreaterThanOrEqual(5);
  });
});
