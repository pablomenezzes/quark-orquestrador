import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createStudioServer } from '../studio/server';
import { SincroniaManual, WORKFLOWS, githubConfigDoAmbiente, workflowValido } from '../studio/lib/sincronia-manual';
import type { AuthService, Papel } from '../studio/lib/auth';

const cfg = { token: 'github_pat_segredo', repo: 'pablomenezzes/quark-orquestrador', ref: 'main' };
type Chamada = { url: string; metodo: string; corpo: any; auth?: string };
function fake(resposta: (c: Chamada) => { status?: number; corpo?: unknown }) {
  const chamadas: Chamada[] = [];
  const f = (async (url: string, init: any = {}) => {
    const c: Chamada = { url, metodo: init.method ?? 'GET', auth: init.headers?.authorization, corpo: init.body ? JSON.parse(init.body) : undefined };
    chamadas.push(c);
    const r = resposta(c);
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.corpo ?? {} };
  }) as unknown as typeof fetch;
  return { f, chamadas };
}
const run = (o: Record<string, unknown> = {}) => ({ id: 1, status: 'completed', conclusion: 'success', run_started_at: '2026-10-27T10:00:00Z', updated_at: '2026-10-27T10:05:00Z', html_url: 'https://github.com/x/y/actions/runs/1', event: 'schedule', ...o });

describe('Gatilho manual da sincronização: configuração', () => {
  it('sem token não está configurado; tem padrões; recusa repositório e branch estranhos', () => {
    expect(githubConfigDoAmbiente({})).toBeNull();
    expect(githubConfigDoAmbiente({ GITHUB_DISPATCH_TOKEN: 't' })).toEqual({ token: 't', repo: 'pablomenezzes/quark-orquestrador', ref: 'main' });
    expect(githubConfigDoAmbiente({ GITHUB_DISPATCH_TOKEN: 't', GITHUB_REPO: 'a/b', GITHUB_REF: 'producao' })).toMatchObject({ repo: 'a/b', ref: 'producao' });
    expect(() => githubConfigDoAmbiente({ GITHUB_DISPATCH_TOKEN: 't', GITHUB_REPO: 'https://evil.com/x' })).toThrow(/GITHUB_REPO/);
    expect(() => githubConfigDoAmbiente({ GITHUB_DISPATCH_TOKEN: 't', GITHUB_REF: 'a b; rm' })).toThrow(/GITHUB_REF/);
  });
  it('só os workflows da lista são aceitos', () => {
    expect(Object.keys(WORKFLOWS)).toEqual(['sincronia', 'meta-incremental']);
    expect(workflowValido('sincronia')).toBe(true);
    for (const ruim of ['../../x.yml', 'sincronia.yml', 'toString', '__proto__', '', 5, null]) expect(workflowValido(ruim), String(ruim)).toBe(false);
  });
});

