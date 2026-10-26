/**
 * Experimentos de growth (pedido do Pablo, 2026-10-26): cadastro simples (hipótese, produto, canal, métrica, meta, período, orçamento e ICE) e
 * acompanhamento AUTOMÁTICO. O resultado, a linha de base, o gasto e o ritmo contra o previsto vêm das mesmas visões de analytics do Monitor
 * (studio/lib/monitor.ts); nada é digitado depois do cadastro.
 *
 * Regras: dia fecha à meia-noite em America/Fortaleza; só dias COMPLETOS entram (até ontem). Linha de base automática = o mesmo número de dias
 * imediatamente antes do início. Métricas de contagem (leads, ganhos...) têm meta = total do período e ritmo linear; métricas de custo e taxa
 * (CPL, CAC, % MQL...) têm meta = valor a atingir e a trajetória sai da linha de base até a meta. Só leitura nas visões (papel orq_panel);
 * a única escrita é a tabela mkt.experimentos.
 */
import type pg from 'pg';
import { PainelInvalido, PainelNotFound } from './painel-repo.js';
import { agoraLocal, lerDadosMonitor, metricasDe, somaDias, type CanalId, type DadosMonitor, type Janela, type ProdutoMonitor } from './monitor.js';

type Db = Pick<pg.Pool, 'query'>;

export const EXP_PRODUTOS = ['rh', 'clinic'] as const;
export const EXP_CANAIS = [
  { id: 'total', nome: 'Total dos 4 canais', pago: true },
  { id: 'pagos', nome: 'Mídia paga (Google e Meta)', pago: true },
  { id: 'google', nome: 'Google Ads', pago: true },
  { id: 'meta', nome: 'Meta Ads', pago: true },
  { id: 'social', nome: 'Social', pago: false },
  { id: 'organico', nome: 'Orgânico', pago: false },
] as const;
export type ExpCanal = (typeof EXP_CANAIS)[number]['id'];
export const EXP_STATUS = ['planejado', 'rodando', 'concluido', 'cancelado'] as const;
export type ExpStatus = (typeof EXP_STATUS)[number];
export type Desfecho = 'atingiu' | 'parcial' | 'nao_atingiu';

export type FormatoMetrica = 'int' | 'brl' | 'brl2' | 'pct';
/** soma: o resultado é o total do período. razao: é um custo ou uma taxa do período inteiro. */
export interface MetricaExp {
  id: string; rotulo: string; formato: FormatoMetrica; tipo: 'soma' | 'razao';
  /** Direção boa: subir (leads) ou descer (CPL). */
  melhor: 'subir' | 'descer';
  /** Depende de investimento: não existe em Social e Orgânico (sem verba). */
  precisaVerba: boolean;
  nota: string;
}
export const METRICAS_EXP: readonly MetricaExp[] = [
  { id: 'leads', rotulo: 'Leads', formato: 'int', tipo: 'soma', melhor: 'subir', precisaVerba: false, nota: 'negócios criados que contam como lead (D-36)' },
  { id: 'mql', rotulo: 'MQL', formato: 'int', tipo: 'soma', melhor: 'subir', precisaVerba: false, nota: 'leads qualificados pela regra D-36' },
  { id: 'reunioes', rotulo: 'Reuniões agendadas', formato: 'int', tipo: 'soma', melhor: 'subir', precisaVerba: false, nota: 'negócios que entraram na etapa de reunião' },
  { id: 'ganhos', rotulo: 'Ganhos', formato: 'int', tipo: 'soma', melhor: 'subir', precisaVerba: false, nota: 'negócios ganhos, pela data do fechamento' },
  { id: 'mrr', rotulo: 'MRR novo', formato: 'brl', tipo: 'soma', melhor: 'subir', precisaVerba: false, nota: 'valor dos negócios ganhos (o MRR do Pipedrive está vazio)' },
  { id: 'cpl', rotulo: 'CPL', formato: 'brl2', tipo: 'razao', melhor: 'descer', precisaVerba: true, nota: 'investimento ÷ leads' },
  { id: 'cpmql', rotulo: 'Custo por MQL', formato: 'brl2', tipo: 'razao', melhor: 'descer', precisaVerba: true, nota: 'investimento ÷ MQL' },
  { id: 'cpreuniao', rotulo: 'Custo por reunião', formato: 'brl2', tipo: 'razao', melhor: 'descer', precisaVerba: true, nota: 'investimento ÷ reuniões agendadas' },
  { id: 'cac', rotulo: 'CAC de mídia', formato: 'brl2', tipo: 'razao', melhor: 'descer', precisaVerba: true, nota: 'investimento ÷ ganhos, sem time nem ferramentas' },
  { id: 'cpc', rotulo: 'CPC', formato: 'brl2', tipo: 'razao', melhor: 'descer', precisaVerba: true, nota: 'investimento ÷ cliques no link' },
  { id: 'cpm', rotulo: 'CPM', formato: 'brl2', tipo: 'razao', melhor: 'descer', precisaVerba: true, nota: 'custo por mil impressões' },
  { id: 'ctr', rotulo: 'CTR', formato: 'pct', tipo: 'razao', melhor: 'subir', precisaVerba: true, nota: 'cliques no link ÷ impressões' },
  { id: 'pctMql', rotulo: '% MQL', formato: 'pct', tipo: 'razao', melhor: 'subir', precisaVerba: false, nota: 'MQL ÷ leads' },
  { id: 'txLead', rotulo: 'Taxa até o lead', formato: 'pct', tipo: 'razao', melhor: 'subir', precisaVerba: false, nota: 'leads ÷ cliques ou visitas' },
];
const METRICA_POR_ID = new Map(METRICAS_EXP.map((m) => [m.id, m]));

