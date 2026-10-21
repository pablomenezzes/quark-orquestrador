/**
 * Arquivo comprimido do historico do GA4 (migration 0022): guarda UMA vez cada mes fechado de cada tabela do GA4, em gzip.
 *   npx tsx scripts/ga4-arquivar.ts                       -> simulacao: mostra o que seria arquivado e o tamanho comprimido
 *   npx tsx scripts/ga4-arquivar.ts --apply               -> arquiva os meses fechados que ainda nao estao arquivados (so insere)
 *   npx tsx scripts/ga4-arquivar.ts --verificar           -> confere hash e linhas de tudo o que ja foi arquivado
 *   npx tsx scripts/ga4-arquivar.ts --restaurar ga4_sessoes_dia 2025-03 --apply   -> reinsere o mes na tabela de trabalho (sem sobrescrever)
 * Variavel (.env.local): SYNC_DB_URL (papel orq_sync).
 */
import pg from 'pg';
import { assertRoleUser, assertSafeDbTarget } from '../src/db/guard.js';
import { arquivarMes, empacotar, MARGEM_DIAS, mesesParaArquivar, restaurarMes, TABELAS_GA4, verificar, type TabelaGa4 } from '../src/datahub/google/ga4-arquivo.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* segue com o ambiente atual */
}
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const url = process.env.SYNC_DB_URL;
if (!url) {
  console.error('Falta SYNC_DB_URL.');
  process.exit(1);
}
assertSafeDbTarget({ target: url, expectedRef: process.env.SUPABASE_PROJECT_REF ?? '' });
assertRoleUser(url, 'orq_sync');
const pool = new pg.Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
let codigo = 0;
try {
  if (argv.includes('--verificar')) {
    const v = await verificar(pool);
    for (const x of v) console.log(`${x.ok ? 'ok     ' : 'FALHOU '} ${x.tabela} ${x.mes}: ${x.linhas} arquivadas, ${x.ao_vivo} na tabela de trabalho${x.linhas !== x.ao_vivo ? ' (diferente)' : ''}`);
    console.log(`${v.length} arquivo(s) conferido(s), ${v.filter((x) => !x.ok).length} com problema.`);
    codigo = v.some((x) => !x.ok) ? 1 : 0;
  } else if (argv.includes('--restaurar')) {
    const i = argv.indexOf('--restaurar');
    const tabela = argv[i + 1] as TabelaGa4;
    const mes = argv[i + 2] ?? '';
    if (!TABELAS_GA4.includes(tabela) || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(mes)) {
      console.error(`Use: --restaurar <${TABELAS_GA4.join('|')}> AAAA-MM`);
      process.exit(1);
    }
    if (!apply) console.log('Simulacao: confere o arquivo sem regravar (use --apply para restaurar).');
    const r = apply ? await restaurarMes(pool, tabela, mes) : { arquivadas: (await pool.query('select linhas from mkt.ga4_arquivo where tabela = $1 and mes = $2', [tabela, mes])).rows[0]?.linhas ?? 0, reinseridas: 0 };
    console.log(`${tabela} ${mes}: ${r.arquivadas} linhas no arquivo, ${r.reinseridas} reinseridas${apply ? '' : ' (simulacao)'}.`);
  } else {
    let total = { meses: 0, linhas: 0, original: 0, comprimido: 0 };
    for (const tabela of TABELAS_GA4) {
      for (const mes of await mesesParaArquivar(pool, tabela)) {
        let p;
        if (apply) p = await arquivarMes(pool, tabela, mes);
        else {
          const r = await pool.query(`select to_jsonb(t) as j from mkt.${tabela} t where dia >= ($1 || '-01')::date and dia < (($1 || '-01')::date + interval '1 month')`, [mes]);
          p = empacotar(r.rows.map((x: { j: Record<string, unknown> }) => x.j));
        }
        total = { meses: total.meses + 1, linhas: total.linhas + p.linhas, original: total.original + p.bytes_originais, comprimido: total.comprimido + p.dados.length };
        console.log(`${apply ? 'arquivado' : 'seria arquivado'}: ${tabela} ${mes}: ${p.linhas} linhas, ${kb(p.bytes_originais)} -> ${kb(p.dados.length)}`);
      }
    }
    console.log(`${total.meses} mes(es) de tabela, ${total.linhas} linhas, ${kb(total.original)} -> ${kb(total.comprimido)} comprimidos (meses fechados = ${MARGEM_DIAS} dias depois do fim do mes).${apply ? '' : ' Simulacao: use --apply para gravar.'}`);
  }
} finally {
  await pool.end();
}
process.exit(codigo);
