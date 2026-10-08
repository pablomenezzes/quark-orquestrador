/**
 * Enxugamento dos negócios (D-40), em lotes, sem estourar o limite de 500 MB do plano gratuito.
 *
 *   npx tsx scripts/datahub-slim.ts            -> só mostra o que faria e o tamanho atual (não altera nada)
 *   npx tsx scripts/datahub-slim.ts --apply    -> executa
 *
 * O que faz:
 *   1. crm.deals.custom_fields -> null (a cópia repetida; os campos ficam em raw.pd_deals.payload). Libera ~170 MB.
 *   2. raw.pd_deals.payload: tira de custom_fields só as chaves com valor null (ausente = vazio). payload_hash NÃO muda.
 *   3. VACUUM entre os lotes (para o espaço liberado ser reaproveitado e o banco não crescer) e, no fim, VACUUM FULL
 *      (devolve o espaço de verdade), primeiro na tabela que fica menor.
 * Usa o papel orq_sync (SYNC_DB_URL) para alterar dados e o dono do banco (SUPABASE_DB_URL) só para VACUUM e medir tamanho.
 * Pré-requisitos conferidos: migration 0009 aplicada (a ficha lê de raw) e um dump de menos de 24 h em backups/.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { assertRoleUser, assertSafeDbTarget } from '../src/db/guard.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* segue com o ambiente atual */
}
const apply = process.argv.includes('--apply');
const LIMITE_MB = 500;
const TETO_SEGURO_MB = 497; // se chegar aqui, para tudo
const LOTE = 2000;

const syncUrl = process.env.SYNC_DB_URL ?? '';
const ownerUrl = process.env.SUPABASE_DB_URL ?? '';
if (!syncUrl || !ownerUrl) {
  console.error('Faltam no .env.local: SYNC_DB_URL e SUPABASE_DB_URL.');
  process.exit(1);
}
const ref = process.env.SUPABASE_PROJECT_REF ?? '';
assertSafeDbTarget({ target: syncUrl, expectedRef: ref });
assertSafeDbTarget({ target: ownerUrl, expectedRef: ref });
assertRoleUser(syncUrl, 'orq_sync');

const sync = new pg.Client({ connectionString: syncUrl, ssl: { rejectUnauthorized: false } });
const owner = new pg.Client({ connectionString: ownerUrl, ssl: { rejectUnauthorized: false } });
await sync.connect();
await owner.connect();
await owner.query('set statement_timeout = 0');

const mb = async () => Number((await owner.query(`select pg_database_size(current_database()) / 1048576.0 as mb`)).rows[0].mb);
const tabelaMb = async (t: string) => Number((await owner.query(`select pg_total_relation_size($1::regclass) / 1048576.0 as mb`, [t])).rows[0].mb);
const fmt = (n: number) => `${n.toFixed(0)} MB`;

