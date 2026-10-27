/**
 * Experimentos de growth (pedido do Pablo, 2026-10-26): cadastro, documentação e monitoramento num lugar só (substitui as planilhas "Growth e
 * Experimentos"): ideia, hipótese, responsável, produto, canal, resultado esperado, métrica chave, meta, período, investimento, ICE, avaliação e
 * aprendizado, em planilha ou kanban, mais a documentação editável com relatório diário, semanal e geral. O acompanhamento é AUTOMÁTICO. O resultado, a linha de base, o gasto e o ritmo contra o previsto vêm das mesmas visões de analytics do Monitor
 * (studio/lib/monitor.ts); nada é digitado depois do cadastro.
 *
 * Regras: dia fecha à meia-noite em America/Fortaleza; só dias COMPLETOS entram (até ontem). Linha de base automática = o mesmo número de dias
 * imediatamente antes do início. Métricas de contagem (leads, ganhos...) têm meta = total do período e ritmo linear; métricas de custo e taxa
 * (CPL, CAC, % MQL...) têm meta = valor a atingir e a trajetória sai da linha de base até a meta. Só leitura nas visões (papel orq_panel);
 * a única escrita é a tabela mkt.experimentos.
 */
import type pg from 'pg';
import { PainelInvalido, PainelNotFound } from './painel-repo.js';
import type { ExperimentoParaSync, RepoSync } from './integracoes.js';
import { CAMPOS, CONTABILIZACOES, RegraInvalida, camposUsados, conferirOrigens, criarMedidor, lerCampos, validarRegras, type Contabilizacao, type LeitorCampos, type Medir, type Regra } from './experimentos-regras.js';
import { ESCOPO_MODOS, campanhaTexto, lerDadosEscopo, lerDetalheEscopo, listarOpcoes, normalizarCampanhas, normalizarPagina, temCampanha, temEscopo, type CampanhaEscopo, type Detalhe, type EscopoModo, type Escopo, type LeitorDetalhe, type LeitorEscopo, type OpcoesEscopo } from './experimentos-escopo.js';
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
export const EXP_STATUS = ['backlog', 'planejado', 'rodando', 'bloqueado', 'concluido', 'cancelado'] as const;
export type ExpStatus = (typeof EXP_STATUS)[number];
export const EXP_TIPOS = [
  { id: 'experimento', nome: 'Experimento' },
  { id: 'ideia', nome: 'Ideia' },
  { id: 'melhoria', nome: 'Melhoria implementada' },
  { id: 'documentacao', nome: 'Documentação de processo' },
] as const;
export type ExpTipo = (typeof EXP_TIPOS)[number]['id'];
export const EXP_AVALIACOES = ['sucesso', 'falha', 'inconclusivo'] as const;
export type Avaliacao = (typeof EXP_AVALIACOES)[number];
/** Tamanho máximo da documentação (HTML do editor), em caracteres. */
export const DOC_MAX = 400_000;
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
  id: number; titulo: string; tipo: ExpTipo; responsavel: string | null; areaImpacto: string | null; hipotese: string | null; resultadoEsperado: string | null;
  produto: ProdutoMonitor; canal: ExpCanal;
  /** Métrica chave (do catálogo) e a meta dela; nulas = sem acompanhamento automático. */
  metrica: string | null; meta: number | null; linhaBase: number | null;
  /** Investimento previsto (R$). O gasto real vem sozinho das visões do Monitor. */
  investimento: number | null; inicio: string | null; fim: string | null; status: ExpStatus;
  avaliacao: Avaliacao | null; evidencias: string | null; temDocumentacao: boolean;
  /** Escopo opcional: página de destino (GA4), campanha da Meta e identificador de conversão do Pipedrive. */
  paginaHost: string | null; paginaCaminho: string | null; campanhas: CampanhaEscopo[]; identificadorConversao: string | null; escopoModo: EscopoModo;
  /** Automática: o Studio conta pelo escopo. Manual: cada métrica pode ter uma regra (fórmula com campos, métricas e números). */
  contabilizacao: Contabilizacao; regras: Regra[];
  /** Página deste experimento no Doc do ClickUp (preenchida ao enviar). */
  clickupPaginaId: string | null; clickupUrl: string | null;
  iceImpacto: number | null; iceConfianca: number | null; iceFacilidade: number | null; iceScore: number | null;
  valorFinal: number | null; atingimentoFinal: number | null; desfecho: Desfecho | null; aprendizado: string | null;
  criadoEm: string; atualizadoEm: string;
}