export interface Experimento {
  id: number; titulo: string; hipotese: string | null; produto: ProdutoMonitor; canal: ExpCanal; metrica: string;
  meta: number; linhaBase: number | null; orcamento: number | null; inicio: string; fim: string; status: ExpStatus;
  iceImpacto: number | null; iceConfianca: number | null; iceFacilidade: number | null; iceScore: number | null;
  valorFinal: number | null; atingimentoFinal: number | null; desfecho: Desfecho | null; aprendizado: string | null;
  criadoEm: string; atualizadoEm: string;
}

export type Estado = 'cancelado' | 'nao_iniciou' | 'cedo' | 'sem_dados' | 'atingida' | 'em_linha' | 'atencao' | 'fora';
export const ESTADO_ROTULO: Record<Estado, string> = {
  cancelado: 'Cancelado', nao_iniciou: 'Ainda não começou', cedo: 'Poucos dias de dados', sem_dados: 'Sem dados no período',
  atingida: 'Meta atingida', em_linha: 'Em linha', atencao: 'Atenção', fora: 'Abaixo do previsto',
};
export interface PontoSerie { dia: string; real: number | null; esperado: number | null }
export interface Progresso {
  estado: Estado;
  /** Dados completos até esta data (ontem, ou o fim do experimento se já passou). */
  dadosAte: string;
  diasCompletos: number; totalDias: number;
  /** Fração do prazo coberta pelos dias completos (0 a 1). */
  decorrido: number;
  atual: number | null; esperado: number | null;
  linhaBase: number | null; linhaBaseAuto: boolean;
  /** Quanto do caminho até a meta já foi andado (1 = meta batida). */
  atingimento: number | null;
  /** Projeção ao fim do prazo (só métricas de contagem). */
  projecao: number | null;
  gasto: number; usoOrcamento: number | null; orcamentoAdiantado: boolean;
  serie: PontoSerie[];
  /** Reta prevista: de (inicio, v0) até (fim, v1). */
  trajetoria: { v0: number; v1: number } | null;
}
export interface ExperimentoComProgresso extends Experimento { progresso: Progresso }

/* ---------- validação (pura) ---------- */
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const dataValida = (v: unknown): v is string => typeof v === 'string' && DATA_RE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const inv = (m: string) => new PainelInvalido(m);

export interface ExperimentoEntrada {
  titulo?: string; hipotese?: string | null; produto?: string; canal?: string; metrica?: string; meta?: number; linhaBase?: number | null;
  orcamento?: number | null; inicio?: string; fim?: string; status?: string; iceImpacto?: number | null; iceConfianca?: number | null;
  iceFacilidade?: number | null; aprendizado?: string | null;
}
const num = (v: unknown, nome: string): number => { if (typeof v !== 'number' || !isFinite(v)) throw inv(`${nome} deve ser um número`); return v; };
const numOuNulo = (v: unknown, nome: string): number | null => (v == null ? null : num(v, nome));
const ice = (v: unknown, nome: string): number | null => {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 10) throw inv(`${nome} deve ser um número inteiro de 1 a 10`);
  return v;
};

