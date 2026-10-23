/**
 * Monitor diário (pedido do Pablo, 2026-10-21): como estamos HOJE contra ontem, a SEMANA contra o mesmo trecho da semana anterior e o MÊS contra
 * o mesmo trecho do mês anterior, no total e em cada canal (Google Ads, Meta Ads, Social e Orgânico) separadamente.
 *
 * Fluxo por data do evento (nunca safra): lead e MQL pela data de CRIAÇÃO do negócio; Reunião Agendada pela data em que o negócio ENTROU na etapa;
 * ganho e MRR novo pela data do FECHAMENTO; investimento pelo dia do gasto. Dia vira à meia-noite em America/Fortaleza; semana começa na segunda.
 * "Mesmo trecho" = mesmo número de dias desde o início do período. No comparativo do dia, as contagens de ontem vão até a MESMA HORA de agora.
 * Só leitura sobre as visões de analytics (papel orq_panel).
 */
import type pg from 'pg';

export const TZ_MONITOR = 'America/Fortaleza';
export const CANAIS = [
  { id: 'google', nome: 'Google Ads', fonte: 'Marketing [Google ADS]', pago: true },
  { id: 'meta', nome: 'Meta Ads', fonte: 'Marketing [Meta ADS]', pago: true },
  { id: 'social', nome: 'Social', fonte: 'Marketing [Social]', pago: false },
  { id: 'organico', nome: 'Orgânico', fonte: 'Marketing [Orgânico]', pago: false },
] as const;
export type CanalId = (typeof CANAIS)[number]['id'];
export const PRODUTOS_MONITOR = ['rh', 'clinic'] as const;
export type ProdutoMonitor = (typeof PRODUTOS_MONITOR)[number];
export type PeriodoId = 'dia' | 'semana' | 'mes';

/** Contagens e valores de um dia (ou da soma de vários). */
export interface Soma {
  leads: number; mql: number; reunioes: number; ganhos: number; mrr: number; invest: number;
  /** Funil de mídia: impressões e cliques no link (Meta Ads e Google Ads) e sessões no site (GA4: Social e Orgânico). */
  impressoes: number; cliques: number; sessoes: number;
  /** Leads dos dias em que o degrau de tráfego existe (GA4 chega com 1 dia de atraso): base da taxa tráfego -> lead. */
  leadsT: number;
}
export const ZERO: Soma = { leads: 0, mql: 0, reunioes: 0, ganhos: 0, mrr: 0, invest: 0, impressoes: 0, cliques: 0, sessoes: 0, leadsT: 0 };
/**
 * Métricas exibidas, na ordem do funil: investimento -> impressões -> cliques ou visitas -> lead. Custos e taxas são nulos quando não se aplicam
 * (canal sem verba: "não se aplica", nunca zero). `trafego` = cliques no link (pagos) + sessões do site (Social e Orgânico).
 */
export interface Metricas extends Soma {
  trafego: number | null; cpm: number | null; ctr: number | null; cpc: number | null; txLead: number | null;
  cpl: number | null; cac: number | null; pctMql: number | null;
}

export interface Janela { de: string; ate: string; dias: number }
export interface PeriodosDef { dia: { atual: Janela; anterior: Janela }; semana: { atual: Janela; anterior: Janela }; mes: { atual: Janela; anterior: Janela } }

export const somaDias = (d: string, k: number) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const diasEntre = (de: string, ate: string) => Math.round((Date.parse(ate) - Date.parse(de)) / 86_400_000) + 1;
const janela = (de: string, ate: string): Janela => ({ de, ate, dias: diasEntre(de, ate) });

