import type pg from 'pg';
import { ANALISES_DEBRIEFING } from './debriefing.js';

/**
 * BI do Data Hub: catálogo de análises, organizado em páginas (Visão geral, Safra, Canais, Qualidade).
 *
 * Cada análise é um bloco independente do array BI_ANALISES. Para acrescentar uma nova, basta acrescentar um bloco: o catálogo,
 * os filtros, a tela, a tabela e a exportação para CSV vêm de graça. Regras:
 *  - SÓ LEITURA, e só sobre as visões de `analytics` (nunca raw nem crm); o navegador nunca manda SQL, só escolhe a análise e os filtros;
 *  - os filtros são validados no servidor e entram no SQL sempre como parâmetros;
 *  - o período filtra a DATA DE CRIAÇÃO do negócio (fuso de São Paulo); cada análise diz o que mede;
 *  - ganho, perdido e aberto vêm do Status do negócio (D-36); MQL e "conta como lead" vêm das regras do Painel;
 *  - "inválido" = lead perdido por um motivo que a regra do Painel tira do MQL (hoje: Lead Invalido, Cliente em Busca de Suporte,
 *    Contato Inexistente, Oportunidade Duplicada); "em branco" = campo do Pipedrive não preenchido.
 */
export const BI_PRODUTOS = ['rh', 'clinic'] as const;
export type BiProduto = (typeof BI_PRODUTOS)[number];

/** Seleção inicial ("fixada") dos filtros de Fonte e Tipo do Lead, pelo NOME da opção no Pipedrive. Edite aqui para mudar o padrão. */
export const PADRAO_FONTES = ['Marketing [Google ADS]', 'Marketing [Meta ADS]', 'Marketing [Orgânico]', 'Marketing [Social]'];
export const PADRAO_TIPOS = ['Marketing'];

export const BI_PAGINAS = [
  { id: 'geral', rotulo: 'Visão geral' },
  { id: 'debriefing', rotulo: 'Debriefing semanal' },
  { id: 'safra', rotulo: 'Safra' },
  { id: 'canais', rotulo: 'Canais' },
  { id: 'ads', rotulo: 'Google Ads' },
  { id: 'meta', rotulo: 'Meta Ads' },
  { id: 'site', rotulo: 'Site e páginas' },
  { id: 'qualidade', rotulo: 'Qualidade' },
] as const;
export type BiPagina = (typeof BI_PAGINAS)[number]['id'];

/** `fontes` e `tipos`: IDs das opções do Pipedrive (texto de dígitos) e/ou 'branco' (campo não preenchido). Ausente = sem filtro. */
export type BiFiltros = { de: string; ate: string; produto?: BiProduto; pipeline_id?: number; fontes?: string[]; tipos?: string[] };

/** `brl2` = reais com centavos (custos unitários: CPL, CAC...); `dec` = número com 2 casas (ex.: ROAS). */
export type Coluna = { id: string; rotulo: string; tipo: 'texto' | 'int' | 'pct' | 'brl' | 'brl2' | 'dec' | 'dias' };
export type Tabela = { colunas: Coluna[]; linhas: Array<Record<string, string | number | null>> };
/** Comparação de um KPI com o mesmo período deslocado (30 dias antes, 1 ano antes). `valor` é o número de lá; `abs` e `pct` são nulos sem base. */
export type Comparacao = { id: 'd30' | 'a1'; rotulo: string; periodo: string; valor: number | null; abs: number | null; pct: number | null };
/** Linha de referência sobre as colunas (ex.: mês anterior, cheia; mesmo mês do ano anterior, tracejada): um valor por categoria, por série. */
export type LinhaRef = { id: 'mes_anterior' | 'ano_anterior'; nome: string; tracejada: boolean; valores: Record<string, number[]> };
export type Grafico =
  | { tipo: 'kpis'; itens: Array<{ id: string; rotulo: string; valor: number | null; formato: 'int' | 'pct' | 'brl' | 'brl2' | 'dec'; dica?: string; comp?: Comparacao[] }> }
  /** `slot`: cor fixa da série (1 a 4 = paleta categórica; 0 = neutro, para "outras"). A cor segue a entidade, nunca a posição. */
  | { tipo: 'colunas'; categorias: string[]; series: Array<{ id: string; nome: string; slot: number; valores: number[] }>; formato?: 'int' | 'pct' | 'brl'; linhas?: LinhaRef[] }
  | { tipo: 'barras'; itens: Array<{ rotulo: string; valor: number; detalhe?: string }>; formato: 'int' | 'dias' | 'pct' | 'brl' | 'brl2'; ordinal?: boolean }
  /** Mapa de calor. `escala`: a cor é relativa ao maior valor de cada coluna ('coluna'), de cada linha ('linha') ou da matriz toda ('global', padrão). */
  | { tipo: 'matriz'; colunas: string[]; linhas: Array<{ rotulo: string; valores: Array<number | null>; detalhe?: string }>; formato: 'pct'; escala?: 'coluna' | 'linha' | 'global' }
  /**
   * Funis lado a lado: uma coluna por fonte (ou "Total"), as mesmas etapas em todas. `valores[i]` = negócios que chegaram na etapa i;
   * `passos[i]` = dos que chegaram na etapa i-1, que parte chegou na i (nunca passa de 100%; null onde não há base).
   */
  | { tipo: 'funis'; etapas: string[]; colunas: Array<{ id: string; nome: string; slot: number; total?: boolean; leads: number; valores: number[]; passos: Array<number | null> }> }
  /**
   * Série no tempo, um ponto por dia com os COMPONENTES (gasto, impressões, cliques no link, visitas, leads): o navegador soma por dia, semana,
   * mês ou trimestre e calcula CPL, CPM, CPC e CTR a partir das somas (nunca média de taxas).
   */
  | { tipo: 'serie'; pontos: Array<{ dia: string; gasto: number; impressoes: number; cliques_link: number; visitas: number; leads_meta: number; leads: number }> }
  | { tipo: 'tabela' };
export type BiResultado = { grafico: Grafico; tabela: Tabela; avisos: string[] };

export type BiAnalise = {
  id: string;
  pagina: BiPagina;
  titulo: string;
  /** A pergunta de negócio que a análise responde, em uma frase. */
  pergunta: string;
  /** Como ler/o que mede (aparece em "Como ler"). */
  como_ler: string;
  largura: 'cheia' | 'meia';
  rodar(db: Pick<pg.Pool, 'query'>, f: BiFiltros): Promise<BiResultado>;
};

type Db = Pick<pg.Pool, 'query'>;
type Row = Record<string, any>;
const TZ = `'America/Sao_Paulo'`;
/** Valores que dizem "não sei": "Desconhecido"/"Unknown" no Canal de origem RD; no UTM Source, modelos de link não preenchidos ({{...}}), undefined, unknown, null. */
const CANAL_DESCONHECIDO = `'(desconhec|unknown)'`;
const UTM_INVALIDO = `'^(\\{\\{.*\\}\\}|undefined|unknown|null)$'`;

/** Nome da fonte; opção que o Pipedrive não oferece mais aparece pelo ID; em branco = "(sem fonte)". */
const FONTE = `coalesce(d.fonte, d.fonte_id, '(sem fonte)')`;

/** `(col = any($n) or col is null)` conforme a lista tenha IDs e/ou 'branco'. */
function listaSql(col: string, vals: string[], params: unknown[]): string {
  const ids = vals.filter((v) => v !== 'branco');
  const partes: string[] = [];
  if (ids.length) {
    params.push(ids);
    partes.push(`${col} = any($${params.length}::text[])`);
  }
  if (vals.includes('branco')) partes.push(`${col} is null`);
  return `(${partes.join(' or ')})`;
}

/** Cláusulas de filtro para a visão analytics.negocios_bi (alias `a`; também serve o alias `d`). Empurra os parâmetros. */
function filtroSql(f: BiFiltros, a: string, params: unknown[]): string[] {
  params.push(f.de, f.ate);
  const out = [
    `${a}.criado_em >= (($${params.length - 1})::date)::timestamp at time zone ${TZ}`,
    `${a}.criado_em < (($${params.length})::date + 1)::timestamp at time zone ${TZ}`,
  ];
  if (f.produto) {
    params.push(f.produto);
    out.push(`${a}.produto = $${params.length}`);
  }
  if (f.pipeline_id != null) {
    params.push(f.pipeline_id);
    out.push(`${a}.pipeline_id = $${params.length}`);
  }
  if (f.fontes?.length) out.push(listaSql(`${a}.fonte_id`, f.fontes, params));
  if (f.tipos?.length) out.push(listaSql(`${a}.tipo_id`, f.tipos, params));
  return out;
}

const n = (v: unknown): number => (v == null ? 0 : Number(v));
const razao = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const c = (id: string, rotulo: string, tipo: Coluna['tipo'] = 'texto'): Coluna => ({ id, rotulo, tipo });
const q = async (db: Db, sql: string, params: unknown[]): Promise<Row[]> => (await db.query(sql, params)).rows;

/** Avisa quando o histórico de etapas de algum ano do período ainda não foi todo lido (os marcos ficam incompletos). */
async function avisoHistorico(db: Db, f: BiFiltros): Promise<string[]> {
  const r = await q(db, `select ano_criacao, pendentes from analytics.historico_progresso where ano_criacao between $1::int and $2::int and pendentes > 0 order by ano_criacao`, [Number(f.de.slice(0, 4)), Number(f.ate.slice(0, 4))]);
  return r.map((x) => `Histórico de etapas de ${x.ano_criacao}: ${x.pendentes} negócios ainda sem leitura; o que depende de etapas (chegou em…, tempo por etapa) está incompleto para eles.`);
}

/**
 * Subconsulta dos marcos para os negócios da CTE `b`. "Chegou em X" significa "chegou em X OU EM UMA ETAPA POSTERIOR": muitos negócios
 * pulam etapas (vão de Qualificação direto para Agendado), e quem chegou em Reunião Agendada ou proposta passou, na prática, pelo SQL.
 * Assim o funil só diminui e as taxas de passo fazem sentido. Ordem dos marcos: sql < Reunião Agendada < proposta.
 */
const MARCOS_CTE = `m as (select deal_id, bool_or(marco in ('sql', 'reuniao', 'proposta')) as sql, bool_or(marco in ('reuniao', 'proposta')) as reuniao, bool_or(marco = 'proposta') as proposta
                          from analytics.negocios_marcos where deal_id in (select deal_id from b) group by deal_id)`;
const SEM_MARCOS = 'Nenhuma etapa foi marcada como SQL, Reunião Agendada ou proposta (ou ainda não há histórico lido): marque as etapas na aba Configuração do Painel de Dados.';

/** Linhas por safra (mês de criação): base das análises de safra. */
async function safras(db: Db, f: BiFiltros, soFonte?: string) {
  const p: unknown[] = [];
  const w = filtroSql(soFonte ? { ...f, fontes: undefined } : f, 'd', p);
  if (soFonte) {
    p.push(soFonte);
    w.push(`${FONTE} = $${p.length}`); // a página do Google Ads ignora o filtro de Fonte: é sempre a fonte do anúncio
  }
  return q(
    db,
    `with b as (select d.deal_id, to_char(date_trunc('month', d.criado_em at time zone ${TZ}), 'YYYY-MM') as safra, d.conta_como_lead, d.is_mql, d.status, d.valor, d.criado_em, d.fechado_em
                  from analytics.negocios_bi d where ${w.join(' and ')}),
          ${MARCOS_CTE}
     select b.safra,
            count(*) filter (where b.conta_como_lead)::int as leads, count(*) filter (where b.is_mql)::int as mql,
            count(*) filter (where m.sql)::int as sql, count(*) filter (where m.reuniao)::int as reuniao, count(*) filter (where m.proposta)::int as proposta,
            count(*) filter (where b.status = 'won')::int as ganhos, count(*) filter (where b.status = 'lost')::int as perdidos, count(*) filter (where b.status = 'open')::int as abertos,
            ${MRR_SQL('b')},
            (percentile_cont(0.5) within group (order by extract(epoch from b.fechado_em - b.criado_em) / 86400.0) filter (where b.status = 'won' and b.fechado_em is not null))::float8 as ciclo_dias
       from b left join m on m.deal_id = b.deal_id group by 1 order by 1`,
    p,
  );
}

/** Cor fixa por fonte (a cor segue a entidade, nunca a posição): Google ADS 1, Meta ADS 2, Orgânico 3, Social 4; demais 0 (neutro). */
const SLOT_FONTE: Record<string, number> = { 'Marketing [Google ADS]': 1, 'Marketing [Meta ADS]': 2, 'Marketing [Orgânico]': 3, 'Marketing [Social]': 4 };
const slotDe = (fonte: string) => SLOT_FONTE[fonte] ?? 0;
const ETAPAS_FUNIL = ['Leads', 'MQL', 'Chegou em SQL', 'Chegou em Reunião Agendada', 'Chegou em proposta', 'Ganhos'];
const PASSOS = ['Lead → MQL', 'MQL → SQL', 'SQL → Reunião Agendada', 'Reunião Agendada → proposta', 'Proposta → ganho'];

/**
 * Funil completo por fonte. Cada negócio que conta como lead tem 6 marcas (lead, MQL, chegou em SQL, Reunião Agendada, proposta, ganho).
 * Os passos são CONDICIONAIS ("dos que chegaram em A, quantos chegaram em B"), por isso nunca passam de 100%, mesmo quando um ganho
 * foi dado antes de alguma etapa (o ganho vem do Status, não da etapa).
 */
async function funisPorFonte(db: Db, f: BiFiltros, maxFontes = 6, soFonte?: string) {
  const p: unknown[] = [];
  const w = filtroSql(soFonte ? { ...f, fontes: undefined } : f, 'd', p);
  if (soFonte) {
    p.push(soFonte);
    w.push(`${FONTE} = $${p.length}`);
  }
  const rows = await q(
    db,
    `with b as (select d.deal_id, ${FONTE} as fonte, d.fonte_id, d.is_mql, d.status from analytics.negocios_bi d where d.conta_como_lead and ${w.join(' and ')}), ${MARCOS_CTE},
          x as (select b.fonte, b.fonte_id, b.is_mql as mql, coalesce(m.sql, false) as sql, coalesce(m.reuniao, false) as reuniao, coalesce(m.proposta, false) as proposta, (b.status = 'won') as ganho
                  from b left join m on m.deal_id = b.deal_id)
     select grouping(x.fonte) as e_total, x.fonte, x.fonte_id, count(*)::int as leads,
            count(*) filter (where mql)::int as mql, count(*) filter (where sql)::int as sql, count(*) filter (where reuniao)::int as reuniao,
            count(*) filter (where proposta)::int as proposta, count(*) filter (where ganho)::int as ganho,
            count(*) filter (where mql and sql)::int as mql_sql, count(*) filter (where sql and reuniao)::int as sql_reuniao,
            count(*) filter (where reuniao and proposta)::int as reuniao_proposta, count(*) filter (where proposta and ganho)::int as proposta_ganho
       from x group by grouping sets ((x.fonte, x.fonte_id), ()) order by e_total, leads desc`,
    p,
  );
  const coluna = (r: Row, total: boolean) => ({
    id: total ? 'total' : String(r.fonte_id ?? 'branco'),
    nome: total ? 'Total das fontes do filtro' : (r.fonte as string),
    slot: total ? 0 : slotDe(r.fonte),
    total,
    leads: n(r.leads),
    valores: [n(r.leads), n(r.mql), n(r.sql), n(r.reuniao), n(r.proposta), n(r.ganho)],
    passos: [null, razao(n(r.mql), n(r.leads)), razao(n(r.mql_sql), n(r.mql)), razao(n(r.sql_reuniao), n(r.sql)), razao(n(r.reuniao_proposta), n(r.reuniao)), razao(n(r.proposta_ganho), n(r.proposta))] as Array<number | null>,
  });
  const fontes = rows.filter((r) => n(r.e_total) === 0).slice(0, maxFontes).map((r) => coluna(r, false));
  const total = rows.find((r) => n(r.e_total) === 1);
  // sem nenhum lead no filtro o agrupamento ainda devolve uma linha de total zerada: nesse caso não há funil para mostrar
  const colunas = total && n(total.leads) > 0 ? [...fontes, coluna(total, true)] : [];
  const mostradas = rows.filter((r) => n(r.e_total) === 0).length;
  const avisos = await avisoHistorico(db, f);
  if (colunas.length && colunas.every((x) => x.valores[2]! + x.valores[3]! + x.valores[4]! === 0)) avisos.unshift(SEM_MARCOS);
  if (mostradas > maxFontes) avisos.push(`Mostra as ${maxFontes} fontes com mais leads (de ${mostradas}); o total considera todas.`);
  return { colunas, avisos };
}

/* ---------- Site (Google Analytics) ---------- */
const nDias = (f: BiFiltros) => Math.round((Date.parse(f.ate) - Date.parse(f.de)) / 86_400_000) + 1;
const somaDias = (d: string, k: number) => new Date(Date.parse(d) + k * 86_400_000).toISOString().slice(0, 10);
const AVISO_SEM_GA4 = 'Não há dados do Google Analytics neste período (a sincronização do GA4 traz de 2025-01-01 até ontem).';
const NOTA_SITE = 'O tráfego do site NÃO muda com os filtros de fonte, tipo nem produto (o Google Analytics não conhece o Pipedrive): vale só o período.';
/** Domínio + caminho; o GA4 às vezes devolve "www.", o Pipedrive não: os dois lados perdem o "www." para casar. */
const HOST_GA4 = `regexp_replace(lower(s.host), '^www[.]', '')`;
const paginaRotulo = (host: string, caminho: string) => (host ? `${host}${caminho === '/' ? '' : caminho}` : caminho);
const fmtInt = (v: number) => new Intl.NumberFormat('pt-BR').format(Math.round(v));
const variacao = (a: number, b: number): number | null => (b > 0 ? a / b - 1 : null);

/**
 * KPIs de MRR, SEMPRE presentes (pedido do Pablo, 2026-10-09). MRR = o `valor` do negócio no Pipedrive: o campo MRR nativo do Pipedrive
 * está zerado em todos os negócios e o time guarda a mensalidade em "Valor" (preços como 99,9, 199,9, 285). Moeda: BRL.
 *  - MRR criado  = soma do valor dos negócios criados no período que contam como lead (qualquer status);
 *  - MRR ganho   = status ganho; MRR perdido = status perdido; MRR em aberto = status aberto (pelo Status do negócio, D-36);
 *  - Ticket médio ganho = MRR ganho ÷ ganhos.
 * `a` é o alias da visão/CTE com as colunas valor, status e conta_como_lead.
 */
const MRR_SQL = (a: string) => `coalesce(sum(${a}.valor) filter (where ${a}.conta_como_lead), 0)::float8 as mrr_criado,
                coalesce(sum(${a}.valor) filter (where ${a}.status = 'won'), 0)::float8 as mrr_ganho,
                coalesce(sum(${a}.valor) filter (where ${a}.status = 'lost'), 0)::float8 as mrr_perdido,
                coalesce(sum(${a}.valor) filter (where ${a}.status = 'open'), 0)::float8 as mrr_aberto`;
