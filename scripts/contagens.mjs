// Conta as linhas das tabelas principais de um banco e imprime em JSON (uma chave por tabela). Usado para comparar a nuvem com o espelho local.
//   node scripts/contagens.mjs --nuvem      -> o Supabase (SUPABASE_DB_URL do .env.local)
//   node scripts/contagens.mjs --espelho    -> o banco espelho local (127.0.0.1:54329)
// So leitura. Nada secreto e impresso.
import pg from 'pg';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* segue com o ambiente */
}

export const TABELAS = [
  'core.leads', 'orq.sources', 'orq.touchpoints', 'orq.events', 'orq.decisions',
  'crm.deals', 'crm.stage_history', 'crm.pipelines', 'crm.stages', 'crm.users', 'crm.field_definitions', 'crm.persons', 'crm.organizations', 'crm.deal_lead_links',
  'raw.pd_deals', 'raw.pd_deal_flow', 'raw.pd_field_defs',
  'ops.sync_jobs', 'ops.sync_checkpoints', 'ops.cfg_pipeline_produto', 'ops.cfg_stage_marco', 'ops.cfg_motivo_perda', 'ops.cfg_status_contagem',
];

const argv = process.argv.slice(2);
const espelho = argv.includes('--espelho');
const url = espelho ? 'postgresql://postgres@127.0.0.1:54329/quark_espelho' : (process.env.SUPABASE_DB_URL ?? '');
if (!url) {
  console.error('Falta SUPABASE_DB_URL no .env.local.');
  process.exit(1);
}
if (!espelho) {
  const ref = process.env.SUPABASE_PROJECT_REF ?? '';
  if (!ref || !url.includes(ref)) {
    console.error('SUPABASE_DB_URL nao contem SUPABASE_PROJECT_REF: recusando.');
    process.exit(1);
  }
}
const c = new pg.Client({ connectionString: url, ssl: espelho ? false : { rejectUnauthorized: false } });
await c.connect();
const out = {};
try {
  for (const t of TABELAS) {
    const existe = (await c.query('select to_regclass($1) is not null as e', [t])).rows[0].e;
    out[t] = existe ? Number((await c.query(`select count(*)::bigint as n from ${t}`)).rows[0].n) : null;
  }
  const m = await c.query(`select to_regclass('supabase_migrations.schema_migrations') is not null as e`);
  out['_migracoes'] = m.rows[0].e ? Number((await c.query('select count(*)::int as n from supabase_migrations.schema_migrations')).rows[0].n) : null;
} finally {
  await c.end();
}
console.log(JSON.stringify(out));
