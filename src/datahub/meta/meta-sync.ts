/**
 * Sincronizacao da Meta Ads -> mkt.meta_* (papel orq_sync). Retomavel, sem repetir trabalho e sem apagar nada:
 *  - estrutura (campanhas, conjuntos, anuncios): relida inteira a cada rodada (e pequena) e gravada por UPSERT;
 *  - desempenho por anuncio e dia: carga inicial em blocos de 31 dias; depois, so os ultimos 28 dias (a Meta ajusta numeros por ate 28 dias);
 *  - anuncios, conjuntos e campanhas que tem desempenho mas ja nao aparecem na listagem (apagados) sao buscados pelo ID.
 * A marca d'agua so avanca depois que o bloco foi gravado; uma interrupcao retoma do bloco seguinte.
 */
import type pg from 'pg';
import { blocosDeDatas } from '../google/ga4.js';
import { intervalo } from '../google/ga4-sync.js';
import {
  lerEstrutura, lerInsights, mapAnuncio, mapCampanha, mapConjunto,
  type AdDia, type Anuncio, type Campanha, type Conjunto, type MetaClient, type MetaConta,
} from './meta.js';

export const META_REVISAO_DIAS = 28;
export const META_BLOCO_DIAS = 31;
const CHUNK = 2000;
type Q = Pick<pg.Pool, 'query'>;
const col = <T, K extends keyof T>(rows: T[], k: K) => rows.map((r) => r[k]);

export class MetaStore {
  constructor(private readonly q: Q) {}

  async conta(c: { conta_id: string; produto: string; nome: string | null; moeda: string | null; fuso: string | null }) {
    await this.q.query(
      `insert into mkt.meta_contas (conta_id, produto, nome, moeda, fuso) values ($1::bigint, $2, $3, $4, $5)
       on conflict (conta_id) do update set produto = excluded.produto, nome = excluded.nome, moeda = excluded.moeda, fuso = excluded.fuso, atualizado_em = now()`,
      [c.conta_id, c.produto, c.nome, c.moeda, c.fuso],
    );
  }