export type Estado = 'sem_metrica' | 'cancelado' | 'nao_iniciou' | 'cedo' | 'sem_dados' | 'atingida' | 'em_linha' | 'atencao' | 'fora';
export const ESTADO_ROTULO: Record<Estado, string> = {
  sem_metrica: 'Sem acompanhamento automático', cancelado: 'Cancelado', nao_iniciou: 'Ainda não começou', cedo: 'Poucos dias de dados', sem_dados: 'Sem dados no período',
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
  titulo?: string; tipo?: string; responsavel?: string | null; areaImpacto?: string | null; hipotese?: string | null; resultadoEsperado?: string | null;
  produto?: string; canal?: string; metrica?: string | null; meta?: number | null; linhaBase?: number | null; investimento?: number | null;
  inicio?: string | null; fim?: string | null; status?: string; avaliacao?: string | null; evidencias?: string | null;
  iceImpacto?: number | null; iceConfianca?: number | null; iceFacilidade?: number | null; aprendizado?: string | null;
  paginaHost?: string | null; paginaCaminho?: string | null; campanhas?: CampanhaEscopo[]; identificadorConversao?: string | null; escopoModo?: EscopoModo;
  contabilizacao?: Contabilizacao; regras?: Regra[];
}
const num = (v: unknown, nome: string): number => { if (typeof v !== 'number' || !isFinite(v)) throw inv(`${nome} deve ser um número`); return v; };
const numOuNulo = (v: unknown, nome: string): number | null => (v == null ? null : num(v, nome));
const ice = (v: unknown, nome: string): number | null => {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 10) throw inv(`${nome} deve ser um número inteiro de 1 a 10`);
  return v;
};
const texto = (v: unknown, nome: string, max: number): string | null => {
  if (v == null) return null;
  if (typeof v !== 'string' || v.length > max) throw inv(`${nome} deve ter até ${max} caracteres`);
  return v.trim() ? v.trim() : null;
};
const dataOuNula = (v: unknown, nome: string): string | null => {
  if (v == null || v === '') return null;
  if (!dataValida(v)) throw inv(`${nome} deve ser AAAA-MM-DD`);
  return v;
};

