/**
 * Sincronizacao do Search Console -> mkt.gsc_* (papel orq_sync). Mesmo desenho do GA4 (ga4-sync.ts): carga inicial por blocos de dias com marca
 * d'agua que so avanca depois de gravar, revisao dos ultimos REVISAO_DIAS dias e UPSERT (reler nao duplica). A diferenca: o dado final do GSC
 * chega com ATRASO_DIAS de atraso, entao o ultimo dia lido nao e ontem. Cada marca tem a sua marca d'agua (chave "entidade:marca").
 */
import type pg from 'pg';
import { blocosDeDatas, type MarcaGa4 } from './ga4.js';
import { ATRASO_DIAS, BLOCO_DIAS, REVISAO_DIAS, blocosMensais, mapGscConsultas, mapGscPaginas, relatorioGsc, type GscClient, type GscConsultaDia, type GscEntidade, type GscPaginaDia } from './gsc.js';

type Q = Pick<pg.Pool, 'query'>;
const CHUNK = 2000;

export interface GscSyncResultado { entidade: GscEntidade; blocos: number; lidos: number; gravados: number; ate: string | null; erro?: string }

export class GscStore {
  /** `sufixo` separa a marca d'agua de cada propriedade quando a marca tem mais de uma; vazio na primeira. */
  constructor(private readonly q: Q, readonly marca: MarcaGa4, private readonly sufixo = '') {}

  private chave(e: GscEntidade): string {
    return this.sufixo ? `${e}:${this.marca}:${this.sufixo}` : `${e}:${this.marca}`;
  }

  async paginas(rows: GscPaginaDia[]): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const c = rows.slice(i, i + CHUNK);
      await this.q.query(
        `insert into mkt.gsc_pagina_dia (marca, dia, host, pagina, cliques, impressoes, pos_x_imp)
         select '${this.marca}', * from unnest($1::date[], $2::text[], $3::text[], $4::int[], $5::int[], $6::numeric[])
         on conflict (marca, dia, host, pagina) do update set cliques = excluded.cliques, impressoes = excluded.impressoes,
           pos_x_imp = excluded.pos_x_imp, atualizado_em = now()`,
        [c.map((r) => r.dia), c.map((r) => r.host), c.map((r) => r.pagina), c.map((r) => r.cliques), c.map((r) => r.impressoes), c.map((r) => r.pos_x_imp)],
      );
    }
  }

  async consultas(rows: GscConsultaDia[]): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const c = rows.slice(i, i + CHUNK);
      await this.q.query(
        `insert into mkt.gsc_consulta_dia (marca, dia, host, pagina, consulta, cliques, impressoes, pos_x_imp)
         select '${this.marca}', * from unnest($1::date[], $2::text[], $3::text[], $4::text[], $5::int[], $6::int[], $7::numeric[])
         on conflict (marca, dia, host, pagina, consulta) do update set cliques = excluded.cliques, impressoes = excluded.impressoes,
           pos_x_imp = excluded.pos_x_imp, atualizado_em = now()`,
        [c.map((r) => r.dia), c.map((r) => r.host), c.map((r) => r.pagina), c.map((r) => r.consulta), c.map((r) => r.cliques), c.map((r) => r.impressoes), c.map((r) => r.pos_x_imp)],
      );
    }
  }

  async marcaDagua(e: GscEntidade): Promise<string | null> {
    const r = await this.q.query(`select marca_dagua::date::text as d from ops.sync_checkpoints where entity = $1`, [this.chave(e)]);
    return r.rows[0]?.d ?? null;
  }

  async salvarMarcaDagua(e: GscEntidade, dia: string, jobId: string, concluido: boolean): Promise<void> {
    await this.q.query(
      `insert into ops.sync_checkpoints (entity, marca_dagua, ultimo_sucesso_em, ultimo_job, backfill_concluido) values ($1, $2::date, now(), $3, $4)
       on conflict (entity) do update set marca_dagua = excluded.marca_dagua, ultimo_sucesso_em = now(), ultimo_job = excluded.ultimo_job,
         backfill_concluido = ops.sync_checkpoints.backfill_concluido or excluded.backfill_concluido`,
      [this.chave(e), dia, jobId, concluido],
    );
  }

  async iniciarJob(e: GscEntidade, modo: 'backfill' | 'incremental', origem: 'agendada' | 'manual'): Promise<string> {
    const r = await this.q.query(`insert into ops.sync_jobs (entity, modo, origem, status) values ($1, $2, $3, 'rodando') returning job_id`, [this.chave(e), modo, origem]);
    return r.rows[0].job_id;
  }

  async terminarJob(jobId: string, status: 'ok' | 'parcial' | 'erro', lidos: number, gravados: number, erro?: string): Promise<void> {
    await this.q.query(`update ops.sync_jobs set terminou_em = now(), status = $2, lidos = $3, gravados = $4, erro = $5 where job_id = $1`, [jobId, status, lidos, gravados, erro ?? null]);
  }
}

