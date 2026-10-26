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

/* ---------- dados diários da fatia ---------- */
export type LeitorEscopo = (db: Db, e: Escopo & { produto: ProdutoMonitor }, hora: string, desde: string) => Promise<DadosMonitor>;
const n = (v: unknown) => (v == null ? 0 : Number(v));

/** Mesma forma do Monitor (um Soma por dia), com tudo na chave `meta`: o cálculo do experimento é o mesmo, só a fonte é a fatia. */
export async function lerDadosEscopo(db: Db, e: Escopo & { produto: ProdutoMonitor }, hora: string, desde: string): Promise<DadosMonitor> {
  const p: unknown[] = [desde, e.produto];
  const add = (v: unknown) => `$${p.push(v)}`;
  const conds: string[] = [];
  // várias campanhas somam: o negócio precisa estar ligado a QUALQUER uma delas (os outros itens do escopo continuam valendo em conjunto)
  const ids = e.campanhas.map((c) => c.id).filter((x): x is string => !!x);
  const nomes = e.campanhas.filter((c) => !c.id && c.nome).map((c) => (c.nome as string).toLowerCase());
  const qualCampanha = (): string => [ids.length ? `campanha_id = any(${add(ids)}::bigint[])` : '', nomes.length ? `lower(campanha) = any(${add(nomes)}::text[])` : ''].filter(Boolean).join(' or ');
  if (temCampanha(e)) conds.push(`d.deal_id in (select deal_id from analytics.negocios_meta where ${qualCampanha()})`);
  if (e.identificadorConversao) conds.push(`d.deal_id in (select deal_id from analytics.conversoes_pipe_negocios where evento = ${add(e.identificadorConversao)})`);
  if (e.paginaCaminho) conds.push(`d.deal_id in (select deal_id from analytics.negocios_url where caminho_url = ${add(e.paginaCaminho)}${e.paginaHost ? ` and host_url = ${add(e.paginaHost)}` : ''})`);
  const alvo = `d.produto = $2 and ${conds.join(' and ') || 'true'}`;
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