const ticketMedio = (r: Row) => razao(n(r.mrr_ganho), n(r.ganhos));
const MRR_DICAS = {
  criado: 'Soma do valor (MRR) dos negócios criados no período que contam como lead',
  ganho: 'Soma do valor dos negócios com status ganho',
  perdido: 'Soma do valor dos negócios com status perdido',
  aberto: 'Soma do valor dos negócios ainda em aberto',
  ticket: 'MRR ganho ÷ número de ganhos',
};
const mrrKpis = (r: Row) => [
  { id: 'mrr_criado', rotulo: 'MRR criado', valor: n(r.mrr_criado), formato: 'brl' as const, dica: MRR_DICAS.criado },
  { id: 'valor_ganho', rotulo: 'MRR ganho', valor: n(r.mrr_ganho), formato: 'brl' as const, dica: MRR_DICAS.ganho },
  { id: 'mrr_perdido', rotulo: 'MRR perdido', valor: n(r.mrr_perdido), formato: 'brl' as const, dica: MRR_DICAS.perdido },
  { id: 'mrr_aberto', rotulo: 'MRR em aberto', valor: n(r.mrr_aberto), formato: 'brl' as const, dica: MRR_DICAS.aberto },
  { id: 'ticket_ganho', rotulo: 'Ticket médio ganho', valor: ticketMedio(r), formato: 'brl' as const, dica: MRR_DICAS.ticket },
];
/** Colunas de tabela com o MRR (o id `valor` continua sendo o MRR ganho). */
const colunasMrr = (): Coluna[] => [c('mrr_criado', 'MRR criado', 'brl'), c('valor', 'MRR ganho', 'brl'), c('mrr_perdido', 'MRR perdido', 'brl'), c('mrr_aberto', 'MRR em aberto', 'brl'), c('ticket', 'Ticket médio ganho', 'brl')];
const celulasMrr = (r: Row) => ({ mrr_criado: n(r.mrr_criado), valor: n(r.mrr_ganho), mrr_perdido: n(r.mrr_perdido), mrr_aberto: n(r.mrr_aberto), ticket: ticketMedio(r) });
/** Resumo de MRR do filtro inteiro (tiles no topo das páginas Safra e Canais). */
async function resumoMrr(db: Db, f: BiFiltros, avisos: string[] = []): Promise<BiResultado> {
  const p: unknown[] = [];
  const w = filtroSql(f, 'd', p);
  const r = (
    await q(
      db,
      `select count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.status = 'won')::int as ganhos, ${MRR_SQL('d')}
         from analytics.negocios_bi d where ${w.join(' and ')}`,
      p,
    )
  )[0]!;
  const itens = [{ id: 'leads', rotulo: 'Leads', valor: n(r.leads), formato: 'int' as const, dica: 'Negócios que contam como lead' }, ...mrrKpis(r), { id: 'ganhos', rotulo: 'Ganhos', valor: n(r.ganhos), formato: 'int' as const, dica: 'Status ganho' }];
  return {
    grafico: { tipo: 'kpis', itens },
    tabela: { colunas: [c('indicador', 'Indicador'), c('valor', 'Valor')], linhas: itens.map((i) => ({ indicador: i.rotulo, valor: i.valor == null ? '—' : i.formato === 'brl' ? `R$ ${i.valor.toFixed(2)}` : String(i.valor) })) },
    avisos,
  };
}

/* ---------- Google Ads ---------- */
const FONTE_GOOGLE_ADS = 'Marketing [Google ADS]';
const AVISO_SEM_CUSTO = 'Não há custo do Google Ads neste período (a sincronização do GA4 traz de 2025-01-01 até ontem).';
const NOTA_ADS =
  'Investimento = custo do Google Ads dos dias do período (hoje vem do que o GA4 importa da conta de anúncios vinculada; quando a API do Google Ads entrar, ela passa a valer nos dias em que tiver dados). Leads e funil = negócios CRIADOS no período com Fonte do Lead "Marketing [Google ADS]": o filtro de Fonte não vale nesta página; tipo, produto e pipeline valem, mas o custo é da conta toda. Custo por etapa = investimento ÷ negócios que chegaram na etapa. Os leads de um mês nem sempre ganham no mesmo mês: compare meses de idade parecida. ROAS = MRR ganho ÷ investimento.';
type Custo = { custo: number; cliques: number; impressoes: number };
const somaCustos = (a: Custo, b: Custo): Custo => ({ custo: a.custo + b.custo, cliques: a.cliques + b.cliques, impressoes: a.impressoes + b.impressoes });

/** Custo do Google Ads no período, por mês de calendário e no total. */
async function custoAds(db: Db, f: BiFiltros): Promise<{ total: Custo; meses: Map<string, Custo>; origens: string[] }> {
  const rows = await q(
    db,
    `select to_char(dia, 'YYYY-MM') as mes, sum(custo)::float8 as custo, sum(cliques)::float8 as cliques, sum(impressoes)::float8 as impressoes, array_agg(distinct origem) as origens
       from analytics.ads_investimento_dia where dia between $1::date and $2::date group by 1 order by 1`,
    [f.de, f.ate],
  );
  const meses = new Map<string, Custo>(rows.map((r) => [r.mes as string, { custo: n(r.custo), cliques: n(r.cliques), impressoes: n(r.impressoes) }]));
  const total = [...meses.values()].reduce(somaCustos, { custo: 0, cliques: 0, impressoes: 0 });
  return { total, meses, origens: [...new Set(rows.flatMap((r) => r.origens as string[]))] };
}
const SOMA_FUNIL = ['leads', 'mql', 'sql', 'reuniao', 'proposta', 'ganhos', 'perdidos', 'abertos', 'mrr_criado', 'mrr_ganho', 'mrr_perdido', 'mrr_aberto'] as const;
const somarFunil = (rows: Row[]): Row => Object.fromEntries(SOMA_FUNIL.map((k) => [k, rows.reduce((s, r) => s + n(r[k]), 0)]));
/** Custo por etapa: investimento ÷ negócios que chegaram na etapa (null se ninguém chegou). */
const custosEtapa = (inv: number, r: Row) => {
  // sem investimento (mês sem gasto, ou linha que não tem gasto próprio, como "negócios sem ligação") não existe custo: fica em branco, nunca R$ 0,00
  const g = inv > 0 ? inv : null;
  const cus = (v: unknown) => (g == null ? null : razao(g, n(v)));
  return { cpl: cus(r.leads), c_mql: cus(r.mql), c_sql: cus(r.sql), c_reuniao: cus(r.reuniao), c_proposta: cus(r.proposta), cac: cus(r.ganhos), roas: g == null ? null : razao(n(r.mrr_ganho), g) };
};
const COL_CUSTOS: Coluna[] = [
  c('cpl', 'Custo por lead', 'brl2'), c('c_mql', 'Custo por MQL', 'brl2'), c('c_sql', 'Custo por SQL', 'brl2'), c('c_reuniao', 'Custo por Reunião Agendada', 'brl2'),
  c('c_proposta', 'Custo por proposta', 'brl2'), c('cac', 'Custo por ganho (CAC)', 'brl2'), c('roas', 'ROAS (MRR ganho ÷ investimento)', 'dec'),
];

/* ---------- Visão geral: comparações com o mesmo período deslocado ---------- */
/** Mesmo dia no ano anterior (29/02 vira 28/02 em ano não bissexto). */
function mesmoDiaAnoAnterior(d: string): string {
  const [y, m, dia] = d.split('-').map(Number) as [number, number, number];
  const ultimo = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(dia, ultimo)).padStart(2, '0')}`;
}
async function totaisGeral(db: Db, f: BiFiltros): Promise<Row> {
  const p: unknown[] = [];
  const w = filtroSql(f, 'd', p);
  return (
    await q(
      db,
      `select count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql,
              count(*) filter (where d.status = 'won')::int as ganhos, count(*) filter (where d.status = 'lost')::int as perdidos, count(*) filter (where d.status = 'open')::int as abertos,
              ${MRR_SQL('d')}
         from analytics.negocios_bi d where ${w.join(' and ')}`,
      p,
    )
  )[0]!;
}
type KpiGeral = { id: string; rotulo: string; valor: number | null; formato: 'int' | 'pct' | 'brl'; dica?: string; comp?: Comparacao[] };
const kpisGeral = (r: Row): KpiGeral[] => {
  const leads = n(r.leads), mql = n(r.mql), ganhos = n(r.ganhos), perdidos = n(r.perdidos), abertos = n(r.abertos);
  return [
    { id: 'leads', rotulo: 'Leads', valor: leads, formato: 'int', dica: 'Negócios que contam como lead' },
    { id: 'mql', rotulo: 'MQL', valor: mql, formato: 'int', dica: 'Contam como lead e não foram perdidos por motivo que tira do MQL' },
    { id: 'pct_mql', rotulo: '% MQL', valor: razao(mql, leads), formato: 'pct', dica: 'MQL ÷ leads' },
    { id: 'ganhos', rotulo: 'Ganhos', valor: ganhos, formato: 'int', dica: 'Status ganho' },
    { id: 'taxa_ganho', rotulo: 'Taxa de ganho', valor: razao(ganhos, ganhos + perdidos), formato: 'pct', dica: 'Ganhos ÷ (ganhos + perdidos)' },
    { id: 'abertos', rotulo: 'Em aberto', valor: abertos, formato: 'int' },
    { id: 'perdidos', rotulo: 'Perdidos', valor: perdidos, formato: 'int' },
    ...mrrKpis(r),
  ];
};
/** `valor` = o número do período comparado; `abs` = atual − anterior (em p.p. nas taxas); `pct` = variação relativa. */
function comparar(id: 'd30' | 'a1', rotulo: string, fp: BiFiltros, atual: number | null, anterior: number | null): Comparacao {
  const ok = atual != null && anterior != null;
  return { id, rotulo, periodo: `${fp.de} a ${fp.ate}`, valor: anterior, abs: ok ? atual - anterior : null, pct: ok && anterior !== 0 ? atual / anterior - 1 : null };
}

/* ---------- Meta Ads ---------- */
const FONTE_META_ADS = 'Marketing [Meta ADS]';
const AVISO_SEM_META = 'Não há dados da Meta neste período (a sincronização da Meta traz de 2025-01-01 até ontem).';
const NOTA_META =
  'Investimento e métricas = o que a Meta informa por anúncio e dia (contas QuarkRH e QuarkClinic; o filtro de Produto escolhe a conta). Leads e funil = negócios CRIADOS no período com Fonte do Lead "Marketing [Meta ADS]", ligados ao anúncio, conjunto e campanha pela tabela de ligação (1º o Meta Ad_id; depois campanha + nome; depois só o nome; nome repetido fica ambíguo e não é somado a nenhum anúncio): o filtro de Fonte não vale nesta página. Custo por etapa = investimento ÷ negócios que chegaram na etapa. Fórmulas: CPM = gasto ÷ impressões × 1000; CPC e CTR são dos cliques NO LINK; Connect Rate = visitas à página ÷ cliques no link (exige o Pixel); Hook rate = visualizações de 3 s ÷ impressões dos anúncios com vídeo; Hold rate = ThruPlays ÷ visualizações de 3 s; retenção = quem chegou a 25/50/75/95/100% ÷ reproduções do vídeo. Taxas se calculam das somas (nunca média de taxas).';
/** Soma das métricas da Meta (alias da visão analytics.meta_desempenho_dia); as taxas saem disso, em taxasMeta. */
const METRICAS_META = (a: string) => `sum(${a}.gasto)::float8 as gasto, sum(${a}.impressoes)::float8 as impressoes, sum(${a}.cliques_link)::float8 as cliques_link,
       sum(${a}.visitas_pagina)::float8 as visitas, sum(${a}.leads_meta)::float8 as leads_meta, sum(${a}.video_reproducoes)::float8 as vplays, sum(${a}.video_3s)::float8 as v3s,
       sum(${a}.video_p25)::float8 as p25, sum(${a}.video_p50)::float8 as p50, sum(${a}.video_p75)::float8 as p75, sum(${a}.video_p95)::float8 as p95, sum(${a}.video_p100)::float8 as p100,
       sum(${a}.video_thruplay)::float8 as thru, coalesce(sum(${a}.impressoes) filter (where ${a}.video_reproducoes > 0 or ${a}.video_3s > 0), 0)::float8 as impr_video,
       coalesce(sum(${a}.video_tempo_medio * ${a}.video_reproducoes), 0)::float8 as tempo_pond`;
const taxasMeta = (r: Row) => ({
  cpm: r.impressoes > 0 ? (n(r.gasto) / n(r.impressoes)) * 1000 : null, cpc: razao(n(r.gasto), n(r.cliques_link)), ctr: razao(n(r.cliques_link), n(r.impressoes)),
  connect: razao(n(r.visitas), n(r.cliques_link)), hook: razao(n(r.v3s), n(r.impr_video)), hold: razao(n(r.thru), n(r.v3s)),
  ret25: razao(n(r.p25), n(r.vplays)), ret50: razao(n(r.p50), n(r.vplays)), ret75: razao(n(r.p75), n(r.vplays)), ret95: razao(n(r.p95), n(r.vplays)), ret100: razao(n(r.p100), n(r.vplays)),
  tempo: razao(n(r.tempo_pond), n(r.vplays)),
});
const COL_TAXAS_META: Coluna[] = [c('cpm', 'CPM', 'brl2'), c('cpc', 'CPC (link)', 'brl2'), c('ctr', 'CTR (link)', 'pct'), c('connect', 'Connect Rate', 'pct'), c('hook', 'Hook rate', 'pct'), c('hold', 'Hold rate', 'pct')];
const COL_FUNIL_META: Coluna[] = [c('leads', 'Leads (Pipedrive)', 'int'), c('mql', 'MQL', 'int'), c('sql', 'Chegou em SQL', 'int'), c('reuniao', 'Chegou em Reunião Agendada', 'int'), c('proposta', 'Chegou em proposta', 'int'), c('ganhos', 'Ganhos', 'int')];
const celulasFunilMeta = (r: Row) => ({ leads: n(r.leads), mql: n(r.mql), sql: n(r.sql), reuniao: n(r.reuniao), proposta: n(r.proposta), ganhos: n(r.ganhos) });
const FUNIL_VAZIO: Row = Object.fromEntries(['leads', 'mql', 'sql', 'reuniao', 'proposta', 'ganhos', 'perdidos', 'abertos', 'mrr_criado', 'mrr_ganho', 'mrr_perdido', 'mrr_aberto'].map((k) => [k, 0]));
/** Filtros dos NEGÓCIOS da Meta (alias d): os da página, menos o de Fonte, que aqui é sempre "Marketing [Meta ADS]". */
function filtroMeta(f: BiFiltros, p: unknown[]): string[] {
  const w = filtroSql({ ...f, fontes: undefined }, 'd', p);
  p.push(FONTE_META_ADS);
  w.push(`${FONTE} = $${p.length}`);
  return w;
}
/** Filtros do GASTO (alias m, a visão meta_desempenho_dia): o período e, se houver, o produto (= a conta). */
function filtroGasto(f: BiFiltros, p: unknown[]): string[] {
  p.push(f.de, f.ate);
  const w = [`m.dia between $${p.length - 1}::date and $${p.length}::date`];
  if (f.produto) {
    p.push(f.produto);
    w.push(`m.produto = $${p.length}`);
  }
  return w;
}
/** Funil e MRR dos negócios da Meta agrupados por uma chave (texto) tirada da ligação ou do criativo. `chave` usa o alias n. */
async function funilPorChave(db: Db, f: BiFiltros, chave: string, origem = 'analytics.negocios_meta'): Promise<Map<string | null, Row>> {
  const p: unknown[] = [];
  const w = filtroMeta(f, p);
  const rows = await q(
    db,
    `with b as (select d.deal_id, (${chave})::text as chave, d.conta_como_lead, d.is_mql, d.status, d.valor
                  from analytics.negocios_bi d join ${origem} n on n.deal_id = d.deal_id where ${w.join(' and ')}), ${MARCOS_CTE}
     select b.chave, count(*) filter (where b.conta_como_lead)::int as leads, count(*) filter (where b.is_mql)::int as mql, count(*) filter (where m.sql)::int as sql,
            count(*) filter (where m.reuniao)::int as reuniao, count(*) filter (where m.proposta)::int as proposta, count(*) filter (where b.status = 'won')::int as ganhos,
            count(*) filter (where b.status = 'lost')::int as perdidos, count(*) filter (where b.status = 'open')::int as abertos, ${MRR_SQL('b')}
       from b left join m on m.deal_id = b.deal_id group by 1`,
    p,
  );
  return new Map(rows.map((r) => [r.chave as string | null, r]));
}
const somaFunil = (rows: Iterable<Row>): Row => somarFunil([...rows]);
async function totalGastoMeta(db: Db, f: BiFiltros): Promise<Row> {
  const p: unknown[] = [];
  const w = filtroGasto(f, p);
  return (await q(db, `select ${METRICAS_META('m')} from analytics.meta_desempenho_dia m where ${w.join(' and ')}`, p))[0] ?? {};
}

const NIVEIS_META = {
  campanha: { id: 'campanha_id', nome: 'campanha', rotulo: 'Campanha', deal: 'n.campanha_id', ctx: [] as string[] },
  conjunto: { id: 'conjunto_id', nome: 'conjunto', rotulo: 'Conjunto de anúncios', deal: 'n.conjunto_id', ctx: ['campanha'] },
  anuncio: { id: 'anuncio_id', nome: 'anuncio', rotulo: 'Anúncio (criativo)', deal: 'n.anuncio_id', ctx: ['conjunto', 'campanha'] },
} as const;
type NivelMeta = keyof typeof NIVEIS_META;
/** Uma linha por campanha, conjunto ou anúncio: investimento e métricas da Meta + o funil e o MRR dos negócios ligados a ele. */
async function metaPorNivel(db: Db, f: BiFiltros, nivel: NivelMeta, limite: number): Promise<{ colunas: Coluna[]; linhas: Array<Record<string, string | number | null>>; barras: Array<{ rotulo: string; valor: number; detalhe: string }>; avisos: string[] }> {
  const N = NIVEIS_META[nivel];
  const p: unknown[] = [];
  const w = filtroGasto(f, p);
  p.push(limite);
  const ctxSql = N.ctx.map((x) => `max(m.${x}) as ${x}`).join(', ');
  const spend = await q(
    db,
    `select m.${N.id}::text as chave, max(m.${N.nome}) as nome${ctxSql ? `, ${ctxSql}` : ''}, ${METRICAS_META('m')}
       from analytics.meta_desempenho_dia m where ${w.join(' and ')} and m.${N.id} is not null group by m.${N.id} order by sum(m.gasto) desc, 1 limit $${p.length}`,
    p,
  );
  const [funil, tot] = await Promise.all([funilPorChave(db, f, N.deal), totalGastoMeta(db, f)]);
  const usadas = new Set(spend.map((r) => r.chave as string));
  const linha = (nome: string, id: string | null, ctx: Record<string, string | null>, m: Row, fn: Row) => ({
    nome, id, ...ctx, gasto: n(m.gasto), impressoes: n(m.impressoes), cliques_link: n(m.cliques_link), ...taxasMeta(m), leads_meta: n(m.leads_meta),
    ...celulasFunilMeta(fn), ...custosEtapa(n(m.gasto), { ...fn }), ...celulasMrr(fn),
  });
  const linhas: Array<Record<string, string | number | null>> = [linha('Total do período', null, Object.fromEntries(N.ctx.map((x) => [x, null])), tot, somaFunil(funil.values()))];
  for (const r of spend) linhas.push(linha((r.nome as string) || `#${r.chave}`, r.chave as string, Object.fromEntries(N.ctx.map((x) => [x, (r[x] as string) ?? null])), r, funil.get(r.chave as string) ?? FUNIL_VAZIO));
  const restantes = [...funil.entries()].filter(([k]) => k != null && !usadas.has(k)).map(([, v]) => v);
  if (restantes.length) linhas.push(linha(`(demais ${restantes.length} com leads e sem gasto entre os ${limite} maiores)`, null, Object.fromEntries(N.ctx.map((x) => [x, null])), {}, somaFunil(restantes)));
  if (funil.get(null)) linhas.push(linha(`(negócios sem ligação a ${N.rotulo.toLowerCase()})`, null, Object.fromEntries(N.ctx.map((x) => [x, null])), {}, funil.get(null)!));
  const colunas = [c('nome', N.rotulo), c('id', 'ID'), ...N.ctx.map((x) => c(x, x === 'campanha' ? 'Campanha' : 'Conjunto')), c('gasto', 'Investimento', 'brl'), c('impressoes', 'Impressões', 'int'), c('cliques_link', 'Cliques no link', 'int'),
    ...COL_TAXAS_META, c('leads_meta', 'Leads (Meta)', 'int'), ...COL_FUNIL_META, ...COL_CUSTOS, ...colunasMrr()];
  const avisos: string[] = [];
  if (!spend.length) avisos.push(AVISO_SEM_META);
  if (spend.length === limite) avisos.push(`Mostra os ${limite} com maior investimento; o total considera todos.`);
  return {
    colunas, linhas,
    barras: spend.slice(0, 10).map((r) => ({ rotulo: (r.nome as string) || `#${r.chave}`, valor: n(r.gasto), detalhe: `${fmtInt(n((funil.get(r.chave as string) ?? FUNIL_VAZIO).leads))} leads · ${fmtInt(n(r.cliques_link))} cliques no link · CPM R$ ${(taxasMeta(r).cpm ?? 0).toFixed(2).replace('.', ',')}` })),
    avisos,
  };
}

