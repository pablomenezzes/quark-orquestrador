/**
 * Atualizacao INCREMENTAL do desempenho da Meta (somente leitura na Meta; grava so linhas novas ou alteradas).
 *   npx tsx scripts/meta-incremental.ts                 -> simulacao: le a Meta e mostra o que gravaria
 *   npx tsx scripts/meta-incremental.ts --apply         -> grava (papel orq_sync)
 *   --dias auto|N      auto (padrao): 48h (2 dias) as 06 UTC, so hoje (1 dia) nas outras horas; N de 1 a 2
 *   --contas rh,clinic
 * Roda de hora em hora no GitHub Actions (.github/workflows/meta-incremental.yml). Nunca relê o historico todo: so os ultimos dias.
 */
import pg from 'pg';
import { assertRoleUser, assertSafeDbTarget } from '../src/db/guard.js';
import { MetaClient, metaCredenciaisFromEnv } from '../src/datahub/meta/meta.js';
import { atualizarIncremental, DIAS_DIARIA, diasDaExecucao, type IncStore } from '../src/datahub/meta/meta-incremental.js';
import { esfriar, RodadaStore } from '../src/datahub/meta/meta-rodadas.js';
import { completarEstrutura, MetaStore } from '../src/datahub/meta/meta-sync.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* segue com o ambiente atual */
}
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const diasOpt = opt('--dias') ?? 'auto';
const dias = diasOpt === 'auto' ? diasDaExecucao(new Date()) : Number(diasOpt);
if (!Number.isInteger(dias) || dias < 1 || dias > DIAS_DIARIA) {
  console.error(`--dias precisa ser "auto" ou um numero de 1 a ${DIAS_DIARIA} (nunca carga toda).`);
  process.exit(1);
}
const url = process.env.SYNC_DB_URL;
if (!url) {
  console.error('Falta SYNC_DB_URL.');
  process.exit(1);
}
assertSafeDbTarget({ target: url, expectedRef: process.env.SUPABASE_PROJECT_REF ?? '' });
assertRoleUser(url, 'orq_sync');
const cred = metaCredenciaisFromEnv(process.env);
const escolhidas = opt('--contas') ? (opt('--contas') ?? '').split(',').filter(Boolean) : cred.contas.map((c) => c.produto);
const contas = cred.contas.filter((c) => escolhidas.includes(c.produto));
const pool = new pg.Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
const rodadaStore = new RodadaStore(pool);
const metaStore = new MetaStore(pool);
// "hoje" no fuso das contas (America/Sao_Paulo): a Meta fecha o dia nesse fuso
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const store: IncStore = {
  existentes: (c, de, ate) => rodadaStore.existentes(c, de, ate),
  gravarLinhas: (rows, id, h) => (apply ? rodadaStore.gravarLinhas(rows, id, h) : Promise.resolve()),
  trimestreFechado: (t, c) => rodadaStore.trimestreFechado(t, c),
};
console.log(`${apply ? 'GRAVAR' : 'SIMULACAO'}: ultimos ${dias} dias ate ${hoje} (incremental).`);
let falhou = false;
let mudou = 0;
for (const conta of contas) {
  const client = new MetaClient(cred.token);
  const entidade = `meta_incremental_${conta.produto}`;
  const jobId = apply ? await metaStore.iniciarJob(entidade, 'incremental', 'agendada') : '';
  try {
    const r = await atualizarIncremental(client, store, conta, hoje, dias, { esfriar: () => esfriar(client, conta), log: (s) => console.log('  ' + s) });
    if (apply && r.inseridas + r.atualizadas > 0) await completarEstrutura(client, metaStore, conta, (s) => console.log('  ' + s));
    mudou += r.inseridas + r.atualizadas;
    console.log(`${entidade}: ${r.de} a ${r.ate}: ${r.linhas_lidas} lidas, ${r.inseridas} novas, ${r.atualizadas} alteradas, ${r.mantidas} iguais; ${r.chamadas} chamadas, cota ${r.uso_cota_pct}%${r.parou ? ` PAROU: ${r.parou}` : ''}${r.ignorados_fechados ? `; ${r.ignorados_fechados} blocos em trimestre fechado ignorados` : ''}`);
    for (const d of r.diferencas) console.log(`  diferenca com o total da conta (esperada nos dias recentes): ${d}`);
    if (apply) {
      await metaStore.terminarJob(jobId, r.parou ? 'parcial' : 'ok', r.linhas_lidas, r.inseridas + r.atualizadas, r.parou);
      // a tela "Saúde da sincronização" do Painel mede o frescor pelo checkpoint: so uma rodada completa (sem parar por cota) conta como "ultima vez com sucesso"
      if (!r.parou) await metaStore.salvarMarcaDagua(entidade, hoje, jobId, true);
    }
  } catch (e) {
    falhou = true;
    const erro = e instanceof Error ? e.message : String(e);
    console.error(`${entidade}: ERRO ${erro}`);
    if (apply) await metaStore.terminarJob(jobId, 'erro', 0, 0, erro);
  }
}
if (apply && mudou > 0) {
  const n = await metaStore.recalcularLigacao();
  console.log(`meta_ligacao: ${n} negocios ligados`);
}
await pool.end();
process.exit(falhou ? 1 : 0);
