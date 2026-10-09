/**
 * Sincronizacao do GA4 -> mkt.ga4_* (papel orq_sync). Retomavel e sem repetir trabalho:
 *  - carga inicial por blocos de dias, do mais antigo ao mais novo; a marca d'agua (ops.sync_checkpoints.marca_dagua) so avanca
 *    depois que o bloco foi gravado, entao uma interrupcao retoma do bloco seguinte;
 *  - depois da carga, cada rodada revisa so os ultimos REVISAO_DIAS dias (o GA4 ajusta numeros por 2 a 3 dias);
 *  - gravacao por UPSERT (reler o mesmo dia nao duplica); nada e apagado.
 */
import type pg from 'pg';
import {
  blocosDeDatas, mapDia, mapEventos, mapPaginas, mapSessoes, relatorio,
  type EventoDia, type Ga4Client, type Ga4Entidade, type PaginaDia, type SessaoDia, type TotalDia,
} from './ga4.js';

export const REVISAO_DIAS = 7;
export const BLOCO_DIAS = 31;
const CHUNK = 2000;

export interface Ga4SyncResultado {
  entidade: Ga4Entidade;
  blocos: number;
  lidos: number;
  gravados: number;
  ate: string | null;
  erro?: string;
}

type Q = Pick<pg.Pool, 'query'>;

/** upsert em lote por unnest: uma consulta por bloco de linhas, tipos explicitos. */
async function upsert(q: Q, sql: string, colunas: unknown[][]): Promise<void> {
  await q.query(sql, colunas);
}

export class Ga4Store {
  constructor(private readonly q: Q, readonly propertyId: number) {}

  async sessoes(rows: SessaoDia[]): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const c = rows.slice(i, i + CHUNK);
      await upsert(
        this.q,
        `insert into mkt.ga4_sessoes_dia (property_id, dia, host, landing_page, fonte, midia, campanha, campanha_id, gads_campanha_id,
           sessoes, usuarios_novos, sessoes_engajadas, visualizacoes)
         select ${this.propertyId}, * from unnest($1::date[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
           $9::int[], $10::int[], $11::int[], $12::int[])
         on conflict (property_id, dia, host, landing_page, fonte, midia, campanha) do update set
           campanha_id = excluded.campanha_id, gads_campanha_id = excluded.gads_campanha_id, sessoes = excluded.sessoes,
           usuarios_novos = excluded.usuarios_novos, sessoes_engajadas = excluded.sessoes_engajadas, visualizacoes = excluded.visualizacoes,
           atualizado_em = now()`,
        [c.map((r) => r.dia), c.map((r) => r.host), c.map((r) => r.landing_page), c.map((r) => r.fonte), c.map((r) => r.midia),
         c.map((r) => r.campanha), c.map((r) => r.campanha_id), c.map((r) => r.gads_campanha_id),
         c.map((r) => r.sessoes), c.map((r) => r.usuarios_novos), c.map((r) => r.sessoes_engajadas), c.map((r) => r.visualizacoes)],
      );
    }
  }

  async eventos(rows: EventoDia[]): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const c = rows.slice(i, i + CHUNK);
      await upsert(
        this.q,
        `insert into mkt.ga4_eventos_dia (property_id, dia, host, pagina, evento, eventos, usuarios)
         select ${this.propertyId}, * from unnest($1::date[], $2::text[], $3::text[], $4::text[], $5::int[], $6::int[])
         on conflict (property_id, dia, host, pagina, evento) do update set
           eventos = excluded.eventos, usuarios = excluded.usuarios, atualizado_em = now()`,
        [c.map((r) => r.dia), c.map((r) => r.host), c.map((r) => r.pagina), c.map((r) => r.evento), c.map((r) => r.eventos), c.map((r) => r.usuarios)],
      );
    }
  }

  async paginas(rows: PaginaDia[]): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const c = rows.slice(i, i + CHUNK);
      await upsert(
        this.q,
        `insert into mkt.ga4_paginas_dia (property_id, dia, host, pagina, visualizacoes, usuarios_ativos)
         select ${this.propertyId}, * from unnest($1::date[], $2::text[], $3::text[], $4::int[], $5::int[])
         on conflict (property_id, dia, host, pagina) do update set
           visualizacoes = excluded.visualizacoes, usuarios_ativos = excluded.usuarios_ativos, atualizado_em = now()`,
        [c.map((r) => r.dia), c.map((r) => r.host), c.map((r) => r.pagina), c.map((r) => r.visualizacoes), c.map((r) => r.usuarios_ativos)],
      );
    }
  }

  async dias(rows: TotalDia[]): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const c = rows.slice(i, i + CHUNK);
      await upsert(
        this.q,
        `insert into mkt.ga4_dia (property_id, dia, sessoes, usuarios_ativos, usuarios_novos, sessoes_engajadas, visualizacoes)
         select ${this.propertyId}, * from unnest($1::date[], $2::int[], $3::int[], $4::int[], $5::int[], $6::int[])
         on conflict (property_id, dia) do update set sessoes = excluded.sessoes, usuarios_ativos = excluded.usuarios_ativos,
           usuarios_novos = excluded.usuarios_novos, sessoes_engajadas = excluded.sessoes_engajadas, visualizacoes = excluded.visualizacoes,
           atualizado_em = now()`,
        [c.map((r) => r.dia), c.map((r) => r.sessoes), c.map((r) => r.usuarios_ativos), c.map((r) => r.usuarios_novos), c.map((r) => r.sessoes_engajadas), c.map((r) => r.visualizacoes)],
      );
    }
  }

  async marcaDagua(entidade: Ga4Entidade): Promise<string | null> {
    const r = await this.q.query(`select marca_dagua::date::text as d from ops.sync_checkpoints where entity = $1`, [entidade]);
    return r.rows[0]?.d ?? null;
  }

  async salvarMarcaDagua(entidade: Ga4Entidade, dia: string, jobId: string, concluido: boolean): Promise<void> {
    await this.q.query(
      `insert into ops.sync_checkpoints (entity, marca_dagua, ultimo_sucesso_em, ultimo_job, backfill_concluido)
       values ($1, $2::date, now(), $3, $4)
       on conflict (entity) do update set marca_dagua = excluded.marca_dagua, ultimo_sucesso_em = now(), ultimo_job = excluded.ultimo_job,
         backfill_concluido = ops.sync_checkpoints.backfill_concluido or excluded.backfill_concluido`,
      [entidade, dia, jobId, concluido],
    );
  }

  async iniciarJob(entidade: Ga4Entidade, modo: 'backfill' | 'incremental', origem: 'agendada' | 'manual'): Promise<string> {
    const r = await this.q.query(`insert into ops.sync_jobs (entity, modo, origem, status) values ($1, $2, $3, 'rodando') returning job_id`, [entidade, modo, origem]);
    return r.rows[0].job_id;
  }

  async terminarJob(jobId: string, status: 'ok' | 'parcial' | 'erro', lidos: number, gravados: number, erro?: string): Promise<void> {
    await this.q.query(
      `update ops.sync_jobs set terminou_em = now(), status = $2, lidos = $3, gravados = $4, erro = $5 where job_id = $1`,
      [jobId, status, lidos, gravados, erro ?? null],
    );
  }
}

