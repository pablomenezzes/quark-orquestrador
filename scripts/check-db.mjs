// Checagem SOMENTE LEITURA da conexão com o banco. Não imprime URL nem senha.
//   node scripts/check-db.mjs
import pg from 'pg';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* sem .env.local */
}

const url = process.env.SUPABASE_DB_URL ?? '';
const ref = process.env.SUPABASE_PROJECT_REF ?? '';
console.log('URL preenchida:', url.length > 0);
console.log('Contém o ref do projeto:', ref !== '' && url.includes(ref));
console.log('Porta:', (url.match(/:(\d{4})\//) ?? [])[1] ?? '?');
console.log('Placeholder [YOUR-PASSWORD] esquecido:', url.includes('[YOUR-PASSWORD]'));
if (!url || url.includes('[YOUR-PASSWORD]')) process.exit(1);

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
try {
  await c.connect();
  const v = await c.query(
    `select current_user as usr, current_database() as db, (select setting from pg_settings where name = 'server_version') as sv`,
  );
  console.log(`Conectou como ${v.rows[0].usr} no banco ${v.rows[0].db} (PostgreSQL ${v.rows[0].sv})`);
  const s = await c.query(
    `select schema_name from information_schema.schemata where schema_name in ('core','orq','crm','mkt','analytics') order by 1`,
  );
  console.log('Schemas do orquestrador já existentes:', s.rows.map((r) => r.schema_name).join(', ') || '(nenhum)');
  const t = await c.query(`select count(*)::int as n from pg_tables where schemaname = 'public'`);
  console.log('Tabelas no schema public:', t.rows[0].n);
  const m = await c.query(`select to_regclass('supabase_migrations.schema_migrations') is not null as ok`);
  if (m.rows[0].ok) {
    const r = await c.query('select version from supabase_migrations.schema_migrations order by 1');
    console.log('Migrations já aplicadas:', r.rows.map((x) => x.version).join(', ') || '(nenhuma)');
  } else {
    console.log('Migrations já aplicadas: (tabela de controle ainda não existe)');
  }
} catch (e) {
  console.log('FALHOU:', e.code ?? '', String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '<url>'));
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
}
