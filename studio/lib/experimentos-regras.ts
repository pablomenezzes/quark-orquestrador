/**
 * Contabilização MANUAL do experimento (pedido do Pablo, 2026-10-26). No modo automático o Studio conta sozinho (o resultado do escopo combinado). No manual,
 * o Pablo escolhe como cada métrica é calculada: uma regra é "métrica = fórmula", e a fórmula é uma conta com campos, outras métricas e números.
 *
 *   Leads = [Leads do identificador de conversão]
 *   CPL   = [Investimento das campanhas (Meta)] ÷ [Leads]        (o segundo termo é a métrica Leads, já definida pela regra acima)
 *
 * Campo = uma grandeza diária de uma origem do escopo (identificador, página, campanhas ou o escopo combinado), somada no período que se está medindo.
 * A conta vale sobre os totais do período (não dia a dia), então uma razão como o CPL é sempre "total ÷ total". Operações: + − × ÷ com a precedência
 * normal (× e ÷ antes de + e −), sem parênteses. Divisão por zero e termo sem dado dão "sem resultado" (nulo), nunca zero inventado.
 * Métrica sem regra continua automática. Tudo é leitura das visões de analytics (papel orq_panel).
 */
import type pg from 'pg';
import { TZ_MONITOR, type Janela } from './monitor.js';
import { montarAlvo, temCampanha, temFiltros, type Escopo } from './experimentos-escopo.js';
import type { ProdutoMonitor } from './monitor.js';

type Db = Pick<pg.Pool, 'query'>;

export const OPERADORES = ['+', '-', '*', '/'] as const;
export type Operador = (typeof OPERADORES)[number];
export type Token = { k: 'campo'; v: string } | { k: 'metrica'; v: string } | { k: 'num'; v: number } | { k: 'op'; v: Operador };
export interface Regra { metrica: string; formula: Token[] }
export const MAX_REGRAS = 20;
export const MAX_TOKENS = 15;
export const CONTABILIZACOES = ['automatica', 'manual'] as const;
export type Contabilizacao = (typeof CONTABILIZACOES)[number];

/* ---------- catálogo de campos ---------- */
export type Origem = 'identificador' | 'pagina' | 'campanhas' | 'filtros' | 'escopo';
export interface CampoDef { id: string; rotulo: string; origem: Origem; formato: 'int' | 'brl'; grupo: string }
const ORIGENS: Array<[Origem, string]> = [['identificador', 'do identificador de conversão'], ['pagina', 'da página de destino'], ['campanhas', 'das campanhas (ligação Meta)'], ['filtros', 'dos filtros por campo do Pipedrive'], ['escopo', 'do escopo combinado']];
const MEDIDAS: Array<[string, string, 'int' | 'brl']> = [['negocios', 'Negócios criados', 'int'], ['leads', 'Leads', 'int'], ['mql', 'MQL', 'int'], ['reunioes', 'Reuniões agendadas', 'int'], ['ganhos', 'Ganhos', 'int'], ['mrr', 'MRR dos ganhos', 'brl'], ['perdidos', 'Perdidos', 'int']];
export const CAMPOS: readonly CampoDef[] = [
  ...ORIGENS.flatMap(([o, r]) => MEDIDAS.map(([m, rot, f]): CampoDef => ({ id: `${o}.${m}`, rotulo: `${rot} ${r}`, origem: o, formato: f, grupo: `Negócios do Pipedrive ${r}` }))),
  { id: 'campanhas.invest', rotulo: 'Investimento das campanhas (Meta)', origem: 'campanhas', formato: 'brl', grupo: 'Mídia das campanhas (Meta Ads)' },
  { id: 'campanhas.impressoes', rotulo: 'Impressões das campanhas (Meta)', origem: 'campanhas', formato: 'int', grupo: 'Mídia das campanhas (Meta Ads)' },
  { id: 'campanhas.cliques', rotulo: 'Cliques no link das campanhas (Meta)', origem: 'campanhas', formato: 'int', grupo: 'Mídia das campanhas (Meta Ads)' },
  { id: 'campanhas.leads_meta', rotulo: 'Leads informados pela Meta (formulário)', origem: 'campanhas', formato: 'int', grupo: 'Mídia das campanhas (Meta Ads)' },
  { id: 'pagina.visualizacoes', rotulo: 'Visualizações da página de destino (GA4)', origem: 'pagina', formato: 'int', grupo: 'Site (Analytics)' },
];
const CAMPO_POR_ID = new Map(CAMPOS.map((c) => [c.id, c]));

