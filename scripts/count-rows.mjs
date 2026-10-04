// Contagem de linhas das tabelas do orquestrador (somente leitura). Útil para provar que nada foi gravado.
//   node scripts/count-rows.mjs
import pg from 'pg';

process.loadEnvFile('.env.local');
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  for (const t of ['core.leads', 'orq.sources', 'orq.touchpoints', 'orq.events', 'orq.rules', 'orq.decisions', 'crm.deals', 'crm.stage_history']) {
    console.log(t.padEnd(20), (await c.query(`select count(*)::int as n from ${t}`)).rows[0].n);
  }
  console.log('public (tabelas)'.padEnd(20), (await c.query(`select count(*)::int as n from pg_tables where schemaname = 'public'`)).rows[0].n);
} finally {
  await c.end();
}
