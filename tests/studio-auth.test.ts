import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest, type Server } from 'node:http';
import { createStudioServer } from '../studio/server';
import { AuthErro, LimiteLogin, SupabaseAuth, VigenciaCache, assinar, lerCookie, senhaValida, verificar, type AuthService, type Papel, type Sessao, type UsuarioInfo } from '../studio/lib/auth';
import { METRICAS_EXP, type ExperimentosRepo } from '../studio/lib/experimentos';

const SEGREDO = 'segredo-de-teste-com-mais-de-32-caracteres!!';
const sessao = (o: Partial<Sessao> = {}): Sessao => ({ id: '11111111-1111-1111-1111-111111111111', email: 'a@quark.com', nome: 'Ana', papel: 'editor', exp: 2_000_000_000, ...o });

describe('Acesso: cookie de sessão assinado', () => {
  it('assina e verifica; adulterar o corpo, trocar o segredo ou vencer invalida', () => {
    const t = assinar(sessao(), SEGREDO);
    expect(verificar(t, SEGREDO, 1_000_000_000_000)).toMatchObject({ email: 'a@quark.com', papel: 'editor' });
    const [corpo, assin] = t.split('.');
    const virouAdmin = Buffer.from(JSON.stringify({ ...sessao(), papel: 'admin' })).toString('base64url');
    expect(verificar(`${virouAdmin}.${assin}`, SEGREDO, 1_000_000_000_000)).toBeNull();
    expect(verificar(`${corpo}.${assin}x`, SEGREDO, 1_000_000_000_000)).toBeNull();
    expect(verificar(t, 'outro-segredo-qualquer-com-32-caracteres!!', 1_000_000_000_000)).toBeNull();
    expect(verificar(t, SEGREDO, 2_000_000_001_000)).toBeNull(); // venceu
    expect(verificar(undefined, SEGREDO, 0)).toBeNull();
    expect(verificar('lixo', SEGREDO, 0)).toBeNull();
    expect(verificar(assinar({ ...sessao(), papel: 'dono' as Papel }, SEGREDO), SEGREDO, 0)).toBeNull(); // papel fora da lista
  });
  it('lê o cookie certo no meio de outros', () => {
    expect(lerCookie('a=1; qd_sessao=abc.def; b=2')).toBe('abc.def');
    expect(lerCookie('a=1')).toBeUndefined();
  });
  it('senha: 10 a 72 caracteres, com letras e números', () => {
    expect(senhaValida('Quark2026abc')).toBe('Quark2026abc');
    for (const ruim of ['curta1', 'somenteletrasaqui', '12345678901234', 'a1'.repeat(40), 7, undefined]) expect(() => senhaValida(ruim)).toThrow(AuthErro);
  });
  it('freio de login: 5 erros em 15 minutos bloqueiam e depois liberam', () => {
    let t = 0;
    const l = new LimiteLogin(5, 15 * 60_000, () => t);
    for (let i = 0; i < 5; i++) l.falhou('x');
    expect(l.bloqueado('x')).toBe(true);
    expect(l.bloqueado('y')).toBe(false);
    t = 15 * 60_000 + 1;
    expect(l.bloqueado('x')).toBe(false);
  });
  it('a vigência é conferida no máximo a cada 5 minutos', async () => {
    let t = 0, chamadas = 0;
    const c = new VigenciaCache({ vigente: async () => { chamadas++; return 'editor'; } }, 5 * 60_000, () => t);
    await c.papel('u'); await c.papel('u');
    expect(chamadas).toBe(1);
    t = 5 * 60_000 + 1;
    await c.papel('u');
    expect(chamadas).toBe(2);
  });
});