type Atual = Pick<Experimento, 'produto' | 'canal' | 'metrica' | 'meta' | 'inicio' | 'fim'> & Partial<Escopo> & { regras?: Regra[] };
/** Confere uma entrada (só o título é obrigatório na criação) e devolve só os campos válidos. `atual` completa as checagens cruzadas na edição. */
export function validarEntrada(b: unknown, modo: 'criar' | 'editar', atual?: Atual): ExperimentoEntrada {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw inv('corpo inválido');
  const e = b as Record<string, unknown>;
  const out: ExperimentoEntrada = {};
  const tem = (k: string) => k in e;
  if (modo === 'criar' && !tem('titulo')) throw inv('falta titulo');
  if (tem('titulo')) { if (typeof e.titulo !== 'string' || !e.titulo.trim() || e.titulo.trim().length > 160) throw inv('título deve ter de 1 a 160 caracteres'); out.titulo = e.titulo.trim(); }
  if (tem('tipo')) { if (!EXP_TIPOS.some((t) => t.id === e.tipo)) throw inv(`tipo inválido (${EXP_TIPOS.map((t) => t.id).join(', ')})`); out.tipo = e.tipo as string; }
  if (tem('responsavel')) out.responsavel = texto(e.responsavel, 'responsável', 120);
  if (tem('areaImpacto')) out.areaImpacto = texto(e.areaImpacto, 'área de impacto', 80);
  if (tem('hipotese')) out.hipotese = texto(e.hipotese, 'hipótese', 2000);
  if (tem('resultadoEsperado')) out.resultadoEsperado = texto(e.resultadoEsperado, 'resultado esperado', 2000);
  if (tem('produto')) { if (!(EXP_PRODUTOS as readonly unknown[]).includes(e.produto)) throw inv('produto deve ser rh ou clinic'); out.produto = e.produto as string; }
  if (tem('canal')) { if (!EXP_CANAIS.some((c) => c.id === e.canal)) throw inv(`canal inválido (${EXP_CANAIS.map((c) => c.id).join(', ')})`); out.canal = e.canal as string; }
  if (tem('metrica')) {
    if (e.metrica != null && (typeof e.metrica !== 'string' || !METRICA_POR_ID.has(e.metrica))) throw inv(`métrica inválida (${METRICAS_EXP.map((m) => m.id).join(', ')})`);
    out.metrica = (e.metrica as string | null | undefined) ?? null;
    if (out.metrica === null) { out.meta = null; out.linhaBase = null; } // sem métrica chave não há meta nem linha de base
  }
  if (tem('meta') && out.metrica !== null) out.meta = numOuNulo(e.meta, 'meta');
  if (tem('linhaBase') && out.metrica !== null) out.linhaBase = numOuNulo(e.linhaBase, 'linhaBase');
  if (tem('investimento')) { const o = numOuNulo(e.investimento, 'investimento'); if (o != null && o < 0) throw inv('investimento não pode ser negativo'); out.investimento = o; }
  if (tem('inicio')) out.inicio = dataOuNula(e.inicio, 'início');
  if (tem('fim')) out.fim = dataOuNula(e.fim, 'fim');
  if (tem('status')) { if (!(EXP_STATUS as readonly unknown[]).includes(e.status)) throw inv(`status inválido (${EXP_STATUS.join(', ')})`); out.status = e.status as string; }
  if (tem('avaliacao')) { if (e.avaliacao != null && !(EXP_AVALIACOES as readonly unknown[]).includes(e.avaliacao)) throw inv(`avaliação inválida (${EXP_AVALIACOES.join(', ')})`); out.avaliacao = (e.avaliacao as string | null) ?? null; }
  if (tem('evidencias')) out.evidencias = texto(e.evidencias, 'evidências', 4000);
  if (tem('iceImpacto')) out.iceImpacto = ice(e.iceImpacto, 'impacto');
  if (tem('iceConfianca')) out.iceConfianca = ice(e.iceConfianca, 'confiança');
  if (tem('iceFacilidade')) out.iceFacilidade = ice(e.iceFacilidade, 'facilidade');
  if (tem('aprendizado')) out.aprendizado = texto(e.aprendizado, 'aprendizado', 4000);
  if (tem('paginaDestino')) {
    const t = texto(e.paginaDestino, 'página de destino', 300);
    const p = t ? normalizarPagina(t) : null;
    if (t && !p) throw inv('página de destino inválida: escolha uma da lista ou digite o endereço (https://site.com.br/pagina) ou só o caminho (/pagina)');
    out.paginaHost = p?.host ?? null; out.paginaCaminho = p?.caminho ?? null;
  }
  if (tem('campanhas')) {
    // lista de textos ("nome (id)", só o ID ou só o nome); vazio limpa. Os resultados das campanhas somam.
    if (e.campanhas != null && (!Array.isArray(e.campanhas) || e.campanhas.length > 60 || e.campanhas.some((t) => typeof t !== 'string' || t.length > 200))) throw inv('campanhas deve ser uma lista de até 40 textos');
    out.campanhas = normalizarCampanhas((e.campanhas as string[] | null) ?? []);
  }
  if (tem('contabilizacao')) { if (!(CONTABILIZACOES as readonly unknown[]).includes(e.contabilizacao)) throw inv(`contabilização inválida (${CONTABILIZACOES.join(', ')})`); out.contabilizacao = e.contabilizacao as Contabilizacao; }
  if (tem('escopoModo')) { if (!(ESCOPO_MODOS as readonly unknown[]).includes(e.escopoModo)) throw inv(`escopoModo inválido (${ESCOPO_MODOS.join(', ')})`); out.escopoModo = e.escopoModo as EscopoModo; }
  if (tem('identificadorConversao')) out.identificadorConversao = texto(e.identificadorConversao, 'identificador de conversão', 200);

  const inicio = out.inicio !== undefined ? out.inicio : atual?.inicio, fim = out.fim !== undefined ? out.fim : atual?.fim;
  if (inicio && fim && fim < inicio) throw inv('o fim não pode ser antes do início');
  const canal = (out.canal ?? atual?.canal ?? 'total') as ExpCanal;
  const idMetrica = out.metrica !== undefined ? out.metrica : (atual?.metrica ?? null);
  const meta = out.meta !== undefined ? out.meta : (atual?.meta ?? null);
  if (idMetrica && meta == null) throw inv('informe a meta da métrica chave');
  if (!idMetrica && meta != null) throw inv('escolha a métrica chave da meta');
  const metrica = idMetrica ? METRICA_POR_ID.get(idMetrica) : undefined;
  const esc: Partial<Escopo> = {
    paginaCaminho: out.paginaCaminho !== undefined ? out.paginaCaminho : atual?.paginaCaminho,
    campanhas: out.campanhas !== undefined ? out.campanhas : atual?.campanhas,
    identificadorConversao: out.identificadorConversao !== undefined ? out.identificadorConversao : atual?.identificadorConversao,
  };
  // regras da contabilização manual: validadas contra o escopo que ficará valendo
  try {
    if (tem('regras')) out.regras = validarRegras(e.regras, new Set(METRICAS_EXP.map((m) => m.id)), esc);
    else if (atual?.regras?.length) conferirOrigens(atual.regras, esc);
  } catch (err) { if (err instanceof RegraInvalida) throw inv(err.message); throw err; }
  if (metrica?.precisaVerba) {
    // com escopo, o investimento só existe se houver campanha da Meta; sem escopo vale a regra do canal
    if (temEscopo(esc)) { if (!temCampanha(esc)) throw inv(`${metrica.rotulo} depende de investimento, que só existe com uma campanha da Meta no escopo. Escolha uma campanha ou outra métrica`); }
    else if (!EXP_CANAIS.find((c) => c.id === canal)!.pago) throw inv(`${metrica.rotulo} depende de investimento: Social e Orgânico não têm verba. Escolha outro canal ou outra métrica`);
  }
  return out;
}