/** Confere uma entrada (completa na criação, parcial na edição) e devolve só os campos válidos. `atual` completa as checagens cruzadas na edição. */
export function validarEntrada(b: unknown, modo: 'criar' | 'editar', atual?: Pick<Experimento, 'produto' | 'canal' | 'metrica' | 'inicio' | 'fim'>): ExperimentoEntrada {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw inv('corpo inválido');
  const e = b as Record<string, unknown>;
  const out: ExperimentoEntrada = {};
  const tem = (k: string) => k in e;
  if (modo === 'criar') for (const k of ['titulo', 'produto', 'metrica', 'meta', 'inicio', 'fim']) if (!tem(k)) throw inv(`falta ${k}`);
  if (tem('titulo')) { if (typeof e.titulo !== 'string' || !e.titulo.trim() || e.titulo.trim().length > 160) throw inv('título deve ter de 1 a 160 caracteres'); out.titulo = e.titulo.trim(); }
  if (tem('hipotese')) { if (e.hipotese != null && (typeof e.hipotese !== 'string' || e.hipotese.length > 2000)) throw inv('hipótese deve ter até 2000 caracteres'); out.hipotese = typeof e.hipotese === 'string' && e.hipotese.trim() ? e.hipotese.trim() : null; }
  if (tem('produto')) { if (!(EXP_PRODUTOS as readonly unknown[]).includes(e.produto)) throw inv('produto deve ser rh ou clinic'); out.produto = e.produto as string; }
  if (tem('canal')) { if (!EXP_CANAIS.some((c) => c.id === e.canal)) throw inv(`canal inválido (${EXP_CANAIS.map((c) => c.id).join(', ')})`); out.canal = e.canal as string; }
  if (tem('metrica')) { if (typeof e.metrica !== 'string' || !METRICA_POR_ID.has(e.metrica)) throw inv(`métrica inválida (${METRICAS_EXP.map((m) => m.id).join(', ')})`); out.metrica = e.metrica; }
  if (tem('meta')) out.meta = num(e.meta, 'meta');
  if (tem('linhaBase')) out.linhaBase = numOuNulo(e.linhaBase, 'linhaBase');
  if (tem('orcamento')) { const o = numOuNulo(e.orcamento, 'orçamento'); if (o != null && o < 0) throw inv('orçamento não pode ser negativo'); out.orcamento = o; }
  if (tem('inicio')) { if (!dataValida(e.inicio)) throw inv('início deve ser AAAA-MM-DD'); out.inicio = e.inicio; }
  if (tem('fim')) { if (!dataValida(e.fim)) throw inv('fim deve ser AAAA-MM-DD'); out.fim = e.fim; }
  if (tem('status')) { if (!(EXP_STATUS as readonly unknown[]).includes(e.status)) throw inv(`status inválido (${EXP_STATUS.join(', ')})`); out.status = e.status as string; }
  if (tem('iceImpacto')) out.iceImpacto = ice(e.iceImpacto, 'impacto');
  if (tem('iceConfianca')) out.iceConfianca = ice(e.iceConfianca, 'confiança');
  if (tem('iceFacilidade')) out.iceFacilidade = ice(e.iceFacilidade, 'facilidade');
  if (tem('aprendizado')) { if (e.aprendizado != null && (typeof e.aprendizado !== 'string' || e.aprendizado.length > 4000)) throw inv('aprendizado deve ter até 4000 caracteres'); out.aprendizado = typeof e.aprendizado === 'string' && e.aprendizado.trim() ? e.aprendizado.trim() : null; }

  const inicio = out.inicio ?? atual?.inicio, fim = out.fim ?? atual?.fim;
  if (inicio && fim && fim < inicio) throw inv('o fim não pode ser antes do início');
  const canal = (out.canal ?? atual?.canal ?? 'total') as ExpCanal;
  const metrica = METRICA_POR_ID.get(out.metrica ?? atual?.metrica ?? '');
  if (metrica?.precisaVerba && !EXP_CANAIS.find((c) => c.id === canal)!.pago) throw inv(`${metrica.rotulo} depende de investimento: Social e Orgânico não têm verba. Escolha outro canal ou outra métrica`);
  return out;
}

