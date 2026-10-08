// Define a senha de um papel do Data Hub e grava a URL de conexão no .env.local. Nada secreto é impresso.
//
//   node scripts/set-role-password.mjs --role orq_sync            -> simulação (não altera nada)
//   node scripts/set-role-password.mjs --role orq_sync --apply    -> define a senha e grava SYNC_DB_URL
//   node scripts/set-role-password.mjs --role orq_panel --apply   -> define a senha e grava PANEL_DB_URL
//
// Rodar de novo gira a senha (a anterior deixa de valer). A senha NUNCA fica em migration.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const ROLES = { orq_sync: 'SYNC_DB_URL', orq_panel: 'PANEL_DB_URL', orq_chat: 'CHAT_DB_URL' };
const argv = process.argv.slice(2);
const role = argv[argv.indexOf('--role') + 1];
const apply = argv.includes('--apply');
if (!ROLES[role]) throw new Error(`Use --role ${Object.keys(ROLES).join(' | ')}`);
const envVar = ROLES[role];

const ENV = '.env.local';
process.loadEnvFile(ENV);
const admin = process.env.SUPABASE_DB_URL ?? '';
const ref = process.env.SUPABASE_PROJECT_REF ?? '';
if (!admin || !ref || !admin.includes(ref)) throw new Error('SUPABASE_DB_URL / SUPABASE_PROJECT_REF ausentes ou inconsistentes no .env.local.');

console.log(`Plano para o papel ${role}:`);
console.log(` 1. ALTER ROLE ${role} WITH PASSWORD <aleatória de 40 caracteres>   (no banco)`);
console.log(` 2. Gravar ${envVar} (usuário ${role}.<ref>) no .env.local`);
if (!apply) {
  console.log('\n(simulação) Nada foi alterado. Rode com --apply depois de aprovar.');
  process.exit(0);
}

const u = new URL(admin);
const password = randomBytes(30).toString('base64url'); // só [A-Za-z0-9_-]: seguro em SQL e em URL
const url = `postgresql://${role}.${ref}:${password}@${u.host}${u.pathname}`;

const c = new pg.Client({ connectionString: admin, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  const r = await c.query('select 1 from pg_roles where rolname = $1', [role]);
  if (r.rowCount === 0) throw new Error(`O papel ${role} não existe. Aplique a migration do Data Hub primeiro.`);
  await c.query(`alter role ${role} with password '${password}'`);
} finally {
  await c.end();
}

let text = readFileSync(ENV, 'utf8');
const re = new RegExp(`^${envVar}=.*$`, 'm');
text = re.test(text) ? text.replace(re, `${envVar}=${url}`) : `${text.replace(/\s*$/, '\n')}${envVar}=${url}\n`;
writeFileSync(ENV, text);
console.log(`\nSenha do papel ${role} definida. ${envVar} gravada no .env.local (valor não exibido).`);