const ETAPAS_URL_COLUNAS: Coluna[] = [
  c('pagina', 'Página (URL de conversão)'),
  c('sessoes', 'Sessões que entraram pela página (GA4)', 'int'),
  c('leads', 'Leads', 'int'),
  c('visita_lead', 'Lead ÷ sessões', 'pct'),
  c('mql', 'MQL', 'int'),
  c('p_mql', 'Lead → MQL', 'pct'),
  c('sql', 'Chegou em SQL', 'int'),
  c('p_sql', 'MQL → SQL', 'pct'),
  c('reuniao', 'Chegou em Reunião Agendada', 'int'),
  c('p_reuniao', 'SQL → Reunião Agendada', 'pct'),
  c('proposta', 'Chegou em proposta', 'int'),
  c('p_proposta', 'Reunião Agendada → proposta', 'pct'),
  c('ganhos', 'Ganhos', 'int'),
  c('p_ganho', 'Proposta → ganho', 'pct'),
  c('perdidos', 'Perdidos', 'int'),
  c('lead_ganho', 'Lead → ganho', 'pct'),
  c('taxa_ganho', 'Taxa de ganho (ganhos ÷ ganhos + perdidos)', 'pct'),
  ...colunasMrr(),
];
const linhaUrl = (pagina: string, r: Row, sessoes: number | null): Record<string, string | number | null> => ({
  pagina,
  sessoes,
  leads: n(r.leads),
  visita_lead: sessoes ? razao(n(r.leads), sessoes) : null,
  mql: n(r.mql),
  p_mql: razao(n(r.mql), n(r.leads)),
  sql: n(r.sql),
  p_sql: razao(n(r.mql_sql), n(r.mql)),
  reuniao: n(r.reuniao),
  p_reuniao: razao(n(r.sql_reuniao), n(r.sql)),
  proposta: n(r.proposta),
  p_proposta: razao(n(r.reuniao_proposta), n(r.reuniao)),
  ganhos: n(r.ganhos),
  p_ganho: razao(n(r.proposta_ganho), n(r.proposta)),
  perdidos: n(r.perdidos),
  lead_ganho: razao(n(r.ganhos), n(r.leads)),
  taxa_ganho: razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos)),
  ...celulasMrr(r),
});

