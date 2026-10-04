// Define a senha do papel orq_ingest e grava INGEST_DB_URL e RATE_LIMIT_SALT no .env.local (e, com --vercel, na Vercel).
// A senha NÃO fica em migration (seria versionada). Nada secreto é impresso.
//
//   node scripts/set-ingest-password.mjs              -> simulação: só mostra o que faria
//   node scripts/set-ingest-password.mjs --apply      -> altera a senha do papel e atualiza o .env.local
//   node scripts/set-ingest-password.mjs --apply --vercel -> também envia as variáveis à Vercel (production)
//
// Rodar de novo gira a senha (a anterior deixa de valer).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const ENV = '.env.local';
const apply = process.argv.includes('--apply');
const toVercel = process.argv.includes('--vercel');

process.loadEnvFile(ENV);
const admin = process.env.SUPABASE_DB_URL ?? '';
const ref = process.env.SUPABASE_PROJECT_REF ?? '';
if (!admin || !ref || !admin.includes(ref)) throw new Error('SUPABASE_DB_URL / SUPABASE_PROJECT_REF ausentes ou inconsistentes no .env.local.');

const u = new URL(admin);
const password = randomBytes(30).toString('base64url'); // só [A-Za-z0-9_-]: seguro em SQL e em URL sem codificação
const ingestUrl = `postgresql://orq_ingest.${ref}:${password}@${u.host}${u.pathname}`;
const salt = process.env.RATE_LIMIT_SALT || randomBytes(32).toString('base64url');

console.log('Plano:');
console.log(' 1. ALTER ROLE orq_ingest WITH PASSWORD <aleatória de 40 caracteres>   (no banco)');
console.log(' 2. Gravar INGEST_DB_URL (usuário orq_ingest.<ref>) no .env.local');
console.log(` 3. ${process.env.RATE_LIMIT_SALT ? 'Manter' : 'Gerar e gravar'} RATE_LIMIT_SALT no .env.local`);
if (toVercel) console.log(' 4. Enviar INGEST_DB_URL (sensível) e RATE_LIMIT_SALT (sensível) à Vercel, ambiente production');
if (!apply) {
  console.log('\n(simulação) Nada foi alterado. Rode com --apply depois de aprovar.');
  process.exit(0);
}

const c = new pg.Client({ connectionString: admin, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  const r = await c.query(`select 1 from pg_roles where rolname = 'orq_ingest'`);
  if (r.rowCount === 0) throw new Error('O papel orq_ingest não existe. Aplique a migration 0003 primeiro.');
  await c.query(`alter role orq_ingest with password '${password}'`);
} finally {
  await c.end();
}

function upsertEnv(key, value) {
  let text = readFileSync(ENV, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\s*$/, '\n')}${key}=${value}\n`;
  writeFileSync(ENV, text);
}
upsertEnv('INGEST_DB_URL', ingestUrl);
upsertEnv('RATE_LIMIT_SALT', salt);
console.log('\nSenha do papel definida. INGEST_DB_URL e RATE_LIMIT_SALT gravadas no .env.local (valores não exibidos).');

if (toVercel) {
  for (const [name, value] of [['INGEST_DB_URL', ingestUrl], ['RATE_LIMIT_SALT', salt]]) {
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vercel', 'env', 'add', name, 'production', '--value', value, '--force', '--yes', '--sensitive'], { stdio: 'pipe', shell: process.platform === 'win32' });
    console.log(`Vercel (production): ${name} atualizada.`);
  }
}
