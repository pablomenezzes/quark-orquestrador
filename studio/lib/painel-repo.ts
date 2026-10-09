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

/** Entrada recusada por regra de negócio (vira HTTP 400): ex.: Mensagem que não é da DOR escolhida, item removido. */
export class PainelInvalido extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PainelInvalido';
  }
}

/** Agrupamento virtual dos criativos do Meta Ads (D-50): DOR > Mensagem e Módulo de Interesse. Tudo opcional (em branco = sem equivalente). */
export const CRIATIVO_ITENS = ['dor', 'mensagem', 'modulo'] as const;
export type CriativoItem = (typeof CRIATIVO_ITENS)[number];
export type CriativoMapaPatch = { dor_id?: number | null; mensagem_id?: number | null; modulo_id?: number | null };
/** `criativos` e `leads` = quantos criativos e leads (Meta Ads, UTM Term preenchido) estão mapeados para o item. */
type ItemCriativo = { id: number; nome: string; ativo: boolean; criativos: number; leads: number };
export type CriativosConfig = {
  dores: Array<ItemCriativo & { mensagens: ItemCriativo[] }>;
  modulos: ItemCriativo[];
};

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
  negocio(id: number): Promise<{ negocio: unknown; campos: unknown[]; historico: unknown[] }>;
  historicoProgresso(): Promise<unknown[]>;
  funilMarcos(ano: number): Promise<unknown[]>;
  motivosPerda(): Promise<MotivoPerda[]>;
  statusContagem(): Promise<StatusContagem[]>;
  setMotivoExcluiMql(reasonId: number, excluiMql: boolean): Promise<void>;
  setStatusContaComoLead(status: StatusNegocio, conta: boolean): Promise<void>;
  /** Conversões do site (GA4): eventos que existem, URLs onde cada um aparece e as regras criadas no Painel. */
  conversaoEventos(dias: number): Promise<unknown[]>;
  conversaoEventoUrls(evento: string, dias: number): Promise<unknown[]>;
  conversaoRegras(): Promise<unknown[]>;
  criarConversaoRegra(r: ConversaoRegraEntrada): Promise<{ id: number }>;
  atualizarConversaoRegra(id: number, r: Partial<ConversaoRegraEntrada> & { ativo?: boolean }): Promise<void>;
  /** Criativos do Meta Ads (UTM Term) agrupados em DOR > Mensagem e Módulo de Interesse. */
  criativosConfig(): Promise<CriativosConfig>;
  criativos(): Promise<unknown[]>;
  /** Cria (ou restaura, se já existia removido com o mesmo nome). `paiId` = a DOR, só para Mensagem. */
  criarCriativoItem(tipo: CriativoItem, nome: string, paiId?: number): Promise<{ id: number; restaurado: boolean }>;
  /** Renomeia e/ou remove (ativo=false) ou restaura (ativo=true). Remover uma DOR remove também as Mensagens dela. */
  atualizarCriativoItem(tipo: CriativoItem, id: number, patch: { nome?: string; ativo?: boolean }): Promise<void>;
  /** Grava DOR, Mensagem e/ou Módulo (só os campos presentes; null = deixar em branco) para os criativos informados. */
  mapearCriativos(termos: string[], patch: CriativoMapaPatch): Promise<{ atualizados: number }>;
}

export const REGRA_TIPOS = ['lead', 'intermediaria', 'ignorar'] as const;
export const REGRA_URL_MODOS = ['qualquer', 'igual', 'comeca', 'contem'] as const;
export type ConversaoRegraEntrada = {
  nome: string;
  tipo: (typeof REGRA_TIPOS)[number];
  evento: string;
  url_modo: (typeof REGRA_URL_MODOS)[number];
  url_valor: string | null;
};

/** Mesma comparação de URL da view analytics.site_conversoes_dia, aplicada à "URL de Conversão" dos negócios do Pipedrive. */
const CASA_URL_NEGOCIO = `case r.url_modo
  when 'igual'  then n.caminho_url = mkt.caminho_url(r.url_valor)
  when 'comeca' then n.caminho_url like mkt.caminho_url(r.url_valor) || '%'
  when 'contem' then n.caminho_url like '%' || lower(btrim(r.url_valor)) || '%'
  else false end`;