/* ---------- cálculo (puro) ---------- */
const razao = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const diasEntre = (de: string, ate: string) => Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000) + 1;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Valor de uma métrica em uma janela, para um canal (ou o total, ou só a mídia paga). Custos do total usam os leads, MQL, reuniões e ganhos dos canais pagos. */
/** Dados do experimento: o Monitor (ou a fatia do escopo) e, na contabilização manual, o medidor das regras. */
export type DadosExp = Pick<DadosMonitor, 'diario'> & { medir?: Medir };
/** O valor da métrica numa janela: pela regra manual, se ela existe; senão, pelo cálculo automático. */
export function medirMetrica(d: DadosExp, canal: ExpCanal, metrica: string, j: Janela): number | null {
  const v = d.medir?.(metrica, j);
  return v !== undefined ? v : valorMetrica(d, canal, metrica, j);
}
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

export type EntradaProgresso = Pick<Experimento, 'canal' | 'metrica' | 'meta' | 'linhaBase' | 'investimento' | 'inicio' | 'fim' | 'status'>;
/** Tem tudo o que o acompanhamento automático precisa: métrica chave do catálogo, meta e período. */
export const acompanhavel = (e: Pick<Experimento, 'metrica' | 'meta' | 'inicio' | 'fim'>): boolean => !!e.metrica && METRICA_POR_ID.has(e.metrica) && e.meta != null && !!e.inicio && !!e.fim;

export function calcularProgresso(exp: EntradaProgresso, d: DadosExp, hoje: string): Progresso {
  if (!acompanhavel(exp)) {
    return { estado: exp.status === 'cancelado' ? 'cancelado' : 'sem_metrica', dadosAte: somaDias(hoje, -1), diasCompletos: 0, totalDias: 0, decorrido: 0, atual: null, esperado: null, linhaBase: exp.linhaBase, linhaBaseAuto: exp.linhaBase == null, atingimento: null, projecao: null, gasto: 0, usoOrcamento: null, orcamentoAdiantado: false, serie: [], trajetoria: null };
  }
  const e = exp as EntradaProgresso & { metrica: string; meta: number; inicio: string; fim: string };
  const met = METRICA_POR_ID.get(e.metrica);
  const totalDias = diasEntre(e.inicio, e.fim);
  const ontem = somaDias(hoje, -1);
  const dadosAte = e.fim < ontem ? e.fim : ontem;
  const diasCompletos = dadosAte >= e.inicio ? diasEntre(e.inicio, dadosAte) : 0;
  const decorrido = clamp01(diasCompletos / totalDias);

  // linha de base: valor combinado, ou o mesmo número de dias imediatamente antes do início
  const auto = e.linhaBase == null;
  const baseJ = janela(somaDias(e.inicio, -totalDias), somaDias(e.inicio, -1));
  const baseAuto = met ? medirMetrica(d, e.canal, e.metrica, baseJ) : null;
  const linhaBase = e.linhaBase ?? baseAuto;

  const vazio: Progresso = { estado: 'sem_dados', dadosAte, diasCompletos, totalDias, decorrido, atual: null, esperado: null, linhaBase, linhaBaseAuto: auto, atingimento: null, projecao: null, gasto: 0, usoOrcamento: null, orcamentoAdiantado: false, serie: [], trajetoria: null };
  if (!met) return vazio;
  const ehSoma = met.tipo === 'soma';
  const trajetoria = ehSoma ? { v0: 0, v1: e.meta } : { v0: linhaBase ?? e.meta, v1: e.meta };
  if (e.status === 'cancelado') return { ...vazio, estado: 'cancelado', trajetoria };
  if (diasCompletos === 0) return { ...vazio, estado: 'nao_iniciou', trajetoria };

  const atualJ = janela(e.inicio, dadosAte);
  const atual = medirMetrica(d, e.canal, e.metrica, atualJ);
  const gasto = metricasDe(d, e.canal as CanalId | 'total' | 'pagos', atualJ).invest;
  const usoOrcamento = e.investimento != null && e.investimento > 0 ? gasto / e.investimento : null;

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
    serie.push({ dia, real: medirMetrica(d, e.canal, e.metrica, janela(e.inicio, dia)), esperado: esperadoEm((k + 1) / totalDias) });
  }
  return { estado, dadosAte, diasCompletos, totalDias, decorrido, atual, esperado, linhaBase, linhaBaseAuto: auto, atingimento, projecao, gasto, usoOrcamento, orcamentoAdiantado: usoOrcamento != null && usoOrcamento > decorrido + 0.15, serie, trajetoria };
}

export const desfechoDe = (atingimento: number | null): Desfecho | null => (atingimento == null ? null : atingimento >= 1 ? 'atingiu' : atingimento >= 0.7 ? 'parcial' : 'nao_atingiu');

