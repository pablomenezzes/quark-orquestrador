/**
 * Studio local: npm run studio
 * Construtor de formulários + ambiente de testes do orquestrador. Escuta só em 127.0.0.1.
 * Por padrão SIMULA (roda o pipeline e desfaz a transação). Gravar de verdade exige mode:"real".
 */
import { exec } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertSafeDbTarget } from '../src/db/guard.js';
import { PgStore } from '../src/db/pg-store.js';
import { ingest } from '../src/pipeline/ingest.js';
import { FormsStore } from './lib/forms-store.js';
import { createStudioServer, type SubmitFn } from './server.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* sem .env.local */
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Fontes que o Studio sabe usar (slug -> variável com o token em texto puro, no .env.local). */
const SOURCE_TOKEN_VARS: Record<string, string> = {
  'lp-vercel-rh-teste': 'SOURCE_TOKEN_LP_VERCEL',
};
const availableSources = Object.entries(SOURCE_TOKEN_VARS)
  .filter(([, v]) => !!process.env[v])
  .map(([slug]) => slug);

let pool: pg.Pool | null = null;
const dbUrl = process.env.SUPABASE_DB_URL ?? '';
let dbState: { connected: boolean; note?: string } = { connected: false, note: 'SUPABASE_DB_URL não configurada' };
if (dbUrl) {
  assertSafeDbTarget({ target: dbUrl, expectedRef: process.env.SUPABASE_PROJECT_REF ?? '' });
  pool = new pg.Pool({ connectionString: dbUrl, max: 2, ssl: { rejectUnauthorized: false } });
  pool
    .query('select 1')
    .then(() => (dbState = { connected: true }))
    .catch((e: Error) => (dbState = { connected: false, note: e.message.replace(/postgres(ql)?:\/\/\S+/g, '<url>') }));
}

const forms = new FormsStore(join(root, 'studio', 'forms'));

const submit: SubmitFn = async (formId, mode, payload, ctx) => {
  const form = forms.get(formId);
  if (!form) return { status: 404, body: { error: 'not_found' } };
  if (!pool) return { status: 503, body: { error: 'db_not_configured' } };
  const tokenVar = SOURCE_TOKEN_VARS[form.source_slug];
  const token = tokenVar ? process.env[tokenVar] : undefined;
  if (!token) return { status: 400, body: { error: 'no_token_for_source', detail: `sem token local para a fonte "${form.source_slug}"` } };

  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const answers = raw.answers && typeof raw.answers === 'object' ? (raw.answers as Record<string, unknown>) : {};
  const body = { ...raw, source_slug: form.source_slug, answers: { ...answers, _studio_form: form.id } };

  const out = await ingest(
    { body, query: {}, headers: { 'x-quark-token': token, ...(ctx.userAgent ? { 'user-agent': ctx.userAgent } : {}) }, ip: null },
    { store: PgStore.fromPool(pool), shadowMode: true, dryRun: mode !== 'real', log: { error: (m, x) => console.error(m, x) } },
  );
  return { status: out.status, body: out.body };
};

const port = Number(process.env.STUDIO_PORT ?? 4310);
const server = createStudioServer({
  formsDir: join(root, 'studio', 'forms'),
  publicDir: join(root, 'studio', 'public'),
  trackingDir: join(root, 'tracking'),
  sources: availableSources,
  dbInfo: () => dbState,
  submit,
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`\nQuark Studio rodando em ${url}`);
  console.log('Modo padrão: SIMULAÇÃO (nada é gravado). Ctrl+C para parar.\n');
  if (process.argv.includes('--open')) exec(`start "" "${url}"`);
});

process.on('SIGINT', () => {
  server.close();
  void pool?.end();
  process.exit(0);
});
