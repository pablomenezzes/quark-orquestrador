/**
 * Sincronizacao do Meta Ads (SOMENTE LEITURA na Meta) -> mkt.meta_* no banco.
 *
 *   npx tsx scripts/meta-sync.ts                      -> simulacao: le a Meta e mostra o que traria; NAO grava
 *   npx tsx scripts/meta-sync.ts --apply              -> grava no banco (papel orq_sync)
 *   --contas rh,clinic     quais contas (padrao: as duas)
 *   --desde 2026-01-01     primeiro dia da carga inicial (padrao: 2026-01-01)
 *   --max-blocos N         para depois de N blocos de 31 dias por conta (continua na proxima rodada)
 *   --so estrutura|desempenho
 * Variaveis (.env.local): META_ACCESS_TOKEN, META_AD_ACCOUNT_RH, META_AD_ACCOUNT_CLINIC e, com --apply, SYNC_DB_URL.
 */
import pg from 'pg';
import { assertRoleUser, assertSafeDbTarget } from '../src/db/guard.js';
import { MetaClient, metaCredenciaisFromEnv } from '../src/datahub/meta/meta.js';
import { MetaStore, syncMetaDesempenho, syncMetaEstrutura, syncMetaLigacao } from '../src/datahub/meta/meta-sync.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* segue com o ambiente atual */
}
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const desde = opt('--desde') ?? '2026-01-01'; // decisao do Pablo (2026-10-13): a Meta so de 2026 em diante
if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
  console.error('--desde precisa ser AAAA-MM-DD.');
  process.exit(1);
}
const so = opt('--so');
if (so && !['estrutura', 'desempenho', 'ligacao'].includes(so)) {
  console.error('--so aceita: estrutura, desempenho ou ligacao.');
  process.exit(1);
}
if (apply && (so === undefined || so === 'desempenho')) {
  // protocolo (2026-10-13): o desempenho so e gravado por rodada autorizada
  console.error('Com --apply use --so estrutura ou --so ligacao. O desempenho da Meta so e gravado por rodada autorizada: scripts/meta-rodada.ts (simulacao, cartao e "pode seguir").');
  process.exit(1);
}
const maxBlocos = opt('--max-blocos') ? Number(opt('--max-blocos')) : undefined;
const cred = metaCredenciaisFromEnv(process.env);
const escolhidas = opt('--contas') ? (opt('--contas') ?? '').split(',').filter(Boolean) : cred.contas.map((c) => c.produto);
const contas = cred.contas.filter((c) => escolhidas.includes(c.produto));
if (!contas.length) {
  console.error('Nenhuma conta escolhida. Use --contas rh,clinic.');
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
const client = new MetaClient(cred.token);
const store = new MetaStore(pool ?? { query: async () => ({ rows: [] }) as never });
console.log(apply ? 'Modo GRAVAR (orq_sync).' : 'Modo SIMULACAO: nada sera gravado.');
let falhou = false;
const log = (s: string) => console.log('  ' + s);
for (const conta of contas) {
  const r: Array<Awaited<ReturnType<typeof syncMetaEstrutura>>> = [];
  if (so !== 'desempenho' && so !== 'ligacao') r.push(await syncMetaEstrutura(client, store, conta, { apply, log }));
  if (so === undefined || so === 'desempenho') r.push(await syncMetaDesempenho(client, store, conta, { desde, apply, maxBlocos, log }));
  for (const x of r) {
    console.log(`${x.entidade}: ${x.lidos} lidos, ${x.gravados} gravados${x.ate ? `, ate ${x.ate}` : ''}${x.faltaram ? `, ${x.faltaram} itens buscados pelo ID` : ''}${x.parou ? ` PAROU: ${x.parou}` : ''}${x.erro ? ` ERRO: ${x.erro}` : ''}`);
    if (x.erro) falhou = true;
  }
}
if (so === 'ligacao' && apply) {
  const lig = await syncMetaLigacao(store, { apply });
  console.log(`${lig.entidade}: ${lig.gravados} negocios ligados${lig.erro ? ` ERRO: ${lig.erro}` : ''}`);
  if (lig.erro) falhou = true;
}
console.log(`Requisicoes a Meta: ${client.requisicoes} | uso maximo da cota: chamadas ${client.usoMaximo.callCount}%, cpu ${client.usoMaximo.cpu}%, tempo ${client.usoMaximo.tempo}% (para a 75%)`);
await pool?.end();
process.exit(falhou ? 1 : 0);
