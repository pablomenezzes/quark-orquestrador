/**
 * Arquivo COMPRIMIDO do historico do GA4 (migration 0022): cada (tabela, mes) fechado e guardado UMA vez, em gzip de NDJSON. So insere; nunca regrava.
 * Restaurar = reinserir as linhas na tabela de trabalho (`on conflict do nothing`), sem tocar no que ja existe.
 */
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type pg from 'pg';

type Q = Pick<pg.Pool, 'query'>;
export const TABELAS_GA4 = ['ga4_sessoes_dia', 'ga4_eventos_dia', 'ga4_paginas_dia', 'ga4_dia', 'ga4_ads_dia'] as const;
export type TabelaGa4 = (typeof TABELAS_GA4)[number];
/** Um mes so e arquivado quando passaram 35 dias do seu fim: o GA4 ja nao ajusta mais os numeros dele. */
export const MARGEM_DIAS = 35;

export interface Pacote { linhas: number; bytes_originais: number; sha256: string; dados: Buffer }

/** Linhas -> NDJSON -> gzip (nivel maximo). Ordem estavel (por texto da linha) para o mesmo conteudo dar o mesmo hash. */
export function empacotar(linhas: Array<Record<string, unknown>>): Pacote {
  const texto = linhas.map((l) => JSON.stringify(l)).sort().join('\n');
  return { linhas: linhas.length, bytes_originais: Buffer.byteLength(texto), sha256: createHash('sha256').update(texto).digest('hex'), dados: gzipSync(Buffer.from(texto), { level: 9 }) };
}
/** Desempacota e CONFERE (hash e numero de linhas); lança erro se o pacote nao bate. */
export function desempacotar(p: { linhas: number; sha256: string; dados: Buffer }): Array<Record<string, unknown>> {
  const texto = gunzipSync(p.dados).toString('utf8');
  if (createHash('sha256').update(texto).digest('hex') !== p.sha256) throw new Error('arquivo do GA4 corrompido: o hash nao bate');
  const linhas = texto === '' ? [] : texto.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  if (linhas.length !== p.linhas) throw new Error(`arquivo do GA4 com ${linhas.length} linhas, esperava ${p.linhas}`);
  return linhas;
}

/** Meses FECHADOS de uma tabela que ainda nao foram arquivados. */
export async function mesesParaArquivar(q: Q, tabela: TabelaGa4, margem = MARGEM_DIAS): Promise<string[]> {
  const r = await q.query(
    `select m.mes from (select distinct to_char(dia, 'YYYY-MM') as mes, (date_trunc('month', dia) + interval '1 month')::date as prox from mkt.${tabela}) m
      where m.prox + $1::int <= current_date and not exists (select 1 from mkt.ga4_arquivo a where a.tabela = $2 and a.mes = m.mes) order by 1`,
    [margem - 1, tabela],
  );
  return r.rows.map((x: { mes: string }) => x.mes);
}

export async function arquivarMes(q: Q, tabela: TabelaGa4, mes: string): Promise<Pacote> {
  const r = await q.query(`select to_jsonb(t) as j from mkt.${tabela} t where dia >= ($1 || '-01')::date and dia < (($1 || '-01')::date + interval '1 month')`, [mes]);
  const p = empacotar(r.rows.map((x: { j: Record<string, unknown> }) => x.j));
  await q.query(`insert into mkt.ga4_arquivo (tabela, mes, linhas, bytes_originais, sha256, dados) values ($1, $2, $3, $4, $5, $6) on conflict (tabela, mes) do nothing`, [tabela, mes, p.linhas, p.bytes_originais, p.sha256, p.dados]);
  return p;
}

/** Reinsere o mes arquivado na tabela de trabalho, sem sobrescrever o que ja existe. Devolve quantas linhas voltaram. */
export async function restaurarMes(q: Q, tabela: TabelaGa4, mes: string): Promise<{ arquivadas: number; reinseridas: number }> {
  const a = await q.query(`select linhas, sha256, dados from mkt.ga4_arquivo where tabela = $1 and mes = $2`, [tabela, mes]);
  if (!a.rows[0]) throw new Error(`nao ha arquivo de ${tabela} em ${mes}`);
  const linhas = desempacotar({ linhas: Number(a.rows[0].linhas), sha256: a.rows[0].sha256, dados: a.rows[0].dados });
  let reinseridas = 0;
  for (let i = 0; i < linhas.length; i += 2000) {
    const r = await q.query(`insert into mkt.${tabela} select * from jsonb_populate_recordset(null::mkt.${tabela}, $1::jsonb) on conflict do nothing`, [JSON.stringify(linhas.slice(i, i + 2000))]);
    reinseridas += r.rowCount ?? 0;
  }
  return { arquivadas: linhas.length, reinseridas };
}

/** Confere os arquivos ja guardados (hash e linhas) e compara com a tabela de trabalho. */
export async function verificar(q: Q): Promise<Array<{ tabela: string; mes: string; linhas: number; ao_vivo: number; ok: boolean }>> {
  const arq = await q.query(`select tabela, mes, linhas, sha256, dados from mkt.ga4_arquivo order by tabela, mes`);
  const out: Array<{ tabela: string; mes: string; linhas: number; ao_vivo: number; ok: boolean }> = [];
  for (const x of arq.rows) {
    let ok = true;
    try { desempacotar({ linhas: Number(x.linhas), sha256: x.sha256, dados: x.dados }); } catch { ok = false; }
    const v = await q.query(`select count(*)::int as n from mkt.${x.tabela as TabelaGa4} where dia >= ($1 || '-01')::date and dia < (($1 || '-01')::date + interval '1 month')`, [x.mes]);
    out.push({ tabela: x.tabela, mes: x.mes, linhas: Number(x.linhas), ao_vivo: v.rows[0].n, ok });
  }
  return out;
}
