import type pg from 'pg';

export const PRODUTOS = ['rh', 'clinic'] as const;
export const MARCOS = ['lead', 'mql', 'sql', 'reuniao', 'proposta', 'ganho', 'perdido'] as const;
export type Produto = (typeof PRODUTOS)[number];
export type Marco = (typeof MARCOS)[number];

export class PainelNotFound extends Error {
  constructor(what: string) {
    super(`${what} não encontrado(a)`);
    this.name = 'PainelNotFound';
  }
}

export type PainelConfigPipeline = {
  pipeline_id: number;
  pipeline: string;
  pipeline_ordem: number | null;
  produto: Produto | null;
  etapas: Array<{ stage_id: number; etapa: string; etapa_ordem: number | null; marco: Marco | null }>;
};

/**
 * O que o Painel pode fazer: LER as views de analytics e as tabelas de ops, e GRAVAR só a configuração
 * (pipeline -> produto, etapa -> marco). Não há nenhuma outra escrita.
 */
export interface PainelRepo {
  saude(): Promise<{ entidades: unknown[]; jobs: unknown[]; erros: unknown[]; uso: unknown[] }>;
  config(): Promise<PainelConfigPipeline[]>;
  usuarios(): Promise<unknown[]>;
  campos(): Promise<unknown[]>;
  setPipelineProduto(pipelineId: number, produto: Produto | null): Promise<void>;
  setStageMarco(stageId: number, marco: Marco | null): Promise<void>;
}

type Row = Record<string, any>;

export class PgPainelRepo implements PainelRepo {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async saude() {
    const [entidades, jobs, erros, uso] = await Promise.all([
      this.pool.query(`select entity, ultimo_sucesso_em, backfill_concluido, ultimo_status, atrasada from analytics.sync_saude order by entity`),
      this.pool.query(
        `select job_id, entity, modo, origem, iniciou_em, terminou_em, status, lidos, gravados, atualizados, ignorados, falhas, tokens_gastos, erro
           from ops.sync_jobs order by iniciou_em desc limit 30`,
      ),
      // só a mensagem: o payload do erro pode conter dados pessoais e não vai para a tela
      this.pool.query(`select id, job_id, entity, source_id, mensagem, criado_em from ops.sync_errors order by criado_em desc limit 20`),
      this.pool.query(`select dia, tokens_gastos, requisicoes, limite_429 from ops.api_usage_daily order by dia desc limit 7`),
    ]);
    return { entidades: entidades.rows, jobs: jobs.rows, erros: erros.rows, uso: uso.rows };
  }

  async config(): Promise<PainelConfigPipeline[]> {
    const r = await this.pool.query(
      `select pipeline_id, pipeline, pipeline_ordem, produto, stage_id, etapa, etapa_ordem, marco
         from analytics.pipelines_etapas
        order by pipeline_ordem nulls last, pipeline_id, etapa_ordem nulls last, stage_id`,
    );
    const out = new Map<number, PainelConfigPipeline>();
    for (const x of r.rows as Row[]) {
      const id = Number(x.pipeline_id);
      if (!out.has(id)) out.set(id, { pipeline_id: id, pipeline: x.pipeline, pipeline_ordem: x.pipeline_ordem, produto: x.produto, etapas: [] });
      if (x.stage_id != null) out.get(id)!.etapas.push({ stage_id: Number(x.stage_id), etapa: x.etapa, etapa_ordem: x.etapa_ordem, marco: x.marco });
    }
    return [...out.values()];
  }

  async usuarios() {
    return (await this.pool.query(`select user_id, nome, ativo from analytics.usuarios order by nome nulls last, user_id`)).rows;
  }

  async campos() {
    return (await this.pool.query(`select entity, field_key, nome_pipedrive, rotulo, tipo, ordem from analytics.campos order by entity, ordem nulls last, nome_pipedrive`)).rows;
  }

  async setPipelineProduto(pipelineId: number, produto: Produto | null): Promise<void> {
    try {
      await this.pool.query(
        `insert into ops.cfg_pipeline_produto (pipeline_id, produto, atualizado_em) values ($1, $2, now())
         on conflict (pipeline_id) do update set produto = excluded.produto, atualizado_em = now()`,
        [pipelineId, produto],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23503') throw new PainelNotFound('pipeline');
      throw e;
    }
  }

  async setStageMarco(stageId: number, marco: Marco | null): Promise<void> {
    try {
      await this.pool.query(
        `insert into ops.cfg_stage_marco (stage_id, marco, atualizado_em) values ($1, $2, now())
         on conflict (stage_id) do update set marco = excluded.marco, atualizado_em = now()`,
        [stageId, marco],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23503') throw new PainelNotFound('etapa');
      throw e;
    }
  }
}
