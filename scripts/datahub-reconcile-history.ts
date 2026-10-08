/**
 * Conferência do histórico de etapas (somente leitura nos dois lados).
 *
 *   npx tsx scripts/datahub-reconcile-history.ts --created-year 2026 [--sample 25]
 *
 * 1) COBERTURA: todo negócio do ano tem linha do tempo? (sem mudança: 1 linha; com mudança: lido)
 * 2) CONSISTÊNCIA: a última etapa da linha do tempo é a etapa atual do negócio? As exceções são EXPLICADAS quando o negócio
 *    mudou de etapa depois da leitura do histórico (a próxima rodada corrige) e SEM EXPLICAÇÃO nos outros casos.
 * 3) AMOSTRA CONTRA O PIPEDRIVE: sorteia negócios, relê o histórico no Pipedrive e compara etapa, entrada e saída linha a linha.
 * Custa 40 unidades da cota por negócio da amostra. Só o item 3 chama o Pipedrive. Variáveis: PIPEDRIVE_*, SYNC_DB_URL.
 */
import pg from 'pg';
import { assertRoleUser, assertSafeDbTarget } from '../src/db/guard.js';
import { PipedriveReadClient } from '../src/datahub/pipedrive/client.js';
import { buildStageHistory, trimFlowItems } from '../src/datahub/history.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* segue com o ambiente atual */
}
const argv = process.argv.slice(2);
const opt = (n: string) => argv[argv.indexOf(n) + 1];
const year = Number(opt('--created-year'));
const sample = argv.includes('--sample') ? Number(opt('--sample')) : 25;
if (!(year >= 2000 && year <= 2100)) {
  console.error('Informe o ano de criação: --created-year 2026');
  process.exit(1);
}
const url = process.env.SYNC_DB_URL ?? '';
assertSafeDbTarget({ target: url, expectedRef: process.env.SUPABASE_PROJECT_REF ?? '' });
assertRoleUser(url, 'orq_sync');
const pool = new pg.Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
const from = `${year}-01-01T00:00:00Z`;
const to = `${year + 1}-01-01T00:00:00Z`;
let problemas = 0;