try {
  const antes = await mb();
  const pendCrm = Number((await sync.query(`select count(*)::int n from crm.deals where custom_fields is not null`)).rows[0].n);
  const pendRaw = Number((await sync.query(`select count(*)::int n from raw.pd_deals where jsonb_path_exists(payload, '$.custom_fields.* ? (@ == null)')`)).rows[0].n);
  console.log(`Banco: ${fmt(antes)} de ${LIMITE_MB} MB (raw.pd_deals ${fmt(await tabelaMb('raw.pd_deals'))}, crm.deals ${fmt(await tabelaMb('crm.deals'))}).`);
  console.log(`A fazer: ${pendCrm} cópias de custom_fields em crm.deals para limpar; ${pendRaw} JSONs em raw.pd_deals para enxugar.`);
  if (!apply) {
    console.log('\nSIMULAÇÃO: nada foi alterado. Para executar: rode de novo com --apply.');
    process.exit(0);
  }

  // ---- pré-requisitos ----
  const view = String((await owner.query(`select pg_get_viewdef('analytics.deal_campos'::regclass) as d`)).rows[0].d);
  if (!/raw\.pd_deals/.test(view)) throw new Error('A migration 0009 ainda não foi aplicada (a ficha ainda lê de crm.deals). Aplique-a antes.');
  const dumps = readdirSync('backups').filter((f) => /^dump-.*\.sql$/.test(f));
  const recente = dumps.some((f) => Date.now() - statSync(join('backups', f)).mtimeMs < 24 * 3600_000);
  if (!recente) throw new Error('Não há dump em backups/ com menos de 24 h. Rode scripts/dump.ps1 antes.');
  if (antes > TETO_SEGURO_MB) throw new Error(`O banco já está em ${fmt(antes)}; sem folga para rodar com segurança.`);

  const guarda = async (onde: string) => {
    const atual = await mb();
    if (atual > TETO_SEGURO_MB) throw new Error(`Parei por segurança em ${onde}: banco em ${fmt(atual)} (teto ${TETO_SEGURO_MB} MB).`);
    return atual;
  };

  // ---- 1) crm.deals.custom_fields -> null ----
  let feitos = 0;
  for (;;) {
    const r = await sync.query(
      `update crm.deals set custom_fields = null
        where pipedrive_id in (select pipedrive_id from crm.deals where custom_fields is not null order by pipedrive_id limit ${LOTE})`,
    );
    if (!r.rowCount) break;
    feitos += r.rowCount;
    await owner.query('vacuum crm.deals');
    console.log(`crm.deals: ${feitos}/${pendCrm} limpos · banco ${fmt(await guarda('crm.deals'))}`);
  }

  // ---- 2) raw.pd_deals.payload sem as chaves vazias de custom_fields ----
  feitos = 0;
  let ultimo = 0;
  for (;;) {
    const lim = await sync.query(`select max(source_id) as m from (select source_id from raw.pd_deals where source_id > $1 order by source_id limit ${LOTE}) t`, [ultimo]);
    const ate = lim.rows[0].m;
    if (ate == null) break;
    const r = await sync.query(
      `update raw.pd_deals
          set payload = jsonb_set(payload, '{custom_fields}',
                coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(payload -> 'custom_fields') e where e.value <> 'null'::jsonb), '{}'::jsonb))
        where source_id > $1 and source_id <= $2
          and jsonb_typeof(payload -> 'custom_fields') = 'object'
          and jsonb_path_exists(payload, '$.custom_fields.* ? (@ == null)')`,
      [ultimo, ate],
    );
    ultimo = Number(ate);
    feitos += r.rowCount ?? 0;
    await owner.query('vacuum raw.pd_deals');
    console.log(`raw.pd_deals: ${feitos}/${pendRaw} enxugados (até o ID ${ultimo}) · banco ${fmt(await guarda('raw.pd_deals'))}`);
  }

  // ---- 3) devolve o espaço de verdade: primeiro a tabela que fica menor (menos pico) ----
  for (const t of ['crm.deals', 'raw.pd_deals']) {
    const atual = await mb();
    const vivo = Number((await owner.query(`select (sum(pg_column_size(t.*)) / 1048576.0) as mb from ${t} t`)).rows[0].mb);
    if (atual + vivo * 1.3 > LIMITE_MB - 2) throw new Error(`VACUUM FULL de ${t} precisaria de ~${fmt(vivo * 1.3)} extras com o banco em ${fmt(atual)}; não é seguro. Pare aqui e me avise.`);
    console.log(`VACUUM FULL ${t} (banco ${fmt(atual)}, cópia nova ~${fmt(vivo * 1.3)})...`);
    await owner.query(`vacuum full ${t}`);
    console.log(`  pronto: ${t} agora ${fmt(await tabelaMb(t))} · banco ${fmt(await mb())}`);
  }

  const depois = await mb();
  console.log(`\nConcluído. Banco: ${fmt(antes)} -> ${fmt(depois)} (liberou ${fmt(antes - depois)}).`);
} catch (e) {
  console.error(`\nERRO: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await sync.end();
  await owner.end();
}
