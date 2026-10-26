/**
 * Escopo de um experimento (pedido do Pablo, 2026-10-26): além do canal, o teste pode ser amarrado a uma PÁGINA DE DESTINO (uma das páginas do GA4),
 * a uma CAMPANHA da Meta e a um IDENTIFICADOR DE CONVERSÃO do Pipedrive (o "Identificador de Conversão RD" do negócio). Cada um é opcional, vem da
 * lista das contas reais (Analytics, Meta Ads, Pipedrive) e também pode ser digitado à mão. Com mais de um, vale o conjunto (E): o negócio precisa
 * bater com todos. O resultado REAL da métrica chave passa a ser só o dessas fatias.
 *
 * Como cada fatia mede:
 *  - negócios (leads, MQL, reuniões, ganhos, MRR): os do Pipedrive que batem com o escopo (campanha pela ligação Meta -> Pipedrive, página pela URL de
 *    conversão, identificador pelo campo do negócio), no produto do experimento;
 *  - investimento, impressões e cliques: só existem com campanha (Meta Ads);
 *  - visitas: com página (e sem campanha), as visualizações dela no GA4.
 * Custos (CPL, CAC...) só fazem sentido com campanha. Tudo é leitura das visões de analytics (papel orq_panel).
 */
import type pg from 'pg';
import { TZ_MONITOR, ZERO, somar, type DadosMonitor, type ProdutoMonitor, type Soma } from './monitor.js';

type Db = Pick<pg.Pool, 'query'>;

/** Uma campanha da Meta: pelo ID, ou só pelo nome quando o ID não é conhecido. */
export interface CampanhaEscopo { id: string | null; nome: string | null }
export const MAX_CAMPANHAS = 40;
export interface Escopo {
  paginaHost: string | null; paginaCaminho: string | null;
  /** Uma ou mais campanhas da Meta: os resultados somam. */
  campanhas: CampanhaEscopo[];
  identificadorConversao: string | null;
  /** Como combinar os critérios para contar os negócios (padrão: todos). */
  escopoModo?: EscopoModo;
}
export const temCampanha = (e: Partial<Escopo>): boolean => !!e.campanhas?.length;
export const temEscopo = (e: Partial<Escopo>): boolean => !!(e.paginaCaminho || temCampanha(e) || e.identificadorConversao);

