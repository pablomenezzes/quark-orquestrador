import type pg from 'pg';

export const PRODUTOS = ['rh', 'clinic'] as const;
/**
 * Marcos de etapa = "até onde o negócio chegou". Ganho/perdido/aberto/excluído vêm do Status do negócio (nunca da etapa)
 * e MQL é regra pelo motivo de perda (cfg_motivo_perda), não etapa. Ver D-36.
 */
export const MARCOS = ['sql', 'reuniao', 'proposta'] as const;
export const STATUS_NEGOCIO = ['open', 'won', 'lost', 'deleted'] as const;
export type Produto = (typeof PRODUTOS)[number];
export type Marco = (typeof MARCOS)[number];
export type StatusNegocio = (typeof STATUS_NEGOCIO)[number];

export const NEGOCIOS_POR_PAGINA = 50;

export type NegociosFiltro = {
  pipeline_id?: number;
  status?: StatusNegocio;
  /** true = só os que contam como MQL (regra D-36). */
  mql?: boolean;
  /** Número = ID do negócio; texto = parte do título. */
  q?: string;
  /** Mês de criação, AAAA-MM. */
  mes?: string;
  pagina?: number;
};

export type NegocioResumoLinha = {
  pipeline_id: number | null;
  pipeline: string | null;
  produto: Produto | null;
  status: string | null;
  is_archived: boolean;
  qtd: number;
  qtd_mql: number;
  valor_total: number;
};

export type MotivoPerda ={ reason_id: number; motivo: string | null; exclui_mql: boolean };
export type StatusContagem = { status: StatusNegocio; conta_como_lead: boolean };

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
  negociosResumo(): Promise<NegocioResumoLinha[]>;
  negocios(f: NegociosFiltro): Promise<{ total: number; pagina: number; por_pagina: number; itens: unknown[] }>;
  negocio(id: number): Promise<{ negocio: unknown; campos: unknown[] }>;
  motivosPerda(): Promise<MotivoPerda[]>;
  statusContagem(): Promise<StatusContagem[]>;
  setMotivoExcluiMql(reasonId: number, excluiMql: boolean): Promise<void>;
  setStatusContaComoLead(status: StatusNegocio, conta: boolean): Promise<void>;
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

  async negociosResumo(): Promise<NegocioResumoLinha[]> {
    const r = await this.pool.query(
      `select pipeline_id, pipeline, produto, status, is_archived, sum(qtd)::int as qtd, sum(qtd_mql)::int as qtd_mql, sum(valor_total)::float8 as valor_total
         from analytics.deals_resumo
        group by pipeline_id, pipeline, produto, status, is_archived
        order by pipeline_id nulls last, status nulls last, is_archived`,
    );
    return (r.rows as Row[]).map((x) => ({ ...x, pipeline_id: x.pipeline_id == null ? null : Number(x.pipeline_id) })) as NegocioResumoLinha[];
  }

  async negocios(f: NegociosFiltro) {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replace('$$', `$${args.length}`));
    };
    if (f.pipeline_id != null) add('pipeline_id = $$', f.pipeline_id);
    if (f.status) add('status = $$', f.status);
    if (f.mql) where.push('is_mql');
    if (f.mes) add(`to_char(criado_em, 'YYYY-MM') = $$`, f.mes);
    const q = f.q?.trim();
    if (q) {
      if (/^\d{1,15}$/.test(q)) add('deal_id = $$', Number(q));
      else add(`titulo ilike $$ escape '\\'`, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const w = where.length ? `where ${where.join(' and ')}` : '';
    const pagina = Math.max(1, Math.floor(f.pagina ?? 1));
    const total = Number((await this.pool.query(`select count(*)::int as n from analytics.deals ${w}`, args)).rows[0].n);
    const r = await this.pool.query(
      `select deal_id, titulo, pipeline_id, pipeline, produto, stage_id, etapa, marco, status, valor, moeda, responsavel, owner_id,
              motivo_perda_id, motivo_perda, criado_em, fechado_em, perdido_em, atualizado_em, is_archived, conta_como_lead, is_mql
         from analytics.deals ${w}
        order by criado_em desc nulls last, deal_id desc
        limit ${NEGOCIOS_POR_PAGINA} offset ${(pagina - 1) * NEGOCIOS_POR_PAGINA}`,
      args,
    );
    return { total, pagina, por_pagina: NEGOCIOS_POR_PAGINA, itens: r.rows };
  }

  async negocio(id: number) {
    const d = await this.pool.query(`select * from analytics.deals where deal_id = $1`, [id]);
    if (!d.rows[0]) throw new PainelNotFound('negócio');
    const c = await this.pool.query(
      `select field_key, nome_pipedrive, rotulo, valor from analytics.deal_campos where deal_id = $1 order by coalesce(rotulo, nome_pipedrive, field_key)`,
      [id],
    );
    return { negocio: d.rows[0], campos: c.rows };
  }

  async motivosPerda(): Promise<MotivoPerda[]> {
    const r = await this.pool.query(`select reason_id, motivo, exclui_mql from analytics.motivos_perda order by exclui_mql desc, motivo nulls last, reason_id`);
    return (r.rows as Row[]).map((x) => ({ reason_id: Number(x.reason_id), motivo: x.motivo, exclui_mql: x.exclui_mql }));
  }

  async statusContagem(): Promise<StatusContagem[]> {
    const r = await this.pool.query(
      `select status, conta_como_lead from analytics.contagem_status
        order by array_position(array['open','won','lost','deleted'], status)`,
    );
    return r.rows as StatusContagem[];
  }

  async setMotivoExcluiMql(reasonId: number, excluiMql: boolean): Promise<void> {
    // só motivos que existem (opção do Pipedrive ou já configurado); inventar ID não grava nada
    const r = await this.pool.query(
      `insert into ops.cfg_motivo_perda (reason_id, exclui_mql, atualizado_em)
       select reason_id, $2, now() from analytics.motivos_perda where reason_id = $1
       on conflict (reason_id) do update set exclui_mql = excluded.exclui_mql, atualizado_em = now()`,
      [reasonId, excluiMql],
    );
    if (!r.rowCount) throw new PainelNotFound('motivo de perda');
  }

  async setStatusContaComoLead(status: StatusNegocio, conta: boolean): Promise<void> {
    const r = await this.pool.query(`update ops.cfg_status_contagem set conta_como_lead = $2, atualizado_em = now() where status = $1`, [status, conta]);
    if (!r.rowCount) throw new PainelNotFound('status');
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