  async campanhas(rows: Campanha[]) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const c = rows.slice(i, i + CHUNK);
      await this.q.query(
        `insert into mkt.meta_campanhas (campanha_id, conta_id, nome, nome_chave, objetivo, status, orcamento_diario, orcamento_total, criada_em, atualizada_em)
         select * from unnest($1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::numeric[], $9::timestamptz[], $10::timestamptz[])
         on conflict (campanha_id) do update set conta_id = excluded.conta_id, nome = excluded.nome, nome_chave = excluded.nome_chave, objetivo = excluded.objetivo,
           status = excluded.status, orcamento_diario = excluded.orcamento_diario, orcamento_total = excluded.orcamento_total, criada_em = excluded.criada_em,
           atualizada_em = excluded.atualizada_em, sincronizado_em = now()`,
        [col(c, 'campanha_id'), col(c, 'conta_id'), col(c, 'nome'), col(c, 'nome_chave'), col(c, 'objetivo'), col(c, 'status'), col(c, 'orcamento_diario'), col(c, 'orcamento_total'), col(c, 'criada_em'), col(c, 'atualizada_em')],
      );
    }
  }

  async conjuntos(rows: Conjunto[]) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const c = rows.slice(i, i + CHUNK);
      await this.q.query(
        `insert into mkt.meta_conjuntos (conjunto_id, campanha_id, conta_id, nome, nome_chave, status, otimizacao, orcamento_diario, orcamento_total, criado_em, atualizado_em)
         select * from unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::timestamptz[], $11::timestamptz[])
         on conflict (conjunto_id) do update set campanha_id = excluded.campanha_id, conta_id = excluded.conta_id, nome = excluded.nome, nome_chave = excluded.nome_chave,
           status = excluded.status, otimizacao = excluded.otimizacao, orcamento_diario = excluded.orcamento_diario, orcamento_total = excluded.orcamento_total,
           criado_em = excluded.criado_em, atualizado_em = excluded.atualizado_em, sincronizado_em = now()`,
        [col(c, 'conjunto_id'), col(c, 'campanha_id'), col(c, 'conta_id'), col(c, 'nome'), col(c, 'nome_chave'), col(c, 'status'), col(c, 'otimizacao'), col(c, 'orcamento_diario'), col(c, 'orcamento_total'), col(c, 'criado_em'), col(c, 'atualizado_em')],
      );
    }
  }

  async anuncios(rows: Anuncio[]) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const c = rows.slice(i, i + CHUNK);
      await this.q.query(
        `insert into mkt.meta_anuncios (anuncio_id, conjunto_id, campanha_id, conta_id, nome, nome_chave, status, criativo_id, criativo_nome, url_tags, criado_em, atualizado_em)
         select * from unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::bigint[], $5::text[], $6::text[], $7::text[], $8::bigint[], $9::text[], $10::text[], $11::timestamptz[], $12::timestamptz[])
         on conflict (anuncio_id) do update set conjunto_id = excluded.conjunto_id, campanha_id = excluded.campanha_id, conta_id = excluded.conta_id, nome = excluded.nome,
           nome_chave = excluded.nome_chave, status = excluded.status, criativo_id = excluded.criativo_id, criativo_nome = excluded.criativo_nome, url_tags = excluded.url_tags,
           criado_em = excluded.criado_em, atualizado_em = excluded.atualizado_em, sincronizado_em = now()`,
        [col(c, 'anuncio_id'), col(c, 'conjunto_id'), col(c, 'campanha_id'), col(c, 'conta_id'), col(c, 'nome'), col(c, 'nome_chave'), col(c, 'status'), col(c, 'criativo_id'), col(c, 'criativo_nome'), col(c, 'url_tags'), col(c, 'criado_em'), col(c, 'atualizado_em')],
      );
    }
  }

  async desempenho(rows: AdDia[]) {
    for (let i = 0; i < rows.length; i += 1000) {
      const c = rows.slice(i, i + 1000);
      await this.q.query(
        `insert into mkt.meta_ads_dia (anuncio_id, dia, conta_id, conjunto_id, campanha_id, gasto, impressoes, alcance, cliques, cliques_link, visitas_pagina, leads_meta,
           video_reproducoes, video_3s, video_p25, video_p50, video_p75, video_p95, video_p100, video_thruplay, video_tempo_medio)
         select * from unnest($1::bigint[], $2::date[], $3::bigint[], $4::bigint[], $5::bigint[], $6::numeric[], $7::int[], $8::int[], $9::int[], $10::int[], $11::int[], $12::int[],
           $13::int[], $14::int[], $15::int[], $16::int[], $17::int[], $18::int[], $19::int[], $20::int[], $21::numeric[])
         on conflict (anuncio_id, dia) do update set conta_id = excluded.conta_id, conjunto_id = excluded.conjunto_id, campanha_id = excluded.campanha_id, gasto = excluded.gasto,
           impressoes = excluded.impressoes, alcance = excluded.alcance, cliques = excluded.cliques, cliques_link = excluded.cliques_link, visitas_pagina = excluded.visitas_pagina,
           leads_meta = excluded.leads_meta, video_reproducoes = excluded.video_reproducoes, video_3s = excluded.video_3s, video_p25 = excluded.video_p25, video_p50 = excluded.video_p50,
           video_p75 = excluded.video_p75, video_p95 = excluded.video_p95, video_p100 = excluded.video_p100, video_thruplay = excluded.video_thruplay,
           video_tempo_medio = excluded.video_tempo_medio, atualizado_em = now()`,
        [col(c, 'anuncio_id'), col(c, 'dia'), col(c, 'conta_id'), col(c, 'conjunto_id'), col(c, 'campanha_id'), col(c, 'gasto'), col(c, 'impressoes'), col(c, 'alcance'), col(c, 'cliques'),
         col(c, 'cliques_link'), col(c, 'visitas_pagina'), col(c, 'leads_meta'), col(c, 'video_reproducoes'), col(c, 'video_3s'), col(c, 'video_p25'), col(c, 'video_p50'),
         col(c, 'video_p75'), col(c, 'video_p95'), col(c, 'video_p100'), col(c, 'video_thruplay'), col(c, 'video_tempo_medio')],
      );
    }
  }

  /** IDs que tem desempenho mas nao tem a estrutura gravada (anuncios apagados na Meta, por exemplo). */
  async idsSemEstrutura(conta: string): Promise<{ anuncios: string[]; conjuntos: string[]; campanhas: string[] }> {
    const q = async (sql: string) => ((await this.q.query(sql, [conta])).rows as Array<{ id: string }>).map((r) => r.id);
    return {
      anuncios: await q(`select distinct d.anuncio_id::text as id from mkt.meta_ads_dia d where d.conta_id = $1::bigint and not exists (select 1 from mkt.meta_anuncios a where a.anuncio_id = d.anuncio_id)`),
      conjuntos: await q(`select distinct d.conjunto_id::text as id from mkt.meta_ads_dia d where d.conta_id = $1::bigint and d.conjunto_id is not null and not exists (select 1 from mkt.meta_conjuntos a where a.conjunto_id = d.conjunto_id)`),
      campanhas: await q(`select distinct d.campanha_id::text as id from mkt.meta_ads_dia d where d.conta_id = $1::bigint and d.campanha_id is not null and not exists (select 1 from mkt.meta_campanhas a where a.campanha_id = d.campanha_id)`),
    };
  }

  /** Recalcula a ligacao negocio -> anuncio/conjunto/campanha (funcao do banco, por upsert; devolve quantos negocios foram gravados). */
  async recalcularLigacao(): Promise<number> {
    return Number((await this.q.query(`select mkt.recalcular_ligacao_meta() as n`)).rows[0].n);
  }

  async marcaDagua(entidade: string): Promise<string | null> {
    const r = await this.q.query(`select marca_dagua::date::text as d from ops.sync_checkpoints where entity = $1`, [entidade]);
    return r.rows[0]?.d ?? null;
  }
  async salvarMarcaDagua(entidade: string, dia: string, jobId: string, concluido: boolean) {
    await this.q.query(
      `insert into ops.sync_checkpoints (entity, marca_dagua, ultimo_sucesso_em, ultimo_job, backfill_concluido) values ($1, $2::date, now(), $3, $4)
       on conflict (entity) do update set marca_dagua = excluded.marca_dagua, ultimo_sucesso_em = now(), ultimo_job = excluded.ultimo_job,
         backfill_concluido = ops.sync_checkpoints.backfill_concluido or excluded.backfill_concluido`,
      [entidade, dia, jobId, concluido],
    );
  }
  async iniciarJob(entidade: string, modo: 'backfill' | 'incremental', origem: 'agendada' | 'manual'): Promise<string> {
    const r = await this.q.query(`insert into ops.sync_jobs (entity, modo, origem, status) values ($1, $2, $3, 'rodando') returning job_id`, [entidade, modo, origem]);
    return r.rows[0].job_id;
  }
  async terminarJob(jobId: string, status: 'ok' | 'parcial' | 'erro', lidos: number, gravados: number, erro?: string) {
    await this.q.query(`update ops.sync_jobs set terminou_em = now(), status = $2, lidos = $3, gravados = $4, erro = $5 where job_id = $1`, [jobId, status, lidos, gravados, erro ?? null]);
  }
}

