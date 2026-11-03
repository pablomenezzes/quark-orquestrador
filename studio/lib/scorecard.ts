/**
 * Scorecard do BI: indicadores por SEMANA (sábado a sexta) ou por MÊS, em colunas, como a planilha do marketing.
 *
 * Regras:
 *  - SÓ LEITURA, só visões de `analytics` (e as tabelas de importação da Umbler, ops.umbler_*); o navegador nunca manda SQL, só escolhe
 *    produto, visão e métricas; todo identificador é conferido contra o catálogo do banco e os valores entram como parâmetros;
 *  - leads só de fonte de Marketing (Google ADS, Meta ADS, Orgânico e Social) e Tipo do Lead Marketing, do produto escolhido;
 *  - cada número cai no período pela data do próprio evento: lead pela criação, etapa pela entrada nela (ou em etapa posterior), ganho pelo
 *    fechamento, perdido pela perda, investimento pelo dia do gasto. Por isso uma taxa de um período curto pode passar de 100%;
 *  - taxas e custos são calculados a partir das SOMAS do período (nunca média de taxas); sem base, o valor é null e a tela mostra "—".
 */
import type pg from 'pg';

type Db = Pick<pg.Pool, 'query'>;
export const PRODUTOS_SCORECARD = ['rh', 'clinic'] as const;
export type ProdutoScorecard = (typeof PRODUTOS_SCORECARD)[number];
export type VisaoPeriodo = 'semana' | 'mes';
export type Fmt = 'int' | 'pct' | 'brl' | 'brl2' | 'dec';

const TZ = `'America/Sao_Paulo'`;
export const FONTES_MARKETING = ['Marketing [Google ADS]', 'Marketing [Meta ADS]', 'Marketing [Orgânico]', 'Marketing [Social]'];
const GRUPOS_FONTE = ['meta', 'google', 'organico', 'social'] as const;
type GrupoFonte = (typeof GRUPOS_FONTE)[number];
const MEDIDAS = ['leads', 'mql', 'sql', 'agend', 'prop', 'fech', 'contr', 'ganhos', 'perdidos'] as const;
type Medida = (typeof MEDIDAS)[number];

/* ---------- períodos ---------- */
export type Periodo = { id: string; de: string; ate: string; rotulo: string; parcial: boolean };
const dia = (t: number) => new Date(t).toISOString().slice(0, 10);
const t0 = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const somaDias = (d: string, k: number) => dia(t0(d) + k * 86_400_000);
const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Hoje no fuso de São Paulo. */
export function hojeSp(agora = new Date()): string {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
  return f;
}

/** O sábado que começa a semana de `d` (semana de sábado a sexta). */
export function inicioSemana(d: string): string {
  const dow = new Date(t0(d)).getUTCDay(); // 0 = domingo ... 6 = sábado
  return somaDias(d, -((dow + 1) % 7));
}

/** Os últimos `n` períodos, do mais antigo ao atual (o atual pode estar em andamento: `parcial`). */
export function periodos(visao: VisaoPeriodo, hoje: string, n: number): Periodo[] {
  const total = Math.min(Math.max(Math.trunc(n) || 12, 1), 60);
  const out: Periodo[] = [];
  if (visao === 'semana') {
    const ini = inicioSemana(hoje);
    for (let i = total - 1; i >= 0; i--) {
      const de = somaDias(ini, -7 * i);
      const ate = somaDias(de, 6);
      out.push({ id: de, de, ate, rotulo: `${dm(de)} a ${dm(ate)}`, parcial: ate > hoje });
    }
  } else {
    const [a, m] = [Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)) - 1];
    for (let i = total - 1; i >= 0; i--) {
      const d0 = new Date(Date.UTC(a, m - i, 1));
      const de = dia(d0.getTime());
      const ate = dia(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 0));
      out.push({ id: de, de, ate, rotulo: `${MESES[d0.getUTCMonth()]}/${String(d0.getUTCFullYear()).slice(2)}`, parcial: ate > hoje });
    }
  }
  return out;
}