export const BI_ANALISES: BiAnalise[] = [
  /* ===================== VISÃO GERAL ===================== */
  {
    id: 'visao-geral',
    pagina: 'geral',
    titulo: 'Visão geral',
    pergunta: 'Como estão os negócios criados no período?',
    como_ler: 'Negócios criados no período e o que aconteceu com eles até hoje. Leads e MQL seguem as regras do Painel (status que contam como lead; motivos de perda que tiram do MQL). Taxa de ganho = ganhos ÷ (ganhos + perdidos), sem contar os abertos. A legenda pequena de cada card compara com o MESMO período deslocado: 30 dias antes e 1 ano antes (mesmos filtros), com o valor de lá, a diferença absoluta e a variação em %. Nas taxas (% MQL, taxa de ganho) a diferença é em pontos percentuais (p.p.) e a variação % é relativa. Negócios de períodos antigos já tiveram tempo de fechar; os do período atual ainda estão abertos, então compare com cuidado.',
    largura: 'cheia',
    async rodar(db, f) {
      const f30 = { ...f, de: somaDias(f.de, -30), ate: somaDias(f.ate, -30) };
      const fa1 = { ...f, de: mesmoDiaAnoAnterior(f.de), ate: mesmoDiaAnoAnterior(f.ate) };
      const [r, r30, ra1] = await Promise.all([totaisGeral(db, f), totaisGeral(db, f30), totaisGeral(db, fa1)]);
      const itens = kpisGeral(r);
      const i30 = kpisGeral(r30), ia1 = kpisGeral(ra1);
      itens.forEach((it, k) => {
        it.comp = [comparar('d30', '30 dias antes', f30, it.valor, i30[k]!.valor), comparar('a1', '1 ano antes', fa1, it.valor, ia1[k]!.valor)];
      });
      const txt = (v: number | null, formato: string) => (v == null ? '—' : formato === 'pct' ? pct(v) : formato === 'brl' ? `R$ ${v.toFixed(2)}` : String(v));
      return {
        grafico: { tipo: 'kpis', itens },
        tabela: {
          colunas: [c('indicador', 'Indicador'), c('valor', 'Valor'), c('d30', '30 dias antes'), c('v30', 'Variação vs 30 dias antes', 'pct'), c('a1', '1 ano antes'), c('va1', 'Variação vs 1 ano antes', 'pct')],
          linhas: itens.map((i, k) => ({ indicador: i.rotulo, valor: txt(i.valor, i.formato), d30: txt(i30[k]!.valor, i.formato), v30: i.comp![0]!.pct, a1: txt(ia1[k]!.valor, i.formato), va1: i.comp![1]!.pct })),
        },
        avisos: [],
      };
    },
  },
  {
    id: 'por-mes',
    pagina: 'geral',
    titulo: 'Leads, MQL e ganhos por mês de criação',
    pergunta: 'Como a entrada de leads evolui e quanto vira ganho?',
    como_ler: 'Cada mês agrupa os negócios CRIADOS naquele mês e mostra o que aconteceu com eles até hoje (um ganho de hoje conta no mês em que o negócio nasceu). Meses recentes ainda têm negócios abertos. As caixas acima do gráfico mostram ou escondem duas linhas de referência para a série escolhida: a linha CHEIA é o valor do mês anterior e a TRACEJADA é o do mesmo mês um ano antes (mesmos filtros). O mês em curso está incompleto, então ele tende a ficar abaixo das linhas.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `select to_char(date_trunc('month', d.criado_em at time zone ${TZ}), 'YYYY-MM') as mes,
                count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql,
                count(*) filter (where d.status = 'won')::int as ganhos, count(*) filter (where d.status = 'lost')::int as perdidos, ${MRR_SQL('d')}
           from analytics.negocios_bi d where ${w.join(' and ')} group by 1 order by 1`,
        p,
      );
      // linhas de referência: o mês anterior (cheia) e o mesmo mês do ano anterior (tracejada), com os MESMOS filtros;
      // para os primeiros meses do período é preciso olhar para antes dele, então a consulta recua até o mês anterior ao do ano passado
      const ref = mesmoDiaAnoAnterior(f.de).split('-').map(Number) as [number, number, number];
      const inicioAmpliado = new Date(Date.UTC(ref[0], ref[1] - 2, 1)).toISOString().slice(0, 10);
      const pa: unknown[] = [];
      const wa = filtroSql({ ...f, de: inicioAmpliado }, 'd', pa);
      const amplo = new Map<string, Row>(
        (
          await q(
            db,
            `select to_char(date_trunc('month', d.criado_em at time zone ${TZ}), 'YYYY-MM') as mes, count(*) filter (where d.conta_como_lead)::int as leads,
                    count(*) filter (where d.is_mql)::int as mql, count(*) filter (where d.status = 'won')::int as ganhos
               from analytics.negocios_bi d where ${wa.join(' and ')} group by 1`,
            pa,
          )
        ).map((r) => [r.mes as string, r]),
      );
      const pad = (v: number) => String(v).padStart(2, '0');
      const mesAnterior = (mes: string) => {
        const [y, m] = mes.split('-').map(Number) as [number, number];
        return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
      };
      const anoAnterior = (mes: string) => {
        const [y, m] = mes.split('-').map(Number) as [number, number];
        return `${y - 1}-${pad(m)}`;
      };
      const categorias = rows.map((r) => r.mes as string);
      const valoresDe = (chave: (m: string) => string) => Object.fromEntries((['leads', 'mql', 'ganhos'] as const).map((s) => [s, categorias.map((m) => n(amplo.get(chave(m))?.[s]))]));
      return {
        grafico: {
          tipo: 'colunas',
          categorias,
          series: [
            { id: 'leads', nome: 'Leads', slot: 1, valores: rows.map((r) => n(r.leads)) },
            { id: 'mql', nome: 'MQL', slot: 2, valores: rows.map((r) => n(r.mql)) },
            { id: 'ganhos', nome: 'Ganhos', slot: 3, valores: rows.map((r) => n(r.ganhos)) },
          ],
          linhas: [
            { id: 'mes_anterior', nome: 'Mês anterior', tracejada: false, valores: valoresDe(mesAnterior) },
            { id: 'ano_anterior', nome: 'Mesmo mês do ano anterior', tracejada: true, valores: valoresDe(anoAnterior) },
          ],
        },
        tabela: {
          colunas: [c('mes', 'Mês de criação'), c('leads', 'Leads', 'int'), c('mql', 'MQL', 'int'), c('ganhos', 'Ganhos', 'int'), c('perdidos', 'Perdidos', 'int'), c('taxa', 'Taxa de ganho', 'pct'), ...colunasMrr()],
          linhas: rows.map((r) => ({ mes: r.mes, leads: n(r.leads), mql: n(r.mql), ganhos: n(r.ganhos), perdidos: n(r.perdidos), taxa: razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos)), ...celulasMrr(r) })),
        },
        avisos: [],
      };
    },
  },
  {
    id: 'funil',
    pagina: 'geral',
    titulo: 'Funil: até onde os negócios chegaram',
    pergunta: 'Quantos negócios chegam em cada marco do funil?',
    como_ler: 'Negócios criados no período. "Chegou em SQL, Reunião Agendada, proposta" vem do histórico de etapas (passou por uma etapa marcada na Configuração do Painel de Dados) e significa "chegou ali ou além": quem foi direto para Reunião Agendada conta também como SQL. Ganhos vêm do Status, nunca da etapa. Um ganho dado em Proposta conta como ganho e também como "chegou em proposta".',
    largura: 'meia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const r = (
        await q(
          db,
          `with b as (select d.deal_id, d.conta_como_lead, d.is_mql, d.status from analytics.negocios_bi d where ${w.join(' and ')}), ${MARCOS_CTE}
           select count(*) filter (where b.conta_como_lead)::int as leads, count(*) filter (where b.is_mql)::int as mql,
                  count(*) filter (where m.sql)::int as sql, count(*) filter (where m.reuniao)::int as reuniao, count(*) filter (where m.proposta)::int as proposta,
                  count(*) filter (where b.status = 'won')::int as ganhos
             from b left join m on m.deal_id = b.deal_id`,
          p,
        )
      )[0]!;
      const etapas = [
        { rotulo: 'Leads', valor: n(r.leads) }, { rotulo: 'MQL', valor: n(r.mql) }, { rotulo: 'Chegou em SQL', valor: n(r.sql) },
        { rotulo: 'Chegou em Reunião Agendada', valor: n(r.reuniao) }, { rotulo: 'Chegou em proposta', valor: n(r.proposta) }, { rotulo: 'Ganhos', valor: n(r.ganhos) },
      ];
      const avisos = await avisoHistorico(db, f);
      if (n(r.sql) + n(r.reuniao) + n(r.proposta) === 0) avisos.unshift(SEM_MARCOS);
      const base = etapas[0]!.valor;
      return {
        grafico: { tipo: 'barras', formato: 'int', ordinal: true, itens: etapas.map((e) => ({ ...e, detalhe: base > 0 ? `${((e.valor / base) * 100).toFixed(1)}% dos leads` : undefined })) },
        tabela: { colunas: [c('etapa', 'Marco'), c('qtd', 'Negócios', 'int'), c('pct', '% dos leads', 'pct')], linhas: etapas.map((e) => ({ etapa: e.rotulo, qtd: e.valor, pct: razao(e.valor, base) })) },
        avisos,
      };
    },
  },
  {
    id: 'motivos-perda',
    pagina: 'geral',
    titulo: 'Principais motivos de perda',
    pergunta: 'Por que estamos perdendo negócios?',
    como_ler: 'Negócios perdidos entre os criados no período, por motivo (nome e ID). "Tira do MQL" marca os motivos que a regra do Painel exclui do MQL.',
    largura: 'meia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `select coalesce(d.motivo_perda, '(sem motivo informado)') as motivo, d.motivo_perda_id as id, count(*)::int as qtd, bool_or(coalesce(m.exclui_mql, false)) as tira_do_mql
           from analytics.negocios_bi d left join analytics.motivos_perda m on m.reason_id = d.motivo_perda_id
          where d.status = 'lost' and ${w.join(' and ')} group by 1, 2 order by qtd desc limit 12`,
        p,
      );
      const total = rows.reduce((s, r) => s + n(r.qtd), 0);
      return {
        grafico: { tipo: 'barras', formato: 'int', itens: rows.map((r) => ({ rotulo: `${r.motivo}${r.id != null ? ` #${r.id}` : ''}`, valor: n(r.qtd), detalhe: `${total > 0 ? ((n(r.qtd) / total) * 100).toFixed(1) : '0'}%${r.tira_do_mql ? ' · tira do MQL' : ''}` })) },
        tabela: {
          colunas: [c('motivo', 'Motivo'), c('id', 'ID'), c('qtd', 'Perdidos', 'int'), c('pct', '% do mostrado', 'pct'), c('mql', 'Tira do MQL')],
          linhas: rows.map((r) => ({ motivo: r.motivo, id: r.id == null ? null : String(r.id), qtd: n(r.qtd), pct: razao(n(r.qtd), total), mql: r.tira_do_mql ? 'sim' : 'não' })),
        },
        avisos: rows.length === 12 ? ['Mostra os 12 motivos mais frequentes.'] : [],
      };
    },
  },
  {
    id: 'tempo-etapas',
    pagina: 'geral',
    titulo: 'Tempo em cada etapa',
    pergunta: 'Onde os negócios ficam parados?',
    como_ler: 'Mediana de dias que os negócios criados no período ficaram em cada etapa, considerando só as passagens já concluídas (o negócio saiu da etapa). A mediana não se distorce por poucos casos muito longos. Mostra as 15 etapas com mais passagens.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = (
        await q(
          db,
          `select h.pipeline, h.etapa, pe.pipeline_ordem, pe.etapa_ordem, count(*)::int as passagens,
                  round((percentile_cont(0.5) within group (order by h.horas_na_etapa) / 24)::numeric, 1)::float8 as mediana_dias,
                  round((avg(h.horas_na_etapa) / 24)::numeric, 1)::float8 as media_dias
             from analytics.historico_etapas h
             join analytics.pipelines_etapas pe on pe.stage_id = h.stage_id
             join analytics.negocios_bi d on d.deal_id = h.deal_id
            where not h.etapa_atual and h.horas_na_etapa is not null and not h.is_deleted and ${w.join(' and ')}
            group by h.pipeline, h.etapa, pe.pipeline_ordem, pe.etapa_ordem having count(*) >= 5 order by passagens desc limit 15`,
          p,
        )
      ).sort((a, b) => n(a.pipeline_ordem) - n(b.pipeline_ordem) || n(a.etapa_ordem) - n(b.etapa_ordem));
      return {
        grafico: { tipo: 'barras', formato: 'dias', itens: rows.map((r) => ({ rotulo: `${r.pipeline} › ${r.etapa}`, valor: n(r.mediana_dias), detalhe: `${n(r.passagens)} passagens · média ${n(r.media_dias)} d` })) },
        tabela: {
          colunas: [c('pipeline', 'Pipeline'), c('etapa', 'Etapa'), c('passagens', 'Passagens', 'int'), c('mediana', 'Mediana', 'dias'), c('media', 'Média', 'dias')],
          linhas: rows.map((r) => ({ pipeline: r.pipeline, etapa: r.etapa, passagens: n(r.passagens), mediana: n(r.mediana_dias), media: n(r.media_dias) })),
        },
        avisos: await avisoHistorico(db, f),
      };
    },
  },
  {
    id: 'por-responsavel',
    pagina: 'geral',
    titulo: 'Desempenho por responsável',
    pergunta: 'Quem está fechando mais?',
    como_ler: 'Negócios criados no período, por responsável atual no Pipedrive. Compare a taxa de ganho junto do volume: quem recebe leads de qualidade diferente não é comparável só pela taxa.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `select coalesce(d.responsavel, '(sem responsável)') as responsavel, d.owner_id as id, count(*) filter (where d.conta_como_lead)::int as leads,
                count(*) filter (where d.status = 'won')::int as ganhos, count(*) filter (where d.status = 'lost')::int as perdidos, count(*) filter (where d.status = 'open')::int as abertos,
                ${MRR_SQL('d')}
           from analytics.negocios_bi d where ${w.join(' and ')} group by 1, 2 order by ganhos desc, leads desc limit 20`,
        p,
      );
      const taxa = (r: Row) => razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos));
      return {
        grafico: { tipo: 'barras', formato: 'int', itens: rows.filter((r) => n(r.ganhos) > 0).map((r) => ({ rotulo: r.responsavel, valor: n(r.ganhos), detalhe: `${n(r.leads)} leads · ${pct(taxa(r))}` })) },
        tabela: {
          colunas: [c('responsavel', 'Responsável'), c('id', 'ID'), c('leads', 'Leads', 'int'), c('ganhos', 'Ganhos', 'int'), c('perdidos', 'Perdidos', 'int'), c('abertos', 'Abertos', 'int'), c('taxa', 'Taxa de ganho', 'pct'), ...colunasMrr()],
          linhas: rows.map((r) => ({ responsavel: r.responsavel, id: r.id == null ? null : String(r.id), leads: n(r.leads), ganhos: n(r.ganhos), perdidos: n(r.perdidos), abertos: n(r.abertos), taxa: taxa(r), ...celulasMrr(r) })),
        },
        avisos: rows.length === 20 ? ['Mostra os 20 responsáveis com mais ganhos.'] : [],
      };
    },
  },

  /* ===================== SAFRA ===================== */
  {
    id: 'safra-kpis',
    pagina: 'safra',
    titulo: 'MRR e ticket médio das safras no período',
    pergunta: 'Quanto de MRR as safras do período criaram, ganharam, perderam e ainda têm em aberto?',
    como_ler: `Totais de todas as safras (meses de criação) do período filtrado. ${MRR_DICAS.criado}. MRR perdido e MRR em aberto são da mesma safra e mostram o que ainda pode virar ganho. MRR = valor do negócio no Pipedrive. O MRR por mês está na tabela "Safras: resultado de cada mês de criação".`,
    largura: 'cheia',
    async rodar(db, f) {
      return resumoMrr(db, f);
    },
  },
  {
    id: 'safra-resumo',
    pagina: 'safra',
    titulo: 'Safras: resultado de cada mês de criação',
    pergunta: 'Como cada safra de leads performou, do lead ao ganho?',
    como_ler: 'Safra = mês em que o negócio foi criado. Cada linha mostra o que aconteceu com os negócios daquele mês até hoje: % que virou MQL, que chegou em SQL, Reunião Agendada e proposta (pelo histórico de etapas), ganhos, taxa de ganho (ganhos ÷ ganhos + perdidos), valor ganho e ciclo de venda (mediana de dias da criação ao ganho). Safras recentes ainda têm muitos negócios abertos: compare safras de idade parecida.',
    largura: 'cheia',
    async rodar(db, f) {
      const rows = await safras(db, f);
      const avisos = await avisoHistorico(db, f);
      if (rows.length && rows.every((r) => n(r.sql) + n(r.reuniao) + n(r.proposta) === 0)) avisos.unshift(SEM_MARCOS);
      return {
        grafico: { tipo: 'tabela' },
        tabela: {
          colunas: [c('safra', 'Safra'), c('leads', 'Leads', 'int'), c('pmql', '% MQL', 'pct'), c('psql', '% chegou SQL', 'pct'), c('preun', '% chegou Reunião Agendada', 'pct'), c('pprop', '% chegou proposta', 'pct'), c('ganhos', 'Ganhos', 'int'), c('perdidos', 'Perdidos', 'int'), c('abertos', 'Abertos', 'int'), c('taxa', 'Taxa de ganho', 'pct'), ...colunasMrr(), c('ciclo', 'Ciclo mediano', 'dias')],
          linhas: rows.map((r) => ({
            safra: r.safra, leads: n(r.leads), pmql: razao(n(r.mql), n(r.leads)), psql: razao(n(r.sql), n(r.leads)), preun: razao(n(r.reuniao), n(r.leads)), pprop: razao(n(r.proposta), n(r.leads)),
            ganhos: n(r.ganhos), perdidos: n(r.perdidos), abertos: n(r.abertos), taxa: razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos)), ...celulasMrr(r), ciclo: r.ciclo_dias == null ? null : Math.round(Number(r.ciclo_dias) * 10) / 10,
          })),
        },
        avisos,
      };
    },
  },
  {
    id: 'safra-funil',
    pagina: 'safra',
    titulo: 'Funil por safra',
    pergunta: 'Que parte de cada safra chegou em cada marco?',
    como_ler: 'Percentual dos leads de cada safra que virou MQL, chegou em SQL, Reunião Agendada e proposta e que foi ganho. Células mais escuras = maior percentual. Marcos de etapa dependem do histórico lido e das etapas marcadas na Configuração.',
    largura: 'cheia',
    async rodar(db, f) {
      const rows = await safras(db, f);
      const avisos = await avisoHistorico(db, f);
      if (rows.length && rows.every((r) => n(r.sql) + n(r.reuniao) + n(r.proposta) === 0)) avisos.unshift(SEM_MARCOS);
      const colunas = ['MQL', 'Chegou em SQL', 'Chegou em Reunião Agendada', 'Chegou em proposta', 'Ganho'];
      const linhas = rows.map((r) => ({ rotulo: r.safra as string, detalhe: `${n(r.leads)} leads`, valores: [razao(n(r.mql), n(r.leads)), razao(n(r.sql), n(r.leads)), razao(n(r.reuniao), n(r.leads)), razao(n(r.proposta), n(r.leads)), razao(n(r.ganhos), n(r.leads))] }));
      return {
        grafico: { tipo: 'matriz', colunas, linhas, formato: 'pct', escala: 'coluna' },
        tabela: { colunas: [c('safra', 'Safra'), c('leads', 'Leads', 'int'), ...colunas.map((x, i) => c(`v${i}`, `% ${x}`, 'pct'))], linhas: linhas.map((l, i) => ({ safra: l.rotulo, leads: n(rows[i]!.leads), ...Object.fromEntries(l.valores.map((v, k) => [`v${k}`, v])) })) },
        avisos,
      };
    },
  },
  {
    id: 'safra-ganhos',
    pagina: 'safra',
    titulo: 'Ganhos acumulados ao longo do tempo (curva de safra)',
    pergunta: 'Quanto de cada safra vira ganho, e em quanto tempo?',
    como_ler: 'Cada linha é uma safra; cada coluna é o tempo desde a criação do negócio. A célula mostra a % dos leads da safra que já tinha sido GANHA até aquele prazo (acumulado). Células vazias = a safra ainda não tem essa idade, então não dá para comparar. Use para ver se uma safra recente está convertendo no mesmo ritmo das antigas.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const MAXM = 12;
      const rows = await q(
        db,
        `with b as (select to_char(date_trunc('month', d.criado_em at time zone ${TZ}), 'YYYY-MM') as safra, d.conta_como_lead, d.status, d.criado_em, d.fechado_em
                      from analytics.negocios_bi d where ${w.join(' and ')})
         select b.safra, m.m, count(*) filter (where b.conta_como_lead)::int as leads,
                count(*) filter (where b.status = 'won' and b.fechado_em is not null and floor(extract(epoch from b.fechado_em - b.criado_em) / 2629746.0) <= m.m)::int as ganhos_ate
           from b cross join generate_series(0, ${MAXM}) as m(m) group by b.safra, m.m order by b.safra, m.m`,
        p,
      );
      const hoje = new Date();
      const porSafra = new Map<string, { leads: number; ate: Array<number | null> }>();
      for (const r of rows) {
        const [a, mes] = String(r.safra).split('-').map(Number) as [number, number];
        // a coluna só vale quando TODOS os leads da safra já têm (m+1) meses de vida: fim da safra (1º dia do mês seguinte) + (m+1) meses
        const idadeOk = new Date(Date.UTC(a, mes + n(r.m) + 1, 1)) <= hoje;
        const s = porSafra.get(r.safra) ?? { leads: n(r.leads), ate: Array(MAXM + 1).fill(null) };
        s.ate[n(r.m)] = idadeOk && n(r.leads) > 0 ? n(r.ganhos_ate) / n(r.leads) : null;
        porSafra.set(r.safra, s);
      }
      const colunas = Array.from({ length: MAXM + 1 }, (_, i) => `até ${i + 1} ${i === 0 ? 'mês' : 'meses'}`);
      const linhas = [...porSafra.entries()].map(([safra, s]) => ({ rotulo: safra, detalhe: `${s.leads} leads`, valores: s.ate }));
      return {
        grafico: { tipo: 'matriz', colunas, linhas, formato: 'pct' },
        tabela: { colunas: [c('safra', 'Safra'), c('leads', 'Leads', 'int'), ...colunas.map((x, i) => c(`m${i}`, x, 'pct'))], linhas: linhas.map((l) => ({ safra: l.rotulo, leads: n(porSafra.get(l.rotulo)!.leads), ...Object.fromEntries(l.valores.map((v, k) => [`m${k}`, v])) })) },
        avisos: [],
      };
    },
  },

  /* ===================== CANAIS ===================== */
  {
    id: 'canais-kpis',
    pagina: 'canais',
    titulo: 'MRR e ticket médio das fontes selecionadas',
    pergunta: 'Quanto de MRR as fontes selecionadas criaram, ganharam, perderam e ainda têm em aberto?',
    como_ler: `Totais das fontes e tipos de lead escolhidos nos filtros, para os negócios criados no período. ${MRR_DICAS.criado}. O MRR de cada fonte está na tabela "Canais: comparativo por fonte". MRR = valor do negócio no Pipedrive.`,
    largura: 'cheia',
    async rodar(db, f) {
      return resumoMrr(db, f);
    },
  },
  {
    id: 'canais-funis',
    pagina: 'canais',
    titulo: 'Funis lado a lado: cada fonte, do lead ao ganho',
    pergunta: 'Em que etapa cada fonte perde força, comparando os funis inteiros?',
    como_ler: 'Uma coluna por fonte (as 6 com mais leads) e o total, com as mesmas etapas alinhadas: Leads, MQL, chegou em SQL, Reunião Agendada, proposta e Ganhos. A barra mostra a parte dos leads da PRÓPRIA fonte que chegou na etapa (a barra dos leads é sempre cheia), então dá para comparar a forma dos funis mesmo com volumes muito diferentes; o número é a quantidade. Em cada etapa, "passo" = dos negócios que chegaram na etapa anterior, quantos chegaram nesta (nunca passa de 100%). Só entram negócios que contam como lead. "Chegou em SQL" inclui quem foi direto para Reunião Agendada ou proposta (chegou em X ou além), porque muitos negócios pulam etapas. As etapas vêm do histórico e das marcações na Configuração do Painel de Dados; ganhos vêm do Status do negócio (um ganho pode ter pulado etapas).',
    largura: 'cheia',
    async rodar(db, f) {
      const { colunas, avisos } = await funisPorFonte(db, f);
      const linhas: Array<Record<string, string | number | null>> = ETAPAS_FUNIL.map((etapa, i) => {
        const l: Record<string, string | number | null> = { etapa };
        for (const k of colunas) {
          l[`${k.id}_qtd`] = k.valores[i]!;
          l[`${k.id}_pct`] = razao(k.valores[i]!, k.leads);
          l[`${k.id}_passo`] = k.passos[i] ?? null;
        }
        return l;
      });
      return {
        grafico: { tipo: 'funis', etapas: ETAPAS_FUNIL, colunas },
        tabela: {
          colunas: [c('etapa', 'Etapa'), ...colunas.flatMap((k) => [c(`${k.id}_qtd`, `${k.nome}: negócios`, 'int'), c(`${k.id}_pct`, `${k.nome}: % dos leads`, 'pct'), c(`${k.id}_passo`, `${k.nome}: passo`, 'pct')])],
          linhas,
        },
        avisos,
      };
    },
  },
  {
    id: 'canais-conversoes',
    pagina: 'canais',
    titulo: 'Taxas de conversão por fonte',
    pergunta: 'Que fonte converte melhor em cada passo do funil?',
    como_ler: 'Cada célula é a taxa de um passo: dos negócios que chegaram na etapa da esquerda, que % chegou na da direita. A cor compara as fontes DENTRO de cada linha (mais escuro = melhor naquela conversão). "Lead → ganho" é o resultado final: ganhos ÷ leads.',
    largura: 'cheia',
    async rodar(db, f) {
      const { colunas, avisos } = await funisPorFonte(db, f);
      const linhas = colunas.length ? PASSOS.map((rotulo, i) => ({ rotulo, valores: colunas.map((k) => k.passos[i + 1] ?? null) })) : [];
      if (colunas.length) linhas.push({ rotulo: 'Lead → ganho (resultado final)', valores: colunas.map((k) => razao(k.valores[5]!, k.leads)) });
      return {
        grafico: { tipo: 'matriz', colunas: colunas.map((k) => (k.total ? 'Total' : k.nome.replace(/^Marketing \[(.*)\]$/, '$1'))), linhas, formato: 'pct', escala: 'linha' },
        tabela: { colunas: [c('passo', 'Conversão'), ...colunas.map((k) => c(k.id, k.total ? 'Total' : k.nome, 'pct'))], linhas: linhas.map((l) => ({ passo: l.rotulo, ...Object.fromEntries(colunas.map((k, i) => [k.id, l.valores[i] ?? null])) })) },
        avisos,
      };
    },
  },
  {
    id: 'canais-resumo',
    pagina: 'canais',
    titulo: 'Canais: comparativo por fonte',
    pergunta: 'Que fontes trazem mais leads e quais convertem melhor?',
    como_ler: 'Fonte = campo "Fonte do Lead" do Pipedrive (nome e ID da opção). Para cada fonte: volume, participação, qualidade (% MQL e % inválidos), até onde chegou no funil (pelo histórico), ganhos, taxa de ganho (ganhos ÷ ganhos + perdidos), valor e ticket médio, e ciclo de venda (mediana de dias criação → ganho). O gráfico mostra o volume de leads.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `with b as (select d.deal_id, ${FONTE} as fonte, d.fonte_id, d.conta_como_lead, d.is_mql, d.status, d.valor, d.criado_em, d.fechado_em from analytics.negocios_bi d where ${w.join(' and ')}), ${MARCOS_CTE}
         select b.fonte, b.fonte_id, count(*) filter (where b.conta_como_lead)::int as leads, count(*) filter (where b.is_mql)::int as mql,
                count(*) filter (where b.conta_como_lead and not b.is_mql)::int as invalidos,
                count(*) filter (where m.sql)::int as sql, count(*) filter (where m.reuniao)::int as reuniao, count(*) filter (where m.proposta)::int as proposta,
                count(*) filter (where b.status = 'won')::int as ganhos, count(*) filter (where b.status = 'lost')::int as perdidos,
                ${MRR_SQL('b')},
                (percentile_cont(0.5) within group (order by extract(epoch from b.fechado_em - b.criado_em) / 86400.0) filter (where b.status = 'won' and b.fechado_em is not null))::float8 as ciclo_dias
           from b left join m on m.deal_id = b.deal_id group by 1, 2 order by leads desc limit 15`,
        p,
      );
      const total = rows.reduce((s, r) => s + n(r.leads), 0);
      const taxa = (r: Row) => razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos));
      const avisos = await avisoHistorico(db, f);
      if (rows.length === 15) avisos.push('Mostra as 15 fontes com mais leads.');
      return {
        grafico: { tipo: 'barras', formato: 'int', itens: rows.map((r) => ({ rotulo: r.fonte, valor: n(r.leads), detalhe: `${pct(razao(n(r.leads), total))} dos leads · ${pct(razao(n(r.mql), n(r.leads)))} MQL · ${n(r.ganhos)} ganhos (${pct(taxa(r))})` })) },
        tabela: {
          colunas: [c('fonte', 'Fonte'), c('id', 'ID'), c('leads', 'Leads', 'int'), c('part', '% dos leads', 'pct'), c('pmql', '% MQL', 'pct'), c('pinv', '% inválidos', 'pct'), c('psql', '% chegou SQL', 'pct'), c('preun', '% chegou Reunião Agendada', 'pct'), c('pprop', '% chegou proposta', 'pct'), c('ganhos', 'Ganhos', 'int'), c('taxa', 'Taxa de ganho', 'pct'), ...colunasMrr(), c('ciclo', 'Ciclo mediano', 'dias')],
          linhas: rows.map((r) => ({
            fonte: r.fonte, id: r.fonte_id, leads: n(r.leads), part: razao(n(r.leads), total), pmql: razao(n(r.mql), n(r.leads)), pinv: razao(n(r.invalidos), n(r.leads)),
            psql: razao(n(r.sql), n(r.leads)), preun: razao(n(r.reuniao), n(r.leads)), pprop: razao(n(r.proposta), n(r.leads)), ganhos: n(r.ganhos), taxa: taxa(r),
            ...celulasMrr(r), ciclo: r.ciclo_dias == null ? null : Math.round(Number(r.ciclo_dias) * 10) / 10,
          })),
        },
        avisos,
      };
    },
  },
  {
    id: 'canais-por-mes',
    pagina: 'canais',
    titulo: 'Leads por fonte, mês a mês',
    pergunta: 'Como cada fonte evolui ao longo do tempo?',
    como_ler: 'Leads criados em cada mês, por fonte. Cada fonte tem sempre a mesma cor (Google ADS azul, Meta ADS laranja, Orgânico verde-água, Social amarelo); as demais fontes entram juntas em "Outras fontes" (cinza).',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `select to_char(date_trunc('month', d.criado_em at time zone ${TZ}), 'YYYY-MM') as mes, ${FONTE} as fonte, count(*) filter (where d.conta_como_lead)::int as leads
           from analytics.negocios_bi d where ${w.join(' and ')} group by 1, 2 order by 1`,
        p,
      );
      const meses = [...new Set(rows.map((r) => r.mes as string))].sort();
      const FIXAS: Array<[string, string, number]> = [['Marketing [Google ADS]', 'Google ADS', 1], ['Marketing [Meta ADS]', 'Meta ADS', 2], ['Marketing [Orgânico]', 'Orgânico', 3], ['Marketing [Social]', 'Social', 4]];
      const val = (pred: (fonte: string) => boolean) => meses.map((m) => rows.filter((r) => r.mes === m && pred(r.fonte)).reduce((s, r) => s + n(r.leads), 0));
      const series = FIXAS.map(([full, nome, slot]) => ({ id: full, nome, slot, valores: val((x) => x === full) })).filter((s) => s.valores.some((v) => v > 0));
      const outras = val((x) => !FIXAS.some(([full]) => full === x));
      if (outras.some((v) => v > 0)) series.push({ id: 'outras', nome: 'Outras fontes', slot: 0, valores: outras });
      return {
        grafico: { tipo: 'colunas', categorias: meses, series },
        tabela: { colunas: [c('mes', 'Mês de criação'), ...series.map((s) => c(s.id, s.nome, 'int'))], linhas: meses.map((m, i) => ({ mes: m, ...Object.fromEntries(series.map((s) => [s.id, s.valores[i]!])) })) },
        avisos: [],
      };
    },
  },
  {
    id: 'canais-rd',
    pagina: 'canais',
    titulo: 'Detalhe: Canal de origem RD',
    pergunta: 'Dentro das fontes selecionadas, de onde exatamente vêm os leads?',
    como_ler: 'Campo de texto "Canal de origem RD" (ex.: Busca orgânica | Google). Mostra os 12 canais com mais leads, com ganhos e taxa de ganho.',
    largura: 'meia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `select coalesce(d.canal_rd, '(em branco)') as canal, count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql,
                count(*) filter (where d.status = 'won')::int as ganhos, count(*) filter (where d.status = 'lost')::int as perdidos
           from analytics.negocios_bi d where ${w.join(' and ')} group by 1 order by leads desc limit 12`,
        p,
      );
      const taxa = (r: Row) => razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos));
      return {
        grafico: { tipo: 'barras', formato: 'int', itens: rows.map((r) => ({ rotulo: r.canal, valor: n(r.leads), detalhe: `${n(r.ganhos)} ganhos · ${pct(taxa(r))}` })) },
        tabela: { colunas: [c('canal', 'Canal de origem RD'), c('leads', 'Leads', 'int'), c('mql', 'MQL', 'int'), c('ganhos', 'Ganhos', 'int'), c('perdidos', 'Perdidos', 'int'), c('taxa', 'Taxa de ganho', 'pct')], linhas: rows.map((r) => ({ canal: r.canal, leads: n(r.leads), mql: n(r.mql), ganhos: n(r.ganhos), perdidos: n(r.perdidos), taxa: taxa(r) })) },
        avisos: rows.length === 12 ? ['Mostra os 12 canais com mais leads.'] : [],
      };
    },
  },

  /* ===================== QUALIDADE ===================== */
  {
    id: 'qualidade-kpis',
    pagina: 'qualidade',
    titulo: 'Qualidade dos leads: indicadores',
    pergunta: 'Os leads que entram têm qualidade e estão bem preenchidos?',
    como_ler: '% MQL = leads que seguem a regra do MQL. Inválidos = leads perdidos por motivo que a regra do Painel tira do MQL (hoje: Lead Invalido, Cliente em Busca de Suporte, Contato Inexistente, Oportunidade Duplicada). "Sem …" = campo do Pipedrive em branco. A faixa depende do produto: RH usa "Faixa de Colaboradores"; Clínica usa "Faixa de profissionais da saúde".',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const r = (
        await q(
          db,
          `select count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql,
                  count(*) filter (where d.conta_como_lead and not d.is_mql)::int as invalidos, count(*) filter (where d.status = 'lost')::int as perdidos,
                  count(*) filter (where d.fonte_id is null)::int as sem_fonte, count(*) filter (where d.tipo_id is null)::int as sem_tipo,
                  count(*) filter (where d.produto = 'rh')::int as rh, count(*) filter (where d.produto = 'rh' and d.faixa_colab_id is null)::int as rh_sem_faixa,
                  count(*) filter (where d.produto = 'clinic')::int as clinic, count(*) filter (where d.produto = 'clinic' and d.faixa_saude_id is null)::int as clinic_sem_faixa,
                  count(*) filter (where d.sem_pessoa)::int as sem_pessoa, count(*) filter (where d.sem_organizacao)::int as sem_org, count(*)::int as total,
                  count(*) filter (where d.canal_rd ~* ${CANAL_DESCONHECIDO})::int as canal_desc,
                  count(*) filter (where d.utm_source is not null)::int as utm_preench, count(*) filter (where d.utm_source ~* ${UTM_INVALIDO})::int as utm_inv
             from analytics.negocios_bi d where ${w.join(' and ')}`,
          p,
        )
      )[0]!;
      const leads = n(r.leads), total = n(r.total);
      const itens = [
        { id: 'leads', rotulo: 'Leads', valor: leads, formato: 'int' as const },
        { id: 'pmql', rotulo: '% MQL', valor: razao(n(r.mql), leads), formato: 'pct' as const, dica: 'MQL ÷ leads' },
        { id: 'pinv', rotulo: '% inválidos', valor: razao(n(r.invalidos), leads), formato: 'pct' as const, dica: 'Perdidos por motivo que tira do MQL ÷ leads' },
        { id: 'pperd', rotulo: '% perdidos', valor: razao(n(r.perdidos), total), formato: 'pct' as const, dica: 'Todos os motivos ÷ negócios' },
        { id: 'psf', rotulo: '% sem fonte', valor: razao(n(r.sem_fonte), total), formato: 'pct' as const, dica: '"Fonte do Lead" em branco' },
        { id: 'pst', rotulo: '% sem tipo do lead', valor: razao(n(r.sem_tipo), total), formato: 'pct' as const, dica: '"Tipo do Lead" em branco' },
        { id: 'prh', rotulo: '% RH sem faixa de colaboradores', valor: razao(n(r.rh_sem_faixa), n(r.rh)), formato: 'pct' as const, dica: `${n(r.rh_sem_faixa)} de ${n(r.rh)} negócios de RH` },
        { id: 'pcl', rotulo: '% Clínica sem faixa de profissionais', valor: razao(n(r.clinic_sem_faixa), n(r.clinic)), formato: 'pct' as const, dica: `${n(r.clinic_sem_faixa)} de ${n(r.clinic)} negócios de Clínica` },
        { id: 'pcd', rotulo: '% com canal de origem "Desconhecido"', valor: razao(n(r.canal_desc), total), formato: 'pct' as const, dica: `${n(r.canal_desc)} negócios com "Desconhecido"/"Unknown" no Canal de origem RD` },
        { id: 'pui', rotulo: '% UTM Source inválido', valor: razao(n(r.utm_inv), n(r.utm_preench)), formato: 'pct' as const, dica: `${n(r.utm_inv)} de ${n(r.utm_preench)} com UTM preenchido: {{...}}, undefined ou unknown` },
        { id: 'ppe', rotulo: '% sem pessoa vinculada', valor: razao(n(r.sem_pessoa), total), formato: 'pct' as const },
        { id: 'por', rotulo: '% sem organização', valor: razao(n(r.sem_org), total), formato: 'pct' as const },
      ];
      return { grafico: { tipo: 'kpis', itens }, tabela: { colunas: [c('indicador', 'Indicador'), c('valor', 'Valor'), c('nota', 'Detalhe')], linhas: itens.map((i) => ({ indicador: i.rotulo, valor: i.formato === 'pct' ? pct(i.valor) : String(i.valor), nota: i.dica ?? '' })) }, avisos: [] };
    },
  },
  {
    id: 'qualidade-por-fonte',
    pagina: 'qualidade',
    titulo: 'Qualidade por fonte',
    pergunta: 'Que fontes trazem leads melhores e mais bem preenchidos?',
    como_ler: 'Para cada fonte: % MQL, % inválidos, % perdidos e % de dados em branco (tipo do lead; faixa de colaboradores nos negócios de RH; faixa de profissionais nos de Clínica). O gráfico ordena pelo volume e mostra o % MQL.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `select ${FONTE} as fonte, d.fonte_id as id, count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql,
                count(*) filter (where d.conta_como_lead and not d.is_mql)::int as invalidos, count(*) filter (where d.status = 'lost')::int as perdidos, count(*)::int as total,
                count(*) filter (where d.tipo_id is null)::int as sem_tipo,
                count(*) filter (where d.produto = 'rh')::int as rh, count(*) filter (where d.produto = 'rh' and d.faixa_colab_id is null)::int as rh_sem,
                count(*) filter (where d.produto = 'clinic')::int as cl, count(*) filter (where d.produto = 'clinic' and d.faixa_saude_id is null)::int as cl_sem
           from analytics.negocios_bi d where ${w.join(' and ')} group by 1, 2 order by leads desc limit 15`,
        p,
      );
      return {
        grafico: { tipo: 'barras', formato: 'pct', itens: rows.map((r) => ({ rotulo: r.fonte, valor: razao(n(r.mql), n(r.leads)) ?? 0, detalhe: `${n(r.leads)} leads · ${pct(razao(n(r.invalidos), n(r.leads)))} inválidos` })) },
        tabela: {
          colunas: [c('fonte', 'Fonte'), c('id', 'ID'), c('leads', 'Leads', 'int'), c('pmql', '% MQL', 'pct'), c('pinv', '% inválidos', 'pct'), c('pperd', '% perdidos', 'pct'), c('pst', '% sem tipo', 'pct'), c('prh', '% RH sem faixa', 'pct'), c('pcl', '% Clínica sem faixa', 'pct')],
          linhas: rows.map((r) => ({ fonte: r.fonte, id: r.id, leads: n(r.leads), pmql: razao(n(r.mql), n(r.leads)), pinv: razao(n(r.invalidos), n(r.leads)), pperd: razao(n(r.perdidos), n(r.total)), pst: razao(n(r.sem_tipo), n(r.total)), prh: razao(n(r.rh_sem), n(r.rh)), pcl: razao(n(r.cl_sem), n(r.cl)) })),
        },
        avisos: rows.length === 15 ? ['Mostra as 15 fontes com mais leads.'] : [],
      };
    },
  },
  {
    id: 'qualidade-por-mes',
    pagina: 'qualidade',
    titulo: 'Qualidade ao longo do tempo',
    pergunta: 'A qualidade dos leads está melhorando ou piorando?',
    como_ler: 'Por mês de criação: % MQL, % inválidos e % de leads com algum dado em branco (fonte, tipo do lead ou a faixa que cabe ao produto). Meses recentes ainda não tiveram tempo de o time classificar os leads perdidos.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `select to_char(date_trunc('month', d.criado_em at time zone ${TZ}), 'YYYY-MM') as mes, count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql,
                count(*) filter (where d.conta_como_lead and not d.is_mql)::int as invalidos, count(*)::int as total,
                count(*) filter (where d.fonte_id is null or d.tipo_id is null or (d.produto = 'rh' and d.faixa_colab_id is null) or (d.produto = 'clinic' and d.faixa_saude_id is null))::int as algum_branco
           from analytics.negocios_bi d where ${w.join(' and ')} group by 1 order by 1`,
        p,
      );
      const s = (fn: (r: Row) => number | null) => rows.map((r) => fn(r) ?? 0);
      return {
        grafico: {
          tipo: 'colunas', formato: 'pct', categorias: rows.map((r) => r.mes),
          series: [
            { id: 'mql', nome: '% MQL', slot: 1, valores: s((r) => razao(n(r.mql), n(r.leads))) },
            { id: 'inv', nome: '% inválidos', slot: 2, valores: s((r) => razao(n(r.invalidos), n(r.leads))) },
            { id: 'branco', nome: '% com algum dado em branco', slot: 3, valores: s((r) => razao(n(r.algum_branco), n(r.total))) },
          ],
        },
        tabela: {
          colunas: [c('mes', 'Mês de criação'), c('leads', 'Leads', 'int'), c('pmql', '% MQL', 'pct'), c('pinv', '% inválidos', 'pct'), c('pbr', '% com algum dado em branco', 'pct')],
          linhas: rows.map((r) => ({ mes: r.mes, leads: n(r.leads), pmql: razao(n(r.mql), n(r.leads)), pinv: razao(n(r.invalidos), n(r.leads)), pbr: razao(n(r.algum_branco), n(r.total)) })),
        },
        avisos: [],
      };
    },
  },
  {
    id: 'qualidade-invalidos',
    pagina: 'qualidade',
    titulo: 'Por que os leads são inválidos',
    pergunta: 'Quais motivos tiram leads do MQL?',
    como_ler: 'Leads perdidos por um motivo que a regra do Painel tira do MQL (nome e ID), com a % sobre todos os leads do filtro. A lista dos motivos é editável na aba Configuração do Painel de Dados.',
    largura: 'meia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `select coalesce(d.motivo_perda, '(sem motivo informado)') as motivo, d.motivo_perda_id as id, count(*)::int as qtd,
                (select count(*)::int from analytics.negocios_bi d2 where d2.conta_como_lead and ${filtroSql(f, 'd2', p).join(' and ')}) as leads
           from analytics.negocios_bi d where d.conta_como_lead and not d.is_mql and ${w.join(' and ')} group by 1, 2 order by qtd desc limit 12`,
        p,
      );
      const leads = rows[0] ? n(rows[0].leads) : 0;
      return {
        grafico: { tipo: 'barras', formato: 'int', itens: rows.map((r) => ({ rotulo: `${r.motivo}${r.id != null ? ` #${r.id}` : ''}`, valor: n(r.qtd), detalhe: `${pct(razao(n(r.qtd), leads))} dos leads` })) },
        tabela: { colunas: [c('motivo', 'Motivo'), c('id', 'ID'), c('qtd', 'Leads inválidos', 'int'), c('pct', '% dos leads', 'pct')], linhas: rows.map((r) => ({ motivo: r.motivo, id: r.id == null ? null : String(r.id), qtd: n(r.qtd), pct: razao(n(r.qtd), leads) })) },
        avisos: [],
      };
    },
  },
  {
    id: 'qualidade-branco',
    pagina: 'qualidade',
    titulo: 'Dados em branco',
    pergunta: 'Quais campos estão mais vazios?',
    como_ler: '% de negócios com o campo em branco ou com valor "desconhecido". A faixa de colaboradores só conta negócios de RH e a faixa de profissionais da saúde só os de Clínica (cada produto tem a sua); negócios sem produto definido não entram nas faixas. "Desconhecido" no Canal de origem RD e valores como {{}}, {{GoogleAds}}, undefined ou unknown no UTM Source indicam link de campanha mal configurado.',
    largura: 'meia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const r = (
        await q(
          db,
          `select count(*)::int as total, count(*) filter (where d.fonte_id is null)::int as sem_fonte, count(*) filter (where d.tipo_id is null)::int as sem_tipo,
                  count(*) filter (where d.produto = 'rh')::int as rh, count(*) filter (where d.produto = 'rh' and d.faixa_colab_id is null)::int as rh_sem,
                  count(*) filter (where d.produto = 'clinic')::int as cl, count(*) filter (where d.produto = 'clinic' and d.faixa_saude_id is null)::int as cl_sem,
                  count(*) filter (where d.canal_rd is null)::int as sem_canal, count(*) filter (where d.utm_source is null)::int as sem_utm,
                  count(*) filter (where d.canal_rd ~* ${CANAL_DESCONHECIDO})::int as canal_desc,
                  count(*) filter (where d.utm_source is not null)::int as utm_preench, count(*) filter (where d.utm_source ~* ${UTM_INVALIDO})::int as utm_inv,
                  count(*) filter (where d.sem_pessoa)::int as sem_pessoa, count(*) filter (where d.sem_organizacao)::int as sem_org
             from analytics.negocios_bi d where ${w.join(' and ')}`,
          p,
        )
      )[0]!;
      const t = n(r.total);
      const linhas = [
        { campo: 'Fonte do Lead', sem: n(r.sem_fonte), base: t },
        { campo: 'Tipo do Lead', sem: n(r.sem_tipo), base: t },
        { campo: 'Faixa de Colaboradores (só RH)', sem: n(r.rh_sem), base: n(r.rh) },
        { campo: 'Faixa de profissionais da saúde (só Clínica)', sem: n(r.cl_sem), base: n(r.cl) },
        { campo: 'Canal de origem RD', sem: n(r.sem_canal), base: t },
        { campo: 'Canal de origem RD = "Desconhecido"', sem: n(r.canal_desc), base: t },
        { campo: 'UTM Source', sem: n(r.sem_utm), base: t },
        { campo: 'UTM Source inválido ({{...}}, undefined, unknown), entre os preenchidos', sem: n(r.utm_inv), base: n(r.utm_preench) },
        { campo: 'Pessoa vinculada', sem: n(r.sem_pessoa), base: t },
        { campo: 'Organização', sem: n(r.sem_org), base: t },
      ];
      return {
        grafico: { tipo: 'barras', formato: 'pct', itens: linhas.map((l) => ({ rotulo: l.campo, valor: razao(l.sem, l.base) ?? 0, detalhe: `${l.sem} de ${l.base}` })) },
        tabela: { colunas: [c('campo', 'Campo'), c('sem', 'Em branco', 'int'), c('base', 'Negócios considerados', 'int'), c('pct', '% em branco', 'pct')], linhas: linhas.map((l) => ({ campo: l.campo, sem: l.sem, base: l.base, pct: razao(l.sem, l.base) })) },
        avisos: [],
      };
    },
  },
  /* ===================== GOOGLE ADS (investimento + funil dos leads da fonte Google ADS) ===================== */
  {
    id: 'ads-resumo',
    pagina: 'ads',
    titulo: 'Google Ads: visão geral do período',
    pergunta: 'Quanto foi investido e o que isso trouxe, do lead ao ganho?',
    como_ler: `Resumo de todo o período filtrado. ${NOTA_ADS}`,
    largura: 'cheia',
    async rodar(db, f) {
      const [rows, cu] = await Promise.all([safras(db, f, FONTE_GOOGLE_ADS), custoAds(db, f)]);
      const t = somarFunil(rows);
      const inv = cu.total.custo;
      const k = custosEtapa(inv, t);
      const itens = [
        { id: 'invest', rotulo: 'Investimento', valor: inv, formato: 'brl' as const, dica: 'Custo do Google Ads no período' },
        { id: 'cliques', rotulo: 'Cliques', valor: cu.total.cliques, formato: 'int' as const },
        { id: 'impressoes', rotulo: 'Impressões', valor: cu.total.impressoes, formato: 'int' as const },
        { id: 'cpc', rotulo: 'CPC médio', valor: razao(inv, cu.total.cliques), formato: 'brl2' as const, dica: 'Investimento ÷ cliques' },
        { id: 'leads', rotulo: 'Leads', valor: n(t.leads), formato: 'int' as const, dica: 'Negócios da fonte Google ADS que contam como lead' },
        { id: 'mql', rotulo: 'MQL', valor: n(t.mql), formato: 'int' as const },
        { id: 'sql', rotulo: 'Chegou em SQL', valor: n(t.sql), formato: 'int' as const },
        { id: 'reuniao', rotulo: 'Chegou em Reunião Agendada', valor: n(t.reuniao), formato: 'int' as const },
        { id: 'proposta', rotulo: 'Chegou em proposta', valor: n(t.proposta), formato: 'int' as const },
        { id: 'ganhos', rotulo: 'Ganhos', valor: n(t.ganhos), formato: 'int' as const },
        { id: 'cpl', rotulo: 'Custo por lead', valor: k.cpl, formato: 'brl2' as const },
        { id: 'c_mql', rotulo: 'Custo por MQL', valor: k.c_mql, formato: 'brl2' as const },
        { id: 'c_sql', rotulo: 'Custo por SQL', valor: k.c_sql, formato: 'brl2' as const },
        { id: 'c_reuniao', rotulo: 'Custo por Reunião Agendada', valor: k.c_reuniao, formato: 'brl2' as const },
        { id: 'c_proposta', rotulo: 'Custo por proposta', valor: k.c_proposta, formato: 'brl2' as const },
        { id: 'cac', rotulo: 'Custo por ganho (CAC)', valor: k.cac, formato: 'brl2' as const, dica: 'Investimento ÷ ganhos' },
        { id: 'roas', rotulo: 'ROAS', valor: k.roas, formato: 'dec' as const, dica: 'MRR ganho ÷ investimento' },
        ...mrrKpis(t),
      ];
      const avisos: string[] = [];
      if (!cu.meses.size) avisos.push(AVISO_SEM_CUSTO);
      if (f.produto) avisos.push('O custo do Google Ads é da conta toda: filtrado por produto, o custo por etapa mistura o custo de todos os produtos com os leads de um só.');
      return {
        grafico: { tipo: 'kpis', itens },
        tabela: { colunas: [c('indicador', 'Indicador'), c('valor', 'Valor')], linhas: itens.map((i) => ({ indicador: i.rotulo, valor: i.valor == null ? '—' : i.formato === 'int' ? String(i.valor) : i.valor.toFixed(2) })) },
        avisos,
      };
    },
  },
  {
    id: 'ads-funil-custos',
    pagina: 'ads',
    titulo: 'Funil do Google Ads e custo de cada etapa',
    pergunta: 'Em que etapa o funil perde força e quanto custa chegar em cada uma?',
    como_ler: `Cada linha é uma etapa do funil dos leads da fonte Google ADS. "Passo" = dos negócios que chegaram na etapa anterior, quantos chegaram nesta (nunca passa de 100%); "% dos leads" = parte dos leads que chegou na etapa. Custo da etapa = investimento do período ÷ negócios que chegaram nela. "Chegou em X" inclui quem chegou em X ou além (negócios pulam etapas); ganhos vêm do Status do negócio. ${NOTA_ADS}`,
    largura: 'cheia',
    async rodar(db, f) {
      const [{ colunas, avisos }, cu] = await Promise.all([funisPorFonte(db, f, 6, FONTE_GOOGLE_ADS), custoAds(db, f)]);
      const k = colunas.find((x) => x.total);
      const inv = cu.total.custo;
      const linhas = k
        ? ETAPAS_FUNIL.map((etapa, i) => ({ etapa, negocios: k.valores[i]!, pct_leads: razao(k.valores[i]!, k.leads), passo: k.passos[i] ?? null, custo: razao(inv, k.valores[i]!), acum: null as number | null }))
        : [];
      if (!cu.meses.size) avisos.push(AVISO_SEM_CUSTO);
      return {
        grafico: { tipo: 'barras', formato: 'brl2', itens: linhas.filter((l) => l.custo != null).map((l) => ({ rotulo: l.etapa, valor: l.custo!, detalhe: `${fmtInt(l.negocios)} negócios · ${pct(l.pct_leads)} dos leads` })) },
        tabela: { colunas: [c('etapa', 'Etapa'), c('negocios', 'Negócios', 'int'), c('pct_leads', '% dos leads', 'pct'), c('passo', 'Passo (da etapa anterior)', 'pct'), c('custo', 'Custo da etapa', 'brl2')], linhas: linhas.map(({ acum: _a, ...l }) => l) },
        avisos,
      };
    },
  },
  {
    id: 'ads-por-mes',
    pagina: 'ads',
    titulo: 'Google Ads mês a mês: investimento e custo por etapa',
    pergunta: 'Como o investimento e o custo por lead, MQL, SQL, Reunião Agendada, proposta e ganho evoluem a cada mês?',
    como_ler: `O gráfico mostra o investimento de cada mês. A tabela traz, mês a mês, investimento, cliques, impressões, CPC, os negócios que chegaram em cada etapa (por mês de CRIAÇÃO do negócio), o custo por etapa, o ROAS e o MRR (criado, ganho, perdido, em aberto) com o ticket médio ganho. Meses recentes ainda têm negócios abertos: o custo por ganho deles tende a cair com o tempo. ${NOTA_ADS}`,
    largura: 'cheia',
    async rodar(db, f) {
      const [rows, cu] = await Promise.all([safras(db, f, FONTE_GOOGLE_ADS), custoAds(db, f)]);
      const porMes = new Map(rows.map((r) => [r.safra as string, r]));
      const meses = [...new Set([...cu.meses.keys(), ...porMes.keys()])].sort();
      const linha = (m: string) => {
        const cc = cu.meses.get(m) ?? { custo: 0, cliques: 0, impressoes: 0 };
        const r = porMes.get(m) ?? somarFunil([]);
        return { m, cc, r, k: custosEtapa(cc.custo, r) };
      };
      const L = meses.map(linha);
      const tot = { cc: cu.total, r: somarFunil(rows), k: custosEtapa(cu.total.custo, somarFunil(rows)) };
      const cel = (m: string, x: { cc: Custo; r: Row; k: ReturnType<typeof custosEtapa> }) => ({
        mes: m, invest: x.cc.custo, cliques: x.cc.cliques, impressoes: x.cc.impressoes, cpc: razao(x.cc.custo, x.cc.cliques),
        leads: n(x.r.leads), mql: n(x.r.mql), sql: n(x.r.sql), reuniao: n(x.r.reuniao), proposta: n(x.r.proposta), ganhos: n(x.r.ganhos),
        ...x.k, ...celulasMrr(x.r),
      });
      return {
        grafico: { tipo: 'colunas', categorias: meses, formato: 'brl', series: [{ id: 'invest', nome: 'Investimento', slot: 1, valores: L.map((x) => x.cc.custo) }] },
        tabela: {
          colunas: [
            c('mes', 'Mês'), c('invest', 'Investimento', 'brl'), c('cliques', 'Cliques', 'int'), c('impressoes', 'Impressões', 'int'), c('cpc', 'CPC médio', 'brl2'),
            c('leads', 'Leads', 'int'), c('mql', 'MQL', 'int'), c('sql', 'Chegou em SQL', 'int'), c('reuniao', 'Chegou em Reunião Agendada', 'int'), c('proposta', 'Chegou em proposta', 'int'), c('ganhos', 'Ganhos', 'int'),
            ...COL_CUSTOS, ...colunasMrr(),
          ],
          linhas: [...L.map((x) => cel(x.m, x)), cel('Total do período', tot)],
        },
        avisos: cu.meses.size ? [] : [AVISO_SEM_CUSTO],
      };
    },
  },
  {
    id: 'ads-leads-mes',
    pagina: 'ads',
    titulo: 'Google Ads mês a mês: leads e funil',
    pergunta: 'Quantos leads do Google Ads viram MQL, SQL, Reunião Agendada, proposta e ganho em cada mês?',
    como_ler: `Negócios da fonte Google ADS agrupados pelo mês em que foram CRIADOS. As porcentagens são sobre os leads do mês. ${NOTA_ADS}`,
    largura: 'cheia',
    async rodar(db, f) {
      const rows = await safras(db, f, FONTE_GOOGLE_ADS);
      const avisos = await avisoHistorico(db, f);
      if (rows.length && rows.every((r) => n(r.sql) + n(r.reuniao) + n(r.proposta) === 0)) avisos.unshift(SEM_MARCOS);
      return {
        grafico: {
          tipo: 'colunas',
          categorias: rows.map((r) => r.safra as string),
          series: [
            { id: 'leads', nome: 'Leads', slot: 1, valores: rows.map((r) => n(r.leads)) },
            { id: 'mql', nome: 'MQL', slot: 2, valores: rows.map((r) => n(r.mql)) },
            { id: 'ganhos', nome: 'Ganhos', slot: 3, valores: rows.map((r) => n(r.ganhos)) },
          ],
        },
        tabela: {
          colunas: [c('mes', 'Mês de criação'), c('leads', 'Leads', 'int'), c('mql', 'MQL', 'int'), c('sql', 'Chegou em SQL', 'int'), c('reuniao', 'Chegou em Reunião Agendada', 'int'), c('proposta', 'Chegou em proposta', 'int'), c('ganhos', 'Ganhos', 'int'), c('perdidos', 'Perdidos', 'int'), c('abertos', 'Abertos', 'int'), c('pmql', '% MQL', 'pct'), c('psql', '% chegou SQL', 'pct'), c('preun', '% chegou Reunião Agendada', 'pct'), c('pprop', '% chegou proposta', 'pct'), c('pganho', '% ganho', 'pct'), c('taxa', 'Taxa de ganho', 'pct')],
          linhas: rows.map((r) => ({
            mes: r.safra, leads: n(r.leads), mql: n(r.mql), sql: n(r.sql), reuniao: n(r.reuniao), proposta: n(r.proposta), ganhos: n(r.ganhos), perdidos: n(r.perdidos), abertos: n(r.abertos),
            pmql: razao(n(r.mql), n(r.leads)), psql: razao(n(r.sql), n(r.leads)), preun: razao(n(r.reuniao), n(r.leads)), pprop: razao(n(r.proposta), n(r.leads)), pganho: razao(n(r.ganhos), n(r.leads)), taxa: razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos)),
          })),
        },
        avisos,
      };
    },
  },
  {
    id: 'ads-campanhas',
    pagina: 'ads',
    titulo: 'Google Ads por campanha: investimento',
    pergunta: 'Em quais campanhas o dinheiro foi gasto?',
    como_ler: `Custo, cliques e impressões por campanha no período (as 25 com mais investimento). Os LEADS ainda não são ligados a cada campanha: o campo "UTM Campaign" do Pipedrive traz nomes soltos ("blindagem", "Institucional", "SoftwareDP"...) que não batem com o nome das campanhas do Google Ads; para ligar é preciso uma tabela de correspondência (nome da UTM → campanha), a ser definida com o Pablo. ${NOTA_ADS}`,
    largura: 'cheia',
    async rodar(db, f) {
      const rows = await q(
        db,
        `select campanha_id, campanha, sum(custo)::float8 as custo, sum(cliques)::float8 as cliques, sum(impressoes)::float8 as impressoes
           from analytics.ads_investimento_dia where dia between $1::date and $2::date and (custo > 0 or cliques > 0)
          group by 1, 2 order by custo desc, 2 limit 25`,
        [f.de, f.ate],
      );
      const total = rows.reduce((s, r) => s + n(r.custo), 0);
      return {
        grafico: { tipo: 'barras', formato: 'brl', itens: rows.slice(0, 10).map((r) => ({ rotulo: (r.campanha as string) || '(sem campanha)', valor: n(r.custo), detalhe: `${fmtInt(n(r.cliques))} cliques · CPC ${razao(n(r.custo), n(r.cliques)) == null ? '—' : `R$ ${razao(n(r.custo), n(r.cliques))!.toFixed(2).replace('.', ',')}`}` })) },
        tabela: {
          colunas: [c('campanha', 'Campanha'), c('id', 'ID'), c('custo', 'Investimento', 'brl'), c('part', '% do investimento', 'pct'), c('cliques', 'Cliques', 'int'), c('impressoes', 'Impressões', 'int'), c('cpc', 'CPC médio', 'brl2')],
          linhas: rows.map((r) => ({ campanha: (r.campanha as string) || '(sem campanha)', id: r.campanha_id || null, custo: n(r.custo), part: razao(n(r.custo), total), cliques: n(r.cliques), impressoes: n(r.impressoes), cpc: razao(n(r.custo), n(r.cliques)) })),
        },
        avisos: rows.length ? [] : [AVISO_SEM_CUSTO],
      };
    },
  },

  /* ===================== META ADS (custo e desempenho da Meta + funil dos leads ligados ao anúncio) ===================== */
  {
    id: 'meta-resumo',
    pagina: 'meta',
    titulo: 'Meta Ads: visão geral do período',
    pergunta: 'Quanto foi investido na Meta, com que desempenho e o que isso trouxe, do lead ao ganho?',
    como_ler: `Resumo de todo o período filtrado. ${NOTA_META}`,
    largura: 'cheia',
    async rodar(db, f) {
      const [g, funil] = await Promise.all([totalGastoMeta(db, f), funilPorChave(db, f, 'n.deal_id')]);
      const t = somaFunil(funil.values());
      const inv = n(g.gasto);
      const x = taxasMeta(g);
      const k = custosEtapa(inv, t);
      const itens = [
        { id: 'invest', rotulo: 'Investimento', valor: inv, formato: 'brl' as const, dica: 'Gasto informado pela Meta no período' },
        { id: 'impressoes', rotulo: 'Impressões', valor: n(g.impressoes), formato: 'int' as const },
        { id: 'cliques_link', rotulo: 'Cliques no link', valor: n(g.cliques_link), formato: 'int' as const },
        { id: 'cpm', rotulo: 'CPM', valor: x.cpm, formato: 'brl2' as const, dica: 'Gasto ÷ impressões × 1000' },
        { id: 'cpc', rotulo: 'CPC (link)', valor: x.cpc, formato: 'brl2' as const, dica: 'Gasto ÷ cliques no link' },
        { id: 'ctr', rotulo: 'CTR (link)', valor: x.ctr, formato: 'pct' as const, dica: 'Cliques no link ÷ impressões' },
        { id: 'connect', rotulo: 'Connect Rate', valor: x.connect, formato: 'pct' as const, dica: 'Visitas à página ÷ cliques no link' },
        { id: 'hook', rotulo: 'Hook rate', valor: x.hook, formato: 'pct' as const, dica: 'Visualizações de 3 s ÷ impressões dos anúncios com vídeo' },
        { id: 'hold', rotulo: 'Hold rate', valor: x.hold, formato: 'pct' as const, dica: 'ThruPlays ÷ visualizações de 3 s' },
        { id: 'leads_meta', rotulo: 'Leads (Meta)', valor: n(g.leads_meta), formato: 'int' as const, dica: 'Leads que a Meta atribui aos anúncios' },
        { id: 'leads', rotulo: 'Leads (Pipedrive)', valor: n(t.leads), formato: 'int' as const, dica: 'Negócios da fonte Meta ADS que contam como lead' },
        { id: 'mql', rotulo: 'MQL', valor: n(t.mql), formato: 'int' as const },
        { id: 'sql', rotulo: 'Chegou em SQL', valor: n(t.sql), formato: 'int' as const },
        { id: 'reuniao', rotulo: 'Chegou em Reunião Agendada', valor: n(t.reuniao), formato: 'int' as const },
        { id: 'proposta', rotulo: 'Chegou em proposta', valor: n(t.proposta), formato: 'int' as const },
        { id: 'ganhos', rotulo: 'Ganhos', valor: n(t.ganhos), formato: 'int' as const },
        { id: 'cpl', rotulo: 'Custo por lead', valor: k.cpl, formato: 'brl2' as const, dica: 'Investimento ÷ leads do Pipedrive' },
        { id: 'c_mql', rotulo: 'Custo por MQL', valor: k.c_mql, formato: 'brl2' as const },
        { id: 'c_sql', rotulo: 'Custo por SQL', valor: k.c_sql, formato: 'brl2' as const },
        { id: 'c_reuniao', rotulo: 'Custo por Reunião Agendada', valor: k.c_reuniao, formato: 'brl2' as const },
        { id: 'c_proposta', rotulo: 'Custo por proposta', valor: k.c_proposta, formato: 'brl2' as const },
        { id: 'cac', rotulo: 'Custo por ganho (CAC)', valor: k.cac, formato: 'brl2' as const },
        { id: 'roas', rotulo: 'ROAS', valor: k.roas, formato: 'dec' as const, dica: 'MRR ganho ÷ investimento' },
        ...mrrKpis(t),
      ];
      return {
        grafico: { tipo: 'kpis', itens },
        tabela: { colunas: [c('indicador', 'Indicador'), c('valor', 'Valor')], linhas: itens.map((i) => ({ indicador: i.rotulo, valor: i.valor == null ? '—' : i.formato === 'int' ? String(i.valor) : i.valor.toFixed(i.formato === 'pct' ? 4 : 2) })) },
        avisos: inv > 0 ? [] : [AVISO_SEM_META],
      };
    },
  },
  {
    id: 'meta-serie',
    pagina: 'meta',
    titulo: 'Meta Ads no tempo: diário, semanal, mensal e trimestral',
    pergunta: 'Como o investimento, o CPL, o CPM, o CPC e o CTR evoluem no tempo, e onde estão os picos e as quedas?',
    como_ler: `Escolha a granularidade (dia, semana, mês ou trimestre) e as métricas: cada métrica ganha o seu gráfico, na mesma linha do tempo e com a sua própria escala (nunca dois eixos num gráfico só). Semana começa na segunda-feira. Tudo é calculado das somas do período escolhido (CPL = investimento ÷ leads; CPM = investimento ÷ impressões × 1000; CPC e CTR são dos cliques NO LINK). CPL (Pipedrive) usa os negócios Meta ADS CRIADOS no dia; CPL (Meta) usa os leads que a Meta atribui aos anúncios. A primeira e a última semana, mês ou trimestre podem estar incompletos se o período filtrado os corta. ${NOTA_META}`,
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroGasto(f, p);
      const p2: unknown[] = [];
      const w2 = filtroMeta(f, p2);
      const [dias, leads] = await Promise.all([
        q(db, `select m.dia::text as dia, ${METRICAS_META('m')} from analytics.meta_desempenho_dia m where ${w.join(' and ')} group by 1 order by 1`, p),
        q(db, `select to_char(d.criado_em at time zone ${TZ}, 'YYYY-MM-DD') as dia, count(*) filter (where d.conta_como_lead)::int as leads from analytics.negocios_bi d where ${w2.join(' and ')} group by 1`, p2),
      ]);
      const ld = new Map(leads.map((r) => [r.dia as string, n(r.leads)]));
      const gd = new Map(dias.map((r) => [r.dia as string, r]));
      const pontos = [...new Set([...gd.keys(), ...ld.keys()])].sort().map((dia) => {
        const g = gd.get(dia) ?? {};
        return { dia, gasto: n(g.gasto), impressoes: n(g.impressoes), cliques_link: n(g.cliques_link), visitas: n(g.visitas), leads_meta: n(g.leads_meta), leads: ld.get(dia) ?? 0 };
      });
      return {
        grafico: { tipo: 'serie', pontos },
        tabela: {
          colunas: [c('dia', 'Dia'), c('gasto', 'Investimento', 'brl'), c('impressoes', 'Impressões', 'int'), c('cliques_link', 'Cliques no link', 'int'), c('cpm', 'CPM', 'brl2'), c('cpc', 'CPC (link)', 'brl2'), c('ctr', 'CTR (link)', 'pct'),
            c('leads_meta', 'Leads (Meta)', 'int'), c('leads', 'Leads (Pipedrive)', 'int'), c('cpl_meta', 'CPL (Meta)', 'brl2'), c('cpl', 'CPL (Pipedrive)', 'brl2')],
          linhas: pontos.map((x) => ({
            dia: x.dia, gasto: x.gasto, impressoes: x.impressoes, cliques_link: x.cliques_link, cpm: x.impressoes > 0 ? (x.gasto / x.impressoes) * 1000 : null, cpc: razao(x.gasto, x.cliques_link),
            ctr: razao(x.cliques_link, x.impressoes), leads_meta: x.leads_meta, leads: x.leads, cpl_meta: razao(x.gasto, x.leads_meta), cpl: razao(x.gasto, x.leads),
          })),
        },
        avisos: dias.length ? [] : [AVISO_SEM_META],
      };
    },
  },
  {
    id: 'meta-funil-custos',
    pagina: 'meta',
    titulo: 'Funil da Meta e custo de cada etapa',
    pergunta: 'Em que etapa o funil perde força e quanto custa chegar em cada uma?',
    como_ler: `Cada linha é uma etapa do funil dos leads da fonte Meta ADS. "Passo" = dos que chegaram na etapa anterior, quantos chegaram nesta (nunca passa de 100%). "Chegou em X" inclui quem chegou em X ou além; ganhos vêm do Status. ${NOTA_META}`,
    largura: 'cheia',
    async rodar(db, f) {
      const [{ colunas, avisos }, g] = await Promise.all([funisPorFonte(db, f, 6, FONTE_META_ADS), totalGastoMeta(db, f)]);
      const k = colunas.find((x) => x.total);
      const inv = n(g.gasto);
      const linhas = k ? ETAPAS_FUNIL.map((etapa, i) => ({ etapa, negocios: k.valores[i]!, pct_leads: razao(k.valores[i]!, k.leads), passo: k.passos[i] ?? null, custo: razao(inv, k.valores[i]!) })) : [];
      if (inv <= 0) avisos.push(AVISO_SEM_META);
      return {
        grafico: { tipo: 'barras', formato: 'brl2', itens: linhas.filter((l) => l.custo != null).map((l) => ({ rotulo: l.etapa, valor: l.custo!, detalhe: `${fmtInt(l.negocios)} negócios · ${pct(l.pct_leads)} dos leads` })) },
        tabela: { colunas: [c('etapa', 'Etapa'), c('negocios', 'Negócios', 'int'), c('pct_leads', '% dos leads', 'pct'), c('passo', 'Passo (da etapa anterior)', 'pct'), c('custo', 'Custo da etapa', 'brl2')], linhas },
        avisos,
      };
    },
  },
  {
    id: 'meta-por-mes',
    pagina: 'meta',
    titulo: 'Meta Ads mês a mês: investimento, desempenho e custo por etapa',
    pergunta: 'Como o investimento, o CPM, o CPC, o CTR, o Connect Rate e o custo por lead, MQL, SQL, Reunião Agendada, proposta e ganho evoluem a cada mês?',
    como_ler: `O gráfico mostra o investimento por mês. A tabela traz, por mês, o desempenho da Meta (investimento, impressões, cliques no link, CPM, CPC, CTR, Connect, Hook e Hold), o funil dos negócios CRIADOS no mês, o custo por etapa, o ROAS e o MRR. Meses recentes têm negócios abertos: o custo por ganho deles tende a cair. ${NOTA_META}`,
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroGasto(f, p);
      const [gastoMes, rows] = await Promise.all([
        q(db, `select to_char(m.dia, 'YYYY-MM') as mes, ${METRICAS_META('m')} from analytics.meta_desempenho_dia m where ${w.join(' and ')} group by 1 order by 1`, p),
        safras(db, f, FONTE_META_ADS),
      ]);
      const porMes = new Map(rows.map((r) => [r.safra as string, r]));
      const gm = new Map(gastoMes.map((r) => [r.mes as string, r]));
      const meses = [...new Set([...gm.keys(), ...porMes.keys()])].sort();
      const tot = await totalGastoMeta(db, f);
      const cel = (mes: string, g: Row, r: Row) => ({
        mes, gasto: n(g.gasto), impressoes: n(g.impressoes), cliques_link: n(g.cliques_link), ...taxasMeta(g), leads_meta: n(g.leads_meta),
        ...celulasFunilMeta(r), ...custosEtapa(n(g.gasto), r), ...celulasMrr(r),
      });
      const linhas = meses.map((m) => cel(m, gm.get(m) ?? {}, porMes.get(m) ?? FUNIL_VAZIO));
      linhas.push(cel('Total do período', tot, somarFunil(rows)));
      return {
        grafico: { tipo: 'colunas', categorias: meses, formato: 'brl', series: [{ id: 'invest', nome: 'Investimento', slot: 1, valores: meses.map((m) => n(gm.get(m)?.gasto)) }] },
        tabela: { colunas: [c('mes', 'Mês'), c('gasto', 'Investimento', 'brl'), c('impressoes', 'Impressões', 'int'), c('cliques_link', 'Cliques no link', 'int'), ...COL_TAXAS_META, c('leads_meta', 'Leads (Meta)', 'int'), ...COL_FUNIL_META, ...COL_CUSTOS, ...colunasMrr()], linhas },
        avisos: gastoMes.length ? [] : [AVISO_SEM_META],
      };
    },
  },
  {
    id: 'meta-leads-mes',
    pagina: 'meta',
    titulo: 'Meta Ads mês a mês: leads e funil',
    pergunta: 'Quantos leads da Meta viram MQL, SQL, Reunião Agendada, proposta e ganho em cada mês?',
    como_ler: `Negócios da fonte Meta ADS agrupados pelo mês em que foram CRIADOS; as porcentagens são sobre os leads do mês. ${NOTA_META}`,
    largura: 'cheia',
    async rodar(db, f) {
      const rows = await safras(db, f, FONTE_META_ADS);
      const avisos = await avisoHistorico(db, f);
      if (rows.length && rows.every((r) => n(r.sql) + n(r.reuniao) + n(r.proposta) === 0)) avisos.unshift(SEM_MARCOS);
      return {
        grafico: {
          tipo: 'colunas', categorias: rows.map((r) => r.safra as string),
          series: [
            { id: 'leads', nome: 'Leads', slot: 1, valores: rows.map((r) => n(r.leads)) },
            { id: 'mql', nome: 'MQL', slot: 2, valores: rows.map((r) => n(r.mql)) },
            { id: 'ganhos', nome: 'Ganhos', slot: 3, valores: rows.map((r) => n(r.ganhos)) },
          ],
        },
        tabela: {
          colunas: [c('mes', 'Mês de criação'), ...COL_FUNIL_META, c('perdidos', 'Perdidos', 'int'), c('abertos', 'Abertos', 'int'), c('pmql', '% MQL', 'pct'), c('psql', '% chegou SQL', 'pct'), c('preun', '% chegou Reunião Agendada', 'pct'), c('pprop', '% chegou proposta', 'pct'), c('pganho', '% ganho', 'pct'), c('taxa', 'Taxa de ganho', 'pct'), ...colunasMrr()],
          linhas: rows.map((r) => ({
            mes: r.safra, ...celulasFunilMeta(r), perdidos: n(r.perdidos), abertos: n(r.abertos), pmql: razao(n(r.mql), n(r.leads)), psql: razao(n(r.sql), n(r.leads)), preun: razao(n(r.reuniao), n(r.leads)),
            pprop: razao(n(r.proposta), n(r.leads)), pganho: razao(n(r.ganhos), n(r.leads)), taxa: razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos)), ...celulasMrr(r),
          })),
        },
        avisos,
      };
    },
  },
  ...(['campanha', 'conjunto', 'anuncio'] as const).map((nivel): BiAnalise => ({
    id: `meta-${nivel === 'anuncio' ? 'criativos' : nivel === 'conjunto' ? 'conjuntos' : 'campanhas'}`,
    pagina: 'meta',
    titulo: nivel === 'campanha' ? 'Meta Ads por campanha' : nivel === 'conjunto' ? 'Meta Ads por conjunto de anúncios' : 'Meta Ads por anúncio (criativo)',
    pergunta: nivel === 'campanha' ? 'Quais campanhas gastam mais e quais trazem leads, ganhos e MRR?' : nivel === 'conjunto' ? 'Quais públicos (conjuntos) performam melhor, do clique ao ganho?' : 'Quais criativos performam melhor, do CPM ao ganho?',
    como_ler: `Os ${nivel === 'anuncio' ? 40 : 30} ${nivel === 'campanha' ? 'campanhas' : nivel === 'conjunto' ? 'conjuntos' : 'anúncios'} com maior investimento no período, com ID e nome juntos. As colunas do funil vêm dos negócios do Pipedrive ligados a ${nivel === 'campanha' ? 'cada campanha' : nivel === 'conjunto' ? 'cada conjunto' : 'cada anúncio'}: negócios que só puderam ser ligados a um nível acima (ambíguos, só campanha...) aparecem na linha "negócios sem ligação" e entram no total. ${NOTA_META}`,
    largura: 'cheia',
    async rodar(db, f) {
      const r = await metaPorNivel(db, f, nivel, nivel === 'anuncio' ? 40 : 30);
      return { grafico: { tipo: 'barras', formato: 'brl', itens: r.barras }, tabela: { colunas: r.colunas, linhas: r.linhas }, avisos: r.avisos };
    },
  })),
  {
    id: 'meta-video',
    pagina: 'meta',
    titulo: 'Vídeos: gancho, retenção e tempo assistido',
    pergunta: 'Quais vídeos seguram a atenção até o fim?',
    como_ler: `Só anúncios com reprodução de vídeo no período (os 20 com maior investimento). Hook rate = visualizações de 3 s ÷ impressões; Hold rate = ThruPlays ÷ visualizações de 3 s; retenção = parte das reproduções que chegou a 25%, 50%, 75%, 95% e 100% do vídeo (cor mais escura = maior retenção em cada coluna); tempo médio = segundos assistidos por reprodução (média ponderada pelas reproduções). ${NOTA_META}`,
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroGasto(f, p);
      const rows = await q(
        db,
        `select m.anuncio_id::text as chave, max(m.anuncio) as nome, max(m.campanha) as campanha, ${METRICAS_META('m')}
           from analytics.meta_desempenho_dia m where ${w.join(' and ')} group by m.anuncio_id having sum(m.video_reproducoes) > 0 order by sum(m.gasto) desc limit 20`,
        p,
      );
      const x = rows.map((r) => ({ r, t: taxasMeta(r) }));
      return {
        grafico: { tipo: 'matriz', colunas: ['Hook', 'Hold', '25%', '50%', '75%', '95%', '100%'], formato: 'pct', escala: 'coluna', linhas: x.map(({ r, t }) => ({ rotulo: (r.nome as string) || `#${r.chave}`, detalhe: `R$ ${n(r.gasto).toFixed(0)} · ${fmtInt(n(r.vplays))} reproduções`, valores: [t.hook, t.hold, t.ret25, t.ret50, t.ret75, t.ret95, t.ret100] })) },
        tabela: {
          colunas: [c('nome', 'Anúncio'), c('id', 'ID'), c('campanha', 'Campanha'), c('gasto', 'Investimento', 'brl'), c('impressoes', 'Impressões', 'int'), c('vplays', 'Reproduções', 'int'), c('v3s', 'Visualizações de 3 s', 'int'), c('thru', 'ThruPlays', 'int'), c('hook', 'Hook rate', 'pct'), c('hold', 'Hold rate', 'pct'), c('ret25', 'Retenção 25%', 'pct'), c('ret50', 'Retenção 50%', 'pct'), c('ret75', 'Retenção 75%', 'pct'), c('ret95', 'Retenção 95%', 'pct'), c('ret100', 'Retenção 100%', 'pct'), c('tempo', 'Tempo médio (s)', 'dec')],
          linhas: x.map(({ r, t }) => ({ nome: r.nome, id: r.chave, campanha: r.campanha, gasto: n(r.gasto), impressoes: n(r.impressoes), vplays: n(r.vplays), v3s: n(r.v3s), thru: n(r.thru), hook: t.hook, hold: t.hold, ret25: t.ret25, ret50: t.ret50, ret75: t.ret75, ret95: t.ret95, ret100: t.ret100, tempo: t.tempo })),
        },
        avisos: rows.length ? [] : ['Nenhum anúncio com reprodução de vídeo neste período.'],
      };
    },
  },
  ...(['dor', 'modulo'] as const).map((eixo): BiAnalise => ({
    id: eixo === 'dor' ? 'meta-dor' : 'meta-modulo',
    pagina: 'meta',
    titulo: eixo === 'dor' ? 'Meta Ads por DOR e Mensagem' : 'Meta Ads por Módulo de Interesse',
    pergunta: eixo === 'dor' ? 'Que dores e mensagens trazem mais leads, ganhos e MRR, e a que custo?' : 'Que módulos de interesse trazem mais leads, ganhos e MRR, e a que custo?',
    como_ler: `${eixo === 'dor' ? 'DOR, Mensagem' : 'Módulo de Interesse'} vêm do agrupamento virtual dos criativos feito na aba "Criativos" do Painel de Dados (a ligação é pelo NOME do criativo: UTM Term do negócio e nome do anúncio, sem diferenciar maiúsculas e espaços). "(em branco)" = criativos ainda sem esse mapeamento, inclusive anúncios que não geraram nenhum lead. Os leads e o funil são dos negócios CRIADOS no período; o investimento, dos anúncios com esse nome. ${NOTA_META}`,
    largura: 'cheia',
    async rodar(db, f) {
      const BR = `'(em branco)'`;
      const campoD = eixo === 'dor' ? `coalesce(n.dor, ${BR}) || ' › ' || coalesce(n.mensagem, ${BR})` : `coalesce(n.modulo, ${BR})`;
      const campoG = eixo === 'dor' ? `coalesce(cm.dor, ${BR}) || ' › ' || coalesce(cm.mensagem, ${BR})` : `coalesce(cm.modulo, ${BR})`;
      const p: unknown[] = [];
      const w = filtroGasto(f, p);
      const [gasto, funil] = await Promise.all([
        q(db, `select ${campoG} as chave, ${METRICAS_META('m')} from analytics.meta_desempenho_dia m left join analytics.criativos_meta cm on cm.termo_chave = mkt.chave_criativo(m.anuncio) where ${w.join(' and ')} group by 1`, p),
        funilPorChave(db, f, campoD, 'analytics.negocios_criativo'),
      ]);
      const gm = new Map(gasto.map((r) => [r.chave as string, r]));
      const chaves = [...new Set([...gm.keys(), ...[...funil.keys()].filter((k): k is string => k != null)])];
      const linhas = chaves
        .map((chave) => { const g = gm.get(chave) ?? {}; const fn = funil.get(chave) ?? FUNIL_VAZIO; return { chave, g, fn }; })
        .sort((a, b) => n(b.g.gasto) - n(a.g.gasto) || n(b.fn.leads) - n(a.fn.leads))
        .map(({ chave, g, fn }) => ({ nome: chave, gasto: n(g.gasto), impressoes: n(g.impressoes), cliques_link: n(g.cliques_link), ...taxasMeta(g), ...celulasFunilMeta(fn), ...custosEtapa(n(g.gasto), fn), ...celulasMrr(fn) }));
      return {
        grafico: { tipo: 'barras', formato: 'brl', itens: linhas.filter((l) => l.gasto > 0).slice(0, 12).map((l) => ({ rotulo: l.nome, valor: l.gasto, detalhe: `${fmtInt(l.leads)} leads · ${fmtInt(l.ganhos)} ganhos · MRR ganho R$ ${fmtInt(l.valor)}` })) },
        tabela: { colunas: [c('nome', eixo === 'dor' ? 'DOR › Mensagem' : 'Módulo de Interesse'), c('gasto', 'Investimento', 'brl'), c('impressoes', 'Impressões', 'int'), c('cliques_link', 'Cliques no link', 'int'), ...COL_TAXAS_META, ...COL_FUNIL_META, ...COL_CUSTOS, ...colunasMrr()], linhas },
        avisos: gasto.length ? [] : [AVISO_SEM_META],
      };
    },
  })),
  {
    id: 'meta-cobertura',
    pagina: 'meta',
    titulo: 'Cobertura: como os negócios foram ligados à Meta',
    pergunta: 'Que parte dos negócios da Meta conseguimos ligar a um anúncio, e por qual método?',
    como_ler: 'Por mês de criação do negócio, quantos negócios do Pipedrive com cara de Meta foram ligados por cada método: ad_id (o ID do anúncio no Pipedrive, o principal), conjunto_id, campanha_id+nome (campanha pelo ID e anúncio pelo nome), nome (só pelos nomes das UTMs), campanha_id/campanha_nome (só a campanha), ambiguo (o nome bate com mais de um anúncio) e sem_ligacao. A cor do mapa mostra a parte de cada método no mês (mais escuro = maior). Antes de ago/2025 o Pipedrive quase não guarda o ID do anúncio, então a ligação depende dos nomes.',
    largura: 'cheia',
    async rodar(db, f) {
      const rows = await q(
        db,
        `select mes, metodo, sum(negocios)::int as negocios from analytics.meta_cobertura where mes >= $1 and mes <= $2 group by 1, 2 order by 1`,
        [f.de.slice(0, 7), f.ate.slice(0, 7)],
      );
      const metodos = ['ad_id', 'conjunto_id', 'campanha_id+nome', 'nome', 'campanha_id', 'campanha_nome', 'ambiguo', 'sem_ligacao'];
      const meses = [...new Set(rows.map((r) => r.mes as string))].sort();
      const val = (m: string, k: string) => n(rows.find((r) => r.mes === m && r.metodo === k)?.negocios);
      const total = (m: string) => metodos.reduce((s, k) => s + val(m, k), 0);
      const ligados = (m: string) => val(m, 'ad_id') + val(m, 'conjunto_id') + val(m, 'campanha_id+nome') + val(m, 'nome');
      return {
        grafico: { tipo: 'matriz', colunas: metodos, formato: 'pct', escala: 'linha', linhas: meses.map((m) => ({ rotulo: m, detalhe: `${fmtInt(total(m))} negócios`, valores: metodos.map((k) => razao(val(m, k), total(m))) })) },
        tabela: {
          colunas: [c('mes', 'Mês de criação'), c('total', 'Negócios', 'int'), ...metodos.map((k) => c(k, k, 'int')), c('pligado', '% ligado a anúncio', 'pct')],
          linhas: meses.map((m) => ({ mes: m, total: total(m), ...Object.fromEntries(metodos.map((k) => [k, val(m, k)])), pligado: razao(ligados(m), total(m)) })),
        },
        avisos: rows.length ? [] : ['Ainda não há ligação calculada (rode a sincronização da Meta).'],
      };
    },
  },

  /* ===================== SITE E PÁGINAS (Google Analytics + funil por URL) ===================== */
  {
    id: 'site-resumo',
    pagina: 'site',
    titulo: 'Desempenho do site no período',
    pergunta: 'Quanto tráfego o site recebeu e como isso se compara ao período anterior?',
    como_ler: `Dados do Google Analytics 4 da propriedade do QuarkRH. Sessões = acessos. Novos usuários = pessoas que chegaram ao site pela primeira vez. Usuários ativos por dia = média dos usuários ativos de cada dia (usuários não se somam entre dias: a mesma pessoa que volta em 3 dias conta 3 vezes se somada, por isso o indicador é a média diária). Taxa de engajamento = sessões engajadas ÷ sessões. A comparação é com o período imediatamente anterior, do mesmo tamanho. ${NOTA_SITE}`,
    largura: 'cheia',
    async rodar(db, f) {
      const k = nDias(f);
      const dePrev = somaDias(f.de, -k);
      const atePrev = somaDias(f.de, -1);
      const soma = async (a: string, b: string) =>
        (
          await q(
            db,
            `select coalesce(sum(sessoes),0)::int as s, coalesce(sum(usuarios_novos),0)::int as nu, coalesce(avg(usuarios_ativos),0)::float8 as ua,
                    coalesce(sum(visualizacoes),0)::int as v, coalesce(sum(sessoes_engajadas),0)::int as e, count(*)::int as dias
               from analytics.site_dia where dia between $1::date and $2::date`,
            [a, b],
          )
        )[0]!;
      const [x, y] = [await soma(f.de, f.ate), await soma(dePrev, atePrev)];
      const itens = [
        { id: 'sessoes', rotulo: 'Sessões (acessos)', a: n(x.s), b: n(y.s), formato: 'int' as const },
        { id: 'novos', rotulo: 'Novos usuários', a: n(x.nu), b: n(y.nu), formato: 'int' as const },
        { id: 'ativos', rotulo: 'Usuários ativos por dia (média)', a: Math.round(n(x.ua)), b: Math.round(n(y.ua)), formato: 'int' as const },
        { id: 'views', rotulo: 'Visualizações de página', a: n(x.v), b: n(y.v), formato: 'int' as const },
        { id: 'engaj', rotulo: 'Taxa de engajamento', a: razao(n(x.e), n(x.s)), b: razao(n(y.e), n(y.s)), formato: 'pct' as const },
        { id: 'pps', rotulo: 'Páginas por sessão', a: razao(n(x.v), n(x.s)), b: razao(n(y.v), n(y.s)), formato: 'num' as const },
      ];
      const txt = (v: number | null, formato: 'int' | 'pct' | 'num') => (v == null ? '—' : formato === 'int' ? fmtInt(v) : formato === 'pct' ? pct(v).replace('.', ',') : v.toFixed(2).replace('.', ','));
      const dica = (i: (typeof itens)[number]) => {
        const v = i.a != null && i.b != null ? variacao(i.a, i.b) : null;
        return `Período anterior (${dePrev} a ${atePrev}): ${txt(i.b, i.formato)}${v == null ? '' : ` (${v >= 0 ? '+' : ''}${(v * 100).toFixed(1).replace('.', ',')}%)`}`;
      };
      return {
        grafico: {
          tipo: 'kpis',
          itens: itens.map((i) => ({ id: i.id, rotulo: i.rotulo, valor: i.a, formato: i.formato === 'num' ? ('dec' as const) : i.formato, dica: dica(i) })),
        },
        tabela: {
          colunas: [c('indicador', 'Indicador'), c('atual', 'Período'), c('anterior', 'Período anterior'), c('variacao', 'Variação', 'pct')],
          linhas: itens.map((i) => ({ indicador: i.rotulo, atual: txt(i.a, i.formato), anterior: txt(i.b, i.formato), variacao: i.a != null && i.b != null ? variacao(i.a, i.b) : null })),
        },
        avisos: n(x.dias) === 0 ? [AVISO_SEM_GA4] : [],
      };
    },
  },
  {
    id: 'site-acessos',
    pagina: 'site',
    titulo: 'Acessos ao longo do tempo',
    pergunta: 'O tráfego do site está subindo ou caindo?',
    como_ler: `Sessões (acessos) e novos usuários por dia (períodos de até 62 dias), por semana (até 200 dias) ou por mês (períodos maiores). A tabela traz também a média de usuários ativos por dia, as visualizações e a taxa de engajamento. ${NOTA_SITE}`,
    largura: 'cheia',
    async rodar(db, f) {
      const k = nDias(f);
      const g = k <= 62 ? 'day' : k <= 200 ? 'week' : 'month';
      const rows = await q(
        db,
        `select to_char(date_trunc('${g}', dia::timestamp), '${g === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'}') as per, sum(sessoes)::int as s, sum(usuarios_novos)::int as nu,
                avg(usuarios_ativos)::float8 as ua, sum(visualizacoes)::int as v, sum(sessoes_engajadas)::int as e
           from analytics.site_dia where dia between $1::date and $2::date group by 1 order by 1`,
        [f.de, f.ate],
      );
      return {
        grafico: {
          tipo: 'colunas',
          categorias: rows.map((r) => r.per as string),
          series: [
            { id: 'sessoes', nome: 'Sessões', slot: 1, valores: rows.map((r) => n(r.s)) },
            { id: 'novos', nome: 'Novos usuários', slot: 2, valores: rows.map((r) => n(r.nu)) },
          ],
        },
        tabela: {
          colunas: [c('periodo', g === 'day' ? 'Dia' : g === 'week' ? 'Semana (início na segunda)' : 'Mês'), c('sessoes', 'Sessões', 'int'), c('novos', 'Novos usuários', 'int'), c('ativos', 'Usuários ativos por dia (média)', 'int'), c('views', 'Visualizações', 'int'), c('engaj', 'Taxa de engajamento', 'pct')],
          linhas: rows.map((r) => ({ periodo: r.per, sessoes: n(r.s), novos: n(r.nu), ativos: Math.round(n(r.ua)), views: n(r.v), engaj: razao(n(r.e), n(r.s)) })),
        },
        avisos: rows.length ? [] : [AVISO_SEM_GA4],
      };
    },
  },
  {
    id: 'site-paginas',
    pagina: 'site',
    titulo: 'Páginas que mais trazem acessos',
    pergunta: 'Por quais páginas as pessoas entram no site?',
    como_ler: `Páginas de ENTRADA (a primeira página da sessão), com domínio e caminho; "(sem pagina)" são sessões em que o GA4 não informou a página. Mostra as 40 com mais sessões. Engajamento = sessões engajadas ÷ sessões. ${NOTA_SITE}`,
    largura: 'cheia',
    async rodar(db, f) {
      const rows = await q(
        db,
        `select ${HOST_GA4} as host, s.caminho, sum(s.sessoes)::int as s, sum(s.usuarios_novos)::int as nu, sum(s.sessoes_engajadas)::int as e, sum(s.visualizacoes)::int as v
           from analytics.site_sessoes_dia s where s.dia between $1::date and $2::date group by 1, 2 order by s desc, 1, 2 limit 40`,
        [f.de, f.ate],
      );
      const tot = n((await q(db, `select coalesce(sum(sessoes),0)::int as s from analytics.site_dia where dia between $1::date and $2::date`, [f.de, f.ate]))[0]!.s);
      return {
        grafico: { tipo: 'barras', formato: 'int', itens: rows.slice(0, 10).map((r) => ({ rotulo: paginaRotulo(r.host, r.caminho), valor: n(r.s), detalhe: `${fmtInt(n(r.nu))} novos usuários · engajamento ${pct(razao(n(r.e), n(r.s)))}` })) },
        tabela: {
          colunas: [c('pagina', 'Página de entrada'), c('sessoes', 'Sessões', 'int'), c('part', '% das sessões do site', 'pct'), c('novos', 'Novos usuários', 'int'), c('engaj', 'Taxa de engajamento', 'pct'), c('views', 'Visualizações', 'int')],
          linhas: rows.map((r) => ({ pagina: paginaRotulo(r.host, r.caminho), sessoes: n(r.s), part: razao(n(r.s), tot), novos: n(r.nu), engaj: razao(n(r.e), n(r.s)), views: n(r.v) })),
        },
        avisos: rows.length ? [] : [AVISO_SEM_GA4],
      };
    },
  },
  {
    id: 'site-fontes',
    pagina: 'site',
    titulo: 'De onde vêm os acessos',
    pergunta: 'Quais fontes e mídias trazem mais tráfego e com que qualidade?',
    como_ler: `Fonte e mídia da sessão, como o GA4 as classifica (google / organic, google / cpc, instagram / social...). Mostra as 20 com mais sessões. É a origem do TRÁFEGO; a fonte do LEAD (campo do Pipedrive) está nas páginas Canais e Qualidade. ${NOTA_SITE}`,
    largura: 'meia',
    async rodar(db, f) {
      const rows = await q(
        db,
        `select fonte, midia, sum(sessoes)::int as s, sum(usuarios_novos)::int as nu, sum(sessoes_engajadas)::int as e
           from analytics.site_sessoes_dia where dia between $1::date and $2::date group by 1, 2 order by s desc, 1, 2 limit 20`,
        [f.de, f.ate],
      );
      return {
        grafico: { tipo: 'barras', formato: 'int', itens: rows.slice(0, 10).map((r) => ({ rotulo: `${r.fonte} / ${r.midia}`, valor: n(r.s), detalhe: `${fmtInt(n(r.nu))} novos usuários · engajamento ${pct(razao(n(r.e), n(r.s)))}` })) },
        tabela: {
          colunas: [c('fonte', 'Fonte'), c('midia', 'Mídia'), c('sessoes', 'Sessões', 'int'), c('novos', 'Novos usuários', 'int'), c('engaj', 'Taxa de engajamento', 'pct')],
          linhas: rows.map((r) => ({ fonte: r.fonte, midia: r.midia, sessoes: n(r.s), novos: n(r.nu), engaj: razao(n(r.e), n(r.s)) })),
        },
        avisos: rows.length ? [] : [AVISO_SEM_GA4],
      };
    },
  },
  {
    id: 'site-conversoes',
    pagina: 'site',
    titulo: 'Conversões do site (regras do Painel)',
    pergunta: 'Quantas conversões cada regra (evento + URL) registrou?',
    como_ler: `Cada linha é uma regra criada no Painel de Dados > Conversões do site (evento do GA4, em qualquer URL ou só em algumas). Eventos = quantas vezes o evento ocorreu; usuários = soma dos usuários de cada dia (não é a contagem de pessoas únicas). Regras desativadas ou do tipo "ignorar" não aparecem. ${NOTA_SITE}`,
    largura: 'meia',
    async rodar(db, f) {
      const rows = await q(
        db,
        `select regra_id, regra, tipo, evento, sum(eventos)::int as e, sum(usuarios)::int as u
           from analytics.site_conversoes_dia where dia between $1::date and $2::date group by 1, 2, 3, 4 order by e desc, regra_id`,
        [f.de, f.ate],
      );
      const tipos: Record<string, string> = { lead: 'Lead do site', intermediaria: 'Conversão intermediária' };
      const avisos: string[] = [];
      if (!rows.length) avisos.push('Nenhuma regra ativa registrou eventos neste período. Crie as regras no Painel de Dados > Conversões do site.');
      return {
        grafico: { tipo: 'barras', formato: 'int', itens: rows.map((r) => ({ rotulo: r.regra as string, valor: n(r.e), detalhe: `${tipos[r.tipo as string] ?? r.tipo} · evento ${r.evento}` })) },
        tabela: {
          colunas: [c('regra', 'Regra'), c('tipo', 'Tipo'), c('evento', 'Evento no GA4'), c('eventos', 'Eventos', 'int'), c('usuarios', 'Usuários (soma dos dias)', 'int')],
          linhas: rows.map((r) => ({ regra: r.regra, tipo: tipos[r.tipo as string] ?? r.tipo, evento: r.evento, eventos: n(r.e), usuarios: n(r.u) })),
        },
        avisos,
      };
    },
  },
  {
    id: 'site-url-funil',
    pagina: 'site',
    titulo: 'Funil dos leads por página de conversão',
    pergunta: 'Que páginas geram leads que viram MQL, SQL, Reunião Agendada, proposta e ganho, e com que taxas?',
    como_ler: `Só entram negócios que contam como lead e têm "URL de Conversão" preenchida com uma URL de verdade (domínio + caminho). Cada linha é uma página; a primeira é o total. As etapas seguem a regra do funil: "chegou em X" inclui quem chegou em X ou além; as taxas de passo são condicionais (dos que chegaram na etapa anterior, quantos chegaram nesta) e nunca passam de 100%. Ganhos e perdidos vêm do Status do negócio. "Lead ÷ sessões" compara os leads criados no período com as sessões que ENTRARAM pela mesma página no mesmo período no GA4: é uma aproximação (a URL de conversão é onde a pessoa converteu, não necessariamente onde entrou, e só vale para domínios que o GA4 mede). Os filtros de período, produto, pipeline, fonte e tipo valem aqui. Mostra as 40 páginas com mais leads.`,
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `with b as (select d.deal_id, d.is_mql, d.status, d.valor, d.conta_como_lead, u.host_url, u.caminho_url
                      from analytics.negocios_bi d join analytics.negocios_url u on u.deal_id = d.deal_id
                     where d.conta_como_lead and u.url_valida and ${w.join(' and ')}), ${MARCOS_CTE},
              x as (select b.host_url, b.caminho_url, b.is_mql as mql, coalesce(m.sql, false) as sql, coalesce(m.reuniao, false) as reuniao,
                           coalesce(m.proposta, false) as proposta, b.status, b.valor, b.conta_como_lead
                      from b left join m on m.deal_id = b.deal_id)
         select grouping(x.host_url) as e_total, x.host_url, x.caminho_url, ${MRR_SQL('x')}, count(*)::int as leads, count(*) filter (where mql)::int as mql,
                count(*) filter (where sql)::int as sql, count(*) filter (where reuniao)::int as reuniao, count(*) filter (where proposta)::int as proposta,
                count(*) filter (where status = 'won')::int as ganhos, count(*) filter (where status = 'lost')::int as perdidos,
                count(*) filter (where mql and sql)::int as mql_sql, count(*) filter (where sql and reuniao)::int as sql_reuniao,
                count(*) filter (where reuniao and proposta)::int as reuniao_proposta, count(*) filter (where proposta and status = 'won')::int as proposta_ganho
           from x group by grouping sets ((x.host_url, x.caminho_url), ()) order by e_total desc, leads desc, x.host_url, x.caminho_url`,
        p,
      );
      const p2: unknown[] = [];
      const w2 = filtroSql(f, 'd', p2);
      const cob = (
        await q(
          db,
          `select count(*)::int as leads, count(*) filter (where u.tem_url and u.url_valida)::int as valida, count(*) filter (where u.tem_url and not u.url_valida)::int as invalida
             from analytics.negocios_bi d left join analytics.negocios_url u on u.deal_id = d.deal_id where d.conta_como_lead and ${w2.join(' and ')}`,
          p2,
        )
      )[0]!;
      const sess = new Map<string, number>();
      for (const r of await q(
        db,
        `select ${HOST_GA4} as host, s.caminho, sum(s.sessoes)::int as sessoes from analytics.site_sessoes_dia s where s.dia between $1::date and $2::date group by 1, 2`,
        [f.de, f.ate],
      ))
        sess.set(`${r.host}|${r.caminho}`, n(r.sessoes));
      const total = rows.find((r) => n(r.e_total) === 1);
      const paginas = rows.filter((r) => n(r.e_total) === 0);
      const top = paginas.slice(0, 40);
      const linhas: Array<Record<string, string | number | null>> = [];
      if (total && n(total.leads) > 0) {
        const sessTotal = top.reduce((a, r) => a + (sess.get(`${r.host_url}|${r.caminho_url}`) ?? 0), 0);
        linhas.push(linhaUrl('Total (leads com URL de conversão válida)', total, sessTotal || null));
        for (const r of top) linhas.push(linhaUrl(paginaRotulo(r.host_url, r.caminho_url), r, sess.has(`${r.host_url}|${r.caminho_url}`) ? sess.get(`${r.host_url}|${r.caminho_url}`)! : null));
        const resto = paginas.slice(40);
        if (resto.length) {
          const soma = (k: string) => resto.reduce((a, r) => a + n(r[k]), 0);
          linhas.push(linhaUrl(`(demais ${resto.length} páginas)`, Object.fromEntries(['leads', 'mql', 'sql', 'reuniao', 'proposta', 'ganhos', 'perdidos', 'mrr_criado', 'mrr_ganho', 'mrr_perdido', 'mrr_aberto', 'mql_sql', 'sql_reuniao', 'reuniao_proposta', 'proposta_ganho'].map((k) => [k, soma(k)])), null));
        }
      }
      const avisos = await avisoHistorico(db, f);
      if (n(cob.leads) > 0) {
        avisos.unshift(
          `${fmtInt(n(cob.valida))} de ${fmtInt(n(cob.leads))} leads do filtro (${pct(razao(n(cob.valida), n(cob.leads)))}) têm uma URL de conversão válida e entram nesta tabela` +
            (n(cob.invalida) ? `; ${fmtInt(n(cob.invalida))} têm um texto que não é URL no campo e ficam de fora` : '') +
            '. O resto não tem o campo preenchido.',
        );
      }
      if (linhas.length > 1 && linhas.slice(1).every((l) => l.sql === 0 && l.reuniao === 0 && l.proposta === 0)) avisos.push(SEM_MARCOS);
      return { grafico: { tipo: 'tabela' }, tabela: { colunas: ETAPAS_URL_COLUNAS, linhas }, avisos };
    },
  },

  /* ===================== DEBRIEFING SEMANAL (studio/lib/debriefing.ts) ===================== */
  ...ANALISES_DEBRIEFING,
];