/* ---------- validação (pura) ---------- */
export class RegraInvalida extends Error {}
const inv = (m: string) => new RegraInvalida(m);

/** Cada origem usada precisa existir no escopo do experimento. */
export function origemDisponivel(o: Origem, esc: Partial<Escopo>): boolean {
  if (o === 'identificador') return !!esc.identificadorConversao;
  if (o === 'pagina') return !!esc.paginaCaminho;
  if (o === 'campanhas') return temCampanha(esc);
  if (o === 'filtros') return temFiltros(esc);
  return !!(esc.identificadorConversao || esc.paginaCaminho || temCampanha(esc) || temFiltros(esc));
}
const ORIGEM_NOME: Record<Origem, string> = { identificador: 'o identificador de conversão', pagina: 'a página de destino', campanhas: 'as campanhas', filtros: 'ao menos um filtro por campo do Pipedrive', escopo: 'algum item do escopo' };

export function validarRegras(b: unknown, metricasValidas: ReadonlySet<string>, esc: Partial<Escopo>): Regra[] {
  if (b == null) return [];
  if (!Array.isArray(b) || b.length > MAX_REGRAS) throw inv(`regras deve ser uma lista de até ${MAX_REGRAS}`);
  const out: Regra[] = [];
  const vistas = new Set<string>();
  for (const r of b as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object' || typeof r.metrica !== 'string' || !metricasValidas.has(r.metrica)) throw inv('regra com métrica inválida');
    if (vistas.has(r.metrica)) throw inv(`a métrica ${r.metrica} tem mais de uma regra`);
    vistas.add(r.metrica);
    const f = r.formula;
    if (!Array.isArray(f) || f.length < 1 || f.length > MAX_TOKENS || f.length % 2 === 0) throw inv(`a fórmula de ${r.metrica} deve alternar termo e operação (ex.: A ÷ B)`);
    const formula: Token[] = f.map((t: Record<string, unknown>, i: number) => {
      const termo = i % 2 === 0;
      if (!t || typeof t !== 'object') throw inv('termo inválido na fórmula');
      if (!termo) {
        if (t.k !== 'op' || !(OPERADORES as readonly unknown[]).includes(t.v)) throw inv('operação inválida: use + − × ÷');
        return { k: 'op', v: t.v as Operador };
      }
      if (t.k === 'num') { if (typeof t.v !== 'number' || !isFinite(t.v)) throw inv('número inválido na fórmula'); return { k: 'num', v: t.v }; }
      if (t.k === 'metrica') { if (typeof t.v !== 'string' || !metricasValidas.has(t.v)) throw inv('métrica inválida na fórmula'); return { k: 'metrica', v: t.v }; }
      if (t.k === 'campo') {
        const c = typeof t.v === 'string' ? CAMPO_POR_ID.get(t.v) : undefined;
        if (!c) throw inv('campo inválido na fórmula');
        if (!origemDisponivel(c.origem, esc)) throw inv(`o campo "${c.rotulo}" exige ${ORIGEM_NOME[c.origem]} no escopo do experimento`);
        return { k: 'campo', v: c.id };
      }
      throw inv('termo inválido na fórmula');
    });
    out.push({ metrica: r.metrica, formula });
  }
  // uma regra não pode depender de si mesma, direta ou por outra regra
  const deps = new Map(out.map((r) => [r.metrica, r.formula.filter((t) => t.k === 'metrica').map((t) => t.v as string)]));
  const visita = (m: string, pilha: string[]): void => {
    if (pilha.includes(m)) throw inv(`as regras de ${[...pilha.slice(pilha.indexOf(m)), m].join(' → ')} se referem uma à outra`);
    for (const d of deps.get(m) ?? []) visita(d, [...pilha, m]);
  };
  for (const m of deps.keys()) visita(m, []);
  return out;
}

/** A origem de cada campo usado precisa continuar no escopo (ao editar o escopo de um experimento que já tem regras). */
export function conferirOrigens(regras: readonly Regra[], esc: Partial<Escopo>): void {
  for (const r of regras) for (const t of r.formula) if (t.k === 'campo') {
    const c = CAMPO_POR_ID.get(t.v);
    if (c && !origemDisponivel(c.origem, esc)) throw inv(`a regra de ${r.metrica} usa "${c.rotulo}", que saiu do escopo`);
  }
}

