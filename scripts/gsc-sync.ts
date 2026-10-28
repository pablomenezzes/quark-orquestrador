/**
 * Sincronizacao do Google Search Console (SOMENTE LEITURA no Google) -> mkt.gsc_* no banco. Uma propriedade por marca.
 *
 *   npx tsx scripts/gsc-sync.ts                    -> simulacao: le o GSC e mostra quantas linhas traria; NAO grava
 *   npx tsx scripts/gsc-sync.ts --apply            -> grava no banco (papel orq_sync)
 *   npx tsx scripts/gsc-sync.ts --marca clinic     -> so uma marca (rh ou clinic)
 *   npx tsx scripts/gsc-sync.ts --entities gsc_pagina --apply
 *   --desde 2025-07-01   primeiro dia da carga inicial (o GSC guarda ~16 meses)
 *   --max-blocos N       para depois de N blocos de 31 dias (continua na proxima rodada)
 * Variaveis (.env.local): GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_PRIVATE_KEY, GSC_SITE_URL (RH), GSC_SITE_URL_CLINIC e, com --apply, SYNC_DB_URL.
 */
import pg from 'pg';
import { assertRoleUser, assertSafeDbTarget } from '../src/db/guard.js';
import { MARCAS_GA4 } from '../src/datahub/google/ga4.js';
import { GSC_ENTIDADES, GscClient, gscSitesFromEnv, type GscEntidade } from '../src/datahub/google/gsc.js';
import { GscStore, syncGscEntidade } from '../src/datahub/google/gsc-sync.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* segue com o ambiente atual */
}
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const desde = opt('--desde') ?? '2025-07-01';
if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
  console.error('--desde precisa ser AAAA-MM-DD.');
  process.exit(1);
}
const wanted = opt('--entities') ? (opt('--entities') ?? '').split(',').filter(Boolean) : [...GSC_ENTIDADES];
const bad = wanted.filter((e) => !(GSC_ENTIDADES as readonly string[]).includes(e));
if (bad.length) {
  console.error(`Entidade desconhecida: ${bad.join(', ')}. Validas: ${GSC_ENTIDADES.join(', ')}`);
  process.exit(1);
}
const maxBlocos = opt('--max-blocos') ? Number(opt('--max-blocos')) : undefined;
const marcaPedida = opt('--marca');
if (marcaPedida && !(MARCAS_GA4 as readonly string[]).includes(marcaPedida)) {
  console.error(`--marca desconhecida: ${marcaPedida}. Validas: ${MARCAS_GA4.join(', ')}`);
  process.exit(1);
}

const clientEmail = process.env.GOOGLE_SA_CLIENT_EMAIL;
const rawKey = process.env.GOOGLE_SA_PRIVATE_KEY;
if (!clientEmail || !rawKey) {
  console.error('Faltam GOOGLE_SA_CLIENT_EMAIL ou GOOGLE_SA_PRIVATE_KEY no .env.local.');
  process.exit(1);
}
const privateKey = rawKey.startsWith('"') ? (JSON.parse(rawKey) as string) : rawKey.replace(/\\n/g, '\n');
const sites = gscSitesFromEnv(process.env).filter((s) => !marcaPedida || s.marca === marcaPedida);
if (!sites.length) {
  console.error(`Nenhuma propriedade do Search Console configurada${marcaPedida ? ` para ${marcaPedida}` : ''}. Confira GSC_SITE_URL e GSC_SITE_URL_CLINIC no .env.local.`);
  process.exit(1);
}
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
console.log(apply ? 'Modo GRAVAR (orq_sync).' : 'Modo SIMULACAO: nada sera gravado.');
let falhou = false;
const jaVistas = new Set<string>();
for (const s of sites) {
  // a primeira propriedade de cada marca mantem a chave simples ("gsc_pagina:rh"); as outras ganham um sufixo com o endereco
  const sufixo = jaVistas.has(s.marca) ? s.siteUrl.replace(/^https?:\/\//, '').replace(/^sc-domain:/, '').replace(/[^a-z0-9.]+/gi, '_') : '';
  jaVistas.add(s.marca);
  console.log(`\n== Search Console ${s.marca} (${s.siteUrl}) ==`);
  const client = new GscClient({ clientEmail, privateKey }, s.siteUrl);
  const store = new GscStore(pool ?? { query: async () => ({ rows: [] }) as never }, s.marca, sufixo);
  for (const e of wanted as GscEntidade[]) {
    const r = await syncGscEntidade(client, store, e, { desde, apply, maxBlocos, log: (m) => console.log('  ' + m) });
    console.log(`${r.entidade}: ${r.blocos} bloco(s), ${r.lidos} linhas lidas, ${r.gravados} gravadas, ate ${r.ate ?? '-'}${r.erro ? ' ERRO: ' + r.erro : ''}`);
    if (r.erro) {
      falhou = true;
      break; // sem acesso (conta de servico nao adicionada na propriedade) ou cota: as outras entidades falhariam igual
    }
  }
  console.log(`Requisicoes ao Search Console (${s.marca}): ${client.requisicoes}`);
}
await pool?.end();
process.exit(falhou ? 1 : 0);
