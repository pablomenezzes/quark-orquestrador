/**
 * Sincronização do Data Hub (Pipedrive -> banco). Pipedrive SOMENTE LEITURA.
 *
 *   npx tsx scripts/datahub-sync.ts                          -> simulação: lê o Pipedrive e mostra o que traria; NÃO grava
 *   npx tsx scripts/datahub-sync.ts --apply                  -> grava no banco (papel orq_sync)
 *   npx tsx scripts/datahub-sync.ts --entities pipelines,stages --apply
 *   npx tsx scripts/datahub-sync.ts --entities deals,deals_archived,deals_deleted --apply
 *   npx tsx scripts/datahub-sync.ts --entities deals --apply --max-pages 5   -> carga gradual: para depois de 5 páginas e continua na próxima
 *   --share 0.4   fatia máxima da cota diária do Pipedrive que a sincronização pode gastar (padrão 0,4)
 *
 * Negócios: a carga inicial (desde 2025-01-01) é retomável e depois só vem o que mudou. Ver src/datahub/sync/deals.ts.
 * Variáveis (.env.local): PIPEDRIVE_DOMAIN, PIPEDRIVE_API_TOKEN e, com --apply, SYNC_DB_URL.
 */
import pg from 'pg';
import { assertRoleUser, assertSafeDbTarget } from '../src/db/guard.js';
import { PgDatahubStore } from '../src/datahub/pg-store.js';
import { PipedriveReadClient, type DealListKind } from '../src/datahub/pipedrive/client.js';
import { E1_ENTITIES, syncBase, type E1Entity } from '../src/datahub/sync/base.js';
import { DEAL_ENTITY, DEAL_KINDS, syncDeals } from '../src/datahub/sync/deals.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* segue com o ambiente atual */
}

const DEAL_ENTITIES = DEAL_KINDS.map((k) => DEAL_ENTITY[k]);
const ALL = [...E1_ENTITIES, ...DEAL_ENTITIES] as readonly string[];
const DESDE = '2025-01-01T00:00:00Z';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const wanted = opt('--entities') ? (opt('--entities') ?? '').split(',').filter(Boolean) : [...E1_ENTITIES];
const bad = wanted.filter((e) => !ALL.includes(e));
if (bad.length) {
  console.error(`Entidade desconhecida: ${bad.join(', ')}. Válidas: ${ALL.join(', ')}`);
  process.exit(1);
}
const maxPages = opt('--max-pages') ? Number(opt('--max-pages')) : undefined;
if (maxPages !== undefined && !(Number.isInteger(maxPages) && maxPages > 0)) {
  console.error('--max-pages precisa ser um número inteiro maior que zero.');
  process.exit(1);
}
const share = opt('--share') ? Number(opt('--share')) : 0.4;
if (!(share > 0 && share <= 1)) {
  console.error('--share precisa estar entre 0 e 1 (ex.: 0.4 = 40% da cota do dia).');
  process.exit(1);
}
// A ordem importa: etapas dependem dos pipelines; negócios dependem das definições de campos (motivos de perda).
const baseEntities = E1_ENTITIES.filter((e) => wanted.includes(e));
const dealKinds = DEAL_KINDS.filter((k) => wanted.includes(DEAL_ENTITY[k]));

const domain = process.env.PIPEDRIVE_DOMAIN ?? '';
const token = process.env.PIPEDRIVE_API_TOKEN ?? '';
const missing = [!domain && 'PIPEDRIVE_DOMAIN', !token && 'PIPEDRIVE_API_TOKEN', apply && !process.env.SYNC_DB_URL && 'SYNC_DB_URL'].filter(Boolean);
if (missing.length) {
  console.error(`Faltam no .env.local: ${missing.join(', ')}.`);
  process.exit(1);
}

const client = new PipedriveReadClient({ domain, apiToken: token, keepFreeShare: 1 - share });

if (!apply) {
  console.log('SIMULAÇÃO: lendo o Pipedrive (somente leitura). Nada será gravado.\n');
  for (const e of baseEntities) {
    const items: unknown[] =
      e === 'pipelines' ? await client.listPipelines()
      : e === 'stages' ? await client.listStages()
      : e === 'users' ? await client.listUsers()
      : await client.listFieldDefs(e.replace('_fields', '') as 'deal');
    const label = (x: unknown) => String((x as { name?: string; field_name?: string }).name ?? (x as { field_name?: string }).field_name ?? '?');
    const sample = e === 'users' ? '' : ` | ${items.slice(0, 8).map(label).join(', ')}${items.length > 8 ? ', ...' : ''}`;
    console.log(`${e.padEnd(20)} ${String(items.length).padStart(4)} registro(s)${sample}`);
  }
  for (const k of dealKinds as DealListKind[]) {
    const page = await client.listDealsPage(k, { updatedSince: DESDE });
    console.log(`${DEAL_ENTITY[k].padEnd(20)} primeira página: ${page.items.length} registro(s)${page.nextCursor ? ' (há mais páginas)' : ' (é tudo)'}`);
  }
  console.log(`\nUnidades da cota gastas: ${client.usage.tokens} (${client.usage.requests} requisições).`);
  console.log('Para gravar de verdade: rode de novo com --apply.');
  process.exit(0);
}

const url = process.env.SYNC_DB_URL!;
assertSafeDbTarget({ target: url, expectedRef: process.env.SUPABASE_PROJECT_REF ?? '' });
assertRoleUser(url, 'orq_sync');
const pool = new pg.Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
try {
  const store = new PgDatahubStore(pool);
  const results: Array<{ entity: string; status: string; lidos: number; gravados: number; atualizados: number; ignorados: number; falhas: number; tokens_gastos: number; erro?: string; extra?: string }> = [];
  if (baseEntities.length) {
    results.push(...(await syncBase({ client, store, entities: baseEntities as E1Entity[], modo: 'incremental', origem: 'manual', now: () => new Date() })));
  }
  if (dealKinds.length) {
    const deals = await syncDeals({ client, store, kinds: dealKinds, desde: DESDE, origem: 'manual', now: () => new Date(), maxPages });
    results.push(...deals.map((d) => ({ ...d, extra: `${d.backfill ? 'carga inicial' : 'só o que mudou'}, ${d.paginas} página(s)` })));
  }
  console.log('');
  console.log('entidade             status   lidos  gravados  atualizados  ignorados  falhas  unidades');
  for (const r of results) {
    console.log(`${r.entity.padEnd(20)} ${r.status.padEnd(8)} ${String(r.lidos).padStart(5)}  ${String(r.gravados).padStart(8)}  ${String(r.atualizados).padStart(11)}  ${String(r.ignorados).padStart(9)}  ${String(r.falhas).padStart(6)}  ${String(r.tokens_gastos).padStart(8)}${r.extra ? `  (${r.extra})` : ''}`);
    if (r.erro) console.log(`  ${r.status === 'parcial' ? 'parou' : 'erro'}: ${r.erro}`);
  }
  const d = client.daily;
  if (d.limit != null && d.remaining != null) console.log(`\nCota diária do Pipedrive: restam ${d.remaining} de ${d.limit} unidades (já usadas hoje por todos: ${d.limit - d.remaining}).`);
  if (results.some((r) => r.status === 'erro')) process.exitCode = 1;
} finally {
  await pool.end();
}