export interface Calibracao { metrica: string; total: number; atingiu: number; parcial: number; confiancaMedia: number | null }
/** Histórico dos experimentos concluídos com a mesma métrica: quantos bateram a meta e que confiança tinham. Ajuda a calibrar a confiança do próximo. */
export function calibracaoPor(exps: ReadonlyArray<Pick<Experimento, 'id' | 'metrica' | 'status' | 'desfecho' | 'iceConfianca'>>): Calibracao[] {
  const por = new Map<string, Calibracao & { soma: number; n: number }>();
  for (const e of exps) {
    if (e.status !== 'concluido' || !e.desfecho || !e.metrica) continue;
    const c = por.get(e.metrica) ?? { metrica: e.metrica, total: 0, atingiu: 0, parcial: 0, confiancaMedia: null, soma: 0, n: 0 };
    c.total++;
    if (e.desfecho === 'atingiu') c.atingiu++;
    if (e.desfecho === 'parcial') c.parcial++;
    if (e.iceConfianca != null) { c.soma += e.iceConfianca; c.n++; }
    por.set(e.metrica, c);
  }
  return [...por.values()].map(({ soma, n, ...c }) => ({ ...c, confiancaMedia: n ? soma / n : null }));
}

/* ---------- relatório diário, semanal e geral (puro) ---------- */
export interface LinhaRel {
  rotulo: string; de: string; ate: string; dias: number;
  leads: number; mql: number; reunioes: number; ganhos: number; mrr: number; invest: number; impressoes: number; cliques: number;
  cpl: number | null;
  /** Valor da métrica chave na janela (acumulado da janela, não do experimento). */
  valor: number | null;
}
export interface Relatorio {
  dadosAte: string;
  /** Um dia por linha, do início até o último dia completo. */
  diario: LinhaRel[];
  /** Semanas de segunda a domingo, cortadas no início do experimento e no último dia completo. */
  semanal: LinhaRel[];
  /** O experimento inteiro até o último dia completo. */
  geral: LinhaRel | null;
  /** O mesmo número de dias imediatamente antes do início, para comparar. */
  base: LinhaRel | null;
}
function linhaRel(d: DadosExp, e: Pick<Experimento, 'canal' | 'metrica'>, j: Janela, rotulo: string): LinhaRel {
  const m = metricasDe(d, e.canal as CanalId | 'total' | 'pagos', j);
  // na contabilização manual, as colunas do funil seguem as regras (ex.: Leads pelo identificador); o que não tem regra segue o automático
  const reg = (id: string, auto: number | null): number | null => { const v = d.medir?.(id, j); return v !== undefined ? v : auto; };
  return {
    rotulo, de: j.de, ate: j.ate, dias: j.dias, leads: reg('leads', m.leads) ?? 0, mql: reg('mql', m.mql) ?? 0, reunioes: reg('reunioes', m.reunioes) ?? 0, ganhos: reg('ganhos', m.ganhos) ?? 0, mrr: reg('mrr', m.mrr) ?? 0, invest: m.invest, impressoes: m.impressoes, cliques: m.cliques,
    cpl: reg('cpl', m.cpl), valor: e.metrica ? medirMetrica(d, e.canal as ExpCanal, e.metrica, j) : null,
  };
}
export function montarRelatorio(e: Pick<Experimento, 'canal' | 'metrica' | 'inicio' | 'fim'>, d: DadosExp, hoje: string): Relatorio {
  const ontem = somaDias(hoje, -1);
  if (!e.inicio || !e.fim) return { dadosAte: ontem, diario: [], semanal: [], geral: null, base: null };
  const dadosAte = e.fim < ontem ? e.fim : ontem;
  if (dadosAte < e.inicio) return { dadosAte, diario: [], semanal: [], geral: null, base: null };
  const diario: LinhaRel[] = [];
  for (let dia = e.inicio; dia <= dadosAte; dia = somaDias(dia, 1)) diario.push(linhaRel(d, e, janela(dia, dia), dia));
  const semanal: LinhaRel[] = [];
  for (let ini = e.inicio, n = 1; ini <= dadosAte; n++) {
    const domingo = somaDias(ini, 6 - ((new Date(`${ini}T00:00:00Z`).getUTCDay() + 6) % 7));
    const fimSem = domingo < dadosAte ? domingo : dadosAte;
    semanal.push(linhaRel(d, e, janela(ini, fimSem), `Semana ${n}`));
    ini = somaDias(fimSem, 1);
  }
  const total = diasEntre(e.inicio, e.fim);
  return {
    dadosAte, diario, semanal,
    geral: linhaRel(d, e, janela(e.inicio, dadosAte), 'Geral'),
    base: linhaRel(d, e, janela(somaDias(e.inicio, -total), somaDias(e.inicio, -1)), 'Antes do teste'),
  };
}

/* ---------- banco ---------- */
const COLUNAS = `id, titulo, tipo, responsavel, area_impacto, hipotese, resultado_esperado, produto, canal, metrica, meta::float8 as meta, linha_base::float8 as linha_base,
  investimento::float8 as investimento, inicio::text as inicio, fim::text as fim, status, avaliacao, evidencias, documentacao is not null as tem_documentacao,
  pagina_host, pagina_caminho, campanhas, campanha_id::text as campanha_id, campanha_nome, identificador_conversao, escopo_modo, contabilizacao, regras, clickup_pagina_id, clickup_url,
  ice_impacto, ice_confianca, ice_facilidade, ice_score::float8 as ice_score,
  valor_final::float8 as valor_final, atingimento_final::float8 as atingimento_final, desfecho, aprendizado, criado_em, atualizado_em`;