export type BiCatalogoItem = Pick<BiAnalise, 'id' | 'pagina' | 'titulo' | 'pergunta' | 'como_ler' | 'largura'>;
export type BiOpcao = { id: string; nome: string; padrao: boolean };

export interface BiRepo {
  catalogo(): BiCatalogoItem[];
  opcoes(): Promise<{
    pipelines: Array<{ pipeline_id: number; pipeline: string; produto: string | null }>;
    produtos: readonly string[];
    primeiro_negocio: string | null;
    fontes: BiOpcao[];
    tipos: BiOpcao[];
    paginas: ReadonlyArray<{ id: string; rotulo: string }>;
  }>;
  rodar(id: string, f: BiFiltros): Promise<BiResultado>;
}

export class BiNotFound extends Error {
  constructor(what: string) {
    super(`${what} não encontrada`);
    this.name = 'BiNotFound';
  }
}

export class PgBiRepo implements BiRepo {
  constructor(private readonly pool: Db) {}

  catalogo(): BiCatalogoItem[] {
    return BI_ANALISES.map(({ id, pagina, titulo, pergunta, como_ler, largura }) => ({ id, pagina, titulo, pergunta, como_ler, largura }));
  }

  async opcoes() {
    const p = await this.pool.query(`select distinct pipeline_id, pipeline, produto, pipeline_ordem from analytics.pipelines_etapas order by pipeline_ordem nulls last, pipeline_id`);
    const d = await this.pool.query(`select to_char(min(criado_em at time zone ${TZ}), 'YYYY-MM-DD') as primeiro from analytics.deals`);
    const o = await this.pool.query(`select campo, opcao_id, opcao from analytics.campo_opcoes where campo in ('Fonte do Lead', 'Tipo do Lead') order by opcao`);
    const lista = (campo: string, padrao: string[]): BiOpcao[] => o.rows.filter((x: Row) => x.campo === campo).map((x: Row) => ({ id: String(x.opcao_id), nome: x.opcao, padrao: padrao.includes(x.opcao) }));
    return {
      pipelines: p.rows.map((x: Row) => ({ pipeline_id: Number(x.pipeline_id), pipeline: x.pipeline, produto: x.produto })),
      produtos: BI_PRODUTOS,
      primeiro_negocio: d.rows[0]?.primeiro ?? null,
      fontes: lista('Fonte do Lead', PADRAO_FONTES),
      tipos: lista('Tipo do Lead', PADRAO_TIPOS),
      paginas: BI_PAGINAS,
    };
  }

  async rodar(id: string, f: BiFiltros): Promise<BiResultado> {
    const a = BI_ANALISES.find((x) => x.id === id);
    if (!a) throw new BiNotFound('análise');
    return a.rodar(this.pool, f);
  }
}