/** Janelas de comparação a partir de "hoje" (AAAA-MM-DD, no fuso do Monitor). */
export function periodosDe(hoje: string): PeriodosDef {
  const ontem = somaDias(hoje, -1);
  const segunda = somaDias(hoje, -((new Date(`${hoje}T00:00:00Z`).getUTCDay() + 6) % 7));
  const nSemana = diasEntre(segunda, hoje);
  const segAnt = somaDias(segunda, -7);
  const primeiro = `${hoje.slice(0, 7)}-01`;
  const nMes = Number(hoje.slice(8, 10));
  const y = Number(hoje.slice(0, 4));
  const m = Number(hoje.slice(5, 7));
  const primeiroAnt = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const ultimoAnt = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
  const fimAnt = somaDias(primeiroAnt, nMes - 1) > ultimoAnt ? ultimoAnt : somaDias(primeiroAnt, nMes - 1); // mês anterior mais curto: vai até o último dia dele
  return {
    dia: { atual: janela(hoje, hoje), anterior: janela(ontem, ontem) },
    semana: { atual: janela(segunda, hoje), anterior: janela(segAnt, somaDias(segAnt, nSemana - 1)) },
    mes: { atual: janela(primeiro, hoje), anterior: janela(primeiroAnt, fimAnt) },
  };
}

const CAMPOS_SOMA = Object.keys(ZERO) as Array<keyof Soma>;
export const somar = (a: Soma, b: Partial<Soma>): Soma => Object.fromEntries(CAMPOS_SOMA.map((k) => [k, a[k] + (b[k] ?? 0)])) as unknown as Soma;
const razao = (a: number, b: number): number | null => (b > 0 ? a / b : null);
export const metricas = (s: Soma): Metricas => {
  const trafego = s.cliques + s.sessoes;
  return {
    ...s,
    trafego: trafego > 0 ? trafego : null,
    cpm: s.invest > 0 && s.impressoes > 0 ? (s.invest / s.impressoes) * 1000 : null,
    ctr: razao(s.cliques, s.impressoes),
    cpc: s.invest > 0 ? razao(s.invest, s.cliques) : null,
    txLead: razao(s.leadsT, trafego),
    cpl: s.invest > 0 ? razao(s.invest, s.leads) : null,
    cac: s.invest > 0 ? razao(s.invest, s.ganhos) : null,
    pctMql: razao(s.mql, s.leads),
  };
};

/** Dados diários por canal (dia AAAA-MM-DD -> Soma) mais as contagens de ontem até a mesma hora. */
export interface DadosMonitor {
  diario: Record<CanalId, Map<string, Soma>>;
  ontemMesmaHora: Record<CanalId, Soma>;
  /** HH:MM de agora, no fuso do Monitor. */
  hora: string;
  /** Último dia com sessões do GA4 (chega com cerca de 1 dia de atraso); depois dele o degrau de visitas de Social e Orgânico não existe. */
  trafegoAte: string | null;
}
/** Canais cujo degrau de tráfego vem do GA4 (sessões do site), não de mídia paga. */
const USA_GA4: ReadonlySet<CanalId> = new Set<CanalId>(['social', 'organico']);

export const somaJanela = (m: Map<string, Soma>, j: Janela): Soma => {
  let s = ZERO;
  for (let d = j.de; d <= j.ate; d = somaDias(d, 1)) s = somar(s, m.get(d) ?? ZERO);
  return s;
};
/** Soma dia a dia dos canais pedidos (padrão: os 4). */
export const total = (d: Record<CanalId, Map<string, Soma>>, canais: ReadonlyArray<CanalId> = CANAIS.map((c) => c.id)): Map<string, Soma> => {
  const t = new Map<string, Soma>();
  for (const id of canais) for (const [dia, s] of d[id]) t.set(dia, somar(t.get(dia) ?? ZERO, s));
  return t;
};
/** Canais com verba (Google Ads e Meta Ads): são os que têm CPL e CAC de mídia. */
export const CANAIS_PAGOS: ReadonlyArray<CanalId> = CANAIS.filter((c) => c.pago).map((c) => c.id);

