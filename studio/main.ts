/**
 * Studio local: npm run studio
 * Construtor de formulários + ambiente de testes do orquestrador. Escuta só em 127.0.0.1.
 * Por padrão SIMULA (roda o pipeline e desfaz a transação). Gravar de verdade exige mode:"real".
 *
 * Ao subir, confere o .env.local, a conexão com o banco e a porta, e explica em português o que falta.
 */
import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertRoleUser, assertSafeDbTarget } from '../src/db/guard.js';
import { PgStore } from '../src/db/pg-store.js';
import { ingest } from '../src/pipeline/ingest.js';
import { FormsStore } from './lib/forms-store.js';
import { PgPainelRepo } from './lib/painel-repo.js';
import { PgBiRepo } from './lib/bi.js';
import { checkPortFree, formatReport, parseEnv, runPreflight } from './lib/preflight.js';
import { createStudioServer, type SubmitFn } from './server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env.local');

/** Fontes que o Studio sabe usar (slug -> variável com o token em texto puro, no .env.local). */
const SOURCE_TOKEN_VARS: Record<string, string> = {
  'lp-vercel-rh-teste': 'SOURCE_TOKEN_LP_VERCEL',
};

/* ---------- checagem de partida ---------- */
const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : null;
const port = Number(process.env.STUDIO_PORT ?? parseEnv(envText ?? '').STUDIO_PORT ?? 4310);

const report = await runPreflight({
  envPath,
  readEnvFile: () => envText,
  nodeVersion: process.versions.node,
  port,
  tokenVar: SOURCE_TOKEN_VARS['lp-vercel-rh-teste']!,
  sourceSlug: 'lp-vercel-rh-teste',
  connectDb: async (url) => {
    const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10_000 });
    try {
      await c.connect();
      await c.query('select 1');
    } finally {
      await c.end().catch(() => undefined);
    }
  },
  isPortFree: checkPortFree,
});
console.log(formatReport(report));
if (!report.ok) process.exit(1);

// Variáveis do .env.local entram no ambiente sem sobrescrever as que já existem.
for (const [k, v] of Object.entries(report.env)) if (process.env[k] === undefined) process.env[k] = v;

/* ---------- servidor ---------- */
const availableSources = Object.entries(SOURCE_TOKEN_VARS)
  .filter(([, v]) => !!process.env[v])
  .map(([slug]) => slug);

assertSafeDbTarget({ target: process.env.SUPABASE_DB_URL!, expectedRef: process.env.SUPABASE_PROJECT_REF! });
const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2, ssl: { rejectUnauthorized: false } });
let dbState: { connected: boolean; note?: string } = { connected: true };
pool.on('error', (e) => {
  dbState = { connected: false, note: e.message.replace(/postgres(ql)?:\/\/\S+/g, '<url>') };
});

// Painel de Dados (Data Hub): usa o papel orq_panel (le analytics e ops; grava so a configuracao).
// Opcional: sem PANEL_DB_URL o Studio sobe normalmente e o Painel avisa o que falta.
let painelPool: pg.Pool | null = null;
let painelRepo: PgPainelRepo | null = null;
let biRepo: PgBiRepo | null = null;
const painelUrl = process.env.PANEL_DB_URL ?? '';
if (painelUrl) {
  assertSafeDbTarget({ target: painelUrl, expectedRef: process.env.SUPABASE_PROJECT_REF! });
  assertRoleUser(painelUrl, 'orq_panel');
  painelPool = new pg.Pool({ connectionString: painelUrl, max: 2, ssl: { rejectUnauthorized: false } });
  painelPool.on('error', () => undefined);
  painelRepo = new PgPainelRepo(painelPool);
  biRepo = new PgBiRepo(painelPool); // o BI usa o mesmo papel orq_panel e só lê as visões de analytics
}

const forms = new FormsStore(join(root, 'studio', 'forms'));

const submit: SubmitFn = async (formId, mode, payload, ctx) => {
  const form = forms.get(formId);
  if (!form) return { status: 404, body: { error: 'not_found' } };
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

const server = createStudioServer({
  formsDir: join(root, 'studio', 'forms'),
  publicDir: join(root, 'studio', 'public'),
  trackingDir: join(root, 'tracking'),
  sources: availableSources,
  dbInfo: () => dbState,
  submit,
  painel: painelRepo,
  bi: biRepo,
});

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n✖ A porta ${port} foi ocupada por outro programa agora há pouco. Feche-o ou use outra porta: $env:STUDIO_PORT = 4311; npm run studio`);
  } else {
    console.error(`\n✖ O servidor do Studio não conseguiu subir: ${e.message}`);
  }
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`\nQuark Studio rodando em ${url}`);
  console.log('Modo padrão: SIMULAÇÃO (nada é gravado). Para parar: Ctrl+C.');
  console.log(painelRepo ? `Painel de Dados: ${url}/painel\nBI: ${url}/bi\n` : 'Painel de Dados e BI: desligados (falta PANEL_DB_URL no .env.local).\n');
  if (process.argv.includes('--open')) exec(`start "" "${url}"`);
});

function shutdown() {
  server.close();
  void pool.end();
  void painelPool?.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
