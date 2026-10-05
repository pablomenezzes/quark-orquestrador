/**
 * Sincronização do Data Hub (Pipedrive -> banco). Pipedrive SOMENTE LEITURA.
 *
 *   npx tsx scripts/datahub-sync.ts                    -> simulação: lê o Pipedrive e mostra o que traria; NÃO grava
 *   npx tsx scripts/datahub-sync.ts --apply            -> grava no banco (papel orq_sync)
 *   npx tsx scripts/datahub-sync.ts --entities pipelines,stages --apply
 *
 * Variáveis (.env.local): PIPEDRIVE_DOMAIN, PIPEDRIVE_API_TOKEN e, com --apply, SYNC_DB_URL.
 */
import pg from 'pg';
import { assertRoleUser, assertSafeDbTarget } from '../src/db/guard.js';
import { PgDatahubStore } from '../src/datahub/pg-store.js';
import { PipedriveReadClient } from '../src/datahub/pipedrive/client.js';
import { E1_ENTITIES, syncBase, type E1Entity } from '../src/datahub/sync/base.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* segue com o ambiente atual */
}

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const ei = argv.indexOf('--entities');
const wanted = ei >= 0 ? (argv[ei + 1] ?? '').split(',').filter(Boolean) : [...E1_ENTITIES];
const bad = wanted.filter((e) => !(E1_ENTITIES as readonly string[]).includes(e));
if (bad.length) {
  console.error(`Entidade desconhecida: ${bad.join(', ')}. Válidas: ${E1_ENTITIES.join(', ')}`);
  process.exit(1);
}
// A ordem importa: etapas dependem dos pipelines.
const entities = E1_ENTITIES.filter((e) => wanted.includes(e));

const domain = process.env.PIPEDRIVE_DOMAIN ?? '';
const token = process.env.PIPEDRIVE_API_TOKEN ?? '';
const missing = [!domain && 'PIPEDRIVE_DOMAIN', !token && 'PIPEDRIVE_API_TOKEN', apply && !process.env.SYNC_DB_URL && 'SYNC_DB_URL'].filter(Boolean);
if (missing.length) {
  console.error(`Faltam no .env.local: ${missing.join(', ')}.`);
  process.exit(1);
}

const client = new PipedriveReadClient({ domain, apiToken: token });

if (!apply) {
  console.log('SIMULAÇÃO: lendo o Pipedrive (somente leitura). Nada será gravado.\n');
  for (const e of entities) {
    const items: unknown[] =
      e === 'pipelines' ? await client.listPipelines()
      : e === 'stages' ? await client.listStages()
      : e === 'users' ? await client.listUsers()
      : await client.listFieldDefs(e.replace('_fields', '') as 'deal');
    const label = (x: unknown) => String((x as { name?: string; field_name?: string }).name ?? (x as { field_name?: string }).field_name ?? '?');
    const sample = e === 'users' ? '' : ` | ${items.slice(0, 8).map(label).join(', ')}${items.length > 8 ? ', ...' : ''}`;
    console.log(`${e.padEnd(20)} ${String(items.length).padStart(4)} registro(s)${sample}`);
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
  const results = await syncBase({
    client,
    store: new PgDatahubStore(pool),
    entities: entities as E1Entity[],
    modo: 'incremental',
    origem: 'manual',
    now: () => new Date(),
  });
  console.log('');
  console.log('entidade             status   lidos  gravados  atualizados  ignorados  falhas  unidades');
  for (const r of results) {
    console.log(`${r.entity.padEnd(20)} ${r.status.padEnd(8)} ${String(r.lidos).padStart(5)}  ${String(r.gravados).padStart(8)}  ${String(r.atualizados).padStart(11)}  ${String(r.ignorados).padStart(9)}  ${String(r.falhas).padStart(6)}  ${String(r.tokens_gastos).padStart(8)}`);
    if (r.erro) console.log(`  erro: ${r.erro}`);
  }
  if (results.some((r) => r.status === 'erro')) process.exitCode = 1;
} finally {
  await pool.end();
}