export interface MetaSyncResultado { entidade: string; lidos: number; gravados: number; ate?: string | null; faltaram?: number; erro?: string }

/** Liga os negocios do Pipedrive a Meta (3 metodos, ver a migration 0018) e devolve a contagem por metodo. */
export async function syncMetaLigacao(store: MetaStore, opts: { apply: boolean; origem?: 'agendada' | 'manual' }): Promise<MetaSyncResultado> {
  const entidade = 'meta_ligacao';
  if (!opts.apply) return { entidade, lidos: 0, gravados: 0 };
  const jobId = await store.iniciarJob(entidade, 'incremental', opts.origem ?? 'manual');
  try {
    const n = await store.recalcularLigacao();
    await store.salvarMarcaDagua(entidade, new Date().toISOString().slice(0, 10), jobId, true);
    await store.terminarJob(jobId, 'ok', n, n);
    return { entidade, lidos: n, gravados: n };
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    await store.terminarJob(jobId, 'erro', 0, 0, erro);
    return { entidade, lidos: 0, gravados: 0, erro };
  }
}

/** Estrutura da conta (campanhas, conjuntos e anuncios) mais a busca pelo ID do que so aparece nos relatorios. */
export async function syncMetaEstrutura(client: MetaClient, store: MetaStore, conta: MetaConta, opts: { apply: boolean; origem?: 'agendada' | 'manual'; log?: (s: string) => void }): Promise<MetaSyncResultado> {
  const entidade = `meta_estrutura_${conta.produto}`;
  const jobId = opts.apply ? await store.iniciarJob(entidade, 'incremental', opts.origem ?? 'manual') : '';
  let lidos = 0, gravados = 0;
  try {
    const e = await lerEstrutura(client, conta);
    lidos = e.campanhas.length + e.conjuntos.length + e.anuncios.length;
    opts.log?.(`${entidade}: ${e.campanhas.length} campanhas, ${e.conjuntos.length} conjuntos, ${e.anuncios.length} anuncios`);
    if (opts.apply) {
      await store.conta(e.conta);
      await store.campanhas(e.campanhas);
      await store.conjuntos(e.conjuntos);
      await store.anuncios(e.anuncios);
      gravados = lidos;
      await store.salvarMarcaDagua(entidade, new Date().toISOString().slice(0, 10), jobId, true);
      await store.terminarJob(jobId, 'ok', lidos, gravados);
    }
    return { entidade, lidos, gravados };
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    if (opts.apply) await store.terminarJob(jobId, 'erro', lidos, gravados, erro);
    return { entidade, lidos, gravados, erro };
  }
}

