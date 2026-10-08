// Conta as linhas das tabelas principais de um banco e imprime em JSON (uma chave por tabela). So leitura. Nada secreto e impresso.
//   node scripts/contagens.mjs --nuvem          -> o Supabase de producao (SUPABASE_DB_URL do .env.local)
//   CONTAGENS_URL=<url> node scripts/contagens.mjs   -> outro banco (usado por restaurar-backup.ps1 para conferir o destino de uma restauracao)
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

const outro = process.env.CONTAGENS_URL ?? '';
const url = outro || (process.env.SUPABASE_DB_URL ?? '');
if (!url) {
  console.error('Falta SUPABASE_DB_URL no .env.local (ou CONTAGENS_URL).');
  process.exit(1);
}
if (!outro) {
  const ref = process.env.SUPABASE_PROJECT_REF ?? '';
  if (!ref || !url.includes(ref)) {
    console.error('SUPABASE_DB_URL nao contem SUPABASE_PROJECT_REF: recusando.');
    process.exit(1);
  }
}
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const out = {};
try {
  for (const t of TABELAS) {
    const existe = (await c.query('select to_regclass($1) is not null as e', [t])).rows[0].e;
    out[t] = existe ? Number((await c.query(`select count(*)::bigint as n from ${t}`)).rows[0].n) : null;
  }
} finally {
  await c.end();
}
console.log(JSON.stringify(out));