describe('Gatilho manual da sincronização: GitHub (simulado)', () => {
  it('lista as execuções dos dois workflows, mais recentes primeiro, com situação e origem', async () => {
    const { f, chamadas } = fake((c) => (c.url.includes('sincronia.yml')
      ? { corpo: { workflow_runs: [run({ id: 10, status: 'in_progress', conclusion: null, run_started_at: '2026-10-27T12:00:00Z', event: 'workflow_dispatch' }), run({ id: 9 })] } }
      : { corpo: { workflow_runs: [run({ id: 20, run_started_at: '2026-10-27T11:00:00Z', conclusion: 'failure' })] } }));
    const e = await new SincroniaManual(cfg, f).execucoes();
    expect(e.map((x) => [x.id, x.workflow, x.situacao, x.resultado, x.origem])).toEqual([[10, 'sincronia', 'rodando', null, 'manual'], [20, 'meta-incremental', 'concluida', 'failure', 'agendada'], [9, 'sincronia', 'concluida', 'success', 'agendada']]);
    expect(chamadas[0]).toMatchObject({ metodo: 'GET', url: 'https://api.github.com/repos/pablomenezzes/quark-orquestrador/actions/workflows/sincronia.yml/runs?per_page=4', auth: 'Bearer github_pat_segredo' });
  });
  it('dispara o workflow certo na branch certa, depois de conferir que não há execução ativa', async () => {
    const { f, chamadas } = fake((c) => (c.metodo === 'POST' ? { status: 204 } : { corpo: { workflow_runs: [run()] } }));
    const r = await new SincroniaManual(cfg, f).disparar('sincronia');
    expect(r.workflow).toBe('sincronia');
    expect(r.mensagem).toMatch(/Pedido enviado/);
    const post = chamadas.find((c) => c.metodo === 'POST')!;
    expect(post.url).toBe('https://api.github.com/repos/pablomenezzes/quark-orquestrador/actions/workflows/sincronia.yml/dispatches');
    expect(post.corpo).toEqual({ ref: 'main' });
    expect(chamadas[0]!.metodo).toBe('GET'); // a checagem vem antes do disparo
  });
  it('não dispara se já há execução na fila ou rodando (409) e espera 60 segundos entre cliques (429)', async () => {
    const { f, chamadas } = fake((c) => (c.metodo === 'POST' ? { status: 204 } : { corpo: { workflow_runs: [run({ status: 'queued', conclusion: null })] } }));
    await expect(new SincroniaManual(cfg, f).disparar('sincronia')).rejects.toMatchObject({ status: 409 });
    expect(chamadas.some((c) => c.metodo === 'POST')).toBe(false);
    let t = 1_000_000;
    const livre = fake((c) => (c.metodo === 'POST' ? { status: 204 } : { corpo: { workflow_runs: [run()] } }));
    const s = new SincroniaManual(cfg, livre.f, () => t);
    await s.disparar('sincronia');
    await expect(s.disparar('meta-incremental')).rejects.toMatchObject({ status: 429 });
    t += 61_000;
    await s.disparar('meta-incremental');
    expect(livre.chamadas.filter((c) => c.metodo === 'POST')).toHaveLength(2);
  });
  it('recusa workflow desconhecido, traduz os erros do GitHub e nunca repete o token', async () => {
    await expect(new SincroniaManual(cfg, fake(() => ({})).f).disparar('outro')).rejects.toMatchObject({ status: 400 });
    for (const [status, msg] of [[401, /vencido ou inválido/], [403, /Actions: leitura e escrita/], [404, /Actions: leitura e escrita/], [500, /recusou a operação/]] as const) {
      const err = await new SincroniaManual(cfg, fake(() => ({ status })).f).disparar('sincronia').catch((e) => e);
      expect(err.message).toMatch(msg);
      expect(err.message).not.toContain('github_pat_segredo');
    }
    await expect(new SincroniaManual(null).disparar('sincronia')).rejects.toMatchObject({ status: 503 });
    expect(new SincroniaManual(null).status()).toMatchObject({ configurado: false, repo: null });
    expect(new SincroniaManual(cfg).status()).toMatchObject({ configurado: true, repo: 'pablomenezzes/quark-orquestrador' });
  });
});