try {
  // ---- 1) cobertura ----
  const cov = (
    await pool.query(
      `select count(*)::int total,
              count(*) filter (where d.stage_change_time is null)::int sem_mudanca,
              count(*) filter (where d.stage_change_time is not null)::int com_mudanca,
              count(*) filter (where d.stage_change_time is not null and f.deal_id is not null and f.stage_change_time_vista is not distinct from d.stage_change_time)::int lidos,
              count(*) filter (where d.stage_change_time is not null and (f.deal_id is null or f.stage_change_time_vista is distinct from d.stage_change_time))::int pendentes,
              count(*) filter (where not exists (select 1 from crm.stage_history h where h.deal_id = d.pipedrive_id))::int sem_linha_do_tempo
         from crm.deals d left join raw.pd_deal_flow f on f.deal_id = d.pipedrive_id
        where d.created_at >= $1 and d.created_at < $2 and not d.is_deleted`,
      [from, to],
    )
  ).rows[0];
  console.log(`\n1) COBERTURA (negócios criados em ${year}, sem os excluídos)`);
  console.log(`   total ${cov.total} | sem mudança de etapa ${cov.sem_mudanca} | com mudança ${cov.com_mudanca} (lidos ${cov.lidos}, pendentes ${cov.pendentes})`);
  console.log(`   sem nenhuma linha do tempo: ${cov.sem_linha_do_tempo}  ${cov.sem_linha_do_tempo === 0 ? 'ok' : cov.pendentes >= cov.sem_linha_do_tempo ? '(explicado: ainda pendentes)' : 'SEM EXPLICAÇÃO'}`);
  if (cov.sem_linha_do_tempo > cov.pendentes) problemas++;

  // ---- 2) consistência com a etapa atual ----
  const inc = (
    await pool.query(
      `select d.pipedrive_id, d.stage_id as etapa_atual, h.stage_id as ultima_do_historico, d.stage_change_time, f.stage_change_time_vista
         from crm.deals d
         join lateral (select stage_id from crm.stage_history x where x.deal_id = d.pipedrive_id order by x.entrou_em desc, x.saiu_em desc nulls first limit 1) h on true
         left join raw.pd_deal_flow f on f.deal_id = d.pipedrive_id
        where d.created_at >= $1 and d.created_at < $2 and not d.is_deleted and d.stage_id is distinct from h.stage_id`,
      [from, to],
    )
  ).rows;
  const explicadas = inc.filter((r: any) => r.stage_change_time_vista == null || new Date(r.stage_change_time) > new Date(r.stage_change_time_vista) || r.stage_change_time_vista !== r.stage_change_time).length;
  const sem = inc.length - explicadas;
  console.log(`\n2) CONSISTÊNCIA: a última etapa da linha do tempo difere da etapa atual em ${inc.length} negócio(s); explicadas ${explicadas}; SEM EXPLICAÇÃO ${sem}`);
  for (const r of inc.slice(0, 5)) console.log(`   - #${r.pipedrive_id}: atual ${r.etapa_atual}, última do histórico ${r.ultima_do_historico}`);
  if (sem > 0) problemas++;

  // ---- 3) amostra contra o Pipedrive ----
  if (sample > 0) {
    const client = new PipedriveReadClient({ domain: process.env.PIPEDRIVE_DOMAIN ?? '', apiToken: process.env.PIPEDRIVE_API_TOKEN ?? '', keepFreeShare: 0.5 });
    const ids = (
      await pool.query(
        `select d.pipedrive_id, d.created_at, d.stage_id from crm.deals d join raw.pd_deal_flow f on f.deal_id = d.pipedrive_id and f.stage_change_time_vista is not distinct from d.stage_change_time
          where d.created_at >= $1 and d.created_at < $2 and not d.is_deleted order by random() limit $3`,
        [from, to, sample],
      )
    ).rows as Array<{ pipedrive_id: string; created_at: Date; stage_id: string }>;
    let iguais = 0;
    const diffs: string[] = [];
    for (const d of ids) {
      const now = trimFlowItems(await client.getDealFlow(Number(d.pipedrive_id)));
      const built = buildStageHistory(d.created_at.toISOString(), Number(d.stage_id), now);
      const dbRows = (
        await pool.query(`select stage_id, entrou_em, saiu_em from crm.stage_history where deal_id = $1 order by entrou_em, stage_id`, [d.pipedrive_id])
      ).rows.map((r: any) => `${r.stage_id}|${r.entrou_em.toISOString()}|${r.saiu_em ? r.saiu_em.toISOString() : ''}`);
      const pd = built.rows.map((r) => `${r.stage_id}|${r.entrou_em}|${r.saiu_em ?? ''}`);
      if (JSON.stringify(dbRows) === JSON.stringify(pd)) iguais++;
      else diffs.push(`#${d.pipedrive_id}: banco ${dbRows.length} linha(s), Pipedrive agora ${pd.length}`);
    }
    console.log(`\n3) AMOSTRA CONTRA O PIPEDRIVE: ${ids.length} negócios sorteados; linha do tempo IGUAL em ${iguais}; diferente em ${diffs.length}  (${client.usage.tokens} unidades)`);
    for (const m of diffs.slice(0, 5)) console.log(`   - ${m}`);
    if (diffs.length) console.log('   (diferenças podem ser negócios que mudaram de etapa depois da leitura; a próxima rodada corrige)');
  }
  console.log(`\n${problemas === 0 ? 'CONFERIDO: o histórico bate com o Pipedrive.' : 'ATENÇÃO: há pontos sem explicação acima.'}`);
  process.exitCode = problemas === 0 ? 0 : 2;
} finally {
  await pool.end();
}