/** Busca pelo ID o que tem desempenho mas nao esta na listagem (anuncios, conjuntos e campanhas apagados). */
export async function completarEstrutura(client: MetaClient, store: MetaStore, conta: MetaConta, log?: (s: string) => void): Promise<number> {
  const falta = await store.idsSemEstrutura(conta.id);
  let total = 0;
  const lotes = (ids: string[]) => Array.from({ length: Math.ceil(ids.length / 50) }, (_, i) => ids.slice(i * 50, i * 50 + 50));
  for (const lote of lotes(falta.campanhas)) {
    const j = await client.get('', { ids: lote.join(','), fields: 'id,name,objective,effective_status,daily_budget,lifetime_budget,created_time,updated_time' });
    await store.campanhas(Object.values(j as Record<string, any>).map((r) => mapCampanha(r, conta.id)));
    total += lote.length;
  }
  for (const lote of lotes(falta.conjuntos)) {
    const j = await client.get('', { ids: lote.join(','), fields: 'id,name,campaign_id,effective_status,optimization_goal,daily_budget,lifetime_budget,created_time,updated_time' });
    await store.conjuntos(Object.values(j as Record<string, any>).map((r) => mapConjunto(r, conta.id)));
    total += lote.length;
  }
  for (const lote of lotes(falta.anuncios)) {
    const j = await client.get('', { ids: lote.join(','), fields: 'id,name,adset_id,campaign_id,effective_status,created_time,updated_time,creative{id,name,url_tags}' });
    await store.anuncios(Object.values(j as Record<string, any>).map((r) => mapAnuncio(r, conta.id)));
    total += lote.length;
  }
  if (total) log?.(`${conta.produto}: ${total} itens fora da listagem buscados pelo ID`);
  return total;
}

/** Desempenho por anuncio e dia de uma conta, em blocos, com marca d'agua. */
export async function syncMetaDesempenho(
  client: MetaClient, store: MetaStore, conta: MetaConta,
  opts: { desde: string; apply: boolean; origem?: 'agendada' | 'manual'; maxBlocos?: number; log?: (s: string) => void },
): Promise<MetaSyncResultado> {
  const entidade = `meta_insights_${conta.produto}`;
  // uma marca d'agua ANTERIOR ao inicio pedido (ex.: sobrou de uma carga que comecava antes) nao vale: comeca em `desde`
  const salva = await store.marcaDagua(entidade);
  const marca = salva && salva >= opts.desde ? salva : null;
  const { inicio, fim, modo } = intervalo(opts.desde, marca, undefined, META_REVISAO_DIAS);
  const blocos = inicio <= fim ? blocosDeDatas(inicio, fim, META_BLOCO_DIAS) : [];
  const jobId = opts.apply ? await store.iniciarJob(entidade, modo, opts.origem ?? 'manual') : '';
  let lidos = 0, gravados = 0, feitos = 0;
  let ate: string | null = marca;
  try {
    for (const b of blocos) {
      if (opts.maxBlocos !== undefined && feitos >= opts.maxBlocos) break;
      const rows = await lerInsights(client, conta, b.inicio, b.fim);
      lidos += rows.length;
      if (opts.apply) {
        await store.desempenho(rows);
        gravados += rows.length;
        await store.salvarMarcaDagua(entidade, b.fim, jobId, b === blocos[blocos.length - 1]);
      }
      ate = b.fim;
      feitos++;
      opts.log?.(`${entidade}: ${b.inicio} a ${b.fim}: ${rows.length} linhas`);
    }
    const faltaram = opts.apply ? await completarEstrutura(client, store, conta, opts.log) : 0;
    if (opts.apply) await store.terminarJob(jobId, feitos === blocos.length ? 'ok' : 'parcial', lidos, gravados);
    return { entidade, lidos, gravados, ate, faltaram };
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    if (opts.apply) await store.terminarJob(jobId, 'erro', lidos, gravados, erro);
    return { entidade, lidos, gravados, ate, erro };
  }
}