/** As n últimas semanas COMPLETAS (segunda a domingo) antes de hoje, da mais recente para trás. */
export function semanasCompletas(hoje: string, n = 8): Janela[] {
  const segunda = somaDias(hoje, -((new Date(`${hoje}T00:00:00Z`).getUTCDay() + 6) % 7));
  return Array.from({ length: n }, (_, k) => janela(somaDias(segunda, -7 * (k + 1)), somaDias(segunda, -7 * (k + 1) + 6)));
}
/** Métricas de uma janela para um canal, ou para o total ('total') ou só a mídia paga ('pagos'). CPL e CAC do total e da mídia paga usam só leads e ganhos de canais pagos. */
export function metricasDe(d: Pick<DadosMonitor, 'diario'>, quem: CanalId | 'total' | 'pagos', j: Janela): Metricas {
  const m = quem === 'total' ? total(d.diario) : quem === 'pagos' ? total(d.diario, CANAIS_PAGOS) : d.diario[quem];
  const s = somaJanela(m, j);
  const pg = quem === 'total' ? somaJanela(total(d.diario, CANAIS_PAGOS), j) : s;
  const base = metricas(s);
  return { ...base, cpl: s.invest > 0 ? razao(s.invest, pg.leads) : null, cac: s.invest > 0 ? razao(s.invest, pg.ganhos) : null };
}

export interface ParAtualAnterior { atual: Metricas; anterior: Metricas }
export interface CanalMonitor { id: CanalId | 'total'; nome: string; pago: boolean; periodos: Record<PeriodoId, ParAtualAnterior>; serie: { dias: string[]; leads: number[]; mql: number[]; ganhos: number[]; invest: number[] } }
export interface Monitor {
  hoje: string; hora: string; tz: string; janelas: PeriodosDef;
  canais: CanalMonitor[];
  /** Leitura em uma frase do que pesa mais, calculada do total (ver `veredito`). */
  veredito: Veredito;
}

/**
 * Métricas "boas quando sobem" (true) ou "boas quando descem" (false); investimento não é bom nem ruim (null).
 */
export const BOM_SE_SOBE: Record<keyof Metricas, boolean | null> = {
  leads: true, mql: true, reunioes: true, ganhos: true, mrr: true, pctMql: true, cpl: false, cac: false, invest: null,
  impressoes: null, cliques: null, sessoes: null, leadsT: null, trafego: true, cpm: false, ctr: true, cpc: false, txLead: true,
};

export interface Veredito { leads: number; ganhos: number; mrr: number; pior: { metrica: keyof Metricas; periodo: PeriodoId; pct: number } | null }
const KPIS_VEREDITO: Array<keyof Metricas> = ['mrr', 'ganhos', 'cac', 'leads', 'pctMql', 'cpl'] as Array<keyof Metricas>;
export function veredito(t: CanalMonitor): Veredito {
  let pior: Veredito['pior'] = null;
  // só semana e mês: o dia ainda em andamento oscila demais (um ganho a mais ou a menos muda o CAC em centenas de %)
  for (const p of ['semana', 'mes'] as PeriodoId[]) {
    for (const k of KPIS_VEREDITO) {
      const a = t.periodos[p].atual[k] as number | null;
      const b = t.periodos[p].anterior[k] as number | null;
      if (a == null || b == null || b === 0) continue;
      const pct = a / b - 1;
      const piora = BOM_SE_SOBE[k] ? -pct : pct; // positivo = piorou
      if (piora > 0.05 && (!pior || piora > (BOM_SE_SOBE[pior.metrica] ? -pior.pct : pior.pct))) pior = { metrica: k, periodo: p, pct };
    }
  }
  const mes = t.periodos.mes.atual;
  return { leads: mes.leads, ganhos: mes.ganhos, mrr: mes.mrr, pior };
}

