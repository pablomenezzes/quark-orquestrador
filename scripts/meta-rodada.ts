/**
 * Rodada da Meta por trimestre (protocolo do Pablo). SOMENTE LEITURA na Meta; so grava no nosso banco, e so com autorizacao.
 *
 *   npx tsx scripts/meta-rodada.ts --trimestre 2026-T3 [--contas rh,clinic]
 *       SIMULACAO (padrao): le a Meta, compara com o banco, reconcilia e imprime o CARTAO DA RODADA. Registra a simulacao em mkt.meta_rodadas.
 *   npx tsx scripts/meta-rodada.ts --trimestre 2026-T3 --contas rh --gravar --autorizacao "pode seguir (texto e data do Pablo)"
 *       GRAVACAO de UMA conta e UM trimestre: recusa sem a autorizacao e sem a simulacao previa da mesma conta e do mesmo intervalo.
 *   --diferenca-explicada "motivo"   grava mesmo com diferenca na reconciliacao (o motivo fica no cartao)
 *   --reabrir "motivo"                regrava um trimestre FECHADO (exige motivo)
 * Nunca encadeia rodadas: cada execucao e uma rodada (uma conta por gravacao). Variaveis (.env.local): META_*, SYNC_DB_URL.
 */
import pg from 'pg';
import { assertRoleUser, assertSafeDbTarget } from '../src/db/guard.js';
import { MetaClient, metaCredenciaisFromEnv } from '../src/datahub/meta/meta.js';
import { CARTAO_TEXTO, gravarRodada, RodadaRecusada, RodadaStore, simularRodada } from '../src/datahub/meta/meta-rodadas.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* segue com o ambiente atual */
}
const argv = process.argv.slice(2);
const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const trimestre = opt('--trimestre');
if (!trimestre || !/^20\d{2}-T[1-4]$/.test(trimestre)) {
  console.error('Use --trimestre AAAA-T1 a AAAA-T4 (ex.: 2026-T3).');
  process.exit(1);
}
const gravar = argv.includes('--gravar');
const url = process.env.SYNC_DB_URL;
if (!url) {
  console.error('Falta SYNC_DB_URL no .env.local.');
  process.exit(1);
}
assertSafeDbTarget({ target: url, expectedRef: process.env.SUPABASE_PROJECT_REF ?? '' });
assertRoleUser(url, 'orq_sync');
const cred = metaCredenciaisFromEnv(process.env);
const escolhidas = opt('--contas') ? (opt('--contas') ?? '').split(',').filter(Boolean) : cred.contas.map((c) => c.produto);
const contas = cred.contas.filter((c) => escolhidas.includes(c.produto));
if (!contas.length) {
  console.error('Nenhuma conta escolhida. Use --contas rh,clinic.');
  process.exit(1);
}
if (gravar && contas.length !== 1) {
  console.error('Gravacao e de UMA conta por rodada: use --contas rh ou --contas clinic.');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
const store = new RodadaStore(pool);
const hoje = new Date().toISOString().slice(0, 10);
let codigo = 0;
for (const conta of contas) {
  const client = new MetaClient(cred.token);
  try {
    if (gravar) {
      const r = await gravarRodada(client, store, conta, trimestre, hoje, { autorizacao: opt('--autorizacao') ?? '', diferencaExplicada: opt('--diferenca-explicada'), reabrir: opt('--reabrir') });
      console.log(`GRAVADA a rodada ${r.rodada_id}.\n${CARTAO_TEXTO(r.cartao)}`);
    } else {
      const r = await simularRodada(client, store, conta, trimestre, hoje);
      console.log(`SIMULACAO ${r.rodada_id} (nada de dados da Meta foi gravado).\n${CARTAO_TEXTO(r.cartao)}\n`);
    }
  } catch (e) {
    codigo = 1;
    console.error(e instanceof RodadaRecusada ? e.message : `ERRO (${conta.produto}): ${e instanceof Error ? e.message : String(e)}`);
  }
}
await pool.end();
process.exit(codigo);