describe('Acesso: Supabase Auth (simulado)', () => {
  const chamadas: Array<{ url: string; metodo: string; corpo: any; auth: string | undefined }> = [];
  const usuario = (o: any = {}) => ({ id: 'u1', email: 'a@quark.com', created_at: '2026-10-01', app_metadata: { quark_papel: 'editor' }, user_metadata: { nome: 'Ana' }, ...o });
  let resposta: (url: string, metodo: string) => { status: number; corpo: unknown } = () => ({ status: 200, corpo: {} });
  const fake = (async (url: string, init: any) => {
    chamadas.push({ url, metodo: init?.method ?? 'GET', corpo: init?.body ? JSON.parse(init.body) : undefined, auth: init?.headers?.authorization });
    const r = resposta(url, init?.method ?? 'GET');
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.corpo), json: async () => r.corpo };
  }) as unknown as typeof fetch;
  const svc = new SupabaseAuth({ url: 'https://abc.supabase.co', anonKey: 'anon', serviceKey: 'service', fetch: fake });

  it('recusa configuração fora do padrão', () => {
    expect(() => new SupabaseAuth({ url: 'http://evil.com', anonKey: 'a', serviceKey: 'b' })).toThrow(/SUPABASE_URL/);
    expect(() => new SupabaseAuth({ url: 'https://abc.supabase.co', anonKey: '', serviceKey: 'b' })).toThrow(/Faltam/);
  });
  it('entrar: aceita quem tem papel; recusa senha errada, bloqueado e quem não tem papel (cadastro por conta própria)', async () => {
    resposta = () => ({ status: 200, corpo: { user: usuario() } });
    expect(await svc.entrar('a@quark.com', 'Senha12345')).toMatchObject({ id: 'u1', papel: 'editor', nome: 'Ana' });
    expect(chamadas.at(-1)!.url).toContain('grant_type=password');
    resposta = () => ({ status: 400, corpo: { error: 'invalid_grant' } });
    expect(await svc.entrar('a@quark.com', 'errada')).toBeNull();
    resposta = () => ({ status: 200, corpo: { user: usuario({ banned_until: '2999-01-01T00:00:00Z' }) } });
    expect(await svc.entrar('a@quark.com', 'Senha12345')).toBeNull();
    resposta = () => ({ status: 200, corpo: { user: usuario({ app_metadata: {} }) } });
    expect(await svc.entrar('a@quark.com', 'Senha12345')).toBeNull();
    resposta = () => ({ status: 500, corpo: {} });
    await expect(svc.entrar('a@quark.com', 'x')).rejects.toThrow(AuthErro);
  });
  it('criar grava o papel em app_metadata, confirma o e-mail e usa a chave de serviço; e-mail repetido vira 409', async () => {
    resposta = () => ({ status: 200, corpo: usuario() });
    await svc.criar({ email: 'a@quark.com', nome: 'Ana', papel: 'admin', senha: 'Senha12345' });
    const c = chamadas.at(-1)!;
    expect(c.url).toBe('https://abc.supabase.co/auth/v1/admin/users');
    expect(c.auth).toBe('Bearer service');
    expect(c.corpo).toMatchObject({ email_confirm: true, app_metadata: { quark_papel: 'admin' } });
    resposta = () => ({ status: 422, corpo: { msg: 'A user with this email address has already been registered' } });
    await expect(svc.criar({ email: 'a@quark.com', nome: null, papel: 'editor', senha: 'Senha12345' })).rejects.toMatchObject({ status: 409 });
  });
  it('bloquear usa ban_duration e preserva o resto do app_metadata; vigente é nulo para bloqueado ou inexistente', async () => {
    resposta = (_u, m) => ({ status: 200, corpo: usuario({ app_metadata: { quark_papel: 'editor', outro: 1 } }) });
    await svc.atualizar('u1', { bloqueado: true });
    expect(chamadas.at(-1)!.corpo.ban_duration).toBe('876000h');
    await svc.atualizar('u1', { papel: 'admin' });
    expect(chamadas.at(-1)!.corpo.app_metadata).toEqual({ quark_papel: 'admin', outro: 1 });
    resposta = () => ({ status: 200, corpo: usuario({ banned_until: '2999-01-01T00:00:00Z' }) });
    expect(await svc.vigente('u1')).toBeNull();
    resposta = () => ({ status: 404, corpo: {} });
    expect(await svc.vigente('u1')).toBeNull();
    resposta = () => ({ status: 200, corpo: usuario() });
    expect(await svc.vigente('u1')).toBe('editor');
  });
});