/** Monta o Monitor (puro: recebe os dados diários e "hoje"). */
export function montarMonitor(d: DadosMonitor, hoje: string): Monitor {
  const janelas = periodosDe(hoje);
  const serieDias = Array.from({ length: 30 }, (_, i) => somaDias(hoje, i - 29));
  const montar = (id: CanalId | 'total', nome: string, pago: boolean, m: Map<string, Soma>, ontemHora: Soma, mPagos: Map<string, Soma> = m): CanalMonitor => {
    const periodos = {} as Record<PeriodoId, ParAtualAnterior>;
    for (const p of ['dia', 'semana', 'mes'] as PeriodoId[]) {
      const atual = somaJanela(m, janelas[p].atual);
      const inteiro = somaJanela(m, janelas[p].anterior);
      // CPL e CAC de mídia: investimento ÷ leads (ou ganhos) dos canais PAGOS; no total, os leads e ganhos de Social e Orgânico não entram na conta do custo
      const ajusta = (met: Metricas, s: Soma, pg: Soma): Metricas => ({ ...met, cpl: s.invest > 0 ? razao(s.invest, pg.leads) : null, cac: s.invest > 0 ? razao(s.invest, pg.ganhos) : null });
      const pgAtual = somaJanela(mPagos, janelas[p].atual);
      const pgInteiro = somaJanela(mPagos, janelas[p].anterior);
      if (p === 'dia') {
        // contagens de ontem até a mesma hora; investimento, impressões, cliques, sessões e todas as razões (CPM, CTR, CPC, taxa, CPL, CAC) de ontem
        // inteiro: o gasto e o tráfego só existem por dia, e custo e taxa são razões
        const hora = metricas({ ...ontemHora, invest: inteiro.invest });
        const cheio = ajusta(metricas(inteiro), inteiro, pgInteiro);
        periodos[p] = {
          atual: ajusta(metricas(atual), atual, pgAtual),
          anterior: { ...hora, invest: cheio.invest, impressoes: cheio.impressoes, cliques: cheio.cliques, sessoes: cheio.sessoes, leadsT: cheio.leadsT, trafego: cheio.trafego, cpm: cheio.cpm, ctr: cheio.ctr, cpc: cheio.cpc, txLead: cheio.txLead, cpl: cheio.cpl, cac: cheio.cac },
        };
      } else periodos[p] = { atual: ajusta(metricas(atual), atual, pgAtual), anterior: ajusta(metricas(inteiro), inteiro, pgInteiro) };
    }
    const serie = { dias: serieDias, leads: [] as number[], mql: [] as number[], ganhos: [] as number[], invest: [] as number[] };
    for (const dia of serieDias) {
      const s = m.get(dia) ?? ZERO;
      serie.leads.push(s.leads); serie.mql.push(s.mql); serie.ganhos.push(s.ganhos); serie.invest.push(s.invest);
    }
    return { id, nome, pago, periodos, serie };
  };
  const ontemTotal = CANAIS.reduce((s, c) => somar(s, d.ontemMesmaHora[c.id]), ZERO);
  const canais = [montar('total', 'Total dos 4 canais', true, total(d.diario), ontemTotal, total(d.diario, CANAIS_PAGOS)), ...CANAIS.map((c) => montar(c.id, c.nome, c.pago, d.diario[c.id], d.ontemMesmaHora[c.id]))];
  return { hoje, hora: d.hora, tz: TZ_MONITOR, janelas, canais, veredito: veredito(canais[0]!) };
}

/* ---------- leitura do banco ---------- */
type Db = Pick<pg.Pool, 'query'>;
const n = (v: unknown) => (v == null ? 0 : Number(v));
const canalDeFonte = (fonte: string): CanalId | null => CANAIS.find((c) => c.fonte === fonte)?.id ?? null;
const FONTES = CANAIS.map((c) => c.fonte);

/** Data e hora de agora no fuso do Monitor. */
export function agoraLocal(agora = new Date()): { hoje: string; hora: string } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_MONITOR, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(agora);
  const g = (t: string) => f.find((p) => p.type === t)!.value;
  return { hoje: `${g('year')}-${g('month')}-${g('day')}`, hora: `${g('hour')}:${g('minute')}` };
}