/* ---------- cálculo (puro) ---------- */
const razao = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const diasEntre = (de: string, ate: string) => Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000) + 1;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Valor de uma métrica em uma janela, para um canal (ou o total, ou só a mídia paga). Custos do total usam os leads, MQL, reuniões e ganhos dos canais pagos. */
export function valorMetrica(d: Pick<DadosMonitor, 'diario'>, canal: ExpCanal, metrica: string, j: Janela): number | null {
  const m = metricasDe(d, canal as CanalId | 'total' | 'pagos', j);
  const pg = canal === 'total' ? metricasDe(d, 'pagos', j) : m;
  switch (metrica) {
    case 'cpmql': return m.invest > 0 ? razao(m.invest, pg.mql) : null;
    case 'cpreuniao': return m.invest > 0 ? razao(m.invest, pg.reunioes) : null;
    default: { const v = (m as unknown as Record<string, number | null>)[metrica]; return v ?? null; }
  }
}

const janela = (de: string, ate: string): Janela => ({ de, ate, dias: diasEntre(de, ate) });

export function calcularProgresso(e: Pick<Experimento, 'canal' | 'metrica' | 'meta' | 'linhaBase' | 'orcamento' | 'inicio' | 'fim' | 'status'>, d: Pick<DadosMonitor, 'diario'>, hoje: string): Progresso {
  const met = METRICA_POR_ID.get(e.metrica);
  const totalDias = diasEntre(e.inicio, e.fim);
  const ontem = somaDias(hoje, -1);
  const dadosAte = e.fim < ontem ? e.fim : ontem;
  const diasCompletos = dadosAte >= e.inicio ? diasEntre(e.inicio, dadosAte) : 0;
  const decorrido = clamp01(diasCompletos / totalDias);

  // linha de base: valor combinado, ou o mesmo número de dias imediatamente antes do início
  const auto = e.linhaBase == null;
  const baseJ = janela(somaDias(e.inicio, -totalDias), somaDias(e.inicio, -1));
  const baseAuto = met ? valorMetrica(d, e.canal, e.metrica, baseJ) : null;
  const linhaBase = e.linhaBase ?? baseAuto;

  const vazio: Progresso = { estado: 'sem_dados', dadosAte, diasCompletos, totalDias, decorrido, atual: null, esperado: null, linhaBase, linhaBaseAuto: auto, atingimento: null, projecao: null, gasto: 0, usoOrcamento: null, orcamentoAdiantado: false, serie: [], trajetoria: null };
  if (!met) return vazio;
  const ehSoma = met.tipo === 'soma';
  const trajetoria = ehSoma ? { v0: 0, v1: e.meta } : { v0: linhaBase ?? e.meta, v1: e.meta };
  if (e.status === 'cancelado') return { ...vazio, estado: 'cancelado', trajetoria };
  if (diasCompletos === 0) return { ...vazio, estado: 'nao_iniciou', trajetoria };

  const atualJ = janela(e.inicio, dadosAte);
  const atual = valorMetrica(d, e.canal, e.metrica, atualJ);
  const gasto = metricasDe(d, e.canal as CanalId | 'total' | 'pagos', atualJ).invest;
  const usoOrcamento = e.orcamento != null && e.orcamento > 0 ? gasto / e.orcamento : null;

  const esperadoEm = (frac: number): number => (ehSoma ? e.meta * frac : trajetoria.v0 + (e.meta - trajetoria.v0) * frac);
  const esperado = esperadoEm(decorrido);

  let atingimento: number | null = null;
  if (atual != null) {
    if (ehSoma) atingimento = e.meta !== 0 ? atual / e.meta : null;
    else if (linhaBase != null && linhaBase !== e.meta) atingimento = (atual - linhaBase) / (e.meta - linhaBase);
    else atingimento = met.melhor === 'subir' ? (e.meta !== 0 ? atual / e.meta : null) : (atual > 0 ? e.meta / atual : null);
  }
  const projecao = ehSoma && atual != null && decorrido >= 0.1 ? atual / decorrido : null;

  let estado: Estado = 'sem_dados';
  if (atingimento != null) {
    if (atingimento >= 1) estado = 'atingida';
    else if (diasCompletos < 3) estado = 'cedo';
    else { const gap = atingimento - decorrido; estado = gap >= -0.05 ? 'em_linha' : gap >= -0.2 ? 'atencao' : 'fora'; }
  }

  // curva real dia a dia: acumulado (contagem) ou a razão do período até o dia (custos e taxas)
  const serie: PontoSerie[] = [];
  for (let k = 0; k < diasCompletos; k++) {
    const dia = somaDias(e.inicio, k);
    serie.push({ dia, real: valorMetrica(d, e.canal, e.metrica, janela(e.inicio, dia)), esperado: esperadoEm((k + 1) / totalDias) });
  }
  return { estado, dadosAte, diasCompletos, totalDias, decorrido, atual, esperado, linhaBase, linhaBaseAuto: auto, atingimento, projecao, gasto, usoOrcamento, orcamentoAdiantado: usoOrcamento != null && usoOrcamento > decorrido + 0.15, serie, trajetoria };
}

