/**
 * Acesso do time ao Quark Dados publicado (pedido do Pablo, 2026-10-26): login com e-mail e senha pelo Supabase Auth (GoTrue), sem cadastro aberto.
 * Só o admin cria, muda o papel, bloqueia ou remove usuários. O papel (admin ou editor) mora em `app_metadata.quark_papel`, que só a chave de serviço
 * consegue gravar: quem se cadastrar por conta própria no Supabase fica sem papel e é recusado aqui.
 *
 * Depois do login, o servidor entrega um cookie assinado (HMAC-SHA256, HttpOnly, Secure, 8 h) com id, e-mail, nome e papel. A cada 5 minutos (por instância)
 * confere de novo se o usuário ainda existe, não está bloqueado e mantém o papel: remover ou bloquear alguém vale em minutos, não só quando o cookie vence.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const PAPEIS = ['admin', 'editor'] as const;
export type Papel = (typeof PAPEIS)[number];
export const COOKIE = 'qd_sessao';
export const SESSAO_SEGUNDOS = 8 * 60 * 60;
export const SENHA_MIN = 10;

export interface Sessao { id: string; email: string; nome: string | null; papel: Papel; exp: number }
export interface UsuarioInfo { id: string; email: string; nome: string | null; papel: Papel | null; bloqueado: boolean; criadoEm: string; ultimoLogin: string | null }

export class AuthErro extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/* ---------- cookie assinado ---------- */
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const mac = (dados: string, segredo: string) => createHmac('sha256', segredo).update(dados).digest();

export function assinar(s: Sessao, segredo: string): string {
  const corpo = b64(JSON.stringify(s));
  return `${corpo}.${b64(mac(corpo, segredo))}`;
}
/** Devolve a sessão se a assinatura confere e não venceu; qualquer outra coisa é nula. */
export function verificar(token: string | undefined, segredo: string, agoraMs: number): Sessao | null {
  if (!token || token.length > 2000) return null;
  const [corpo, assin, resto] = token.split('.');
  if (!corpo || !assin || resto !== undefined) return null;
  const esperado = mac(corpo, segredo);
  let recebido: Buffer;
  try { recebido = Buffer.from(assin, 'base64url'); } catch { return null; }
  if (recebido.length !== esperado.length || !timingSafeEqual(recebido, esperado)) return null;
  try {
    const s = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')) as Partial<Sessao>;
    if (typeof s.id !== 'string' || typeof s.email !== 'string' || typeof s.exp !== 'number' || !(PAPEIS as readonly unknown[]).includes(s.papel)) return null;
    if (s.exp * 1000 <= agoraMs) return null;
    return { id: s.id, email: s.email, nome: typeof s.nome === 'string' ? s.nome : null, papel: s.papel as Papel, exp: s.exp };
  } catch { return null; }
}
export function lerCookie(header: string | undefined, nome = COOKIE): string | undefined {
  for (const parte of (header ?? '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nome) return parte.slice(i + 1).trim();
  }
  return undefined;
}
export const cookieSessao = (token: string, seguro: boolean): string => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSAO_SEGUNDOS}${seguro ? '; Secure' : ''}`;
export const cookieLimpo = (seguro: boolean): string => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${seguro ? '; Secure' : ''}`;

/* ---------- regras ---------- */
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
export const emailValido = (e: unknown): e is string => typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e);
export function senhaValida(s: unknown): string {
  if (typeof s !== 'string' || s.length < SENHA_MIN) throw new AuthErro(400, `A senha precisa ter pelo menos ${SENHA_MIN} caracteres.`);
  if (s.length > 72) throw new AuthErro(400, 'A senha pode ter no máximo 72 caracteres.');
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) throw new AuthErro(400, 'A senha precisa ter letras e números.');
  return s;
}

/** Freio simples contra tentativa de senha: 5 erros por e-mail+IP em 15 minutos (por instância; o Supabase também limita do lado dele). */
export class LimiteLogin {
  private readonly falhas = new Map<string, number[]>();
  constructor(private readonly max = 5, private readonly janelaMs = 15 * 60_000, private readonly agora: () => number = Date.now) {}
  private recentes(chave: string): number[] {
    const corte = this.agora() - this.janelaMs;
    const v = (this.falhas.get(chave) ?? []).filter((t) => t > corte);
    if (v.length) this.falhas.set(chave, v); else this.falhas.delete(chave);
    return v;
  }
  bloqueado(chave: string): boolean { return this.recentes(chave).length >= this.max; }
  falhou(chave: string): void { this.falhas.set(chave, [...this.recentes(chave), this.agora()]); if (this.falhas.size > 5000) this.falhas.clear(); }
  limpar(chave: string): void { this.falhas.delete(chave); }
}

/* ---------- serviço de usuários ---------- */
export interface AuthService {
  /** Confere e-mail e senha. Nulo = credenciais erradas, usuário bloqueado ou sem papel. */
  entrar(email: string, senha: string): Promise<{ id: string; email: string; nome: string | null; papel: Papel } | null>;
  /** O usuário ainda existe, não está bloqueado e tem papel? Devolve o papel atual. */
  vigente(id: string): Promise<Papel | null>;
  listar(): Promise<UsuarioInfo[]>;
  criar(e: { email: string; nome: string | null; papel: Papel; senha: string }): Promise<UsuarioInfo>;
  atualizar(id: string, e: { papel?: Papel; nome?: string | null; bloqueado?: boolean; senha?: string }): Promise<UsuarioInfo>;
  remover(id: string): Promise<void>;
}