/* ---------- números por dia e por período ---------- */
type Num = Record<string, number>;
/** Soma `parte` em `dest`. */
const soma = (dest: Num, parte: Num) => { for (const [k, v] of Object.entries(parte)) dest[k] = (dest[k] ?? 0) + v; };
const key = (m: string, g: GrupoFonte) => `${m}_${g}`;
const n = (v: unknown) => (v == null ? 0 : Number(v));
const div = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** Quantidades de um período (somas dos dias). */
class P {
  constructor(readonly v: Num) {}
  g = (m: string, g: GrupoFonte) => this.v[key(m, g)] ?? 0;
  tot = (m: Medida) => GRUPOS_FONTE.reduce((a, g) => a + this.g(m, g), 0);
  pago = (m: Medida) => this.g(m, 'meta') + this.g(m, 'google');
  org = (m: Medida) => this.g(m, 'organico') + this.g(m, 'social');
  inv = (g: 'meta' | 'google' | 'total') => (g === 'total' ? (this.v.inv_meta ?? 0) + (this.v.inv_google ?? 0) : (this.v[`inv_${g}`] ?? 0));
  x = (k: string) => this.v[k] ?? 0;
}

export type Linha = { id: string; grupo: string; rotulo: string; fmt: Fmt; dica?: string; calc: (p: P) => number | null };
const NOMES_ETAPA = { sql: 'Qualificado [SQL]', agend: 'Agendado', prop: 'Proposta Enviada [SAL] (reunião realizada)', fech: 'Fechamento', contr: 'Contratação' };

const G = {
  inv: 'Investimento (mídia paga)',
  leads: 'Leads e mídia',
  funil: 'Funil: entradas em cada etapa no período',
  taxas: 'Taxas de conversão',
  custos: 'Custos (investimento da mídia paga ÷ itens vindos de Meta Ads e Google Ads)',
  wa: 'WhatsApp (Umbler)',
} as const;