/* ---------- avaliação (pura) ---------- */
/** termo (op termo)*, com × e ÷ antes de + e −. Qualquer termo nulo ou divisão por zero dá nulo. */
export function avaliar(formula: readonly Token[], valor: (t: Token) => number | null): number | null {
  const nums: Array<number | null> = [];
  const ops: Operador[] = [];
  formula.forEach((t, i) => { if (i % 2 === 0) nums.push(valor(t)); else ops.push((t as { v: Operador }).v); });
  const aplica = (a: number | null, op: Operador, b: number | null): number | null => {
    if (a == null || b == null) return null;
    if (op === '+') return a + b;
    if (op === '-') return a - b;
    if (op === '*') return a * b;
    return b === 0 ? null : a / b;
  };
  for (let i = 0; i < ops.length;) {
    if (ops[i] === '*' || ops[i] === '/') { nums.splice(i, 2, aplica(nums[i]!, ops[i]!, nums[i + 1]!)); ops.splice(i, 1); } else i++;
  }
  let r = nums[0] ?? null;
  for (let i = 0; i < ops.length; i++) r = aplica(r, ops[i]!, nums[i + 1]!);
  return r;
}

export type CamposDia = Map<string, Map<string, number>>;
/** undefined = a métrica não tem regra (vale o cálculo automático); nulo = tem regra, mas sem resultado. */
export type Medir = (metrica: string, j: Janela) => number | null | undefined;
export const somaCampo = (campos: CamposDia, id: string, j: Janela): number => {
  let s = 0;
  const m = campos.get(id);
  if (!m) return 0;
  for (const [dia, v] of m) if (dia >= j.de && dia <= j.ate) s += v;
  return s;
};

/** `auto` calcula a métrica pelo caminho automático (usado quando uma regra cita uma métrica que não tem regra própria). */
export function criarMedidor(regras: readonly Regra[], campos: CamposDia, auto: (metrica: string, j: Janela) => number | null): Medir {
  const porMetrica = new Map(regras.map((r) => [r.metrica, r]));
  const medir = (metrica: string, j: Janela, pilha: readonly string[]): number | null | undefined => {
    const r = porMetrica.get(metrica);
    if (!r) return undefined;
    if (pilha.includes(metrica)) return null;
    return avaliar(r.formula, (t) => {
      if (t.k === 'num') return t.v;
      if (t.k === 'campo') return somaCampo(campos, t.v, j);
      const m = medir(t.v, j, [...pilha, metrica]);
      return m === undefined ? auto(t.v, j) : m;
    });
  };
  return (metrica, j) => medir(metrica, j, []);
}

export const camposUsados = (regras: readonly Regra[]): string[] => [...new Set(regras.flatMap((r) => r.formula.filter((t) => t.k === 'campo').map((t) => t.v as string)))];

/* ---------- leitura dos campos (só as visões de analytics) ---------- */
export type LeitorCampos = (db: Db, e: Escopo & { produto: ProdutoMonitor }, campoIds: readonly string[], desde: string) => Promise<CamposDia>;
const n = (v: unknown) => (v == null ? 0 : Number(v));

/** O escopo restrito a uma só origem (para o campo "do identificador" contar só pelo identificador, e assim por diante). */
function escopoDaOrigem(e: Escopo & { produto: ProdutoMonitor }, o: Origem): Escopo & { produto: ProdutoMonitor } {
  if (o === 'escopo') return e;
  return {
    ...e, escopoModo: 'todos',
    identificadorConversao: o === 'identificador' ? e.identificadorConversao : null,
    paginaCaminho: o === 'pagina' ? e.paginaCaminho : null, paginaHost: o === 'pagina' ? e.paginaHost : null,
    campanhas: o === 'campanhas' ? e.campanhas : [],
    filtros: o === 'filtros' ? e.filtros : [],
  };
}