const hoje = () => new Date().toISOString().slice(0, 10);
const somaDias = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/** Intervalo a ler: da marca d'agua (menos a janela de revisao) ate ontem; sem marca, desde o inicio da carga. */
export function intervalo(desde: string, marcaDagua: string | null, agora = hoje()): { inicio: string; fim: string; modo: 'backfill' | 'incremental' } {
  const fim = somaDias(agora, -1);
  if (!marcaDagua) return { inicio: desde, fim, modo: 'backfill' };
  const inicio = somaDias(marcaDagua, -(REVISAO_DIAS - 1));
  return { inicio: inicio < desde ? desde : inicio, fim, modo: 'incremental' };
}

export async function syncGa4Entidade(
  client: Ga4Client,
  store: Ga4Store,
  entidade: Ga4Entidade,
  opts: { desde: string; apply: boolean; origem?: 'agendada' | 'manual'; maxBlocos?: number; log?: (s: string) => void },
): Promise<Ga4SyncResultado> {
  const log = opts.log ?? (() => {});
  const marca = await store.marcaDagua(entidade);
  const { inicio, fim, modo } = intervalo(opts.desde, marca);
  const blocos = inicio <= fim ? blocosDeDatas(inicio, fim, BLOCO_DIAS) : [];
  const jobId = opts.apply ? await store.iniciarJob(entidade, modo, opts.origem ?? 'manual') : '';
  let lidos = 0, gravados = 0, feitos = 0;
  let ate: string | null = marca;
  try {
    for (const b of blocos) {
      if (opts.maxBlocos !== undefined && feitos >= opts.maxBlocos) break;
      const rows = await client.runReportAll(relatorio(entidade, b.inicio, b.fim));
      lidos += rows.length;
      if (opts.apply) {
        if (entidade === 'ga4_dia') { const m = mapDia(rows); await store.dias(m); gravados += m.length; }
        else if (entidade === 'ga4_sessoes') { const m = mapSessoes(rows); await store.sessoes(m); gravados += m.length; }
        else if (entidade === 'ga4_eventos') { const m = mapEventos(rows); await store.eventos(m); gravados += m.length; }
        else { const m = mapPaginas(rows); await store.paginas(m); gravados += m.length; }
        await store.salvarMarcaDagua(entidade, b.fim, jobId, b === blocos[blocos.length - 1]);
      }
      ate = b.fim;
      feitos++;
      log(`${entidade}: ${b.inicio} a ${b.fim}: ${rows.length} linhas`);
    }
    const completo = feitos === blocos.length;
    if (opts.apply) await store.terminarJob(jobId, completo ? 'ok' : 'parcial', lidos, gravados);
    return { entidade, blocos: feitos, lidos, gravados, ate };
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    if (opts.apply) await store.terminarJob(jobId, 'erro', lidos, gravados, erro);
    return { entidade, blocos: feitos, lidos, gravados, ate, erro };
  }
}