const hoje = () => new Date().toISOString().slice(0, 10);
const somaDias = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/** Da marca d'agua (menos a janela de revisao) ate hoje - ATRASO_DIAS; sem marca, desde o inicio da carga. */
export function intervaloGsc(desde: string, marcaDagua: string | null, agora = hoje(), revisao = REVISAO_DIAS, atraso = ATRASO_DIAS): { inicio: string; fim: string; modo: 'backfill' | 'incremental' } {
  const fim = somaDias(agora, -atraso);
  if (!marcaDagua) return { inicio: desde, fim, modo: 'backfill' };
  const inicio = somaDias(marcaDagua, -(revisao - 1));
  return { inicio: inicio < desde ? desde : inicio, fim, modo: 'incremental' };
}

export async function syncGscEntidade(
  client: GscClient,
  store: GscStore,
  entidade: GscEntidade,
  opts: { desde: string; apply: boolean; origem?: 'agendada' | 'manual'; maxBlocos?: number; log?: (s: string) => void },
): Promise<GscSyncResultado> {
  const log = opts.log ?? (() => {});
  const marca = await store.marcaDagua(entidade);
  const { inicio, fim, modo } = intervaloGsc(opts.desde, marca);
  // consultas: um bloco por MES inteiro (o mes em curso e relido por inteiro a cada rodada, pois a linha do mes e substituida)
  const blocos = inicio > fim ? [] : entidade === 'gsc_consulta' ? blocosMensais(inicio, fim) : blocosDeDatas(inicio, fim, BLOCO_DIAS);
  const jobId = opts.apply ? await store.iniciarJob(entidade, modo, opts.origem ?? 'manual') : '';
  let lidos = 0, gravados = 0, feitos = 0;
  let ate: string | null = marca;
  try {
    for (const b of blocos) {
      if (opts.maxBlocos !== undefined && feitos >= opts.maxBlocos) break;
      const rows = await client.queryAll(relatorioGsc(entidade, b.inicio, b.fim));
      lidos += rows.length;
      if (opts.apply) {
        if (entidade === 'gsc_pagina') {
          const m = mapGscPaginas(rows);
          await store.paginas(m);
          gravados += m.length;
        } else {
          const m = mapGscConsultas(rows, b.inicio);
          await store.consultas(m);
          gravados += m.length;
        }
        await store.salvarMarcaDagua(entidade, b.fim, jobId, b === blocos[blocos.length - 1]);
      }
      ate = b.fim;
      feitos++;
      log(`${entidade}: ${b.inicio} a ${b.fim}: ${rows.length} linhas`);
    }
    if (opts.apply) await store.terminarJob(jobId, feitos === blocos.length ? 'ok' : 'parcial', lidos, gravados);
    return { entidade, blocos: feitos, lidos, gravados, ate };
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    if (opts.apply) await store.terminarJob(jobId, 'erro', lidos, gravados, erro);
    return { entidade, blocos: feitos, lidos, gravados, ate, erro };
  }
}