export async function lerCampos(db: Db, e: Escopo & { produto: ProdutoMonitor }, campoIds: readonly string[], desde: string): Promise<CamposDia> {
  const out: CamposDia = new Map();
  const poe = (id: string, dia: string, v: number) => { if (!campoIds.includes(id)) return; const m = out.get(id) ?? new Map<string, number>(); m.set(dia, (m.get(dia) ?? 0) + v); out.set(id, m); };
  const ts = (col: string) => `(${col} at time zone '${TZ_MONITOR}')`;
  const ini = `($1::date)::timestamp`;
  const origens = [...new Set(campoIds.map((id) => CAMPO_POR_ID.get(id)?.origem).filter((o): o is Origem => !!o))];
  const tarefas: Array<Promise<void>> = [];

  for (const o of origens) {
    const algumNegocio = campoIds.some((id) => CAMPO_POR_ID.get(id)?.origem === o && !['invest', 'impressoes', 'cliques', 'leads_meta', 'visualizacoes'].includes(id.split('.')[1]!));
    if (!algumNegocio) continue;
    const p: unknown[] = [desde, e.produto];
    const { sql: alvo } = montarAlvo(escopoDaOrigem(e, o), p, 2);
    const q = (sql: string, f: (x: Record<string, unknown>) => void) => tarefas.push(db.query(sql, p).then((r) => { for (const x of r.rows) f(x); }));
    q(`select to_char(${ts('d.criado_em')}, 'YYYY-MM-DD') as dia, count(*)::int as negocios, count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql
         from analytics.negocios_bi d where ${ts('d.criado_em')} >= ${ini} and ${alvo} group by 1`, (x) => { const dia = String(x.dia); poe(`${o}.negocios`, dia, n(x.negocios)); poe(`${o}.leads`, dia, n(x.leads)); poe(`${o}.mql`, dia, n(x.mql)); });
    q(`select to_char(${ts('d.fechado_em')}, 'YYYY-MM-DD') as dia, count(*)::int as ganhos, coalesce(sum(d.valor), 0)::float8 as mrr
         from analytics.negocios_bi d where d.status = 'won' and d.fechado_em is not null and ${ts('d.fechado_em')} >= ${ini} and ${alvo} group by 1`, (x) => { poe(`${o}.ganhos`, String(x.dia), n(x.ganhos)); poe(`${o}.mrr`, String(x.dia), n(x.mrr)); });
    q(`select to_char(${ts('d.perdido_em')}, 'YYYY-MM-DD') as dia, count(*)::int as perdidos
         from analytics.negocios_bi d where d.status = 'lost' and d.perdido_em is not null and ${ts('d.perdido_em')} >= ${ini} and ${alvo} group by 1`, (x) => poe(`${o}.perdidos`, String(x.dia), n(x.perdidos)));
    q(`select to_char(${ts('m.chegou_em')}, 'YYYY-MM-DD') as dia, count(distinct m.deal_id)::int as reunioes
         from analytics.negocios_marcos m join analytics.negocios_bi d on d.deal_id = m.deal_id
        where m.marco = 'reuniao' and ${ts('m.chegou_em')} >= ${ini} and ${alvo} group by 1`, (x) => poe(`${o}.reunioes`, String(x.dia), n(x.reunioes)));
  }

  if (campoIds.some((id) => id.startsWith('campanhas.') && ['invest', 'impressoes', 'cliques', 'leads_meta'].includes(id.split('.')[1]!)) && temCampanha(e)) {
    const q: unknown[] = [desde];
    const a = (v: unknown) => `$${q.push(v)}`;
    const ids = e.campanhas.map((c) => c.id).filter((x): x is string => !!x);
    const nomes = e.campanhas.filter((c) => !c.id && c.nome).map((c) => (c.nome as string).toLowerCase());
    const qual = [ids.length ? `campanha_id = any(${a(ids)}::bigint[])` : '', nomes.length ? `lower(campanha) = any(${a(nomes)}::text[])` : ''].filter(Boolean).join(' or ');
    tarefas.push(db.query(`select dia::text as dia, sum(gasto)::float8 as gasto, sum(impressoes)::float8 as impressoes, sum(cliques_link)::float8 as cliques, sum(leads_meta)::float8 as leads_meta
                             from analytics.meta_desempenho_dia where dia >= $1::date and (${qual}) group by 1`, q).then((r) => {
      for (const x of r.rows) { const dia = String(x.dia); poe('campanhas.invest', dia, n(x.gasto)); poe('campanhas.impressoes', dia, n(x.impressoes)); poe('campanhas.cliques', dia, n(x.cliques)); poe('campanhas.leads_meta', dia, n(x.leads_meta)); }
    }));
  }
  if (campoIds.includes('pagina.visualizacoes') && e.paginaCaminho) {
    const q: unknown[] = [desde, e.paginaCaminho];
    tarefas.push(db.query(`select dia::text as dia, sum(visualizacoes)::float8 as v from analytics.site_paginas_dia
                            where dia >= $1::date and caminho = $2${e.paginaHost ? ` and regexp_replace(host, '^www[.]', '') = $${q.push(e.paginaHost)}` : ''} group by 1`, q).then((r) => { for (const x of r.rows) poe('pagina.visualizacoes', String(x.dia), n(x.v)); }));
  }
  await Promise.all(tarefas);
  return out;
}
