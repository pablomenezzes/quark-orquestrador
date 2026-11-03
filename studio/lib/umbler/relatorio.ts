/**
 * Relatório enxuto mês a mês: disparos, de qual template, gasto e interesse do lead. Funções puras sobre o que está no banco.
 * Gasto: ESTIMATIVA = mensagens de template x tarifa de marketing (média ponderada das cobranças que a Umbler registrou);
 * o custo registrado pela Umbler aparece à parte quando existe. Interesse: respondeu / clicou em botão / atendente entrou,
 * até 24 h depois de cada template.
 */
import type { CustoLinha, TemplateCatalogo } from './normaliza.js';
import type { MensagemBanco, SessaoBanco } from './banco.js';

export type Grupo = 'Geladeira' | 'Outros fluxos' | 'Disparos avulsos';
export const GRUPOS: Grupo[] = ['Geladeira', 'Outros fluxos', 'Disparos avulsos'];

export const grupoDe = (s: Pick<SessaoBanco, 'tipo' | 'botNome' | 'titulo'>): Grupo =>
  s.tipo === 'Template' ? 'Disparos avulsos' : /gelad/i.test(`${s.botNome ?? ''} ${s.titulo ?? ''}`) ? 'Geladeira' : 'Outros fluxos';

/** Botão que significa recusa. Qualquer outro botão clicado é interesse. */
const RECUSA = /n[aã]o\s+(tenho|quero|desejo|tem)|sem\s+interesse|n[aã]o\s+me\s+interess|parar|cancelar|descadastr|remover|sair\s+da\s+lista|pare\b/i;
export type ClasseCta = 'interesse' | 'sem_interesse';
export const classeDoCta = (cta: string): ClasseCta => (RECUSA.test(cta) ? 'sem_interesse' : 'interesse');

export type Metricas = {
  sessoes: number;
  /** Contatos que entraram, segundo as sessões de envio da Umbler. */
  envios: number;
  /** Mensagens de template contadas nas conversas (inclui os envios de acompanhamento dos fluxos). */
  disparos: number;
  respondeu: number;
  clicou: number;
  humano: number;
  /** Clicou num botão de interesse (ex.: "Quero retomar com 20%OFF"). */
  interesse: number;
  /** Clicou num botão de recusa (ex.: "Não tenho interesse"). */
  semInteresse: number;
  /** Respondeu por texto livre (ou por botão sem rótulo guardado): existe resposta, mas não dá para classificar sem ler o texto. */
  textoLivre: number;
  /** Créditos que a Umbler registrou nas sessões (null = nenhum registro). */
  creditosRegistrados: number | null;
  creditosEst: number | null;
  reaisEst: number | null;
  /** Sessões cujas conversas já foram lidas. */
  sessoesLidas: number;
};
export type LinhaMes = { mes: string; grupos: Record<Grupo, Metricas>; total: Metricas };
export type LinhaTemplate = { templateId: string; nome: string; categoria: string | null; disparos: number; respondeu: number; clicou: number; humano: number; interesse: number; semInteresse: number; textoLivre: number; creditosEst: number | null; reaisEst: number | null; primeiro: string; ultimo: string; grupos: Grupo[] };
export type Relatorio = {
  canal: { id: string; nome: string | null };
  de: string;
  ate: string;
  tarifa: { creditosPorMsg: number; mensagens: number; sessoes: number } | null;
  precoCredito: number | null;
  /** R$ por mensagem de marketing usado na conta (informado, ou derivado do preço do crédito x tarifa). */
  precoPorMsg: number | null;
  meses: LinhaMes[];
  templates: LinhaTemplate[];
  /** Cada botão clicado, por template, com a classificação. */
  ctas: { templateId: string; template: string; cta: string; classe: ClasseCta; cliques: number }[];
  total: Metricas;
  /** sessoes/sessoesLidas: criadas no período; sessoesCanal: todas do canal desde jul/2026; mensagens: de template enviadas no período (de sessões de qualquer data). */
  cobertura: { sessoes: number; sessoesLidas: number; sessoesCanal: number; conversasLidas: number; mensagens: number };
};

const vazia = (): Metricas => ({ sessoes: 0, envios: 0, disparos: 0, respondeu: 0, clicou: 0, humano: 0, interesse: 0, semInteresse: 0, textoLivre: 0, creditosRegistrados: null, creditosEst: null, reaisEst: null, sessoesLidas: 0 });

/** Tarifa de marketing: créditos por mensagem de template, média ponderada das cobranças registradas (linhas do tipo Template com créditos). */
export function tarifaMarketing(sessoes: Pick<SessaoBanco, 'linhasCusto' | 'custoSituacao'>[]): Relatorio['tarifa'] {
  let msgs = 0, cred = 0, n = 0;
  for (const s of sessoes) {
    if (s.custoSituacao !== 'registrado' || !s.linhasCusto) continue;
    const ls = (s.linhasCusto as CustoLinha[]).filter((l) => l.tipo === 'Template' && l.count > 0 && l.credits > 0);
    if (!ls.length) continue;
    n++;
    for (const l of ls) { msgs += l.count; cred += l.credits; }
  }
  return msgs ? { creditosPorMsg: cred / msgs, mensagens: msgs, sessoes: n } : null;
}