describe('Gatilho manual da sincronização: rotas', () => {
  const disparos: string[] = [];
  const sinc = {
    status: () => ({ configurado: true, repo: 'a/b', workflows: [{ id: 'sincronia', nome: 'Sincronia completa', duracao: '5 min' }] }),
    async execucoes() { return [{ workflow: 'sincronia', id: 1, situacao: 'concluida', resultado: 'success', inicio: '2026-10-27T10:00:00Z', atualizado: null, url: 'u', origem: 'agendada' }]; },
    async disparar(id: unknown) { disparos.push(String(id)); if (id === 'ocupado') { const { IntegracaoErro } = await import('../studio/lib/integracoes'); throw new IntegracaoErro(409, 'Já existe uma execução rodando'); } return { workflow: id, mensagem: 'Pedido enviado' }; },
  } as unknown as SincroniaManual;
  const auth: AuthService = {
    async entrar(email, senha) { return senha === 'Senha12345' ? { id: email.startsWith('adm') ? '00000000-0000-0000-0000-00000000000a' : '00000000-0000-0000-0000-00000000000e', email, nome: 'X', papel: (email.startsWith('adm') ? 'admin' : 'editor') as Papel } : null; },
    async vigente(id) { return id.endsWith('a') ? 'admin' : 'editor'; }, async listar() { return []; }, async criar() { throw new Error('x'); }, async atualizar() { throw new Error('x'); }, async remover() { /* nada */ },
  };
  let local: Server, sem: Server, publico: Server, uL: string, uS: string, uP: string, dir: string;
  const mk = (extra: object) => createStudioServer({ formsDir: join(dir, 'f'), publicDir: join(dir, 'p'), trackingDir: join(dir, 't'), sources: [], dbInfo: () => ({ connected: true }), submit: async () => ({ status: 200, body: {} }), ...extra } as never);
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'studio-sinc-'));
    for (const d of ['f', 'p', 't']) mkdirSync(join(dir, d));
    local = mk({ sincronia: sinc }); sem = mk({}); publico = mk({ sincronia: sinc, acesso: { servico: auth, segredo: 'segredo-de-teste-com-mais-de-32-caracteres!!', seguro: true } });
    await Promise.all([local, sem, publico].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    const u = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    uL = u(local); uS = u(sem); uP = u(publico);
  });
  afterAll(async () => { await Promise.all([local, sem, publico].map((s) => new Promise((r) => s.close(r)))); rmSync(dir, { recursive: true, force: true }); });
  const post = (base: string, path: string, corpo: unknown, cookie?: string) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(corpo) });
  const entrar = async (email: string) => (await post(uP, '/api/login', { email, senha: 'Senha12345' })).headers.get('set-cookie')!.split(';')[0]!;

  it('local: estado com as execuções, disparo aceito (202), workflow inválido e conflito', async () => {
    const e = await (await fetch(`${uL}/api/painel/sincronia`)).json();
    expect(e).toMatchObject({ configurado: true, workflows: [{ id: 'sincronia' }], execucoes: [{ id: 1, situacao: 'concluida' }] });
    const r = await post(uL, '/api/painel/sincronia/disparar', { workflow: 'sincronia' });
    expect(r.status).toBe(202);
    expect((await r.json()).mensagem).toBe('Pedido enviado');
    expect(disparos).toContain('sincronia');
    const c = await post(uL, '/api/painel/sincronia/disparar', { workflow: 'ocupado' });
    expect(c.status).toBe(409);
    expect((await c.json()).detail).toMatch(/rodando/);
  });
  it('sem token: o estado diz que não está configurado e o disparo responde 503 com o que falta', async () => {
    expect(await (await fetch(`${uS}/api/painel/sincronia`)).json()).toMatchObject({ configurado: false, execucoes: [] });
    const r = await post(uS, '/api/painel/sincronia/disparar', { workflow: 'sincronia' });
    expect(r.status).toBe(503);
    expect((await r.json()).detail).toMatch(/GITHUB_DISPATCH_TOKEN/);
  });
  it('publicado: só logado vê o estado e só o admin dispara', async () => {
    expect((await fetch(`${uP}/api/painel/sincronia`)).status).toBe(401);
    expect((await post(uP, '/api/painel/sincronia/disparar', { workflow: 'sincronia' })).status).toBe(401);
    const editor = await entrar('ed@quark.com'), admin = await entrar('adm@quark.com');
    expect((await fetch(`${uP}/api/painel/sincronia`, { headers: { cookie: editor } })).status).toBe(200);
    const antes = disparos.length;
    expect((await post(uP, '/api/painel/sincronia/disparar', { workflow: 'sincronia' }, editor)).status).toBe(403);
    expect(disparos.length).toBe(antes);
    expect((await post(uP, '/api/painel/sincronia/disparar', { workflow: 'sincronia' }, admin)).status).toBe(202);
    expect(disparos.length).toBe(antes + 1);
  });
  it('a aba Saúde tem o botão, só o admin dispara e a lista se atualiza enquanto há execução ativa', () => {
    const js = readFileSync(new URL('../studio/public/painel.js', import.meta.url), 'utf8');
    for (const t of ['Sincronizar agora', 'data-sinc', '/api/painel/sincronia/disparar', 'GITHUB_DISPATCH_TOKEN', 'souAdmin', '10_000']) expect(js).toContain(t);
    const api = readFileSync(new URL('../api/studio.ts', import.meta.url), 'utf8');
    expect(api).toContain('githubConfigDoAmbiente');
    expect(api).not.toMatch(/github_pat_|ghp_/);
  });
});
