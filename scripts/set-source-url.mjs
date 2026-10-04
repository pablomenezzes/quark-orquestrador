// Cadastra as origens permitidas (CORS) de uma fonte em orq.sources.url.
//   node scripts/set-source-url.mjs --slug lp-vercel-rh-teste --url "https://lp.exemplo.com.br https://www.exemplo.com.br"
//   (acrescente --apply para gravar; sem ele é só simulação)
//
// A coluna aceita várias URLs separadas por espaço, vírgula, ponto e vírgula ou quebra de linha; só a ORIGEM
// (esquema + host + porta) vale. Fontes de servidor (Elementor, Fillout, Meta) não precisam de URL.
import pg from 'pg';

const args = new Map();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args.set(argv[i].slice(2), next); i++; } else args.set(argv[i].slice(2), 'true');
  }
}
const slug = args.get('slug');
const url = args.get('url');
if (!slug || !url) throw new Error('Uso: --slug <slug> --url "<url1> <url2>" [--apply]');

const origins = [];
for (const part of url.split(/[\s,;]+/).filter(Boolean)) {
  try {
    const o = new URL(part);
    if (!['http:', 'https:'].includes(o.protocol)) throw new Error('esquema');
    if (!origins.includes(o.origin)) origins.push(o.origin);
  } catch {
    throw new Error(`URL inválida: ${part}`);
  }
}
console.log(`Fonte: ${slug}`);
console.log(`Origens que passarão a ser aceitas pelo navegador:\n  - ${origins.join('\n  - ')}`);
if (!args.has('apply')) {
  console.log('\n(simulação) Nada foi gravado. Rode com --apply para gravar.');
  process.exit(0);
}

process.loadEnvFile('.env.local');
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  const r = await c.query(`update orq.sources set url = $1 where slug = $2`, [origins.join(' '), slug]);
  if (r.rowCount === 0) throw new Error(`Fonte "${slug}" não encontrada.`);
  console.log('\nGravado. O endpoint passa a enxergar a mudança em até 60 segundos (cache).');
} finally {
  await c.end();
}
