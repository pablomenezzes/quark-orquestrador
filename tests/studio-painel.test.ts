import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createStudioServer } from '../studio/server';
import { PainelNotFound, type PainelRepo } from '../studio/lib/painel-repo';

let server: Server;
let serverSem: Server;
let base: string;
let baseSem: string;
let dir: string;

const calls: Array<[string, unknown[]]> = [];
let failWith: Error | null = null;

const repo: PainelRepo = {
  async saude() {
    if (failWith) throw failWith;
    return {
      entidades: [{ entity: 'pipelines', ultimo_sucesso_em: '2026-10-05T12:00:00.000Z', backfill_concluido: false, ultimo_status: 'ok', atrasada: false }],
      jobs: [{ job_id: 'j1', entity: 'pipelines', status: 'ok', lidos: 2 }],
      erros: [],
      uso: [{ dia: '2026-10-05', tokens_gastos: 70, requisicoes: 7, limite_429: 0 }],
    };
  },
  async config() {
    return [
      { pipeline_id: 1, pipeline: 'Funil RH', pipeline_ordem: 1, produto: 'rh', etapas: [{ stage_id: 11, etapa: 'Lead', etapa_ordem: 1, marco: 'lead' }] },
      { pipeline_id: 2, pipeline: 'Funil Clínica', pipeline_ordem: 2, produto: null, etapas: [] },
    ];
  },
  async usuarios() {
    return [{ user_id: 100, nome: 'Ana Teste', ativo: true }];
  },
  async campos() {
    return [{ entity: 'deal', field_key: 'a'.repeat(40), nome_pipedrive: 'Origem', rotulo: null, tipo: 'enum', ordem: 1 }];
  },
  async setPipelineProduto(id, produto) {
    calls.push(['pipeline', [id, produto]]);
    if (id === 999) throw new PainelNotFound('pipeline');
  },
  async setStageMarco(id, marco) {
    calls.push(['stage', [id, marco]]);
    if (id === 999) throw new PainelNotFound('etapa');
  },
};

const mkServer = (painel: PainelRepo | null) =>
  createStudioServer({
    formsDir: join(dir, 'forms'),
    publicDir: join(dir, 'public'),
    trackingDir: join(dir, 'tracking'),
    sources: [],
    dbInfo: () => ({ connected: true }),
    submit: async () => ({ status: 200, body: {} }),
    painel,
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'studio-painel-'));
  for (const d of ['forms', 'public', 'tracking']) mkdirSync(join(dir, d));
  writeFileSync(join(dir, 'public', 'painel.html'), '<h1>painel de dados</h1>');
  writeFileSync(join(dir, 'public', 'index.html'), '<h1>builder</h1>');
  writeFileSync(join(dir, 'public', 'form.html'), '<h1>form</h1>');
  server = mkServer(repo);
  serverSem = mkServer(null);
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
  failWith = null;
});

const J = { 'content-type': 'application/json' };
const put = (path: string, body: unknown, headers: Record<string, string> = {}, b = base) =>
  fetch(`${b}${path}`, { method: 'PUT', headers: { ...J, ...headers }, body: JSON.stringify(body) });

describe('páginas e leitura', () => {
  it('serve a página do Painel', async () => {
    expect(await (await fetch(`${base}/painel`)).text()).toContain('painel de dados');
  });
  it('saúde: entidades, jobs, erros e uso da cota', async () => {
    const j = await (await fetch(`${base}/api/painel/saude`)).json();
    expect(j.entidades[0]).toMatchObject({ entity: 'pipelines', ultimo_status: 'ok' });
    expect(j.jobs).toHaveLength(1);
    expect(j.uso[0].tokens_gastos).toBe(70);
  });
  it('configuração: pipelines com etapas, produto e marco', async () => {
    const j = await (await fetch(`${base}/api/painel/config`)).json();
    expect(j).toHaveLength(2);
    expect(j[0]).toMatchObject({ pipeline: 'Funil RH', produto: 'rh' });
    expect(j[0].etapas[0]).toMatchObject({ etapa: 'Lead', marco: 'lead' });
    expect(j[1].produto).toBeNull();
  });
  it('usuários (sem e-mail) e campos', async () => {
    const u = await (await fetch(`${base}/api/painel/usuarios`)).json();
    expect(u[0]).toEqual({ user_id: 100, nome: 'Ana Teste', ativo: true });
    const c = await (await fetch(`${base}/api/painel/campos`)).json();
    expect(c[0].field_key).toHaveLength(40);
  });
});

