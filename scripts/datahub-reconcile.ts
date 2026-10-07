/**
 * Conferência dos negócios: compara o que o Pipedrive tem AGORA com o que está no banco (somente leitura nos dois lados).
 *
 *   npx tsx scripts/datahub-reconcile.ts
 *
 * 1) Tabela por pipeline e status (lista normal) e totais de arquivados e excluídos.
 * 2) Negócio a negócio: cada diferença é EXPLICADA (o negócio mudou depois da última sincronização, o que é normal
 *    porque o time mexe no Pipedrive o dia todo) ou fica "SEM EXPLICAÇÃO" (aí sim é problema). Só a segunda dá código de saída 2.
 *
 * Custa cerca de 10 unidades da cota por 500 negócios (+1 por negócio que sumiu da lista). Variáveis: PIPEDRIVE_*, SYNC_DB_URL.
 */
import pg from 'pg';
import { assertRoleUser, assertSafeDbTarget } from '../src/db/guard.js';
import { PipedriveReadClient, type DealListKind } from '../src/datahub/pipedrive/client.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* segue com o ambiente atual */
}
const DESDE = '2025-01-01T00:00:00Z';
const domain = process.env.PIPEDRIVE_DOMAIN ?? '';
const token = process.env.PIPEDRIVE_API_TOKEN ?? '';
const url = process.env.SYNC_DB_URL ?? '';
if (!domain || !token || !url) {
  console.error('Faltam no .env.local: PIPEDRIVE_DOMAIN, PIPEDRIVE_API_TOKEN e SYNC_DB_URL.');
  process.exit(1);
}
assertSafeDbTarget({ target: url, expectedRef: process.env.SUPABASE_PROJECT_REF ?? '' });
assertRoleUser(url, 'orq_sync');

const client = new PipedriveReadClient({ domain, apiToken: token, keepFreeShare: 0.5 });
type PdDeal = { id: number; pipeline_id: number | null; status: string | null; update_time: string | null };

async function listAll(kind: DealListKind): Promise<PdDeal[]> {
  const out: PdDeal[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: unknown[]; nextCursor: string | null } = await client.listDealsPage(kind, { updatedSince: DESDE, cursor });
    for (const it of page.items as PdDeal[]) out.push({ id: it.id, pipeline_id: it.pipeline_id ?? null, status: it.status ?? null, update_time: it.update_time ?? null });
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

const pdNormal = await listAll('normal');
const pdArq = await listAll('archived');
const pdDel = await listAll('deleted');

const pool = new pg.Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
try {
  const dbRows = (
    await pool.query(`select pipedrive_id, pipeline_id, status, updated_at from crm.deals where not is_archived and not is_deleted`)
  ).rows as Array<{ pipedrive_id: string; pipeline_id: string | null; status: string | null; updated_at: Date | null }>;
  const names = new Map<string, string>((await pool.query(`select pipeline_id::text k, nome from crm.pipelines`)).rows.map((r: { k: string; nome: string }) => [r.k, r.nome]));
  const arq = (await pool.query(`select count(*)::int n from crm.deals where is_archived and not is_deleted`)).rows[0].n as number;
  const del = (await pool.query(`select count(*)::int n from crm.deals where is_deleted`)).rows[0].n as number;
  const cp = (await pool.query(`select marca_dagua from ops.sync_checkpoints where entity = 'deals'`)).rows[0]?.marca_dagua as Date | undefined;
  const marca = cp ? cp.getTime() : 0;

  // ---- 1) contagem por pipeline e status ----
  const pdCount = new Map<string, number>();
  for (const d of pdNormal) pdCount.set(`${d.pipeline_id}|${d.status}`, (pdCount.get(`${d.pipeline_id}|${d.status}`) ?? 0) + 1);
  const dbCount = new Map<string, number>();
  for (const r of dbRows) dbCount.set(`${r.pipeline_id}|${r.status}`, (dbCount.get(`${r.pipeline_id}|${r.status}`) ?? 0) + 1);
  console.log('pipeline (ID e nome)                           status   Pipedrive   Banco   diferença');
  for (const k of [...new Set([...pdCount.keys(), ...dbCount.keys()])].sort()) {
    const [pid, st] = k.split('|');
    const a = pdCount.get(k) ?? 0;
    const b = dbCount.get(k) ?? 0;
    console.log(`${`#${pid} ${names.get(pid!) ?? '?'}`.padEnd(44)} ${String(st).padEnd(7)} ${String(a).padStart(9)} ${String(b).padStart(7)}   ${a === b ? 'ok' : String(b - a)}`);
  }
  const line = (label: string, a: number, b: number) => console.log(`${label.padEnd(52)} ${String(a).padStart(9)} ${String(b).padStart(7)}   ${a === b ? 'ok' : String(b - a)}`);
  line('arquivados', pdArq.length, arq);
  line('excluídos (últimos 30 dias no Pipedrive; o banco guarda todos)', pdDel.length, del);

  // ---- 2) negócio a negócio ----
  const changedAfter = (iso: string | null | undefined) => !!iso && Date.parse(iso) > marca;
  const db = new Map(dbRows.map((r) => [Number(r.pipedrive_id), r]));
  const pd = new Map(pdNormal.map((d) => [d.id, d]));
  let explained = 0;
  const unexplained: string[] = [];
  const note = (ok: boolean, msg: string) => (ok ? explained++ : unexplained.push(msg));

  for (const d of pdNormal) {
    const r = db.get(d.id);
    if (!r) note(changedAfter(d.update_time), `#${d.id} está no Pipedrive mas não no banco (alterado em ${d.update_time})`);
    else if (String(r.pipeline_id) !== String(d.pipeline_id) || r.status !== d.status) note(changedAfter(d.update_time), `#${d.id} difere (Pipedrive: pipeline ${d.pipeline_id}/${d.status}; banco: ${r.pipeline_id}/${r.status})`);
  }
  const extras = dbRows.filter((r) => !pd.has(Number(r.pipedrive_id)));
  for (const r of extras.slice(0, 200)) {
    const now = (await client.getDeal(Number(r.pipedrive_id))) as { update_time?: string; status?: string; is_deleted?: boolean; is_archived?: boolean } | null;
    note(changedAfter(now?.update_time), `#${r.pipedrive_id} está no banco como normal mas saiu da lista do Pipedrive (agora: ${now ? `${now.status}${now.is_archived ? ', arquivado' : ''}${now.is_deleted ? ', excluído' : ''}, alterado em ${now.update_time}` : 'não existe mais (mesclado?)'})`);
  }
  if (extras.length > 200) unexplained.push(`${extras.length - 200} negócios a mais no banco não foram examinados (limite de 200)`);

  console.log(`\nÚltima sincronização completa de negócios: ${cp ? cp.toISOString() : 'nunca'}.`);
  console.log(`Diferenças explicadas (o negócio mudou depois da última sincronização): ${explained}.`);
  console.log(`Diferenças SEM EXPLICAÇÃO: ${unexplained.length}.`);
  for (const m of unexplained.slice(0, 30)) console.log(`  - ${m}`);
  console.log(`\n${unexplained.length === 0 ? 'CONFERIDO: o banco bate com o Pipedrive.' : 'ATENÇÃO: há diferenças sem explicação.'} Unidades da cota gastas: ${client.usage.tokens}.`);
  process.exitCode = unexplained.length === 0 ? 0 : 2;
} finally {
  await pool.end();
}