export async function lerDadosMonitor(db: Db, hoje: string, hora: string, produto?: ProdutoMonitor, desde?: string): Promise<DadosMonitor> {
  const j = periodosDe(hoje);
  const inicio = [j.mes.anterior.de, j.semana.anterior.de, somaDias(hoje, -29), ...(desde ? [desde] : [])].sort()[0]!; // o mais antigo entre mês anterior, semana anterior e a série de 30 dias
  const ontem = somaDias(hoje, -1);
  const diario = Object.fromEntries(CANAIS.map((c) => [c.id, new Map<string, Soma>()])) as Record<CanalId, Map<string, Soma>>;
  const ontemMesmaHora = Object.fromEntries(CANAIS.map((c) => [c.id, ZERO])) as Record<CanalId, Soma>;
  const poe = (c: CanalId, dia: string, parte: Partial<Soma>) => diario[c].set(dia, somar(diario[c].get(dia) ?? ZERO, parte));
  const ts = (col: string) => `(${col} at time zone '${TZ_MONITOR}')`;
  const ini = `($1::date)::timestamp`; // início da janela, em hora local
  const prod = produto ? ' and d.produto = $3' : '';
  const params = () => (produto ? [inicio, FONTES, produto] : [inicio, FONTES]);

  const [criados, ganhos, reunioes] = await Promise.all([
    db.query(`select to_char(${ts('d.criado_em')}, 'YYYY-MM-DD') as dia, d.fonte, count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql
                from analytics.negocios_bi d where ${ts('d.criado_em')} >= ${ini} and d.fonte = any($2)${prod} group by 1, 2`, params()),
    db.query(`select to_char(${ts('d.fechado_em')}, 'YYYY-MM-DD') as dia, d.fonte, count(*)::int as ganhos, coalesce(sum(d.valor), 0)::float8 as mrr
                from analytics.negocios_bi d where d.status = 'won' and d.fechado_em is not null and ${ts('d.fechado_em')} >= ${ini} and d.fonte = any($2)${prod} group by 1, 2`, params()),
    db.query(`select to_char(${ts('m.chegou_em')}, 'YYYY-MM-DD') as dia, d.fonte, count(distinct m.deal_id)::int as reunioes
                from analytics.negocios_marcos m join analytics.negocios_bi d on d.deal_id = m.deal_id
               where m.marco = 'reuniao' and ${ts('m.chegou_em')} >= ${ini} and d.fonte = any($2)${prod} group by 1, 2`, params()),
  ]);
  for (const r of criados.rows) { const c = canalDeFonte(r.fonte); if (c) poe(c, r.dia, { leads: n(r.leads), mql: n(r.mql) }); }
  for (const r of ganhos.rows) { const c = canalDeFonte(r.fonte); if (c) poe(c, r.dia, { ganhos: n(r.ganhos), mrr: n(r.mrr) }); }
  for (const r of reunioes.rows) { const c = canalDeFonte(r.fonte); if (c) poe(c, r.dia, { reunioes: n(r.reunioes) }); }

  // investimento por dia: Meta pela conta do produto; Google Ads vem do GA4 do site (QuarkRH): só entra no total e no RH
  // funil de mídia paga: gasto, impressões e cliques no link; Social e Orgânico não têm verba: o topo deles são as sessões do site (GA4)
  const meta = await db.query(
    `select dia::text as dia, sum(gasto)::float8 as gasto, sum(impressoes)::float8 as impressoes, sum(cliques_link)::float8 as cliques from analytics.meta_desempenho_dia m
      where m.dia >= $1::date${produto ? ' and m.produto = $2' : ''} group by 1`, produto ? [inicio, produto] : [inicio]);
  for (const r of meta.rows) poe('meta', r.dia, { invest: n(r.gasto), impressoes: n(r.impressoes), cliques: n(r.cliques) });
  if (!produto || produto === 'rh') {
    const g = await db.query(`select dia::text as dia, sum(custo)::float8 as custo, sum(impressoes)::float8 as impressoes, sum(cliques)::float8 as cliques from analytics.ads_investimento_dia where dia >= $1::date group by 1`, [inicio]);
    for (const r of g.rows) poe('google', r.dia, { invest: n(r.custo), impressoes: n(r.impressoes), cliques: n(r.cliques) });
  }
  // sessões do site por canal (a mídia do GA4: social = midia "social"; orgânico = busca orgânica); o site do QuarkClinic é um host separado
  const host = produto === 'clinic' ? ` and host = 'quarkclinic.com.br'` : produto === 'rh' ? ` and host <> 'quarkclinic.com.br'` : '';
  const [ga, ultimoGa] = await Promise.all([
    db.query(`select dia::text as dia, midia, sum(sessoes)::float8 as sessoes from analytics.site_sessoes_dia where dia >= $1::date and midia in ('social', 'organic')${host} group by 1, 2`, [inicio]),
    db.query(`select max(dia)::text as dia from analytics.site_sessoes_dia`),
  ]);
  for (const r of ga.rows) poe(r.midia === 'social' ? 'social' : 'organico', r.dia, { sessoes: n(r.sessoes) });
  const trafegoAte: string | null = ultimoGa.rows[0]?.dia ?? null;
  // leadsT: leads dos dias em que o degrau de tráfego existe (o GA4 não tem o dia de hoje), base da taxa tráfego -> lead
  for (const c of CANAIS) {
    for (const [dia, s] of diario[c.id]) diario[c.id].set(dia, { ...s, leadsT: USA_GA4.has(c.id) && (trafegoAte == null || dia > trafegoAte) ? 0 : s.leads });
  }

  // ontem até a mesma hora (só contagens: o gasto só existe por dia)
  const de = `${ontem} 00:00:00`;
  const ate = `${ontem} ${hora}:59`;
  const q = (sql: string) => db.query(sql, produto ? [FONTES, produto, de, ate] : [FONTES, de, ate]);
  const a = (k: number) => `$${(produto ? 2 : 1) + k}`; // $de, $ate
  const pr = produto ? ' and d.produto = $2' : '';
  const [oc, og, or] = await Promise.all([
    q(`select d.fonte, count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql from analytics.negocios_bi d
        where ${ts('d.criado_em')} between ${a(1)}::timestamp and ${a(2)}::timestamp and d.fonte = any($1)${pr} group by 1`),
    q(`select d.fonte, count(*)::int as ganhos, coalesce(sum(d.valor), 0)::float8 as mrr from analytics.negocios_bi d
        where d.status = 'won' and ${ts('d.fechado_em')} between ${a(1)}::timestamp and ${a(2)}::timestamp and d.fonte = any($1)${pr} group by 1`),
    q(`select d.fonte, count(distinct m.deal_id)::int as reunioes from analytics.negocios_marcos m join analytics.negocios_bi d on d.deal_id = m.deal_id
        where m.marco = 'reuniao' and ${ts('m.chegou_em')} between ${a(1)}::timestamp and ${a(2)}::timestamp and d.fonte = any($1)${pr} group by 1`),
  ]);
  for (const r of oc.rows) { const c = canalDeFonte(r.fonte); if (c) ontemMesmaHora[c] = somar(ontemMesmaHora[c], { leads: n(r.leads), mql: n(r.mql) }); }
  for (const r of og.rows) { const c = canalDeFonte(r.fonte); if (c) ontemMesmaHora[c] = somar(ontemMesmaHora[c], { ganhos: n(r.ganhos), mrr: n(r.mrr) }); }
  for (const r of or.rows) { const c = canalDeFonte(r.fonte); if (c) ontemMesmaHora[c] = somar(ontemMesmaHora[c], { reunioes: n(r.reunioes) }); }
  return { diario, ontemMesmaHora, hora, trafegoAte };
}

export interface MonitorRepo { monitor(produto?: ProdutoMonitor): Promise<Monitor> }
export class PgMonitorRepo implements MonitorRepo {
  constructor(private readonly db: Db, private readonly agora: () => Date = () => new Date()) {}
  async monitor(produto?: ProdutoMonitor): Promise<Monitor> {
    const { hoje, hora } = agoraLocal(this.agora());
    return montarMonitor(await lerDadosMonitor(this.db, hoje, hora, produto), hoje);
  }
}