/** Linhas padrão do scorecard, na ordem em que aparecem. */
export const LINHAS: Linha[] = [
  { id: 'inv_total', grupo: G.inv, rotulo: 'Investimento total', fmt: 'brl', calc: (p) => p.inv('total') },
  { id: 'inv_meta', grupo: G.inv, rotulo: 'Investimento Meta Ads', fmt: 'brl', calc: (p) => p.inv('meta') },
  { id: 'inv_google', grupo: G.inv, rotulo: 'Investimento Google Ads', fmt: 'brl', calc: (p) => p.inv('google') },

  { id: 'leads_total', grupo: G.leads, rotulo: 'Leads (prospects) total', fmt: 'int', calc: (p) => p.tot('leads') },
  { id: 'leads_meta', grupo: G.leads, rotulo: 'Leads Meta Ads', fmt: 'int', calc: (p) => p.g('leads', 'meta') },
  { id: 'leads_google', grupo: G.leads, rotulo: 'Leads Google Ads', fmt: 'int', calc: (p) => p.g('leads', 'google') },
  { id: 'leads_organico', grupo: G.leads, rotulo: 'Leads Orgânico', fmt: 'int', calc: (p) => p.g('leads', 'organico') },
  { id: 'leads_social', grupo: G.leads, rotulo: 'Leads Social', fmt: 'int', calc: (p) => p.g('leads', 'social') },
  { id: 'pct_pago', grupo: G.leads, rotulo: '% de leads da mídia paga', fmt: 'pct', calc: (p) => div(p.pago('leads'), p.tot('leads')) },
  { id: 'mql_total', grupo: G.leads, rotulo: 'MQL total', fmt: 'int', calc: (p) => p.tot('mql') },
  { id: 'pct_mql', grupo: G.leads, rotulo: '% MQL (sobre os leads)', fmt: 'pct', calc: (p) => div(p.tot('mql'), p.tot('leads')) },
  { id: 'cpl_pago', grupo: G.leads, rotulo: 'CPL mídia paga (Meta + Google)', fmt: 'brl2', calc: (p) => div(p.inv('total'), p.pago('leads')) },
  { id: 'cpl_meta', grupo: G.leads, rotulo: 'CPL Meta Ads', fmt: 'brl2', calc: (p) => div(p.inv('meta'), p.g('leads', 'meta')) },
  { id: 'cpl_google', grupo: G.leads, rotulo: 'CPL Google Ads', fmt: 'brl2', calc: (p) => div(p.inv('google'), p.g('leads', 'google')) },

  { id: 'sql_total', grupo: G.funil, rotulo: `SQL total (${NOMES_ETAPA.sql})`, fmt: 'int', dica: 'Negócios que entraram em Qualificado [SQL] ou numa etapa posterior no período.', calc: (p) => p.tot('sql') },
  { id: 'sql_meta', grupo: G.funil, rotulo: 'SQL Meta Ads', fmt: 'int', calc: (p) => p.g('sql', 'meta') },
  { id: 'sql_google', grupo: G.funil, rotulo: 'SQL Google Ads', fmt: 'int', calc: (p) => p.g('sql', 'google') },
  { id: 'sql_org', grupo: G.funil, rotulo: 'SQL Orgânico e Social', fmt: 'int', calc: (p) => p.org('sql') },
  { id: 'pct_sql_pago', grupo: G.funil, rotulo: '% dos SQL da mídia paga', fmt: 'pct', calc: (p) => div(p.pago('sql'), p.tot('sql')) },
  { id: 'agend_total', grupo: G.funil, rotulo: `Agendamento (${NOMES_ETAPA.agend})`, fmt: 'int', calc: (p) => p.tot('agend') },
  { id: 'prop_total', grupo: G.funil, rotulo: `Proposta (${NOMES_ETAPA.prop})`, fmt: 'int', calc: (p) => p.tot('prop') },
  { id: 'fech_total', grupo: G.funil, rotulo: 'Fechamento', fmt: 'int', calc: (p) => p.tot('fech') },
  { id: 'contr_total', grupo: G.funil, rotulo: 'Contratação', fmt: 'int', calc: (p) => p.tot('contr') },
  { id: 'ganhos', grupo: G.funil, rotulo: 'Ganhos', fmt: 'int', dica: 'Status Ganho, pela data de fechamento.', calc: (p) => p.tot('ganhos') },
  { id: 'perdidos', grupo: G.funil, rotulo: 'Perdidos', fmt: 'int', dica: 'Status Perdido, pela data da perda.', calc: (p) => p.tot('perdidos') },

  { id: 'cv_mql_sql', grupo: G.taxas, rotulo: 'MQL → SQL', fmt: 'pct', calc: (p) => div(p.tot('sql'), p.tot('mql')) },
  { id: 'cv_lead_sql_meta', grupo: G.taxas, rotulo: 'Lead → SQL, Meta Ads', fmt: 'pct', calc: (p) => div(p.g('sql', 'meta'), p.g('leads', 'meta')) },
  { id: 'cv_lead_sql_google', grupo: G.taxas, rotulo: 'Lead → SQL, Google Ads', fmt: 'pct', calc: (p) => div(p.g('sql', 'google'), p.g('leads', 'google')) },
  { id: 'cv_lead_sql_org', grupo: G.taxas, rotulo: 'Lead → SQL, Orgânico e Social', fmt: 'pct', calc: (p) => div(p.org('sql'), p.org('leads')) },
  { id: 'cv_sql_agend', grupo: G.taxas, rotulo: 'SQL → Agendamento', fmt: 'pct', calc: (p) => div(p.tot('agend'), p.tot('sql')) },
  { id: 'cv_agend_prop', grupo: G.taxas, rotulo: 'Agendamento → Proposta (reunião realizada)', fmt: 'pct', calc: (p) => div(p.tot('prop'), p.tot('agend')) },
  { id: 'cv_prop_fech', grupo: G.taxas, rotulo: 'Proposta → Fechamento', fmt: 'pct', calc: (p) => div(p.tot('fech'), p.tot('prop')) },
  { id: 'cv_fech_contr', grupo: G.taxas, rotulo: 'Fechamento → Contratação', fmt: 'pct', calc: (p) => div(p.tot('contr'), p.tot('fech')) },
  { id: 'cv_sql_ganho', grupo: G.taxas, rotulo: 'SQL → Ganho', fmt: 'pct', calc: (p) => div(p.tot('ganhos'), p.tot('sql')) },
  { id: 'taxa_ganho', grupo: G.taxas, rotulo: 'Taxa de ganho (ganhos ÷ ganhos + perdidos)', fmt: 'pct', calc: (p) => div(p.tot('ganhos'), p.tot('ganhos') + p.tot('perdidos')) },

  { id: 'custo_mql', grupo: G.custos, rotulo: 'Custo por MQL (mídia paga)', fmt: 'brl2', calc: (p) => div(p.inv('total'), p.pago('mql')) },
  { id: 'custo_sql', grupo: G.custos, rotulo: 'Custo por SQL (mídia paga)', fmt: 'brl2', calc: (p) => div(p.inv('total'), p.pago('sql')) },
  { id: 'custo_sql_meta', grupo: G.custos, rotulo: 'Custo por SQL, Meta Ads', fmt: 'brl2', calc: (p) => div(p.inv('meta'), p.g('sql', 'meta')) },
  { id: 'custo_sql_google', grupo: G.custos, rotulo: 'Custo por SQL, Google Ads', fmt: 'brl2', calc: (p) => div(p.inv('google'), p.g('sql', 'google')) },
  { id: 'custo_agend', grupo: G.custos, rotulo: 'Custo por agendamento', fmt: 'brl2', calc: (p) => div(p.inv('total'), p.pago('agend')) },
  { id: 'custo_prop', grupo: G.custos, rotulo: 'Custo por proposta (reunião realizada)', fmt: 'brl2', calc: (p) => div(p.inv('total'), p.pago('prop')) },
  { id: 'custo_fech', grupo: G.custos, rotulo: 'Custo por fechamento', fmt: 'brl2', calc: (p) => div(p.inv('total'), p.pago('fech')) },
  { id: 'custo_contr', grupo: G.custos, rotulo: 'Custo por contratação', fmt: 'brl2', calc: (p) => div(p.inv('total'), p.pago('contr')) },
  { id: 'cac_ganho', grupo: G.custos, rotulo: 'Custo por ganho (CAC de mídia)', fmt: 'brl2', calc: (p) => div(p.inv('total'), p.pago('ganhos')) },

  { id: 'wa_disparos', grupo: G.wa, rotulo: 'Disparos de template no WhatsApp', fmt: 'int', dica: 'Mensagens de template lidas nas conversas importadas da Umbler (todos os canais já importados). Não depende do produto.', calc: (p) => p.x('wa_disparos') },
];