export function montarRelatorio(args: {
  canal: { id: string; nome: string | null };
  de: string;
  ate: string;
  /** Todas as sessões do banco no período (a tarifa usa todas as cobranças; o canal é filtrado aqui). */
  sessoes: SessaoBanco[];
  mensagens: MensagemBanco[];
  templates: TemplateCatalogo[];
  precoCredito: number | null;
  /** R$ por mensagem de marketing, informado direto; tem prioridade sobre o preço do crédito. */
  precoPorMsg?: number | null;
}): Relatorio {
  const { canal, de, ate } = args;
  const tarifa = tarifaMarketing(args.sessoes);
  const doCanal = args.sessoes.filter((s) => s.canalId === canal.id && s.dia >= de && s.dia <= ate);
  // as mensagens de acompanhamento de um fluxo chegam semanas depois da sessão: o período filtra pelo dia da MENSAGEM, não pelo da sessão
  const porId = new Map(args.sessoes.filter((s) => s.canalId === canal.id).map((s) => [s.id, s]));
  const cat = new Map(args.templates.map((t) => [t.id, t]));
  const mes = (d: string) => d.slice(0, 7);
  const meses = new Map<string, LinhaMes>();
  const linha = (m: string): LinhaMes => {
    let l = meses.get(m);
    if (!l) { l = { mes: m, grupos: { Geladeira: vazia(), 'Outros fluxos': vazia(), 'Disparos avulsos': vazia() }, total: vazia() }; meses.set(m, l); }
    return l;
  };
  const soma = (a: Metricas, b: Partial<Metricas>) => {
    a.sessoes += b.sessoes ?? 0; a.envios += b.envios ?? 0; a.disparos += b.disparos ?? 0; a.respondeu += b.respondeu ?? 0; a.clicou += b.clicou ?? 0; a.humano += b.humano ?? 0; a.interesse += b.interesse ?? 0; a.semInteresse += b.semInteresse ?? 0; a.textoLivre += b.textoLivre ?? 0; a.sessoesLidas += b.sessoesLidas ?? 0;
    if (b.creditosRegistrados != null) a.creditosRegistrados = (a.creditosRegistrados ?? 0) + b.creditosRegistrados;
  };

  for (const s of doCanal) {
    const g = grupoDe(s);
    const l = linha(mes(s.dia));
    const parte = { sessoes: 1, envios: s.enviadas ?? 0, sessoesLidas: s.scanCompleto ? 1 : 0, creditosRegistrados: s.custoSituacao === 'registrado' ? s.creditos : null };
    soma(l.grupos[g], parte);
    soma(l.total, parte);
  }

  const tpl = new Map<string, LinhaTemplate>();
  const ctas = new Map<string, Relatorio['ctas'][number]>();
  let msgsTotal = 0;
  for (const m of args.mensagens) {
    const s = porId.get(m.sessaoId);
    if (!s || m.dia < de || m.dia > ate) continue;
    msgsTotal++;
    const g = grupoDe(s);
    const l = linha(mes(m.dia));
    const classe = m.clicou && m.cta ? classeDoCta(m.cta) : null;
    const parte = { disparos: 1, respondeu: m.respondeu ? 1 : 0, clicou: m.clicou ? 1 : 0, humano: m.humano ? 1 : 0, interesse: classe === 'interesse' ? 1 : 0, semInteresse: classe === 'sem_interesse' ? 1 : 0, textoLivre: m.respondeu && !classe ? 1 : 0 };
    soma(l.grupos[g], parte);
    soma(l.total, parte);
    const id = m.templateId ?? '(sem template)';
    let t = tpl.get(id);
    if (!t) { t = { templateId: id, nome: cat.get(id)?.nome ?? id, categoria: cat.get(id)?.categoria ?? null, disparos: 0, respondeu: 0, clicou: 0, humano: 0, interesse: 0, semInteresse: 0, textoLivre: 0, creditosEst: null, reaisEst: null, primeiro: m.dia, ultimo: m.dia, grupos: [] }; tpl.set(id, t); }
    t.disparos++; t.respondeu += parte.respondeu; t.clicou += parte.clicou; t.humano += parte.humano; t.interesse += parte.interesse; t.semInteresse += parte.semInteresse; t.textoLivre += parte.textoLivre;
    if (classe && m.cta) { const k = `${id}|${m.cta}`; const c = ctas.get(k) ?? { templateId: id, template: t.nome, cta: m.cta, classe, cliques: 0 }; c.cliques++; ctas.set(k, c); }
    if (m.dia < t.primeiro) t.primeiro = m.dia;
    if (m.dia > t.ultimo) t.ultimo = m.dia;
    if (!t.grupos.includes(g)) t.grupos.push(g);
  }

  // gasto estimado: todas as mensagens de template cobradas como marketing
  const est = (disparos: number) => (tarifa ? disparos * tarifa.creditosPorMsg : null);
  const porMsg = args.precoPorMsg ?? (tarifa && args.precoCredito != null ? tarifa.creditosPorMsg * args.precoCredito : null);
  const rs = (disparos: number) => (porMsg != null ? disparos * porMsg : null);
  const fecha = (x: Metricas) => { x.creditosEst = est(x.disparos); x.reaisEst = rs(x.disparos); };
  const lista = [...meses.values()].sort((a, b) => a.mes.localeCompare(b.mes));
  for (const l of lista) { fecha(l.total); for (const g of GRUPOS) fecha(l.grupos[g]); }
  for (const t of tpl.values()) { t.creditosEst = est(t.disparos); t.reaisEst = rs(t.disparos); }
  const total = vazia();
  for (const l of lista) soma(total, l.total);
  fecha(total);

  return {
    canal, de, ate, tarifa, precoCredito: args.precoCredito, precoPorMsg: porMsg, meses: lista,
    templates: [...tpl.values()].sort((a, b) => b.disparos - a.disparos),
    ctas: [...ctas.values()].sort((a, b) => b.cliques - a.cliques),
    total,
    cobertura: { sessoes: doCanal.length, sessoesLidas: doCanal.filter((s) => s.scanCompleto).length, sessoesCanal: porId.size, conversasLidas: doCanal.reduce((a, s) => a + s.scanCursor, 0), mensagens: msgsTotal },
  };
}
