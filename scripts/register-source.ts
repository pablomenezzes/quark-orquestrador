/**
 * Registra uma fonte em orq.sources e gera o token dela.
 *
 *   npx tsx scripts/register-source.ts --slug lp-vercel-rh --tipo vercel --produto rh --url https://lp.exemplo.com.br
 *
 * Sem --apply: mostra o que seria feito e NÃO toca no banco (regra 4 da seção 4).
 * Com --apply: grava só o hash. O token em texto puro aparece UMA vez, no seu terminal;
 * copie para o LP / URL do webhook. Ele não é guardado em lugar nenhum.
 */
import { appendFileSync } from 'node:fs';
import pg from 'pg';
import { assertSafeDbTarget } from '../src/db/guard';
import { generateToken, hashToken } from '../src/security/verify-token';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* segue com o ambiente atual */
}

const TIPOS = ['elementor', 'vercel', 'lovable', 'fillout', 'meta_form'];
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith('--')) {
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args.set(a.slice(2), next);
      i++;
    } else args.set(a.slice(2), 'true');
  }
}

const slug = args.get('slug');
const tipo = args.get('tipo');
const produto = args.get('produto') ?? null;
const url = args.get('url') ?? null;
if (!slug || !/^[a-z0-9][a-z0-9-]{2,60}$/.test(slug)) throw new Error('--slug obrigatório (minúsculas, números e hífen)');
if (!tipo || !TIPOS.includes(tipo)) throw new Error(`--tipo obrigatório: ${TIPOS.join(' | ')}`);
if (produto && !['rh', 'clinic'].includes(produto)) throw new Error('--produto deve ser rh ou clinic');

const token = generateToken();
console.log('Fonte a registrar:', { slug, tipo, produto, url });

if (!args.has('apply')) {
  console.log('\n(simulação) Nada foi gravado. Rode com --apply depois de aprovar.');
  process.exit(0);
}

const dbUrl = process.env.SUPABASE_DB_URL ?? '';
assertSafeDbTarget({ target: dbUrl, expectedRef: process.env.SUPABASE_PROJECT_REF ?? '' });
const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(`insert into orq.sources (slug, tipo, produto, url, token_hash) values ($1, $2, $3, $4, $5)`, [slug, tipo, produto, url, hashToken(token)]);
  console.log('\nFonte registrada.');
  const saveAs = args.get('save-env');
  if (saveAs) {
    // Grava o token em texto puro só no .env.local (ignorado pelo git); nada é impresso.
    appendFileSync('.env.local', `\n${saveAs}=${token}\n`);
    console.log(`Token salvo em .env.local como ${saveAs} (não exibido).`);
  } else {
    console.log(`TOKEN (copie agora; não será mostrado de novo): ${token}`);
  }
} finally {
  await client.end();
}