/* ---------- consultas ---------- */
type Diario = Map<string, Num>;
function poe(d: Diario, diaStr: string, parte: Num) {
  const cur = d.get(diaStr) ?? {};
  soma(cur, parte);
  d.set(diaStr, cur);
}
const GRUPO_SQL = `case d.fonte when 'Marketing [Meta ADS]' then 'meta' when 'Marketing [Google ADS]' then 'google' when 'Marketing [Orgânico]' then 'organico' else 'social' end`;
const diaLocal = (col: string) => `to_char((${col} at time zone ${TZ}), 'YYYY-MM-DD')`;
const BASE_NEGOCIOS = `d.produto = $2 and d.fonte = any($3::text[]) and d.tipo = 'Marketing'`;
const DESDE = (col: string) => `${col} >= (($1)::date)::timestamp at time zone ${TZ}`;

export async function lerDiario(db: Db, produto: ProdutoScorecard, desde: string): Promise<{ diario: Diario; avisos: string[] }> {
  const diario: Diario = new Map();
  const avisos: string[] = [];
  const params = [desde, produto, FONTES_MARKETING];
  const [criados, ganhos, perdidos, etapas, meta, google] = await Promise.all([
    db.query(`select ${diaLocal('d.criado_em')} as dia, ${GRUPO_SQL} as g, count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql
                from analytics.negocios_bi d where ${DESDE('d.criado_em')} and ${BASE_NEGOCIOS} group by 1, 2`, params),
    db.query(`select ${diaLocal('d.fechado_em')} as dia, ${GRUPO_SQL} as g, count(*)::int as n from analytics.negocios_bi d
               where d.status = 'won' and d.fechado_em is not null and ${DESDE('d.fechado_em')} and ${BASE_NEGOCIOS} group by 1, 2`, params),
    db.query(`select ${diaLocal('d.perdido_em')} as dia, ${GRUPO_SQL} as g, count(*)::int as n from analytics.negocios_bi d
               where d.status = 'lost' and d.perdido_em is not null and ${DESDE('d.perdido_em')} and ${BASE_NEGOCIOS} group by 1, 2`, params),
    // primeira entrada em cada etapa OU EM UMA POSTERIOR (muitos negócios pulam etapas), por produto: a ordem vem de analytics.pipelines_etapas
    db.query(
      `with th as (
         select pipeline_id,
                min(etapa_ordem) filter (where etapa ilike 'Qualificado%') as k_sql, min(etapa_ordem) filter (where etapa = 'Agendado') as k_agend,
                min(etapa_ordem) filter (where etapa ilike 'Proposta%') as k_prop, min(etapa_ordem) filter (where etapa = 'Fechamento') as k_fech,
                min(etapa_ordem) filter (where etapa ilike 'Contrata%') as k_contr
           from analytics.pipelines_etapas where produto = $2 group by pipeline_id),
       base as (select d.deal_id, ${GRUPO_SQL} as g from analytics.negocios_bi d where ${BASE_NEGOCIOS}),
       reach as (
         select h.deal_id,
                min(h.entrou_em) filter (where pe.etapa_ordem >= th.k_sql) as t_sql, min(h.entrou_em) filter (where pe.etapa_ordem >= th.k_agend) as t_agend,
                min(h.entrou_em) filter (where pe.etapa_ordem >= th.k_prop) as t_prop, min(h.entrou_em) filter (where pe.etapa_ordem >= th.k_fech) as t_fech,
                min(h.entrou_em) filter (where pe.etapa_ordem >= th.k_contr) as t_contr
           from analytics.historico_etapas h
           join analytics.pipelines_etapas pe on pe.stage_id = h.stage_id
           join th on th.pipeline_id = pe.pipeline_id
          -- só negócios com alguma entrada de etapa dentro da janela (quem não se mexeu desde então não pode ter "chegado" a nada novo): evita ler o histórico inteiro
          where h.deal_id in (select deal_id from base)
            and h.deal_id in (select h2.deal_id from analytics.historico_etapas h2 where ${DESDE('h2.entrou_em')})
          group by h.deal_id)
       select ${diaLocal('v.t')} as dia, b.g, v.etapa, count(*)::int as n
         from reach r join base b on b.deal_id = r.deal_id
        cross join lateral (values ('sql', r.t_sql), ('agend', r.t_agend), ('prop', r.t_prop), ('fech', r.t_fech), ('contr', r.t_contr)) as v(etapa, t)
        where v.t is not null and ${DESDE('v.t')} group by 1, 2, 3`,
      params,
    ),
    db.query(`select dia::text as dia, sum(gasto)::float8 as gasto from analytics.meta_desempenho_dia where dia >= $1::date and produto = $2 group by 1`, [desde, produto]),
    db.query(`select dia::text as dia, sum(custo)::float8 as custo from analytics.ads_investimento_dia where dia >= $1::date and marca = $2 group by 1`, [desde, produto]),
  ]);
  for (const r of criados.rows) poe(diario, r.dia, { [key('leads', r.g)]: n(r.leads), [key('mql', r.g)]: n(r.mql) });
  for (const r of ganhos.rows) poe(diario, r.dia, { [key('ganhos', r.g)]: n(r.n) });
  for (const r of perdidos.rows) poe(diario, r.dia, { [key('perdidos', r.g)]: n(r.n) });
  for (const r of etapas.rows) poe(diario, r.dia, { [key(r.etapa, r.g)]: n(r.n) });
  for (const r of meta.rows) poe(diario, r.dia, { inv_meta: n(r.gasto) });
  for (const r of google.rows) poe(diario, r.dia, { inv_google: n(r.custo) });
  try {
    const wa = await db.query(`select dia::text as dia, count(*)::int as n from ops.umbler_mensagem where dia >= $1::date group by 1`, [desde]);
    for (const r of wa.rows) poe(diario, r.dia, { wa_disparos: n(r.n) });
  } catch {
    avisos.push('Disparos de WhatsApp indisponíveis: as tabelas da Umbler ainda não existem neste banco.');
  }
  return { diario, avisos };
}