const nn = (v: unknown): number | null => (v == null ? null : Number(v));
const ns = (v: unknown): string | null => (v == null ? null : String(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
/** A lista nova; ou, em linha antiga da 0024 sem lista, a campanha única que ela gravou. */
function campanhasDe(r: Record<string, unknown>): CampanhaEscopo[] {
  if (Array.isArray(r.campanhas) && r.campanhas.length) return r.campanhas as CampanhaEscopo[];
  return r.campanha_id || r.campanha_nome ? [{ id: ns(r.campanha_id), nome: ns(r.campanha_nome) }] : [];
}
function deLinha(r: Record<string, unknown>): Experimento {
  return {
    id: Number(r.id), titulo: String(r.titulo), tipo: (r.tipo as ExpTipo) ?? 'experimento', responsavel: ns(r.responsavel), areaImpacto: ns(r.area_impacto),
    hipotese: ns(r.hipotese), resultadoEsperado: ns(r.resultado_esperado), produto: r.produto as ProdutoMonitor, canal: r.canal as ExpCanal,
    metrica: ns(r.metrica), meta: nn(r.meta), linhaBase: nn(r.linha_base), investimento: nn(r.investimento), inicio: ns(r.inicio), fim: ns(r.fim), status: r.status as ExpStatus,
    avaliacao: (r.avaliacao as Avaliacao | null) ?? null, evidencias: ns(r.evidencias), temDocumentacao: r.tem_documentacao === true,
    paginaHost: ns(r.pagina_host), paginaCaminho: ns(r.pagina_caminho), campanhas: campanhasDe(r), identificadorConversao: ns(r.identificador_conversao), escopoModo: ((ESCOPO_MODOS as readonly unknown[]).includes(r.escopo_modo) ? r.escopo_modo : 'todos') as EscopoModo,
    contabilizacao: (r.contabilizacao === 'manual' ? 'manual' : 'automatica') as Contabilizacao, regras: Array.isArray(r.regras) ? (r.regras as Regra[]) : [],
    clickupPaginaId: ns(r.clickup_pagina_id), clickupUrl: ns(r.clickup_url),
    iceImpacto: nn(r.ice_impacto), iceConfianca: nn(r.ice_confianca), iceFacilidade: nn(r.ice_facilidade), iceScore: nn(r.ice_score),
    valorFinal: nn(r.valor_final), atingimentoFinal: nn(r.atingimento_final), desfecho: (r.desfecho as Desfecho | null) ?? null, aprendizado: ns(r.aprendizado),
    criadoEm: iso(r.criado_em), atualizadoEm: iso(r.atualizado_em),
  };
}
const CAMPO_SQL: Record<keyof ExperimentoEntrada, string> = {
  titulo: 'titulo', tipo: 'tipo', responsavel: 'responsavel', areaImpacto: 'area_impacto', hipotese: 'hipotese', resultadoEsperado: 'resultado_esperado',
  produto: 'produto', canal: 'canal', metrica: 'metrica', meta: 'meta', linhaBase: 'linha_base', investimento: 'investimento', inicio: 'inicio', fim: 'fim',
  status: 'status', avaliacao: 'avaliacao', evidencias: 'evidencias', iceImpacto: 'ice_impacto', iceConfianca: 'ice_confianca', iceFacilidade: 'ice_facilidade', aprendizado: 'aprendizado',
  paginaHost: 'pagina_host', paginaCaminho: 'pagina_caminho', campanhas: 'campanhas', identificadorConversao: 'identificador_conversao', escopoModo: 'escopo_modo', contabilizacao: 'contabilizacao', regras: 'regras',
};

/** A lista de campanhas vai como JSON (o pg mandaria um array do Postgres, não jsonb). */
const valorSql = (k: keyof ExperimentoEntrada, v: unknown): unknown => (k === 'campanhas' || k === 'regras' ? JSON.stringify(v ?? []) : v);

export interface ListaExperimentos {
  hoje: string;
  metricas: readonly MetricaExp[];
  canais: typeof EXP_CANAIS;
  tipos: typeof EXP_TIPOS;
  /** Campos que as regras da contabilização manual podem usar. */
  campos: typeof CAMPOS;
  experimentos: ExperimentoComProgresso[];
  calibracao: Calibracao[];
}
export interface RelatorioExperimento {
  hoje: string;
  metricas: readonly MetricaExp[];
  canais: typeof EXP_CANAIS;
  tipos: typeof EXP_TIPOS;
  campos: typeof CAMPOS;
  experimento: ExperimentoComProgresso;
  relatorio: Relatorio;
  /** Funil, perfil, perdas, safra, criativos e conferência dos negócios do escopo; nulo sem escopo ou sem período. */
  detalhe: Detalhe | null;
  /** HTML do editor, ou nulo se a documentação ainda não foi aberta. */
  documentacao: string | null;
}
export interface ExperimentosRepo {
  listar(): Promise<ListaExperimentos>;
  criar(entrada: unknown): Promise<ExperimentoComProgresso>;
  atualizar(id: number, entrada: unknown): Promise<ExperimentoComProgresso>;
  relatorio(id: number): Promise<RelatorioExperimento>;
  salvarDocumentacao(id: number, corpo: unknown): Promise<{ id: number; atualizadoEm: string }>;
  /** Páginas do Analytics, campanhas da Meta e identificadores de conversão do Pipedrive para escolher no cadastro. */
  opcoes(produto?: string): Promise<OpcoesEscopo>;
}

export type LeitorDados = (db: Db, hoje: string, hora: string, produto: ProdutoMonitor, desde: string) => Promise<DadosMonitor>;
/** Com escopo (página, campanha ou identificador), os dados da fatia ficam na chave `meta` (ver experimentos-escopo.ts). */
const efetivo = <T extends Pick<Experimento, 'canal'> & Partial<Escopo>>(e: T): T => (temEscopo(e) ? { ...e, canal: 'meta' } : e);
export const rotuloEscopo = (e: Pick<Experimento, 'paginaHost' | 'paginaCaminho' | 'campanhas' | 'identificadorConversao'> & Partial<Pick<Experimento, 'escopoModo'>>): string[] =>
  [e.paginaCaminho ? `Página ${e.paginaHost ?? ''}${e.paginaCaminho}` : '', e.campanhas.length ? `${e.campanhas.length === 1 ? 'Campanha' : 'Campanhas (somadas)'} ${e.campanhas.map(campanhaTexto).join(', ')}` : '', e.identificadorConversao ? `Identificador ${e.identificadorConversao}` : ''].filter(Boolean);
const SEM_DADOS = { diario: { google: new Map(), meta: new Map(), social: new Map(), organico: new Map() } } as DadosExp;

export class PgExperimentosRepo implements ExperimentosRepo, RepoSync {
  constructor(private readonly db: Db, private readonly agora: () => Date = () => new Date(), private readonly ler: LeitorDados = lerDadosMonitor, private readonly lerEscopo: LeitorEscopo = lerDadosEscopo, private readonly lerDetalhe: LeitorDetalhe = lerDetalheEscopo, private readonly lerCamposManuais: LeitorCampos = lerCampos) {}

  /** Dados por experimento: os sem escopo leem o Monitor uma vez por produto; os com escopo leem só a fatia deles. */
  private async dadosPor(exps: Experimento[], hoje: string, hora: string): Promise<Map<number, DadosExp>> {
    const out = new Map<number, DadosExp>();
    const ativos = exps.filter((e) => e.status !== 'cancelado' && e.inicio && e.fim);
    const desdeDe = (e: Experimento) => somaDias(e.inicio!, -diasEntre(e.inicio!, e.fim!));
    for (const produto of EXP_PRODUTOS) {
      const meus = ativos.filter((e) => e.produto === produto && !temEscopo(e));
      if (!meus.length) continue;
      const d = await this.ler(this.db, hoje, hora, produto, meus.map(desdeDe).sort()[0]!);
      for (const e of meus) out.set(e.id, d);
    }
    for (const e of ativos.filter((x) => temEscopo(x))) out.set(e.id, await this.lerEscopo(this.db, e, hora, desdeDe(e)));
    // contabilização manual: lê só os campos que as regras usam e põe o medidor junto dos dados
    for (const e of ativos.filter((x) => x.contabilizacao === 'manual' && x.regras.length)) {
      const base = out.get(e.id);
      if (!base) continue;
      const campos = await this.lerCamposManuais(this.db, e, camposUsados(e.regras), desdeDe(e));
      const canal = temEscopo(e) ? 'meta' : e.canal;
      out.set(e.id, { ...base, medir: criarMedidor(e.regras, campos, (m, j) => valorMetrica(base, canal, m, j)) });
    }
    return out;
  }
  private comProgresso(exps: Experimento[], dados: Map<number, DadosExp>, hoje: string): ExperimentoComProgresso[] {
    return exps.map((e) => ({ ...e, progresso: calcularProgresso(efetivo(e), dados.get(e.id) ?? SEM_DADOS, hoje) }));
  }

  async listar(): Promise<ListaExperimentos> {
    const { hoje, hora } = agoraLocal(this.agora());
    const r = await this.db.query(`select ${COLUNAS} from mkt.experimentos order by (status = 'rodando') desc, ice_score desc nulls last, id desc`);
    const exps = r.rows.map(deLinha);
    const dados = await this.dadosPor(exps, hoje, hora);
    return { hoje, metricas: METRICAS_EXP, canais: EXP_CANAIS, tipos: EXP_TIPOS, campos: CAMPOS, experimentos: this.comProgresso(exps, dados, hoje), calibracao: calibracaoPor(exps) };
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
      campos.map((k) => valorSql(k, v[k])),
    );
    return this.completo(await this.um(Number(r.rows[0].id)));
  }

  async atualizar(id: number, entrada: unknown): Promise<ExperimentoComProgresso> {
    const antes = await this.um(id);
    const v = validarEntrada(entrada, 'editar', antes);
    const campos = (Object.keys(v) as Array<keyof ExperimentoEntrada>).filter((k) => v[k] !== undefined);
    if (!campos.length) throw new PainelInvalido('nada para gravar');
    const params: unknown[] = campos.map((k) => valorSql(k, v[k]));
    const sets = campos.map((k, i) => `${CAMPO_SQL[k]} = $${i + 1}`);
    // ao concluir, o resultado é fotografado: deixa de variar com dados novos (só se o experimento tem métrica chave, meta e período)
    if (v.status === 'concluido' && antes.status !== 'concluido') {
      const mesclado: Experimento = { ...antes, ...(v as Partial<Experimento>) };
      if (acompanhavel(mesclado)) {
        const p = (await this.completo(mesclado)).progresso;
        sets.push(`valor_final = $${params.push(p.atual)}`, `atingimento_final = $${params.push(p.atingimento)}`, `desfecho = $${params.push(desfechoDe(p.atingimento))}`);
      }
    }
    params.push(id);
    await this.db.query(`update mkt.experimentos set ${sets.join(', ')}, atualizado_em = now() where id = $${params.length}`, params);
    return this.completo(await this.um(id));
  }

  async relatorio(id: number): Promise<RelatorioExperimento> {
    const e = await this.um(id);
    const { hoje, hora } = agoraLocal(this.agora());
    const d = (e.inicio && e.fim ? await this.dadosPor([e], hoje, hora) : new Map<number, DadosExp>()).get(e.id) ?? SEM_DADOS;
    const doc = await this.db.query(`select documentacao from mkt.experimentos where id = $1`, [id]);
    return {
      hoje, metricas: METRICAS_EXP, canais: EXP_CANAIS, tipos: EXP_TIPOS, campos: CAMPOS,
      experimento: { ...e, progresso: calcularProgresso(efetivo(e), d, hoje) },
      relatorio: montarRelatorio(efetivo(e), d, hoje),
      detalhe: temEscopo(e) && e.inicio && e.fim && e.inicio <= somaDias(hoje, -1) ? await this.lerDetalhe(this.db, e, e.inicio, e.fim < somaDias(hoje, -1) ? e.fim : somaDias(hoje, -1)) : null,
      documentacao: ns(doc.rows[0]?.documentacao),
    };
  }

  /** Todos os experimentos, com progresso e a documentação salva, para a planilha. */
  async paraSincronizar(): Promise<ExperimentoParaSync[]> {
    const lista = await this.listar();
    const docs = await this.db.query('select id, documentacao from mkt.experimentos where documentacao is not null');
    const porId = new Map(docs.rows.map((r) => [Number(r.id), String(r.documentacao)]));
    return lista.experimentos.map((e) => ({ ...e, documentacaoHtml: porId.get(e.id) ?? null }));
  }
  async paraClickUp(id: number): Promise<ExperimentoParaSync> {
    const e = await this.completo(await this.um(id));
    const doc = await this.db.query('select documentacao from mkt.experimentos where id = $1', [id]);
    return { ...e, documentacaoHtml: ns(doc.rows[0]?.documentacao) };
  }
  async registrarClickUp(id: number, paginaId: string, url: string): Promise<void> {
    await this.db.query('update mkt.experimentos set clickup_pagina_id = $1, clickup_url = $2, clickup_enviado_em = now() where id = $3', [paginaId, url, id]);
  }

  async opcoes(produto?: string): Promise<OpcoesEscopo> {
    if (produto && !(EXP_PRODUTOS as readonly string[]).includes(produto)) throw new PainelInvalido('produto deve ser rh ou clinic');
    return listarOpcoes(this.db, produto as ProdutoMonitor | undefined);
  }

  async salvarDocumentacao(id: number, corpo: unknown): Promise<{ id: number; atualizadoEm: string }> {
    const html = documentacaoValida(corpo);
    await this.um(id);
    const r = await this.db.query(`update mkt.experimentos set documentacao = $1, atualizado_em = now() where id = $2 returning atualizado_em`, [html, id]);
    return { id, atualizadoEm: iso(r.rows[0]?.atualizado_em) };
  }
}

/** A documentação é o HTML do editor. Texto com limite; scripts, iframes e atributos de evento são recusados (o editor só gera formatação e SVG de gráficos). */
export function documentacaoValida(b: unknown): string {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw inv('corpo inválido');
  const html = (b as Record<string, unknown>).html;
  if (typeof html !== 'string') throw inv('html deve ser texto');
  if (html.length > DOC_MAX) throw inv(`a documentação passou do limite de ${DOC_MAX} caracteres`);
  if (/<\s*(script|iframe|object|embed|link|meta|base|form)\b/i.test(html) || /\son[a-z]+\s*=/i.test(html) || /javascript:/i.test(html)) throw inv('a documentação tem conteúdo não permitido (script, iframe ou atributo de evento)');
  return html;
}