export const desfechoDe = (atingimento: number | null): Desfecho | null => (atingimento == null ? null : atingimento >= 1 ? 'atingiu' : atingimento >= 0.7 ? 'parcial' : 'nao_atingiu');

export interface Calibracao { metrica: string; total: number; atingiu: number; parcial: number; confiancaMedia: number | null }
/** Histórico dos experimentos concluídos com a mesma métrica: quantos bateram a meta e que confiança tinham. Ajuda a calibrar a confiança do próximo. */
export function calibracaoPor(exps: ReadonlyArray<Pick<Experimento, 'id' | 'metrica' | 'status' | 'desfecho' | 'iceConfianca'>>): Calibracao[] {
  const por = new Map<string, Calibracao & { soma: number; n: number }>();
  for (const e of exps) {
    if (e.status !== 'concluido' || !e.desfecho) continue;
    const c = por.get(e.metrica) ?? { metrica: e.metrica, total: 0, atingiu: 0, parcial: 0, confiancaMedia: null, soma: 0, n: 0 };
    c.total++;
    if (e.desfecho === 'atingiu') c.atingiu++;
    if (e.desfecho === 'parcial') c.parcial++;
    if (e.iceConfianca != null) { c.soma += e.iceConfianca; c.n++; }
    por.set(e.metrica, c);
  }
  return [...por.values()].map(({ soma, n, ...c }) => ({ ...c, confiancaMedia: n ? soma / n : null }));
}

/* ---------- banco ---------- */
const COLUNAS = `id, titulo, hipotese, produto, canal, metrica, meta::float8 as meta, linha_base::float8 as linha_base, orcamento::float8 as orcamento,
  inicio::text as inicio, fim::text as fim, status, ice_impacto, ice_confianca, ice_facilidade, ice_score::float8 as ice_score,
  valor_final::float8 as valor_final, atingimento_final::float8 as atingimento_final, desfecho, aprendizado, criado_em, atualizado_em`;