describe('gravar a configuração (a única escrita do Painel)', () => {
  it.each(['rh', 'clinic', null])('pipeline -> produto %s', async (produto) => {
    const r = await put('/api/painel/config/pipeline/1', { produto });
    expect(r.status).toBe(200);
    expect(calls).toEqual([['pipeline', [1, produto]]]);
  });
  it.each(['lead', 'mql', 'sql', 'reuniao', 'proposta', 'ganho', 'perdido', null])('etapa -> marco %s', async (marco) => {
    const r = await put('/api/painel/config/stage/11', { marco });
    expect(r.status).toBe(200);
    expect(calls).toEqual([['stage', [11, marco]]]);
  });
  it('valores fora da lista são recusados e nada é gravado', async () => {
    for (const body of [{ produto: 'outro' }, { produto: '' }, { produto: 1 }, {}, { produto: ['rh'] }]) {
      expect((await put('/api/painel/config/pipeline/1', body)).status, JSON.stringify(body)).toBe(400);
    }
    for (const body of [{ marco: 'qualificado' }, { marco: 'GANHO' }, {}]) {
      expect((await put('/api/painel/config/stage/11', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toEqual([]);
  });
  it('ID inválido é recusado', async () => {
    for (const id of ['abc', '1.5', '-1', '1;drop', '99999999999999999999']) {
      expect((await put(`/api/painel/config/pipeline/${encodeURIComponent(id)}`, { produto: 'rh' })).status, id).toBe(400);
    }
    expect(calls).toEqual([]);
  });
  it('pipeline ou etapa que não existe: 404', async () => {
    expect((await put('/api/painel/config/pipeline/999', { produto: 'rh' })).status).toBe(404);
    expect((await put('/api/painel/config/stage/999', { marco: 'lead' })).status).toBe(404);
  });
  it('o Painel NÃO oferece nenhuma outra escrita: POST/DELETE nas rotas dele não existem', async () => {
    for (const p of ['/api/painel/saude', '/api/painel/config', '/api/painel/usuarios', '/api/painel/config/pipeline/1']) {
      for (const method of ['POST', 'DELETE', 'PATCH']) {
        const r = await fetch(`${base}${p}`, { method, headers: J, body: '{}' });
        expect([404, 405], `${method} ${p}`).toContain(r.status);
      }
    }
    expect(calls).toEqual([]);
  });
});

describe('proteções e falhas', () => {
  it('escrita vinda de outra origem é barrada (anti CSRF)', async () => {
    const r = await put('/api/painel/config/pipeline/1', { produto: 'rh' }, { origin: 'https://site-malicioso.com' });
    expect(r.status).toBe(403);
    expect(calls).toEqual([]);
  });
  it('sem o banco do Painel configurado: 503 com explicação, sem quebrar o Studio', async () => {
    const r = await fetch(`${baseSem}/api/painel/saude`);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe('painel_nao_configurado');
    expect(await (await fetch(`${baseSem}/painel`)).text()).toContain('painel de dados'); // a página abre e avisa
    expect(await (await fetch(`${baseSem}/`)).text()).toContain('builder');
  });
  it('erro do banco: 500 genérico, sem vazar a mensagem', async () => {
    failWith = new Error('senha=segredo postgresql://u:p@h/db');
    const r = await fetch(`${base}/api/painel/saude`);
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain('segredo');
  });
});