/* ---------- entrada digitada ou escolhida (pura) ---------- */
/** "https://www.site.com.br/Blog/Post/?a=1" -> host "site.com.br" e caminho "/blog/post"; "/blog/post" -> só o caminho (vale para qualquer host). */
export function normalizarPagina(entrada: string): { host: string | null; caminho: string } | null {
  const t = entrada.trim().toLowerCase();
  if (!t) return null;
  let host: string | null = null;
  let resto = t.replace(/^https?:\/\//, '');
  if (!resto.startsWith('/')) {
    const i = resto.search(/[/?#]/);
    host = (i < 0 ? resto : resto.slice(0, i)).replace(/^www\./, '').replace(/:\d+$/, '');
    resto = i < 0 ? '' : resto.slice(i);
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host)) return null;
  }
  const caminho = resto.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return { host, caminho: caminho === '' ? '/' : caminho };
}
export const paginaTexto = (host: string | null, caminho: string | null): string | null => (caminho ? `${host ?? ''}${caminho}` : null);

/** "Black Friday RH (120219)" -> id 120219; "120219" -> id; qualquer outro texto -> nome. */
export function normalizarCampanha(entrada: string): { id: string | null; nome: string | null } | null {
  const t = entrada.trim();
  if (!t) return null;
  const m = /\((\d{6,20})\)\s*$/.exec(t) ?? /^(\d{6,20})$/.exec(t);
  if (m) { const nome = t.replace(/\s*\(\d{6,20}\)\s*$/, '').trim(); return { id: m[1]!, nome: /^\d+$/.test(nome) || !nome ? null : nome }; }
  return { id: null, nome: t };
}
export const campanhaTexto = (c: CampanhaEscopo): string => (c.id ? `${c.nome ?? 'Campanha'} (${c.id})` : (c.nome ?? ''));
/** Lista de textos (um por campanha) -> campanhas sem repetição, no máximo MAX_CAMPANHAS; texto vazio é ignorado. */
export function normalizarCampanhas(textos: readonly string[]): CampanhaEscopo[] {
  const vistos = new Set<string>();
  const out: CampanhaEscopo[] = [];
  for (const t of textos) {
    const c = normalizarCampanha(t);
    if (!c) continue;
    const chave = c.id ?? `nome:${(c.nome ?? '').toLowerCase()}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    out.push(c);
  }
  return out.slice(0, MAX_CAMPANHAS);
}

/* ---------- opções das contas reais ---------- */
export interface OpcoesEscopo {
  paginas: Array<{ host: string; caminho: string; visualizacoes: number }>;
  campanhas: Array<{ id: string; nome: string; gasto: number }>;
  identificadores: Array<{ evento: string; negocios: number }>;
}
export async function listarOpcoes(db: Db, produto?: ProdutoMonitor): Promise<OpcoesEscopo> {
  const host = produto === 'clinic' ? ` and host = 'quarkclinic.com.br'` : produto === 'rh' ? ` and host <> 'quarkclinic.com.br'` : '';
  const [pg, ca, id] = await Promise.all([
    db.query(`select host, caminho, sum(visualizacoes)::int as v from analytics.site_paginas_dia where dia >= current_date - 90${host} group by 1, 2 order by v desc limit 400`),
    db.query(`select campanha_id::text as id, max(campanha) as nome, sum(gasto)::float8 as gasto from analytics.meta_desempenho_dia
               where dia >= current_date - 365 and campanha_id is not null${produto ? ' and produto = $1' : ''} group by 1 order by max(dia) desc, gasto desc limit 400`, produto ? [produto] : []),
    db.query(`select evento, count(*)::int as n from analytics.conversoes_pipe_negocios where evento is not null and evento not like '[Etapa]%'${produto ? ' and produto = $1' : ''} group by 1 order by n desc limit 400`, produto ? [produto] : []),
  ]);
  return {
    paginas: pg.rows.map((r) => ({ host: String(r.host), caminho: String(r.caminho), visualizacoes: Number(r.v) })),
    campanhas: ca.rows.filter((r) => r.nome).map((r) => ({ id: String(r.id), nome: String(r.nome), gasto: Number(r.gasto) })),
    identificadores: id.rows.map((r) => ({ evento: String(r.evento), negocios: Number(r.n) })),
  };
}

/* ---------- como o escopo vira filtro de negócios ---------- */
/**
 * Como combinar os critérios do escopo para CONTAR os negócios do Pipedrive:
 *  - todos: o negócio precisa bater com todos os critérios (E);
 *  - qualquer: basta bater com um (OU);
 *  - campanha_so_investimento: página e identificador (quando existem) definem os negócios; a campanha só traz o investimento, as impressões e os cliques.
 *    É o modo certo quando a página ou o identificador pegam leads que a ligação Meta -> Pipedrive não consegue atribuir à campanha (UTM ausente ou com outro nome).
 */
export const ESCOPO_MODOS = ['todos', 'qualquer', 'campanha_so_investimento'] as const;
export type EscopoModo = (typeof ESCOPO_MODOS)[number];
export const MODO_ROTULO: Record<EscopoModo, string> = {
  todos: 'Todos os critérios ao mesmo tempo (E)',
  qualquer: 'Qualquer um dos critérios (OU)',
  campanha_so_investimento: 'Campanha só para o investimento; negócios pela página e pelo identificador',
};

interface Alvo { sql: string; ids: string[]; nomes: string[] }
/** Monta a condição de negócios (alias `d` = analytics.negocios_bi). `p` já traz o produto no índice `ip` (1 = $1); os critérios entram no fim, na ordem campanha, identificador, página. */
export function montarAlvo(e: Escopo & { produto: ProdutoMonitor }, p: unknown[], ip: number): Alvo {
  const add = (v: unknown) => `$${p.push(v)}`;
  const ids = e.campanhas.map((c) => c.id).filter((x): x is string => !!x);
  const nomes = e.campanhas.filter((c) => !c.id && c.nome).map((c) => (c.nome as string).toLowerCase());
  const modo = e.escopoModo ?? 'todos';
  const temOutros = !!(e.identificadorConversao || e.paginaCaminho);
  const usaCampanha = temCampanha(e) && !(modo === 'campanha_so_investimento' && temOutros);
  const partes: { campanha?: string; identificador?: string; pagina?: string } = {};
  if (usaCampanha) {
    const qual = [ids.length ? `campanha_id = any(${add(ids)}::bigint[])` : '', nomes.length ? `lower(campanha) = any(${add(nomes)}::text[])` : ''].filter(Boolean).join(' or ');
    partes.campanha = `d.deal_id in (select deal_id from analytics.negocios_meta where ${qual})`;
  }
  if (e.identificadorConversao) partes.identificador = `d.deal_id in (select deal_id from analytics.conversoes_pipe_negocios where evento = ${add(e.identificadorConversao)})`;
  if (e.paginaCaminho) partes.pagina = `d.deal_id in (select deal_id from analytics.negocios_url where caminho_url = ${add(e.paginaCaminho)}${e.paginaHost ? ` and host_url = ${add(e.paginaHost)}` : ''})`;
  const lista = [partes.campanha, partes.identificador, partes.pagina].filter((x): x is string => !!x);
  const filtro = !lista.length ? 'true' : `(${lista.join(modo === 'qualquer' ? ' or ' : ' and ')})`;
  return { sql: `d.produto = $${ip} and not d.is_deleted and ${filtro}`, ids, nomes };
}

/* ---------- dados diários da fatia ---------- */
export type LeitorEscopo = (db: Db, e: Escopo & { produto: ProdutoMonitor }, hora: string, desde: string) => Promise<DadosMonitor>;
const n = (v: unknown) => (v == null ? 0 : Number(v));

/** Mesma forma do Monitor (um Soma por dia), com tudo na chave `meta`: o cálculo do experimento é o mesmo, só a fonte é a fatia. */
export async function lerDadosEscopo(db: Db, e: Escopo & { produto: ProdutoMonitor }, hora: string, desde: string): Promise<DadosMonitor> {
  const p: unknown[] = [desde, e.produto];
  const { sql: alvo, ids, nomes } = montarAlvo(e, p, 2);
  const ts = (col: string) => `(${col} at time zone '${TZ_MONITOR}')`;
  const ini = `($1::date)::timestamp`;
  const meta = new Map<string, Soma>();
  const poe = (dia: string, parte: Partial<Soma>) => meta.set(dia, somar(meta.get(dia) ?? ZERO, parte));

  const consultas: Array<Promise<void>> = [
    db.query(`select to_char(${ts('d.criado_em')}, 'YYYY-MM-DD') as dia, count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql
                from analytics.negocios_bi d where ${ts('d.criado_em')} >= ${ini} and ${alvo} group by 1`, p).then((r) => { for (const x of r.rows) poe(x.dia, { leads: n(x.leads), mql: n(x.mql) }); }),
    db.query(`select to_char(${ts('d.fechado_em')}, 'YYYY-MM-DD') as dia, count(*)::int as ganhos, coalesce(sum(d.valor), 0)::float8 as mrr
                from analytics.negocios_bi d where d.status = 'won' and d.fechado_em is not null and ${ts('d.fechado_em')} >= ${ini} and ${alvo} group by 1`, p).then((r) => { for (const x of r.rows) poe(x.dia, { ganhos: n(x.ganhos), mrr: n(x.mrr) }); }),
    db.query(`select to_char(${ts('m.chegou_em')}, 'YYYY-MM-DD') as dia, count(distinct m.deal_id)::int as reunioes
                from analytics.negocios_marcos m join analytics.negocios_bi d on d.deal_id = m.deal_id
               where m.marco = 'reuniao' and ${ts('m.chegou_em')} >= ${ini} and ${alvo} group by 1`, p).then((r) => { for (const x of r.rows) poe(x.dia, { reunioes: n(x.reunioes) }); }),
  ];
  if (temCampanha(e)) {
    const q: unknown[] = [desde];
    const a = (v: unknown) => `$${q.push(v)}`;
    const qual = [ids.length ? `campanha_id = any(${a(ids)}::bigint[])` : '', nomes.length ? `lower(campanha) = any(${a(nomes)}::text[])` : ''].filter(Boolean).join(' or ');
    consultas.push(db.query(`select dia::text as dia, sum(gasto)::float8 as gasto, sum(impressoes)::float8 as impressoes, sum(cliques_link)::float8 as cliques
                               from analytics.meta_desempenho_dia where dia >= $1::date and (${qual}) group by 1`, q).then((r) => { for (const x of r.rows) poe(x.dia, { invest: n(x.gasto), impressoes: n(x.impressoes), cliques: n(x.cliques) }); }));
  } else if (e.paginaCaminho) {
    const q: unknown[] = [desde, e.paginaCaminho];
    consultas.push(db.query(`select dia::text as dia, sum(visualizacoes)::float8 as v from analytics.site_paginas_dia
                              where dia >= $1::date and caminho = $2${e.paginaHost ? ` and regexp_replace(host, '^www[.]', '') = $${q.push(e.paginaHost)}` : ''} group by 1`, q).then((r) => { for (const x of r.rows) poe(x.dia, { sessoes: n(x.v) }); }));
  }
  await Promise.all(consultas);
  for (const [dia, s] of meta) meta.set(dia, { ...s, leadsT: s.leads });
  return {
    diario: { google: new Map(), meta, social: new Map(), organico: new Map() },
    ontemMesmaHora: { google: ZERO, meta: ZERO, social: ZERO, organico: ZERO },
    hora, trafegoAte: null,
  };
}

/* ---------- detalhe da fatia: funil, perfil, perdas, safra, criativos e conferência ---------- */
export interface Quebra { rotulo: string; n: number; abertos: number; ganhos: number; perdidos: number }
export interface Detalhe {
  /** Janela dos negócios (data de criação): do início do teste até o último dia completo. */
  de: string; ate: string;
  modo: EscopoModo;
  /** Negócios do Pipedrive no escopo (como combinado) e quantos contam como lead. */
  negocios: number; leads: number;
  status: { abertos: number; ganhos: number; perdidos: number };
  etapas: Array<Quebra & { funil: string }>;
  faixaColab: Quebra[]; faixaSaude: Quebra[]; cargos: Quebra[];
  motivosPerda: Array<{ rotulo: string; n: number }>;
  /** Safra: negócios por semana de criação (segunda-feira), por situação atual. */
  safra: Array<{ semana: string; n: number; abertos: number; ganhos: number; perdidos: number }>;
  criativos: Array<{ anuncio: string; gasto: number; impressoes: number; cliques: number; leadsMeta: number; negocios: number; ganhos: number }>;
  conferencia: {
    /** Quantos negócios cada critério traz sozinho (mesma janela); nulo = critério não usado. */
    porIdentificador: number | null; porPagina: number | null; porCampanhas: number | null;
    /** Ligação Meta -> Pipedrive dos negócios do escopo, por método (sem_ligacao = nenhum método achou a campanha). */
    ligacaoMeta: Array<{ metodo: string; n: number }>;
    semUtmCampanha: number;
  };
  amostra: Array<{ id: number; titulo: string; etapa: string; status: string; criado: string }>;
}
export type LeitorDetalhe = (db: Db, e: Escopo & { produto: ProdutoMonitor }, de: string, ate: string) => Promise<Detalhe>;

/** Quando ninguém preencheu a faixa de profissionais da saúde (é do QuarkClinic), a quebra some em vez de mostrar uma linha só "(em branco)". */
const semFaixaSaude = (l: Quebra[]): Quebra[] => (l.length === 1 && l[0]!.rotulo === '(em branco)' ? [] : l);

export async function lerDetalheEscopo(db: Db, e: Escopo & { produto: ProdutoMonitor }, de: string, ate: string): Promise<Detalhe> {
  const p: unknown[] = [de, ate, e.produto];
  const { sql: alvo, ids, nomes } = montarAlvo(e, p, 3);
  const ts = (col: string) => `(${col} at time zone '${TZ_MONITOR}')`;
  const janela = `${ts('d.criado_em')} >= ($1::date)::timestamp and ${ts('d.criado_em')} < ($2::date + 1)::timestamp`;
  const base = `from analytics.negocios_bi d where ${janela} and ${alvo}`;
  const contagens = `count(*)::int as n, count(*) filter (where d.status = 'open')::int as abertos, count(*) filter (where d.status = 'won')::int as ganhos, count(*) filter (where d.status = 'lost')::int as perdidos`;
  const quebra = (expr: string, juncao = '', ordem = 'n desc') => db.query(`select ${expr} as k, ${contagens} from analytics.negocios_bi d ${juncao} where ${janela} and ${alvo} group by 1 order by ${ordem} limit 30`, p);
  const q = (r: { rows: Array<Record<string, unknown>> }): Quebra[] => r.rows.map((x) => ({ rotulo: String(x.k ?? '(em branco)'), n: n(x.n), abertos: n(x.abertos), ganhos: n(x.ganhos), perdidos: n(x.perdidos) }));

  // cada critério sozinho (a mesma janela de criação), para o Pablo conferir contra o Pipedrive
  const sozinho = async (sqlCond: string, params: unknown[]): Promise<number> => {
    const r = await db.query(`select count(*)::int as n from analytics.negocios_bi d where ${janela} and d.produto = $3 and not d.is_deleted and ${sqlCond}`, [de, ate, e.produto, ...params]);
    return n(r.rows[0]?.n);
  };
  const campCond = ((): { sql: string; params: unknown[] } | null => {
    if (!temCampanha(e)) return null;
    const pr: unknown[] = [];
    const a = (v: unknown) => `$${3 + pr.push(v)}`;
    const qual = [ids.length ? `campanha_id = any(${a(ids)}::bigint[])` : '', nomes.length ? `lower(campanha) = any(${a(nomes)}::text[])` : ''].filter(Boolean).join(' or ');
    return { sql: `d.deal_id in (select deal_id from analytics.negocios_meta where ${qual})`, params: pr };
  })();

  const [tot, etapas, colab, saude, cargos, motivos, safra, ligacao, semUtm, amostra, porIdent, porPag, porCamp] = await Promise.all([
    db.query(`select ${contagens}, count(*) filter (where d.conta_como_lead)::int as leads ${base}`, p),
    db.query(`select d.pipeline as funil, d.etapa as k, ${contagens} ${base} group by 1, 2 order by 1, n desc limit 40`, p),
    quebra(`d.faixa_colab`),
    quebra(`d.faixa_saude`),
    quebra(`c.valor_legivel`, `left join analytics.deal_campos c on c.deal_id = d.deal_id and c.nome_pipedrive = 'Cargo (Negócio)'`),
    db.query(`select d.motivo_perda as k, count(*)::int as n ${base} and d.status = 'lost' group by 1 order by n desc limit 20`, p),
    db.query(`select to_char(date_trunc('week', ${ts('d.criado_em')}), 'YYYY-MM-DD') as k, ${contagens} ${base} group by 1 order by 1`, p),
    db.query(`select coalesce(m.metodo, 'sem_ligacao') as k, count(*)::int as n ${base.replace('from analytics.negocios_bi d', 'from analytics.negocios_bi d left join analytics.negocios_meta m on m.deal_id = d.deal_id')} group by 1 order by n desc`, p),
    db.query(`select count(*)::int as n ${base.replace('from analytics.negocios_bi d', 'from analytics.negocios_bi d left join analytics.negocios_url a on a.deal_id = d.deal_id')} and (a.utm_campaign is null or a.utm_campaign = '' or a.utm_campaign like '{{%')`, p),
    db.query(`select d.deal_id::text as id, d.titulo, d.etapa, d.status, to_char(${ts('d.criado_em')}, 'YYYY-MM-DD') as criado ${base} order by d.criado_em desc limit 15`, p),
    e.identificadorConversao ? sozinho(`d.deal_id in (select deal_id from analytics.conversoes_pipe_negocios where evento = $4)`, [e.identificadorConversao]) : Promise.resolve(null),
    e.paginaCaminho ? sozinho(`d.deal_id in (select deal_id from analytics.negocios_url where caminho_url = $4${e.paginaHost ? ' and host_url = $5' : ''})`, [e.paginaCaminho, ...(e.paginaHost ? [e.paginaHost] : [])]) : Promise.resolve(null),
    campCond ? sozinho(campCond.sql, campCond.params) : Promise.resolve(null),
  ]);

  // criativos (anúncios) das campanhas escolhidas: mídia (Meta) e negócios ligados
  let criativos: Detalhe['criativos'] = [];
  if (temCampanha(e)) {
    const pc: unknown[] = [de, ate];
    const a = (v: unknown) => `$${pc.push(v)}`;
    const qual = [ids.length ? `campanha_id = any(${a(ids)}::bigint[])` : '', nomes.length ? `lower(campanha) = any(${a(nomes)}::text[])` : ''].filter(Boolean).join(' or ');
    const [midia, negocios] = await Promise.all([
      db.query(`select coalesce(anuncio, '(sem nome)') as anuncio, sum(gasto)::float8 as gasto, sum(impressoes)::float8 as impressoes, sum(cliques_link)::float8 as cliques, sum(leads_meta)::float8 as leads_meta
                  from analytics.meta_desempenho_dia where dia >= $1::date and dia <= $2::date and (${qual}) group by 1 order by gasto desc limit 15`, pc),
      db.query(`select coalesce(m.anuncio, '(sem nome)') as anuncio, count(*)::int as n, count(*) filter (where d.status = 'won')::int as ganhos
                  from analytics.negocios_meta m join analytics.negocios_bi d on d.deal_id = m.deal_id
                 where ${janela} and d.produto = $3 and not d.is_deleted and m.deal_id in (select d.deal_id from analytics.negocios_bi d where ${alvo}) group by 1`, p),
    ]);
    const nm = new Map(negocios.rows.map((x) => [String(x.anuncio), x]));
    criativos = midia.rows.map((x) => ({ anuncio: String(x.anuncio), gasto: n(x.gasto), impressoes: n(x.impressoes), cliques: n(x.cliques), leadsMeta: n(x.leads_meta), negocios: n(nm.get(String(x.anuncio))?.n), ganhos: n(nm.get(String(x.anuncio))?.ganhos) }));
  }

  const t = tot.rows[0] ?? {};
  return {
    de, ate, modo: e.escopoModo ?? 'todos', negocios: n(t.n), leads: n(t.leads), status: { abertos: n(t.abertos), ganhos: n(t.ganhos), perdidos: n(t.perdidos) },
    etapas: etapas.rows.map((x) => ({ funil: String(x.funil ?? ''), rotulo: String(x.k ?? ''), n: n(x.n), abertos: n(x.abertos), ganhos: n(x.ganhos), perdidos: n(x.perdidos) })),
    faixaColab: q(colab), faixaSaude: semFaixaSaude(q(saude)), cargos: q(cargos),
    motivosPerda: motivos.rows.map((x) => ({ rotulo: String(x.k ?? '(sem motivo)'), n: n(x.n) })),
    safra: safra.rows.map((x) => ({ semana: String(x.k), n: n(x.n), abertos: n(x.abertos), ganhos: n(x.ganhos), perdidos: n(x.perdidos) })),
    criativos,
    conferencia: { porIdentificador: porIdent, porPagina: porPag, porCampanhas: porCamp, ligacaoMeta: ligacao.rows.map((x) => ({ metodo: String(x.k), n: n(x.n) })), semUtmCampanha: n(semUtm.rows[0]?.n) },
    amostra: amostra.rows.map((x) => ({ id: Number(x.id), titulo: String(x.titulo ?? ''), etapa: String(x.etapa ?? ''), status: String(x.status ?? ''), criado: String(x.criado) })),
  };
}