interface UserGoTrue {
  id: string; email?: string; created_at?: string; last_sign_in_at?: string | null; banned_until?: string | null;
  app_metadata?: { quark_papel?: string }; user_metadata?: { nome?: string };
}
const papelDe = (u: UserGoTrue): Papel | null => ((PAPEIS as readonly string[]).includes(u.app_metadata?.quark_papel ?? '') ? (u.app_metadata!.quark_papel as Papel) : null);
const bloqueadoDe = (u: UserGoTrue): boolean => !!u.banned_until && Date.parse(u.banned_until) > Date.now();
const infoDe = (u: UserGoTrue): UsuarioInfo => ({ id: u.id, email: u.email ?? '', nome: u.user_metadata?.nome ?? null, papel: papelDe(u), bloqueado: bloqueadoDe(u), criadoEm: u.created_at ?? '', ultimoLogin: u.last_sign_in_at ?? null });

export interface SupabaseAuthConfig { url: string; anonKey: string; serviceKey: string; fetch?: typeof fetch }

export class SupabaseAuth implements AuthService {
  private readonly f: typeof fetch;
  constructor(private readonly c: SupabaseAuthConfig) {
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(c.url)) throw new Error('SUPABASE_URL inválida (esperado https://<ref>.supabase.co).');
    if (!c.anonKey || !c.serviceKey) throw new Error('Faltam SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY.');
    this.f = c.fetch ?? fetch;
  }
  private base = () => `${this.c.url.replace(/\/$/, '')}/auth/v1`;
  private async admin<T>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
    const r = await this.f(`${this.base()}${caminho}`, {
      method: metodo,
      headers: { apikey: this.c.serviceKey, authorization: `Bearer ${this.c.serviceKey}`, 'content-type': 'application/json' },
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    });
    const texto = await r.text();
    const json = texto ? (JSON.parse(texto) as Record<string, unknown>) : {};
    if (!r.ok) {
      const msg = String(json.msg ?? json.message ?? json.error_description ?? '');
      if (r.status === 422 || /already|registered|exists/i.test(msg)) throw new AuthErro(409, 'Já existe um usuário com esse e-mail.');
      if (r.status === 404) throw new AuthErro(404, 'Usuário não encontrado.');
      throw new AuthErro(502, 'O Supabase Auth recusou a operação.');
    }
    return json as T;
  }

  async entrar(email: string, senha: string) {
    const r = await this.f(`${this.base()}/token?grant_type=password`, { method: 'POST', headers: { apikey: this.c.anonKey, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: senha }) });
    if (r.status === 400 || r.status === 401 || r.status === 422) return null;
    if (!r.ok) throw new AuthErro(502, 'Não foi possível falar com o Supabase Auth agora.');
    const u = ((await r.json()) as { user?: UserGoTrue }).user;
    if (!u || bloqueadoDe(u)) return null;
    const papel = papelDe(u);
    return papel ? { id: u.id, email: u.email ?? email, nome: u.user_metadata?.nome ?? null, papel } : null;
  }
  async vigente(id: string): Promise<Papel | null> {
    try {
      const u = await this.admin<UserGoTrue>('GET', `/admin/users/${encodeURIComponent(id)}`);
      return bloqueadoDe(u) ? null : papelDe(u);
    } catch (e) {
      if (e instanceof AuthErro && e.status === 404) return null;
      throw e;
    }
  }
  async listar(): Promise<UsuarioInfo[]> {
    const r = await this.admin<{ users?: UserGoTrue[] }>('GET', '/admin/users?page=1&per_page=200');
    return (r.users ?? []).map(infoDe).sort((a, b) => a.email.localeCompare(b.email));
  }
  async criar(e: { email: string; nome: string | null; papel: Papel; senha: string }): Promise<UsuarioInfo> {
    return infoDe(await this.admin<UserGoTrue>('POST', '/admin/users', { email: e.email, password: e.senha, email_confirm: true, app_metadata: { quark_papel: e.papel }, user_metadata: { nome: e.nome } }));
  }
  async atualizar(id: string, e: { papel?: Papel; nome?: string | null; bloqueado?: boolean; senha?: string }): Promise<UsuarioInfo> {
    const atual = await this.admin<UserGoTrue>('GET', `/admin/users/${encodeURIComponent(id)}`);
    const corpo: Record<string, unknown> = {};
    if (e.papel) corpo.app_metadata = { ...(atual.app_metadata ?? {}), quark_papel: e.papel };
    if (e.nome !== undefined) corpo.user_metadata = { ...(atual.user_metadata ?? {}), nome: e.nome };
    if (e.bloqueado !== undefined) corpo.ban_duration = e.bloqueado ? '876000h' : 'none';
    if (e.senha) corpo.password = e.senha;
    return infoDe(await this.admin<UserGoTrue>('PUT', `/admin/users/${encodeURIComponent(id)}`, corpo));
  }
  async remover(id: string): Promise<void> {
    await this.admin('DELETE', `/admin/users/${encodeURIComponent(id)}`);
  }
}

/** Confere a vigência com cache curto, para não chamar o Supabase a cada clique. */
export class VigenciaCache {
  private readonly m = new Map<string, { papel: Papel | null; ate: number }>();
  constructor(private readonly svc: Pick<AuthService, 'vigente'>, private readonly ttlMs = 5 * 60_000, private readonly agora: () => number = Date.now) {}
  async papel(id: string): Promise<Papel | null> {
    const c = this.m.get(id);
    if (c && c.ate > this.agora()) return c.papel;
    const papel = await this.svc.vigente(id);
    this.m.set(id, { papel, ate: this.agora() + this.ttlMs });
    if (this.m.size > 2000) this.m.clear();
    return papel;
  }
  esquecer(id: string): void { this.m.delete(id); }
}