type Row = Record<string, any>;
const n0 = (v: unknown): number => (v == null ? 0 : Number(v));

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
      `select field_key, nome_pipedrive, rotulo, valor, valor_legivel from analytics.deal_campos where deal_id = $1 order by coalesce(rotulo, nome_pipedrive, field_key)`,
      [id],
    );
    const h = await this.pool.query(
      `select stage_id, etapa, pipeline, marco, entrou_em, saiu_em, horas_na_etapa, etapa_atual, movido_por, origem_dado
         from analytics.historico_etapas where deal_id = $1 order by entrou_em, stage_id`,
      [id],
    );
    return { negocio: d.rows[0], campos: c.rows, historico: h.rows };
  }

  async historicoProgresso() {
    return (await this.pool.query(`select * from analytics.historico_progresso order by ano_criacao desc`)).rows;
  }

  /**
   * Funil por pipeline dos negócios criados no ano: leads (conta como lead), MQL, e quantos CHEGARAM em sql, reunião e proposta
   * (pelo histórico de etapas; só vale para os negócios com histórico lido), ganhos e perdidos (pelo Status, nunca pela etapa).
   */
  async funilMarcos(ano: number) {
    return (
      await this.pool.query(
        `select d.pipeline_id, d.pipeline, d.produto,
                count(*) filter (where d.conta_como_lead)::int as leads,
                count(*) filter (where d.is_mql)::int as mql,
                count(*) filter (where m.sql)::int as chegou_sql,
                count(*) filter (where m.reuniao)::int as chegou_reuniao,
                count(*) filter (where m.proposta)::int as chegou_proposta,
                count(*) filter (where d.status = 'won')::int as ganhos,
                count(*) filter (where d.status = 'lost')::int as perdidos
           from analytics.deals d
           left join (select deal_id, bool_or(marco = 'sql') as sql, bool_or(marco = 'reuniao') as reuniao, bool_or(marco = 'proposta') as proposta
                        from analytics.negocios_marcos group by deal_id) m on m.deal_id = d.deal_id
          where extract(year from d.criado_em) = $1
          group by d.pipeline_id, d.pipeline, d.produto
          order by d.pipeline_id nulls last`,
        [ano],
      )
    ).rows;
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

  async conversaoEventos(dias: number) {
    return (
      await this.pool.query(
        `select evento, sum(eventos)::int as eventos, sum(usuarios)::int as usuarios, count(distinct caminho)::int as urls,
                max(dia)::text as ultimo_dia
           from analytics.site_eventos_dia where dia >= current_date - $1::int
          group by evento order by sum(eventos) desc, evento`,
        [dias],
      )
    ).rows;
  }

  async conversaoEventoUrls(evento: string, dias: number) {
    return (
      await this.pool.query(
        `select host, caminho, sum(eventos)::int as eventos, sum(usuarios)::int as usuarios, max(dia)::text as ultimo_dia
           from analytics.site_eventos_dia where evento = $1 and dia >= current_date - $2::int
          group by host, caminho order by sum(eventos) desc, caminho limit 200`,
        [evento, dias],
      )
    ).rows;
  }

  /** Cada regra com o que ela pega nos últimos 30 dias: eventos do GA4 e negócios do Pipedrive com aquela URL de conversão. */
  async conversaoRegras() {
    return (
      await this.pool.query(
        `select r.id, r.nome, r.tipo, r.evento, r.url_modo, r.url_valor, r.ativo, r.atualizado_em,
                coalesce(c.eventos, 0)::int as eventos_30d, coalesce(c.usuarios, 0)::int as usuarios_30d,
                case when r.url_modo = 'qualquer' then null else (
                  select count(*)::int from analytics.negocios_url n
                   where n.criado_em >= now() - interval '30 days' and n.tem_url and ${CASA_URL_NEGOCIO}
                ) end as negocios_30d
           from analytics.conversao_regras r
           left join lateral (
             select sum(eventos) as eventos, sum(usuarios) as usuarios from analytics.site_conversoes_dia s
              where s.regra_id = r.id and s.dia >= current_date - 30
           ) c on true
          order by r.ativo desc, r.id`,
      )
    ).rows;
  }

  async criarConversaoRegra(r: ConversaoRegraEntrada) {
    const x = await this.pool.query(
      `insert into mkt.conversao_regras (nome, tipo, evento, url_modo, url_valor) values ($1, $2, $3, $4, $5) returning id`,
      [r.nome, r.tipo, r.evento, r.url_modo, r.url_modo === 'qualquer' ? null : r.url_valor],
    );
    return { id: Number(x.rows[0].id) };
  }

  async atualizarConversaoRegra(id: number, r: Partial<ConversaoRegraEntrada> & { ativo?: boolean }) {
    const sets: string[] = [];
    const vals: unknown[] = [id];
    for (const k of ['nome', 'tipo', 'evento', 'url_modo', 'url_valor', 'ativo'] as const) {
      if (k in r) {
        vals.push(k === 'url_valor' && r.url_modo === 'qualquer' ? null : r[k]);
        sets.push(`${k} = $${vals.length}`);
      }
    }
    if (!sets.length) return;
    const x = await this.pool.query(`update mkt.conversao_regras set ${sets.join(', ')}, atualizado_em = now() where id = $1`, vals);
    if (!x.rowCount) throw new PainelNotFound('regra');
  }

  async criativosConfig(): Promise<CriativosConfig> {
    const [d, m, o, cont] = await Promise.all([
      this.pool.query(`select id, nome, ativo from mkt.cri_dor order by ativo desc, lower(nome)`),
      this.pool.query(`select id, dor_id, nome, ativo from mkt.cri_mensagem order by ativo desc, lower(nome)`),
      this.pool.query(`select id, nome, ativo from mkt.cri_modulo order by ativo desc, lower(nome)`),
      this.pool.query(`select salvo_dor_id as dor_id, salvo_mensagem_id as mensagem_id, salvo_modulo_id as modulo_id, count(*)::int as criativos, sum(leads)::int as leads from analytics.criativos_meta group by 1, 2, 3`),
    ]);
    const soma = (campo: 'dor_id' | 'mensagem_id' | 'modulo_id', id: number): { criativos: number; leads: number } =>
      (cont.rows as Row[]).filter((r) => r[campo] != null && Number(r[campo]) === id).reduce<{ criativos: number; leads: number }>((a, r) => ({ criativos: a.criativos + n0(r.criativos), leads: a.leads + n0(r.leads) }), { criativos: 0, leads: 0 });
    return {
      dores: (d.rows as Row[]).map((x) => ({
        id: Number(x.id), nome: x.nome, ativo: x.ativo, ...soma('dor_id', Number(x.id)),
        mensagens: (m.rows as Row[]).filter((y) => Number(y.dor_id) === Number(x.id)).map((y) => ({ id: Number(y.id), nome: y.nome, ativo: y.ativo, ...soma('mensagem_id', Number(y.id)) })),
      })),
      modulos: (o.rows as Row[]).map((x) => ({ id: Number(x.id), nome: x.nome, ativo: x.ativo, ...soma('modulo_id', Number(x.id)) })),
    };
  }

  async criativos() {
    const id = (v: unknown) => (v == null ? null : Number(v));
    return (
      (await this.pool.query(
        `select termo_chave, termo, leads, mql, ganhos, mrr_ganho, primeiro_lead, ultimo_lead,
                salvo_dor_id as dor_id, salvo_mensagem_id as mensagem_id, salvo_modulo_id as modulo_id, dor, mensagem, modulo
           from analytics.criativos_meta order by leads desc, termo_chave`,
      )).rows as Row[]
    ).map((r) => ({ ...r, dor_id: id(r.dor_id), mensagem_id: id(r.mensagem_id), modulo_id: id(r.modulo_id) }));
  }

  async criarCriativoItem(tipo: CriativoItem, nome: string, paiId?: number) {
    const limpo = nome.trim().replace(/\s+/g, ' ');
    if (!limpo) throw new PainelInvalido('Dê um nome.');
    try {
      if (tipo === 'mensagem') {
        if (paiId == null) throw new PainelInvalido('A Mensagem precisa de uma DOR.');
        const ok = await this.pool.query(`select 1 from mkt.cri_dor where id = $1 and ativo`, [paiId]);
        if (!ok.rowCount) throw new PainelInvalido('DOR não encontrada ou removida.');
      }
      const tabela = tipo === 'dor' ? 'mkt.cri_dor' : tipo === 'mensagem' ? 'mkt.cri_mensagem' : 'mkt.cri_modulo';
      // mesmo nome (sem diferenciar maiúsculas): se já existe ativo, é erro; se estava removido, é restaurado em vez de duplicado
      const escopo = tipo === 'mensagem' ? 'and dor_id = $2' : '';
      const ja = await this.pool.query(`select id, ativo from ${tabela} where lower(btrim(nome)) = lower($1) ${escopo}`, tipo === 'mensagem' ? [limpo, paiId] : [limpo]);
      if (ja.rowCount) {
        if (ja.rows[0].ativo) throw new PainelInvalido('Já existe um item com esse nome.');
        await this.pool.query(`update ${tabela} set ativo = true, atualizado_em = now() where id = $1`, [ja.rows[0].id]);
        return { id: Number(ja.rows[0].id), restaurado: true };
      }
      const r = tipo === 'mensagem'
        ? await this.pool.query(`insert into mkt.cri_mensagem (dor_id, nome) values ($1, $2) returning id`, [paiId, limpo])
        : await this.pool.query(`insert into ${tabela} (nome) values ($1) returning id`, [limpo]);
      return { id: Number(r.rows[0].id), restaurado: false };
    } catch (e) {
      if ((e as { code?: string }).code === '23514') throw new PainelInvalido('Nome inválido (vazio ou muito longo).');
      throw e;
    }
  }

  async atualizarCriativoItem(tipo: CriativoItem, id: number, patch: { nome?: string; ativo?: boolean }) {
    const tabela = tipo === 'dor' ? 'mkt.cri_dor' : tipo === 'mensagem' ? 'mkt.cri_mensagem' : 'mkt.cri_modulo';
    const sets: string[] = [];
    const vals: unknown[] = [id];
    if (patch.nome !== undefined) {
      const limpo = patch.nome.trim().replace(/\s+/g, ' ');
      if (!limpo) throw new PainelInvalido('Dê um nome.');
      vals.push(limpo);
      sets.push(`nome = $${vals.length}`);
    }
    if (patch.ativo !== undefined) {
      vals.push(patch.ativo);
      sets.push(`ativo = $${vals.length}`);
    }
    if (!sets.length) return;
    try {
      if (tipo === 'mensagem' && patch.ativo === true) {
        const ok = await this.pool.query(`select 1 from mkt.cri_mensagem m join mkt.cri_dor d on d.id = m.dor_id where m.id = $1 and d.ativo`, [id]);
        if (!ok.rowCount) throw new PainelInvalido('Restaure a DOR antes de restaurar a Mensagem dela.');
      }
      const r = await this.pool.query(`update ${tabela} set ${sets.join(', ')}, atualizado_em = now() where id = $1`, vals);
      if (!r.rowCount) throw new PainelNotFound(tipo === 'dor' ? 'DOR' : tipo === 'mensagem' ? 'Mensagem' : 'Módulo de interesse');
      // remover uma DOR remove também as Mensagens dela (restaurar a DOR não as traz de volta: restaure uma a uma)
      if (tipo === 'dor' && patch.ativo === false) await this.pool.query(`update mkt.cri_mensagem set ativo = false, atualizado_em = now() where dor_id = $1 and ativo`, [id]);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') throw new PainelInvalido('Já existe um item com esse nome.');
      if (code === '23514') throw new PainelInvalido('Nome inválido (vazio ou muito longo).');
      throw e;
    }
  }

  async mapearCriativos(termos: string[], patch: CriativoMapaPatch) {
    const chaves = [...new Set(termos)];
    if (!chaves.length) throw new PainelInvalido('Escolha ao menos um criativo.');
    if (!('dor_id' in patch) && !('mensagem_id' in patch) && !('modulo_id' in patch)) throw new PainelInvalido('Nada para gravar.');
    const existentes = await this.pool.query(`select termo_chave, salvo_dor_id, salvo_mensagem_id, salvo_modulo_id from analytics.criativos_meta where termo_chave = any($1::text[])`, [chaves]);
    if (existentes.rowCount !== chaves.length) throw new PainelNotFound('criativo');
    const ativo = async (tabela: string, id: number | null | undefined, rotulo: string) => {
      if (id == null) return;
      const r = await this.pool.query(`select 1 from ${tabela} where id = $1 and ativo`, [id]);
      if (!r.rowCount) throw new PainelInvalido(`${rotulo} não encontrada(o) ou removida(o).`);
    };
    await ativo('mkt.cri_dor', patch.dor_id, 'DOR');
    await ativo('mkt.cri_mensagem', patch.mensagem_id, 'Mensagem');
    await ativo('mkt.cri_modulo', patch.modulo_id, 'Módulo de interesse');
    const atuais = new Map((existentes.rows as Row[]).map((r) => [r.termo_chave as string, r]));
    const idOuNulo = (v: unknown) => (v == null ? null : Number(v));
    const dores: Array<number | null> = [], msgs: Array<number | null> = [], mods: Array<number | null> = [];
    for (const k of chaves) {
      const a = atuais.get(k)!;
      const dor = 'dor_id' in patch ? patch.dor_id ?? null : idOuNulo(a.salvo_dor_id);
      // trocar a DOR esvazia a Mensagem (ela pertence à DOR antiga), a menos que a nova Mensagem venha junto
      const msg = 'mensagem_id' in patch ? patch.mensagem_id ?? null : 'dor_id' in patch && dor !== idOuNulo(a.salvo_dor_id) ? null : idOuNulo(a.salvo_mensagem_id);
      dores.push(dor);
      msgs.push(dor == null ? null : msg);
      mods.push('modulo_id' in patch ? patch.modulo_id ?? null : idOuNulo(a.salvo_modulo_id));
    }
    try {
      const r = await this.pool.query(
        `insert into mkt.cri_mapa (termo_chave, dor_id, mensagem_id, modulo_id)
         select * from unnest($1::text[], $2::bigint[], $3::bigint[], $4::bigint[])
         on conflict (termo_chave) do update set dor_id = excluded.dor_id, mensagem_id = excluded.mensagem_id, modulo_id = excluded.modulo_id, atualizado_em = now()`,
        [chaves, dores, msgs, mods],
      );
      return { atualizados: r.rowCount ?? chaves.length };
    } catch (e) {
      if ((e as { code?: string }).code === '23503') throw new PainelInvalido('Essa Mensagem não pertence à DOR escolhida.');
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
