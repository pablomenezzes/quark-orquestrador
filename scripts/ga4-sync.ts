/**
 * Sincronizacao do Google Analytics 4 (SOMENTE LEITURA no Google) -> mkt.ga4_* no banco.
 *
 *   npx tsx scripts/ga4-sync.ts                    -> simulacao: le o GA4 e mostra quantas linhas traria; NAO grava
 *   npx tsx scripts/ga4-sync.ts --apply            -> grava no banco (papel orq_sync)
 *   npx tsx scripts/ga4-sync.ts --entities ga4_eventos --apply
 *   --desde 2025-01-01   primeiro dia da carga inicial (padrao 2025-01-01)
 *   --max-blocos N       para depois de N blocos de 31 dias (continua na proxima rodada)
 * Variaveis (.env.local): GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_PRIVATE_KEY, GA4_PROPERTY_ID e, com --apply, SYNC_DB_URL.
 */
import pg from 'pg';
import { assertRoleUser, assertSafeDbTarget } from '../src/db/guard.js';
import { GA4_ENTIDADES, Ga4Client, ga4CredentialsFromEnv, type Ga4Entidade } from '../src/datahub/google/ga4.js';
import { Ga4Store, syncGa4Entidade } from '../src/datahub/google/ga4-sync.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* segue com o ambiente atual */
}
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const desde = opt('--desde') ?? '2025-01-01';
if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
  console.error('--desde precisa ser AAAA-MM-DD.');
  process.exit(1);
}
const wanted = opt('--entities') ? (opt('--entities') ?? '').split(',').filter(Boolean) : [...GA4_ENTIDADES];
const bad = wanted.filter((e) => !(GA4_ENTIDADES as readonly string[]).includes(e));
if (bad.length) {
  console.error(`Entidade desconhecida: ${bad.join(', ')}. Validas: ${GA4_ENTIDADES.join(', ')}`);
  process.exit(1);
}
const maxBlocos = opt('--max-blocos') ? Number(opt('--max-blocos')) : undefined;

const cred = ga4CredentialsFromEnv(process.env);
const client = new Ga4Client(cred);
let pool: pg.Pool | undefined;
if (apply) {
  const url = process.env.SYNC_DB_URL;
  if (!url) {
    console.error('Falta SYNC_DB_URL no .env.local.');
    process.exit(1);
  }
  assertSafeDbTarget({ target: url, expectedRef: process.env.SUPABASE_PROJECT_REF ?? '' });
  assertRoleUser(url, 'orq_sync');
  pool = new pg.Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
}
const store = new Ga4Store(pool ?? { query: async () => ({ rows: [] }) as never }, Number(cred.propertyId));
console.log(apply ? 'Modo GRAVAR (orq_sync).' : 'Modo SIMULACAO: nada sera gravado.');
let falhou = false;
for (const e of wanted as Ga4Entidade[]) {
  const r = await syncGa4Entidade(client, store, e, { desde, apply, maxBlocos, log: (s) => console.log('  ' + s) });
  console.log(`${r.entidade}: ${r.blocos} bloco(s), ${r.lidos} linhas lidas, ${r.gravados} gravadas, ate ${r.ate ?? '-'}${r.erro ? ' ERRO: ' + r.erro : ''}`);
  if (r.erro) falhou = true;
}
console.log(`Requisicoes ao GA4: ${client.requisicoes}`);
await pool?.end();
process.exit(falhou ? 1 : 0);