describe('Acesso: servidor publicado (login, papéis e Studio de testes desligado)', () => {
  const ADMIN = { id: '00000000-0000-0000-0000-00000000000a', email: 'admin@quark.com', nome: 'Admin', papel: 'admin' as Papel };
  const EDITOR = { id: '00000000-0000-0000-0000-00000000000e', email: 'ed@quark.com', nome: 'Edi', papel: 'editor' as Papel };
  const senhas: Record<string, string> = { 'admin@quark.com': 'Admin12345', 'ed@quark.com': 'Editor12345' };
  const vigentes = new Map<string, Papel | null>([[ADMIN.id, 'admin'], [EDITOR.id, 'editor']]);
  const feitos: string[] = [];
  const servico: AuthService = {
    async entrar(email, senha) { return senhas[email] === senha ? (email === ADMIN.email ? ADMIN : EDITOR) : null; },
    async vigente(id) { return vigentes.get(id) ?? null; },
    async listar() { return [{ ...ADMIN, bloqueado: false, criadoEm: '', ultimoLogin: null }]; },
    async criar(e) { feitos.push(`criar:${e.email}:${e.papel}`); return { id: 'n', email: e.email, nome: e.nome, papel: e.papel, bloqueado: false, criadoEm: '', ultimoLogin: null } as UsuarioInfo; },
    async atualizar(id, e) { feitos.push(`atualizar:${id}:${JSON.stringify(e)}`); return { id, email: 'x', nome: null, papel: 'editor', bloqueado: false, criadoEm: '', ultimoLogin: null }; },
    async remover(id) { feitos.push(`remover:${id}`); },
  };
  const exp: ExperimentosRepo = {
    async listar() { feitos.push('listar'); return { hoje: '2026-10-11', metricas: METRICAS_EXP, canais: [] as never, tipos: [] as never, experimentos: [], calibracao: [] }; },
    async criar() { feitos.push('criar-exp'); return { id: 1 } as never; },
    async atualizar(id) { return { id } as never; },
    async relatorio(id) { return { id } as never; },
    async salvarDocumentacao(id) { return { id, atualizadoEm: 'x' }; },
  };
  let server: Server; let base: string; let dir: string; let host: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'studio-auth-'));
    for (const d of ['forms', 'public', 'tracking']) mkdirSync(join(dir, d));
    for (const f of ['login.html', 'inicio.html', 'usuarios.html', 'index.html', 'experimentos.html']) writeFileSync(join(dir, 'public', f), `<h1>${f}</h1>`);
    writeFileSync(join(dir, 'public', 'login.js'), '//login');
    writeFileSync(join(dir, 'public', 'monitor.js'), '//monitor');
    server = createStudioServer({ formsDir: join(dir, 'forms'), publicDir: join(dir, 'public'), trackingDir: join(dir, 'tracking'), sources: [], dbInfo: () => ({ connected: true }), submit: async () => ({ status: 200, body: {} }), experimentos: exp, acesso: { servico, segredo: SEGREDO, seguro: true } });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    base = `http://${host}`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); });

  const json = (metodo: string, corpo: unknown, cookie?: string, origin = base) => ({ method: metodo, redirect: 'manual' as const, headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(corpo) });
  const entrar = async (email: string, senha: string) => fetch(`${base}/api/login`, json('POST', { email, senha }));
  const cookieDe = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  const get = (path: string, cookie?: string) => fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

  it('sem login: páginas mandam para /login e a API responde 401; a tela de login é pública', async () => {
    const p = await get('/experimentos');
    expect(p.status).toBe(302);
    expect(p.headers.get('location')).toBe('/login?voltar=%2Fexperimentos');
    expect((await get('/api/experimentos')).status).toBe(401);
    expect((await get('/api/painel/config')).status).toBe(401);
    expect((await get('/api/usuarios')).status).toBe(401);
    expect(await (await get('/login')).text()).toContain('login.html');
    expect((await get('/s/login.js')).status).toBe(200);
    expect((await get('/s/monitor.js')).status).toBe(302); // o resto dos arquivos só depois do login
  });
  it('login certo entrega cookie HttpOnly, Secure e SameSite; senha errada, e-mail inventado e corpo estranho dão 401 sem dizer qual', async () => {
    const r = await entrar('ed@quark.com', 'Editor12345');
    expect(r.status).toBe(200);
    const sc = r.headers.get('set-cookie')!;
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/Secure/);
    expect(sc).toMatch(/SameSite=Lax/);
    for (const [e, s] of [['ed@quark.com', 'errada'], ['ninguem@quark.com', 'Editor12345'], ['isto-nao-e-email', 'x']] as const) {
      const f = await entrar(e, s);
      expect(f.status).toBe(401);
      expect((await f.json()).detail).toContain('E-mail ou senha incorretos');
    }
  });
  it('depois de 5 erros seguidos, bloqueia as tentativas daquele e-mail (429)', async () => {
    for (let i = 0; i < 5; i++) await entrar('freio@quark.com', 'errada');
    const r = await entrar('freio@quark.com', 'Editor12345');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('900');
  });
  it('editor vê e edita experimentos, mas não entra em Usuários nem grava no Painel; o Studio de testes não existe', async () => {
    const c = cookieDe(await entrar('ed@quark.com', 'Editor12345'));
    expect((await get('/api/experimentos', c)).status).toBe(200);
    expect((await fetch(`${base}/api/experimentos`, json('POST', { titulo: 'x' }, c))).status).toBe(201);
    expect((await get('/api/usuarios', c)).status).toBe(403);
    expect((await get('/usuarios', c)).status).toBe(302);
    expect((await fetch(`${base}/api/painel/config/pipeline/1`, json('PUT', { produto: 'rh' }, c))).status).toBe(403);
    for (const p of ['/studio', '/f/abc', '/api/forms', '/api/meta', '/attribution.js']) expect((await get(p, c)).status, p).toBe(404);
    expect((await fetch(`${base}/api/submit/abc`, json('POST', {}, c))).status).toBe(404);
    expect(await (await get('/api/me', c)).json()).toMatchObject({ publico: true, papel: 'editor', email: 'ed@quark.com' });
  });
  it('admin gerencia usuários, mas não rebaixa, bloqueia nem remove a si mesmo', async () => {
    const c = cookieDe(await entrar('admin@quark.com', 'Admin12345'));
    expect((await get('/api/usuarios', c)).status).toBe(200);
    expect((await get('/usuarios', c)).status).toBe(200);
    const criado = await fetch(`${base}/api/usuarios`, json('POST', { email: 'Novo@Quark.com', nome: 'Novo', papel: 'editor', senha: 'Senha12345' }, c));
    expect(criado.status).toBe(201);
    expect(feitos).toContain('criar:novo@quark.com:editor'); // e-mail em minúsculas
    expect((await fetch(`${base}/api/usuarios`, json('POST', { email: 'x@quark.com', papel: 'editor', senha: 'curta' }, c))).status).toBe(400);
    expect((await fetch(`${base}/api/usuarios`, json('POST', { email: 'x@quark.com', papel: 'dono', senha: 'Senha12345' }, c))).status).toBe(400);
    expect((await fetch(`${base}/api/usuarios/${ADMIN.id}`, json('PUT', { papel: 'editor' }, c))).status).toBe(400);
    expect((await fetch(`${base}/api/usuarios/${ADMIN.id}`, json('PUT', { bloqueado: true }, c))).status).toBe(400);
    expect((await fetch(`${base}/api/usuarios/${ADMIN.id}`, json('DELETE', {}, c))).status).toBe(400);
    expect((await fetch(`${base}/api/usuarios/${EDITOR.id}`, json('PUT', { bloqueado: true }, c))).status).toBe(200);
    expect((await fetch(`${base}/api/usuarios/nao-e-id`, json('PUT', { papel: 'admin' }, c))).status).toBe(404);
    expect((await fetch(`${base}/api/painel/config/pipeline/1`, json('PUT', { produto: 'rh' }, c))).status).not.toBe(403); // admin passa do portão (o 503 é só falta de repositório)
  });
  it('trocar a própria senha exige a atual e uma nova válida', async () => {
    const c = cookieDe(await entrar('ed@quark.com', 'Editor12345'));
    expect((await fetch(`${base}/api/senha`, json('POST', { atual: 'errada1234', nova: 'Nova1234567' }, c))).status).toBe(403);
    expect((await fetch(`${base}/api/senha`, json('POST', { atual: 'Editor12345', nova: 'fraca' }, c))).status).toBe(400);
    expect((await fetch(`${base}/api/senha`, json('POST', { atual: 'Editor12345', nova: 'Nova1234567' }, c))).status).toBe(200);
  });
  it('cookie adulterado ou de usuário removido deixa de valer; sair limpa o cookie', async () => {
    const c = cookieDe(await entrar('ed@quark.com', 'Editor12345'));
    expect((await get('/api/experimentos', `${c}x`)).status).toBe(401);
    const sai = await fetch(`${base}/api/logout`, json('POST', {}, c));
    expect(sai.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    const velho = `qd_sessao=${assinar(sessao({ id: '99999999-9999-9999-9999-999999999999', papel: 'admin' }), SEGREDO)}`; // assinado certo, mas o usuário não existe mais
    expect((await get('/api/usuarios', velho)).status).toBe(401);
  });
  it('escritas só valem vindas da própria página (Origin) e em JSON; respostas levam CSP e anti-iframe', async () => {
    const c = cookieDe(await entrar('ed@quark.com', 'Editor12345'));
    expect((await fetch(`${base}/api/experimentos`, json('POST', { titulo: 'x' }, c, 'https://site-do-mal.com'))).status).toBe(403);
    expect((await fetch(`${base}/api/experimentos`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: c }, body: '{}' })).status).toBe(403); // sem Origin
    expect((await fetch(`${base}/api/experimentos`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: base, cookie: c }, body: '{}' })).status).toBe(415);
    const r = await get('/experimentos', c);
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('x-frame-options')).toBe('DENY');
  });
  it('a configuração de produção não tem segredo no código e a página de login é de marca', () => {
    const api = readFileSync(new URL('../api/studio.ts', import.meta.url), 'utf8');
    expect(api).toContain("assertRoleUser(env('PANEL_DB_URL'), 'orq_panel')");
    expect(api).not.toMatch(/INGEST_DB_URL|SUPABASE_DB_URL/); // nunca usa o postgres nem o papel de ingestão
    const vj = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    expect(vj.rewrites.at(-1)).toEqual({ source: '/(.*)', destination: '/api/studio' });
    expect(vj.rewrites[0].source).toBe('/api/ingest');
    expect(readFileSync(new URL('../studio/public/login.html', import.meta.url), 'utf8')).toContain('Red+Hat+Display');
  });
});

describe('Acesso: servidor local continua como era', () => {
  it('sem o modo publicado, o Host continua restrito ao local e /api/me responde admin local', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-local-'));
    for (const d of ['forms', 'public', 'tracking']) mkdirSync(join(dir, d));
    const s = createStudioServer({ formsDir: join(dir, 'forms'), publicDir: join(dir, 'public'), trackingDir: join(dir, 'tracking'), sources: [], dbInfo: () => ({ connected: true }), submit: async () => ({ status: 200, body: {} }) });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    expect(await (await fetch(`${b}/api/me`)).json()).toEqual({ publico: false, papel: 'admin' });
    const status = await new Promise<number>((resolve, reject) => {
      const q = httpRequest({ host: '127.0.0.1', port: (s.address() as AddressInfo).port, path: '/api/me', headers: { host: 'evil.com' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      q.on('error', reject);
      q.end();
    });
    expect(status).toBe(403);
    await new Promise((r2) => s.close(r2));
    rmSync(dir, { recursive: true, force: true });
  });
});
