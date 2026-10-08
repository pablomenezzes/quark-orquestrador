import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createStudioServer } from '../studio/server';

let server: Server;
let base: string;
let dir: string;
const submits: Array<{ formId: string; mode: string; payload: any }> = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'studio-srv-'));
  mkdirSync(join(dir, 'forms'));
  mkdirSync(join(dir, 'public'));
  mkdirSync(join(dir, 'tracking'));
  writeFileSync(join(dir, 'public', 'index.html'), '<h1>builder</h1>');
  writeFileSync(join(dir, 'public', 'inicio.html'), '<h1>inicio</h1>');
  writeFileSync(join(dir, 'public', 'form.html'), '<h1>form</h1>');
  writeFileSync(join(dir, 'public', 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'tracking', 'attribution.js'), '/* attr */');
  writeFileSync(join(dir, 'segredo.txt'), 'SEGREDO');
  server = createStudioServer({
    formsDir: join(dir, 'forms'),
    publicDir: join(dir, 'public'),
    trackingDir: join(dir, 'tracking'),
    sources: ['lp-vercel-rh-teste'],
    dbInfo: () => ({ connected: true }),
    submit: async (formId, mode, payload) => {
      submits.push({ formId, mode, payload });
      return { status: 200, body: { ok: true, dry_run: mode !== 'real' } };
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const JSON_H = { 'content-type': 'application/json' };
const form = (over: object = {}) => ({
  id: 'demo',
  title: 'Demo',
  source_slug: 'lp-vercel-rh-teste',
  fields: [{ id: 'f1', key: 'nome', type: 'text', label: 'Nome', map: 'name' }],
  ...over,
});

describe('páginas estáticas', () => {
  it('serve o construtor, o formulário e o script de atribuição', async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain('inicio'); // a tela inicial
    expect(await (await fetch(`${base}/studio`)).text()).toContain('builder'); // o construtor de testes passou para /studio
    expect(await (await fetch(`${base}/f/demo`)).text()).toContain('form');
    expect(await (await fetch(`${base}/s/app.js`)).text()).toContain('console.log');
    expect(await (await fetch(`${base}/attribution.js`)).text()).toContain('attr');
  });
  it('não sai da pasta pública (path traversal)', async () => {
    for (const p of ['/s/../segredo.txt', '/s/%2e%2e/segredo.txt', '/s/..%5Csegredo.txt']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain('SEGREDO');
    }
  });
  it('404 para rotas desconhecidas e id de formulário inválido na página', async () => {
    expect((await fetch(`${base}/nada`)).status).toBe(404);
    expect((await fetch(`${base}/f/..%2Fx`)).status).toBe(404);
  });
});

describe('API de formulários', () => {
  it('cria, lista, lê e apaga', async () => {
    const put = await fetch(`${base}/api/forms/demo`, { method: 'PUT', headers: JSON_H, body: JSON.stringify(form()) });
    expect(put.status).toBe(200);
    const list = await (await fetch(`${base}/api/forms`)).json();
    expect(list.map((f: any) => f.id)).toEqual(['demo']);
    const got = await (await fetch(`${base}/api/forms/demo`)).json();
    expect(got.title).toBe('Demo');
    expect((await fetch(`${base}/api/forms/demo`, { method: 'DELETE', headers: JSON_H })).status).toBe(200);
    expect((await fetch(`${base}/api/forms/demo`)).status).toBe(404);
  });

  it('400 com as mensagens quando o formulário é inválido; o id da URL manda', async () => {
    const bad = await fetch(`${base}/api/forms/demo`, { method: 'PUT', headers: JSON_H, body: JSON.stringify(form({ title: '' })) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).issues.length).toBeGreaterThan(0);
    const other = await fetch(`${base}/api/forms/outro`, { method: 'PUT', headers: JSON_H, body: JSON.stringify(form()) });
    expect(other.status).toBe(200);
    expect((await (await fetch(`${base}/api/forms/outro`)).json()).id).toBe('outro');
    await fetch(`${base}/api/forms/outro`, { method: 'DELETE', headers: JSON_H });
  });

  it('meta: fontes e estado do banco', async () => {
    const m = await (await fetch(`${base}/api/meta`)).json();
    expect(m).toMatchObject({ sources: ['lp-vercel-rh-teste'], db: { connected: true } });
  });
});

describe('envio', () => {
  it('simulação é o padrão e o formulário sempre vem do servidor', async () => {
    await fetch(`${base}/api/forms/demo`, { method: 'PUT', headers: JSON_H, body: JSON.stringify(form()) });
    submits.length = 0;
    const r = await fetch(`${base}/api/submit/demo`, { method: 'POST', headers: JSON_H, body: JSON.stringify({ payload: { event_id: 'abcdefgh1' } }) });
    expect(r.status).toBe(200);
    expect(submits[0]).toMatchObject({ formId: 'demo', mode: 'dry' });
  });

  it('gravar de verdade exige mode:"real" explícito', async () => {
    submits.length = 0;
    await fetch(`${base}/api/submit/demo`, { method: 'POST', headers: JSON_H, body: JSON.stringify({ mode: 'real', payload: {} }) });
    await fetch(`${base}/api/submit/demo`, { method: 'POST', headers: JSON_H, body: JSON.stringify({ mode: 'qualquer', payload: {} }) });
    expect(submits.map((s) => s.mode)).toEqual(['real', 'dry']);
  });

  it('404 para formulário inexistente', async () => {
    const r = await fetch(`${base}/api/submit/nao-existe`, { method: 'POST', headers: JSON_H, body: JSON.stringify({ payload: {} }) });
    expect(r.status).toBe(404);
  });
});

describe('proteções do servidor local', () => {
  it('recusa Host que não é loopback (DNS rebinding)', async () => {
    // fetch proíbe sobrescrever o Host; node:http permite.
    const { request } = await import('node:http');
    const url = new URL(base);
    const status = await new Promise<number>((resolve, reject) => {
      const rq = request({ host: url.hostname, port: url.port, path: '/api/forms', headers: { host: 'atacante.com' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      rq.on('error', reject);
      rq.end();
    });
    expect(status).toBe(403);
  });
  it('recusa escrita vinda de outra origem (CSRF)', async () => {
    const r = await fetch(`${base}/api/forms/demo`, { method: 'PUT', headers: { ...JSON_H, origin: 'https://site-malicioso.com' }, body: JSON.stringify(form()) });
    expect(r.status).toBe(403);
    const s = await fetch(`${base}/api/submit/demo`, { method: 'POST', headers: { ...JSON_H, origin: 'https://site-malicioso.com' }, body: JSON.stringify({ mode: 'real', payload: {} }) });
    expect(s.status).toBe(403);
  });
  it('recusa escrita sem content-type JSON', async () => {
    const r = await fetch(`${base}/api/forms/demo`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(form()) });
    expect(r.status).toBe(415);
  });
  it('recusa corpo gigante', async () => {
    const big = JSON.stringify(form({ description: 'x'.repeat(2_000_000) }));
    const r = await fetch(`${base}/api/forms/demo`, { method: 'PUT', headers: JSON_H, body: big });
    expect(r.status).toBe(413);
  });
  it('aceita a própria origem', async () => {
    const r = await fetch(`${base}/api/forms/demo`, { method: 'PUT', headers: { ...JSON_H, origin: base }, body: JSON.stringify(form()) });
    expect(r.status).toBe(200);
  });
});
