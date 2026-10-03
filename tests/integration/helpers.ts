import pg from 'pg';
import { assertSafeDbTarget } from '../../src/db/guard';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* sem .env.local: os testes de integração serão pulados */
}

export const TABLES = [
  'core.leads',
  'orq.sources',
  'orq.touchpoints',
  'orq.events',
  'orq.rules',
  'orq.decisions',
  'crm.deals',
  'crm.stage_history',
] as const;

export const hasDbConfig = Boolean(process.env.SUPABASE_DB_URL && process.env.SUPABASE_PROJECT_REF);

/** Conecta com a trava de alvo. Quem chama é responsável por BEGIN e ROLLBACK. */
export async function connect(): Promise<pg.Client> {
  assertSafeDbTarget({ target: process.env.SUPABASE_DB_URL ?? '', expectedRef: process.env.SUPABASE_PROJECT_REF ?? '' });
  const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

/** Contagem de linhas de todas as tabelas do orquestrador e de tabelas no public. */
export async function snapshot(client: pg.Client): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = Number((await client.query(`select count(*)::int as n from ${t}`)).rows[0].n);
  out['public.(tabelas)'] = Number(
    (await client.query(`select count(*)::int as n from pg_tables where schemaname = 'public'`)).rows[0].n,
  );
  return out;
}

export async function schemaReady(client: pg.Client): Promise<boolean> {
  const r = await client.query(`select to_regclass('orq.events') is not null as ok`);
  return r.rows[0].ok === true;
}