function somaPeriodo(diario: Diario, p: Periodo, ate: string): P {
  const v: Num = {};
  const fim = p.ate < ate ? p.ate : ate;
  for (const [d, parte] of diario) if (d >= p.de && d <= fim) soma(v, parte);
  return new P(v);
}

/* ---------- métricas acrescentadas à mão ---------- */
export const AGREGACOES = ['soma', 'media', 'contagem', 'maximo'] as const;
export type Agregacao = (typeof AGREGACOES)[number];
export type MetricaColuna = { tipo: 'coluna'; id: string; rotulo: string; visao: string; colData: string; colValor: string | null; agg: Agregacao; fmt: Fmt; porProduto: boolean };
export type MetricaRazao = { tipo: 'razao'; id: string; rotulo: string; a: string; b: string; fmt: Fmt };
export type MetricaCustom = MetricaColuna | MetricaRazao;
export type ConfigScorecard = { versao: 1; metricas: MetricaCustom[] };
export class ScorecardInvalido extends Error {}

export type CatalogoVisoes = Record<string, { colunas: { nome: string; tipo: 'data' | 'numero' | 'outro' }[]; temProduto: boolean }>;
const TIPOS_DATA = new Set(['date', 'timestamp with time zone', 'timestamp without time zone']);
const TIPOS_NUM = new Set(['integer', 'bigint', 'smallint', 'numeric', 'double precision', 'real']);
/** Visões de analytics que o construtor oferece (nome, colunas e tipo). Só nomes: nenhum dado. */
export async function catalogoVisoes(db: Db): Promise<CatalogoVisoes> {
  const r = await db.query(
    `select c.table_name, c.column_name, c.data_type from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'analytics' order by c.table_name, c.ordinal_position`,
  );
  const out: CatalogoVisoes = {};
  for (const x of r.rows as { table_name: string; column_name: string; data_type: string }[]) {
    const v = (out[x.table_name] ??= { colunas: [], temProduto: false });
    v.colunas.push({ nome: x.column_name, tipo: TIPOS_DATA.has(x.data_type) ? 'data' : TIPOS_NUM.has(x.data_type) ? 'numero' : 'outro' });
    if (x.column_name === 'produto') v.temProduto = true;
  }
  return out;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'metrica';

/** Confere uma métrica nova contra o catálogo do banco e devolve a versão limpa. Nunca aceita SQL: só nomes que existem. */
export function validarMetrica(m: unknown, cat: CatalogoVisoes, existentes: MetricaCustom[]): MetricaCustom {
  const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
  const rotulo = typeof o.rotulo === 'string' ? o.rotulo.trim() : '';
  if (!rotulo || rotulo.length > 80) throw new ScorecardInvalido('Dê um nome de até 80 letras à métrica.');
  const fmt = o.fmt as Fmt;
  if (!['int', 'pct', 'brl', 'brl2', 'dec'].includes(fmt)) throw new ScorecardInvalido('Formato inválido.');
  let id = `c_${slug(rotulo)}`;
  for (let i = 2; existentes.some((x) => x.id === id) || LINHAS.some((l) => l.id === id); i++) id = `c_${slug(rotulo)}_${i}`;
  if (o.tipo === 'razao') {
    const ids = new Set([...LINHAS.map((l) => l.id), ...existentes.filter((x) => x.tipo === 'coluna').map((x) => x.id)]);
    if (typeof o.a !== 'string' || typeof o.b !== 'string' || !ids.has(o.a) || !ids.has(o.b)) throw new ScorecardInvalido('Escolha duas métricas existentes para a razão.');
    return { tipo: 'razao', id, rotulo, a: o.a, b: o.b, fmt };
  }
  if (o.tipo !== 'coluna') throw new ScorecardInvalido('Tipo de métrica inválido.');
  const visao = typeof o.visao === 'string' ? o.visao : '';
  const v = IDENT.test(visao) ? cat[visao] : undefined;
  if (!v) throw new ScorecardInvalido('Essa visão não existe no banco (só as de analytics).');
  const colData = typeof o.colData === 'string' ? o.colData : '';
  if (!v.colunas.some((c) => c.nome === colData && c.tipo === 'data')) throw new ScorecardInvalido('A coluna de data precisa existir na visão e ser uma data.');
  const agg = o.agg as Agregacao;
  if (!(AGREGACOES as readonly string[]).includes(agg)) throw new ScorecardInvalido('Agregação inválida.');
  let colValor: string | null = null;
  if (agg !== 'contagem') {
    colValor = typeof o.colValor === 'string' ? o.colValor : '';
    if (!v.colunas.some((c) => c.nome === colValor && c.tipo === 'numero')) throw new ScorecardInvalido('A coluna de valor precisa existir na visão e ser numérica.');
  }
  return { tipo: 'coluna', id, rotulo, visao, colData, colValor, agg, fmt, porProduto: v.temProduto && o.porProduto !== false };
}

type Acum = { s: number; c: number; m: number | null };
async function lerCustom(db: Db, m: MetricaColuna, produto: ProdutoScorecard, desde: string, ate: string, cat: CatalogoVisoes): Promise<Map<string, Acum>> {
  const v = cat[m.visao];
  if (!v || !IDENT.test(m.visao) || !IDENT.test(m.colData) || (m.colValor != null && !IDENT.test(m.colValor))) throw new ScorecardInvalido(`A métrica "${m.rotulo}" aponta para algo que não existe mais no banco.`);
  const col = m.colValor ? `"${m.colValor}"` : '1';
  const params: unknown[] = [desde, ate];
  let filtro = '';
  if (m.porProduto && v.temProduto) { params.push(produto); filtro = ` and produto = $3`; }
  const r = await db.query(
    `select to_char("${m.colData}"::date, 'YYYY-MM-DD') as dia, coalesce(sum(${col}), 0)::float8 as s, count(${m.colValor ? col : '*'})::float8 as c, max(${col})::float8 as m
       from analytics."${m.visao}" where "${m.colData}"::date between $1::date and $2::date${filtro} group by 1`,
    params,
  );
  return new Map((r.rows as { dia: string; s: unknown; c: unknown; m: unknown }[]).map((x) => [x.dia, { s: n(x.s), c: n(x.c), m: x.m == null ? null : Number(x.m) }]));
}
const valorCustom = (m: MetricaColuna, dias: Map<string, Acum>, p: Periodo, ate: string): number | null => {
  let s = 0, c = 0, mx: number | null = null, achou = false;
  const fim = p.ate < ate ? p.ate : ate;
  for (const [d, a] of dias) if (d >= p.de && d <= fim) { achou = true; s += a.s; c += a.c; mx = a.m == null ? mx : mx == null ? a.m : Math.max(mx, a.m); }
  if (!achou) return m.agg === 'soma' || m.agg === 'contagem' ? 0 : null;
  return m.agg === 'soma' ? s : m.agg === 'contagem' ? c : m.agg === 'media' ? div(s, c) : mx;
};

/* ---------- resultado ---------- */
export type LinhaResultado = { id: string; grupo: string; rotulo: string; fmt: Fmt; dica?: string; custom?: boolean; valores: Array<number | null> };
export type ResultadoScorecard = {
  produto: ProdutoScorecard;
  visao: VisaoPeriodo;
  periodos: Periodo[];
  linhas: LinhaResultado[];
  avisos: string[];
  geradoEm: string;
};

export async function montarScorecard(db: Db, cfg: ConfigScorecard, o: { produto: ProdutoScorecard; visao: VisaoPeriodo; n: number; hoje?: string }): Promise<ResultadoScorecard> {
  const hoje = o.hoje ?? hojeSp();
  const per = periodos(o.visao, hoje, o.n);
  const desde = per[0]!.de;
  const { diario, avisos } = await lerDiario(db, o.produto, desde);
  const somas = per.map((p) => somaPeriodo(diario, p, hoje));
  const linhas: LinhaResultado[] = LINHAS.map((l) => ({ id: l.id, grupo: l.grupo, rotulo: l.rotulo, fmt: l.fmt, ...(l.dica ? { dica: l.dica } : {}), valores: somas.map((s) => l.calc(s)) }));

  const valoresPorId = new Map(linhas.map((l) => [l.id, l.valores]));
  const colunas = cfg.metricas.filter((m): m is MetricaColuna => m.tipo === 'coluna');
  const razoes = cfg.metricas.filter((m): m is MetricaRazao => m.tipo === 'razao');
  if (colunas.length) {
    const cat = await catalogoVisoes(db);
    for (const m of colunas) {
      try {
        const dias = await lerCustom(db, m, o.produto, desde, hoje, cat);
        const valores = per.map((p) => valorCustom(m, dias, p, hoje));
        valoresPorId.set(m.id, valores);
        linhas.push({ id: m.id, grupo: 'Minhas métricas', rotulo: m.rotulo, fmt: m.fmt, custom: true, dica: `${m.agg} de ${m.colValor ?? 'linhas'} em analytics.${m.visao}`, valores });
      } catch (e) {
        avisos.push(e instanceof ScorecardInvalido ? e.message : `A métrica "${m.rotulo}" falhou ao ser lida.`);
      }
    }
  }
  for (const m of razoes) {
    const a = valoresPorId.get(m.a), b = valoresPorId.get(m.b);
    if (!a || !b) { avisos.push(`A métrica "${m.rotulo}" depende de uma métrica que não existe mais.`); continue; }
    linhas.push({ id: m.id, grupo: 'Minhas métricas', rotulo: m.rotulo, fmt: m.fmt, custom: true, dica: `${m.a} ÷ ${m.b}`, valores: a.map((x, i) => (x == null || b[i] == null ? null : div(x, b[i]!))) });
  }
  const parcial = per.at(-1)!.parcial;
  if (parcial) avisos.push(`A última coluna (${per.at(-1)!.rotulo}) está em andamento: os números dela ainda vão crescer.`);
  avisos.push('Cada número entra no período pela data do próprio evento (lead pela criação, etapa pela entrada nela, ganho pelo fechamento). Por isso uma taxa de um período curto pode passar de 100%.');
  return { produto: o.produto, visao: o.visao, periodos: per, linhas, avisos, geradoEm: new Date().toISOString() };
}

/* ---------- configuração (ops.cfg_scorecard) ---------- */
export const configVazia = (): ConfigScorecard => ({ versao: 1, metricas: [] });
export interface ScorecardRepo {
  scorecard(o: { produto: ProdutoScorecard; visao: VisaoPeriodo; n: number }): Promise<ResultadoScorecard>;
  catalogo(): Promise<{ visoes: CatalogoVisoes; padrao: { id: string; grupo: string; rotulo: string; fmt: Fmt }[]; personalizadas: MetricaCustom[] }>;
  adicionar(m: unknown): Promise<MetricaCustom>;
  remover(id: string): Promise<void>;
}
export class PgScorecardRepo implements ScorecardRepo {
  constructor(private readonly pool: Db) {}
  private async config(): Promise<ConfigScorecard> {
    let r;
    try {
      r = await this.pool.query(`select config from ops.cfg_scorecard where chave = 'principal'`);
    } catch (e) {
      if ((e as { code?: string } | null)?.code === '42P01') return configVazia(); // a tabela das métricas próprias ainda não existe: o scorecard padrão funciona
      throw e;
    }
    const c = r.rows[0]?.config as Partial<ConfigScorecard> | undefined;
    return { versao: 1, metricas: Array.isArray(c?.metricas) ? (c!.metricas as MetricaCustom[]) : [] };
  }
  private async salvar(c: ConfigScorecard): Promise<void> {
    await this.pool.query(
      `insert into ops.cfg_scorecard (chave, config, atualizado_em) values ('principal', $1::jsonb, now())
       on conflict (chave) do update set config = excluded.config, atualizado_em = now()`,
      [JSON.stringify(c)],
    );
  }
  /** Resultados guardados por 5 minutos (a leitura do histórico de etapas é a parte lenta); some ao acrescentar ou remover métrica. */
  private memo = new Map<string, { t: number; p: Promise<ResultadoScorecard> }>();
  async scorecard(o: { produto: ProdutoScorecard; visao: VisaoPeriodo; n: number }) {
    const k = `${o.produto}|${o.visao}|${o.n}|${hojeSp()}`;
    const c = this.memo.get(k);
    if (c && Date.now() - c.t < 300_000) return c.p;
    const p = this.config().then((cfg) => montarScorecard(this.pool, cfg, o));
    this.memo.set(k, { t: Date.now(), p });
    p.catch(() => this.memo.delete(k));
    return p;
  }
  async catalogo() {
    return { visoes: await catalogoVisoes(this.pool), padrao: LINHAS.map(({ id, grupo, rotulo, fmt }) => ({ id, grupo, rotulo, fmt })), personalizadas: (await this.config()).metricas };
  }
  async adicionar(m: unknown) {
    const cfg = await this.config();
    if (cfg.metricas.length >= 40) throw new ScorecardInvalido('Limite de 40 métricas próprias atingido. Remova alguma antes.');
    const nova = validarMetrica(m, await catalogoVisoes(this.pool), cfg.metricas);
    await this.salvar({ ...cfg, metricas: [...cfg.metricas, nova] });
    this.memo.clear();
    return nova;
  }
  async remover(id: string) {
    const cfg = await this.config();
    if (!cfg.metricas.some((x) => x.id === id)) throw new ScorecardInvalido('Métrica não encontrada.');
    await this.salvar({ ...cfg, metricas: cfg.metricas.filter((x) => x.id !== id && !(x.tipo === 'razao' && (x.a === id || x.b === id))) }); // some junto quem dependia dela
    this.memo.clear();
  }
}