const nn = (v: unknown): number | null => (v == null ? null : Number(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
function deLinha(r: Record<string, unknown>): Experimento {
  return {
    id: Number(r.id), titulo: String(r.titulo), hipotese: (r.hipotese as string | null) ?? null, produto: r.produto as ProdutoMonitor, canal: r.canal as ExpCanal, metrica: String(r.metrica),
    meta: Number(r.meta), linhaBase: nn(r.linha_base), orcamento: nn(r.orcamento), inicio: String(r.inicio), fim: String(r.fim), status: r.status as ExpStatus,
    iceImpacto: nn(r.ice_impacto), iceConfianca: nn(r.ice_confianca), iceFacilidade: nn(r.ice_facilidade), iceScore: nn(r.ice_score),
    valorFinal: nn(r.valor_final), atingimentoFinal: nn(r.atingimento_final), desfecho: (r.desfecho as Desfecho | null) ?? null, aprendizado: (r.aprendizado as string | null) ?? null,
    criadoEm: iso(r.criado_em), atualizadoEm: iso(r.atualizado_em),
  };
}
const CAMPO_SQL: Record<keyof ExperimentoEntrada, string> = {
  titulo: 'titulo', hipotese: 'hipotese', produto: 'produto', canal: 'canal', metrica: 'metrica', meta: 'meta', linhaBase: 'linha_base', orcamento: 'orcamento',
  inicio: 'inicio', fim: 'fim', status: 'status', iceImpacto: 'ice_impacto', iceConfianca: 'ice_confianca', iceFacilidade: 'ice_facilidade', aprendizado: 'aprendizado',
};

export interface ListaExperimentos {
  hoje: string;
  metricas: readonly MetricaExp[];
  canais: typeof EXP_CANAIS;
  experimentos: ExperimentoComProgresso[];
  calibracao: Calibracao[];
}
export interface ExperimentosRepo {
  listar(): Promise<ListaExperimentos>;
  criar(entrada: unknown): Promise<ExperimentoComProgresso>;
  atualizar(id: number, entrada: unknown): Promise<ExperimentoComProgresso>;
}

export type LeitorDados = (db: Db, hoje: string, hora: string, produto: ProdutoMonitor, desde: string) => Promise<DadosMonitor>;

export class PgExperimentosRepo implements ExperimentosRepo {
  constructor(private readonly db: Db, private readonly agora: () => Date = () => new Date(), private readonly ler: LeitorDados = lerDadosMonitor) {}

  private async dadosPor(exps: Experimento[], hoje: string, hora: string): Promise<Map<ProdutoMonitor, DadosMonitor>> {
    const out = new Map<ProdutoMonitor, DadosMonitor>();
    for (const produto of EXP_PRODUTOS) {
      const meus = exps.filter((e) => e.produto === produto && e.status !== 'cancelado');
      if (!meus.length) continue;
      const desde = meus.map((e) => somaDias(e.inicio, -diasEntre(e.inicio, e.fim))).sort()[0]!;
      out.set(produto, await this.ler(this.db, hoje, hora, produto, desde));
    }
    return out;
  }
  private comProgresso(exps: Experimento[], dados: Map<ProdutoMonitor, DadosMonitor>, hoje: string): ExperimentoComProgresso[] {
    return exps.map((e) => {
      const d = dados.get(e.produto);
      return { ...e, progresso: d ? calcularProgresso(e, d, hoje) : calcularProgresso(e, { diario: { google: new Map(), meta: new Map(), social: new Map(), organico: new Map() } }, hoje) };
    });
  }

  async listar(): Promise<ListaExperimentos> {
    const { hoje, hora } = agoraLocal(this.agora());
    const r = await this.db.query(`select ${COLUNAS} from mkt.experimentos order by (status = 'rodando') desc, ice_score desc nulls last, id desc`);
    const exps = r.rows.map(deLinha);
    const dados = await this.dadosPor(exps, hoje, hora);
    return { hoje, metricas: METRICAS_EXP, canais: EXP_CANAIS, experimentos: this.comProgresso(exps, dados, hoje), calibracao: calibracaoPor(exps) };
  }

  private async um(id: number): Promise<Experimento> {
    const r = await this.db.query(`select ${COLUNAS} from mkt.experimentos where id = $1`, [id]);
    if (!r.rows[0]) throw new PainelNotFound(`experimento ${id} não existe`);
    return deLinha(r.rows[0]);
  }
  private async completo(e: Experimento): Promise<ExperimentoComProgresso> {
    const { hoje, hora } = agoraLocal(this.agora());
    return this.comProgresso([e], await this.dadosPor([e], hoje, hora), hoje)[0]!;
  }

  async criar(entrada: unknown): Promise<ExperimentoComProgresso> {
    const v = validarEntrada(entrada, 'criar');
    const campos = (Object.keys(v) as Array<keyof ExperimentoEntrada>).filter((k) => v[k] !== undefined);
    const r = await this.db.query(
      `insert into mkt.experimentos (${campos.map((k) => CAMPO_SQL[k]).join(', ')}) values (${campos.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      campos.map((k) => v[k]),
    );
    return this.completo(await this.um(Number(r.rows[0].id)));
  }

  async atualizar(id: number, entrada: unknown): Promise<ExperimentoComProgresso> {
    const antes = await this.um(id);
    const v = validarEntrada(entrada, 'editar', antes);
    const campos = (Object.keys(v) as Array<keyof ExperimentoEntrada>).filter((k) => v[k] !== undefined);
    if (!campos.length) throw new PainelInvalido('nada para gravar');
    const params: unknown[] = campos.map((k) => v[k]);
    const sets = campos.map((k, i) => `${CAMPO_SQL[k]} = $${i + 1}`);
    // ao concluir, o resultado é fotografado: deixa de variar com dados novos
    if (v.status === 'concluido' && antes.status !== 'concluido') {
      const mesclado: Experimento = { ...antes, ...(v as Partial<Experimento>) };
      const p = (await this.completo(mesclado)).progresso;
      sets.push(`valor_final = $${params.push(p.atual)}`, `atingimento_final = $${params.push(p.atingimento)}`, `desfecho = $${params.push(desfechoDe(p.atingimento))}`);
    }
    params.push(id);
    await this.db.query(`update mkt.experimentos set ${sets.join(', ')}, atualizado_em = now() where id = $${params.length}`, params);
    return this.completo(await this.um(id));
  }
}
