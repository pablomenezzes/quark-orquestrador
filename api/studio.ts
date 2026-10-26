import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import pg from 'pg';
import { assertRoleUser, assertSafeDbTarget } from '../src/db/guard.js';
import { SupabaseAuth } from '../studio/lib/auth.js';
import { PgBiRepo } from '../studio/lib/bi.js';
import { PgExperimentosRepo } from '../studio/lib/experimentos.js';
import { PgMonitorRepo } from '../studio/lib/monitor.js';
import { PgPainelRepo } from '../studio/lib/painel-repo.js';
import { createStudioHandler } from '../studio/server.js';

/**
 * Quark Dados publicado (Monitor, Experimentos, BI, Painel de Dados e Usuários), atrás de login. Região gru1 (vercel.json).
 *
 * Só usa o papel de leitura do painel (PANEL_DB_URL, usuário orq_panel): nunca o `postgres`, nunca o papel de ingestão. O Studio de testes
 * (formulários e envio ao pipeline) não existe aqui: o servidor, no modo publicado, responde 404 a essas rotas.
 * Se faltar qualquer variável, a função responde 500 "misconfigured" com o que falta (sem valores) em vez de abrir sem proteção.
 */
const env = (k: string) => process.env[k] ?? '';

function montar() {
  const faltam = ['PANEL_DB_URL', 'SUPABASE_PROJECT_REF', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET'].filter((k) => !env(k));
  if (faltam.length) throw new Error(`variáveis ausentes: ${faltam.join(', ')}`);
  if (env('SESSION_SECRET').length < 32) throw new Error('SESSION_SECRET curto demais (mínimo 32 caracteres).');
  assertSafeDbTarget({ target: env('PANEL_DB_URL'), expectedRef: env('SUPABASE_PROJECT_REF') });
  assertRoleUser(env('PANEL_DB_URL'), 'orq_panel');
  const pool = new pg.Pool({ connectionString: env('PANEL_DB_URL'), max: 1, ssl: { rejectUnauthorized: false } });
  pool.on('error', (e) => console.error('pool: erro no banco', e.message.replace(/postgres(ql)?:\/\/\S+/gi, '<url>')));
  const raiz = process.cwd();
  return createStudioHandler({
    formsDir: join(raiz, 'studio', 'forms'),
    publicDir: join(raiz, 'studio', 'public'),
    trackingDir: join(raiz, 'tracking'),
    sources: [],
    dbInfo: () => ({ connected: true }),
    submit: async () => ({ status: 404, body: { error: 'not_found' } }),
    painel: new PgPainelRepo(pool),
    bi: new PgBiRepo(pool),
    monitor: new PgMonitorRepo(pool),
    experimentos: new PgExperimentosRepo(pool),
    acesso: { servico: new SupabaseAuth({ url: env('SUPABASE_URL'), anonKey: env('SUPABASE_ANON_KEY'), serviceKey: env('SUPABASE_SERVICE_ROLE_KEY') }), segredo: env('SESSION_SECRET'), seguro: true },
  });
}

let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
let erro: string | undefined;
try { handler = montar(); } catch (e) { erro = e instanceof Error ? e.message : 'configuração inválida'; console.error('studio: misconfigured:', erro); }

export default function studio(req: IncomingMessage, res: ServerResponse): void {
  if (!handler) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'misconfigured' }));
    return;
  }
  handler(req, res);
}
