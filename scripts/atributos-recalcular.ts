/**
 * Atualiza crm.deal_atributos (campos dos negocios que o BI e o Painel usam: UTMs, Meta, identificador de conversao RD...) so para os negocios
 * que mudaram desde a ultima vez. Roda logo depois da sincronizacao de negocios.
 *   npx tsx scripts/atributos-recalcular.ts --apply
 */
import pg from 'pg';
import { assertRoleUser, assertSafeDbTarget } from '../src/db/guard.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* segue com o ambiente atual */
}
if (!process.argv.includes('--apply')) {
  console.log('Simulacao: nada a fazer sem --apply (a funcao so grava em crm.deal_atributos).');
  process.exit(0);
}
const url = process.env.SYNC_DB_URL;
if (!url) {
  console.error('Falta SYNC_DB_URL.');
  process.exit(1);
}
assertSafeDbTarget({ target: url, expectedRef: process.env.SUPABASE_PROJECT_REF ?? '' });
assertRoleUser(url, 'orq_sync');
const pool = new pg.Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
const r = await pool.query('select crm.recalcular_deal_atributos(true) as n');
console.log(`deal_atributos: ${r.rows[0].n} negocios novos ou alterados.`);
await pool.end();
