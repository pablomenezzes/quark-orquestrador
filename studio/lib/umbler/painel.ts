/**
 * Agregações do painel Umbler. Funções puras sobre as sessões já normalizadas: nada aqui fala com a rede ou com o disco.
 * Regras: ausência é null com motivo; toda soma diz de quantas sessões veio (completude); abaixo da amostra mínima não ranqueia.
 */
import { SEM_REGISTRO, falta, ok, type CustoLinha, type Parada, type Sessao, type TemplateCatalogo, type V } from './normaliza.js';
import { precoVigente, pertenceAoMarketing, type ConfigUmbler } from './config.js';

export type Filtros = {
  de: string;
  ate: string;
  canais?: string[];
  tipo?: 'Template' | 'Bot';
  /** ID do template ou do fluxo (bot). */
  modelo?: string;
  sessao?: string;
  escopo: 'marketing' | 'tudo';
};

export class FiltroInvalido extends Error {}

const dataOk = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export function validarFiltros(q: { de?: string | null; ate?: string | null; canal?: string | null; tipo?: string | null; modelo?: string | null; sessao?: string | null; escopo?: string | null }): Filtros {
  if (!dataOk(q.de) || !dataOk(q.ate)) throw new FiltroInvalido('Informe o período como AAAA-MM-DD.');
  if (q.de > q.ate) throw new FiltroInvalido('A data inicial é depois da final.');
  if ((Date.parse(q.ate) - Date.parse(q.de)) / 86_400_000 > 400) throw new FiltroInvalido('Período longo demais (máximo de 400 dias).');
  const f: Filtros = { de: q.de, ate: q.ate, escopo: q.escopo === 'tudo' ? 'tudo' : 'marketing' };
  if (q.canal) {
    const ids = q.canal.split(',');
    if (ids.length > 50 || ids.some((i) => !/^[\w.\-:]{1,100}$/.test(i))) throw new FiltroInvalido('Canal inválido.');
    f.canais = ids;
  }
  if (q.tipo) {
    if (q.tipo !== 'Template' && q.tipo !== 'Bot') throw new FiltroInvalido('Tipo inválido (Template ou Bot).');
    f.tipo = q.tipo;
  }
  for (const k of ['modelo', 'sessao'] as const) {
    const v = q[k];
    if (v) {
      if (!/^[\w.\-:]{1,100}$/.test(v)) throw new FiltroInvalido(`${k} inválido.`);
      f[k] = v;
    }
  }
  return f;
}

/* ---------- custo ---------- */
export type SessaoCalc = Sessao & {
  canalNome: string | null;
  reais: V;
  precoUsado: number | null;
  cprCreditos: V;
  cprReais: V;
  completude: { campos: number; de: number };
};

const fmtDia = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '?');

export function calcularSessao(cfg: ConfigUmbler, s: Sessao, canalNomes: Map<string, string>): SessaoCalc {
  const preco = precoVigente(cfg, s.dia);
  const reais: V = s.creditos.v == null ? falta(s.creditos.m ?? 'Custo indisponível.') : preco == null ? falta(`Sem preço do crédito vigente em ${fmtDia(s.dia)}. Cadastre em Configuração.`) : ok(s.creditos.v * preco);
  const base = (custo: V): V => {
    if (custo.v == null) return falta(custo.m ?? 'Custo indisponível.');
    if (s.respondidas.v == null) return falta(s.respondidas.m ?? 'Respostas indisponíveis.');
    if (s.respondidas.v === 0) return falta('Nenhuma resposta nesta sessão.');
    return ok(custo.v / s.respondidas.v);
  };
  const campos = [s.enviadas, s.lidas, s.respondidas, s.falhas, s.creditos].filter((x) => x.v != null).length;
  return { ...s, canalNome: s.canalId ? (canalNomes.get(s.canalId) ?? null) : null, reais, precoUsado: preco, cprCreditos: base(s.creditos), cprReais: base(reais), completude: { campos, de: 5 } };
}

/* ---------- somas e razões ---------- */
export type Soma = V & { x: number; y: number };
export function somar(vs: V[]): Soma {
  const conhecidos = vs.filter((v) => v.v != null) as { v: number; m: null }[];
  if (!vs.length) return { v: null, m: 'Nenhuma sessão no filtro.', x: 0, y: 0 };
  if (!conhecidos.length) return { v: null, m: vs.find((v) => v.m)?.m ?? 'Indisponível.', x: 0, y: vs.length };
  return { v: conhecidos.reduce((a, b) => a + b.v, 0), m: null, x: conhecidos.length, y: vs.length };
}
/** num/den somando só as sessões em que os DOIS valores existem (para a razão não misturar bases diferentes). */
export function razao(ss: SessaoCalc[], num: (s: SessaoCalc) => V, den: (s: SessaoCalc) => V): V & { x: number; y: number } {
  const par = ss.filter((s) => num(s).v != null && den(s).v != null);
  if (!ss.length) return { v: null, m: 'Nenhuma sessão no filtro.', x: 0, y: 0 };
  const d = par.reduce((a, s) => a + den(s).v!, 0);
  if (!par.length) return { v: null, m: num(ss[0]!).m ?? den(ss[0]!).m ?? 'Indisponível.', x: 0, y: ss.length };
  if (d === 0) return { v: null, m: 'Divisão por zero: nenhuma resposta no grupo.', x: par.length, y: ss.length };
  return { v: par.reduce((a, s) => a + num(s).v!, 0) / d, m: null, x: par.length, y: ss.length };
}

/* ---------- filtros ---------- */
export function filtrar(cfg: ConfigUmbler, ss: Sessao[], f: Filtros): Sessao[] {
  return ss.filter((s) => {
    if (!s.dia || s.dia < f.de || s.dia > f.ate) return false;
    if (f.escopo === 'marketing' && !pertenceAoMarketing(cfg, s)) return false;
    if (f.canais && (!s.canalId || !f.canais.includes(s.canalId))) return false;
    if (f.tipo && s.tipo !== f.tipo) return false;
    if (f.modelo && s.modeloId !== f.modelo && s.botId !== f.modelo) return false;
    if (f.sessao && s.id !== f.sessao) return false;
    return true;
  });
}

/* ---------- painel ---------- */
export type Grupo = {
  chave: string;
  nome: string;
  sessoes: number;
  enviadas: Soma;
  lidas: Soma;
  respondidas: Soma;
  creditos: Soma;
  reais: Soma;
  taxaLeitura: V;
  taxaResposta: V;
  cprReais: V;
  cprCreditos: V;
  amostraPequena: boolean;
  posicao: number | null;
};

function agrupar(ss: SessaoCalc[], chave: (s: SessaoCalc) => string | null, nome: (s: SessaoCalc) => string, minimo: number): Grupo[] {
  const mapa = new Map<string, SessaoCalc[]>();
  for (const s of ss) {
    const k = chave(s);
    if (!k) continue;
    (mapa.get(k) ?? mapa.set(k, []).get(k)!).push(s);
  }
  const grupos: Grupo[] = [...mapa].map(([k, lista]) => {
    const enviadas = somar(lista.map((s) => s.enviadas));
    return {
      chave: k,
      nome: nome(lista[0]!),
      sessoes: lista.length,
      enviadas,
      lidas: somar(lista.map((s) => s.lidas)),
      respondidas: somar(lista.map((s) => s.respondidas)),
      creditos: somar(lista.map((s) => s.creditos)),
      reais: somar(lista.map((s) => s.reais)),
      taxaLeitura: razao(lista, (s) => s.lidas, (s) => s.enviadas),
      taxaResposta: razao(lista, (s) => s.respondidas, (s) => s.enviadas),
      cprReais: razao(lista, (s) => s.reais, (s) => s.respondidas),
      cprCreditos: razao(lista, (s) => s.creditos, (s) => s.respondidas),
      amostraPequena: (enviadas.v ?? 0) < minimo,
      posicao: null,
    };
  });
  // ranking: só quem tem amostra suficiente e taxa de resposta conhecida; ordena pela taxa de resposta (depois leitura)
  const rank = grupos
    .filter((g) => !g.amostraPequena && (g.taxaResposta.v != null || g.taxaLeitura.v != null))
    .sort((a, b) => (b.taxaResposta.v ?? -1) - (a.taxaResposta.v ?? -1) || (b.taxaLeitura.v ?? -1) - (a.taxaLeitura.v ?? -1));
  rank.forEach((g, i) => (g.posicao = i + 1));
  return grupos.sort((a, b) => (a.posicao ?? 1e9) - (b.posicao ?? 1e9) || (b.enviadas.v ?? 0) - (a.enviadas.v ?? 0));
}

/** Créditos por mensagem enviada observados em sessões que TÊM custo registrado, por tipo (base da estimativa). */
export type Referencias = Partial<Record<'Template' | 'Bot', { creditosPorEnvio: number; amostra: number }>>;

export type Estimativa = {
  /** Sessões sem registro de custo que receberam estimativa, de quantas sem registro havia. */
  sessoes: { x: number; y: number };
  creditos: V;
  reais: V;
  base: { tipo: string; creditosPorEnvio: number; amostra: number }[];
};

/** ESTIMATIVA, nunca dado da Umbler: envios da sessão x média de créditos por envio de sessões do mesmo tipo que têm custo registrado. Fica separada do custo real. */
export function estimar(cfg: ConfigUmbler, ss: SessaoCalc[], refs: Referencias): Estimativa {
  const sem = ss.filter((s) => s.creditos.v == null && (s.creditos.m ?? '').startsWith(SEM_REGISTRO));
  const com = sem.filter((s) => s.enviadas.v != null && s.tipo && refs[s.tipo]);
  const base = (['Template', 'Bot'] as const).filter((t) => refs[t]).map((t) => ({ tipo: t, ...refs[t]! }));
  if (!com.length) {
    return { sessoes: { x: 0, y: sem.length }, creditos: falta(sem.length ? 'Sem base: nenhuma sessão recente do mesmo tipo tem custo registrado para servir de referência.' : 'Todas as sessões do filtro têm custo registrado (ou aguardam consulta): nada a estimar.'), reais: falta('Sem estimativa de créditos.'), base };
  }
  const cred = com.reduce((a, s) => a + s.enviadas.v! * refs[s.tipo!]!.creditosPorEnvio, 0);
  const reaisParts = com.map((s) => { const p = precoVigente(cfg, s.dia); return p == null ? null : s.enviadas.v! * refs[s.tipo!]!.creditosPorEnvio * p; });
  const todosComPreco = reaisParts.every((x) => x != null);
  return {
    sessoes: { x: com.length, y: sem.length },
    creditos: ok(Math.round(cred)),
    reais: todosComPreco ? ok(reaisParts.reduce<number>((a, b) => a + (b ?? 0), 0)) : falta('Sem preço do crédito vigente em parte das sessões. Cadastre em Configuração.'),
    base,
  };
}

export type PainelUmbler = {
  filtros: Filtros;
  amostraMinima: number;
  avisos: string[];
  completude: Record<'sessoes' | 'custo' | 'reais' | 'enviadas' | 'lidas' | 'respondidas' | 'falhas', { x: number; y: number }>;
  cartoes: { custoCreditos: Soma; custoReais: Soma; enviadas: Soma; lidas: Soma; respondidas: Soma; falhas: Soma; cprReais: V; cprCreditos: V };
  funil: { etapa: string; v: number | null; m: string | null; queda: number | null }[];
  serie: { dia: string; envios: number | null; respostas: number | null; creditos: number | null; reais: number | null }[];
  sessoes: SessaoCalc[];
  modelos: Grupo[];
  fluxos: Grupo[];
  paradas: { itens: Parada[]; sessoesComDado: number; sessoesDeBot: number } | null;
  estimativa: Estimativa;
};

export function montarPainel(cfg: ConfigUmbler, todas: Sessao[], canalNomes: Map<string, string>, f: Filtros, refs: Referencias = {}): PainelUmbler {
  const ss = filtrar(cfg, todas, f).map((s) => calcularSessao(cfg, s, canalNomes));
  ss.sort((a, b) => (b.criadaEm ?? '').localeCompare(a.criadaEm ?? ''));
  const cont = (pega: (s: SessaoCalc) => V) => ({ x: ss.filter((s) => pega(s).v != null).length, y: ss.length });
  const enviadas = somar(ss.map((s) => s.enviadas));
  const lidas = somar(ss.map((s) => s.lidas));
  const respondidas = somar(ss.map((s) => s.respondidas));
  const falhas = somar(ss.map((s) => s.falhas));
  const creditos = somar(ss.map((s) => s.creditos));
  const reais = somar(ss.map((s) => s.reais));

  const avisos: string[] = [];
  if (f.escopo === 'marketing' && !cfg.canais.some((c) => c.fixado)) avisos.push('Nenhum canal está fixado como Marketing. Vá em Configuração, marque os canais do Marketing e clique em Fixar.');
  if (!cfg.precoCredito.length) avisos.push('Não há preço do crédito cadastrado: o custo aparece só em créditos e o R$ fica indisponível. Cadastre em Configuração.');

  const funilBase: [string, Soma][] = [['Enviadas', enviadas], ['Lidas', lidas], ['Respondidas', respondidas]];
  const funil = funilBase.map(([etapa, soma], i) => {
    const ant = i ? funilBase[i - 1]![1].v : null;
    return { etapa, v: soma.v, m: soma.m, queda: soma.v != null && ant != null && ant > 0 ? 1 - soma.v / ant : null };
  });

  const dias = new Map<string, SessaoCalc[]>();
  for (const s of ss) if (s.dia) (dias.get(s.dia) ?? dias.set(s.dia, []).get(s.dia)!).push(s);
  const serie = [...dias]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dia, l]) => ({ dia, envios: somar(l.map((s) => s.enviadas)).v, respostas: somar(l.map((s) => s.respondidas)).v, creditos: somar(l.map((s) => s.creditos)).v, reais: somar(l.map((s) => s.reais)).v }));

  const bots = ss.filter((s) => s.tipo === 'Bot');
  const comParada = bots.filter((s) => s.paradas);
  const mapaParada = new Map<string, number>();
  for (const s of comParada) for (const p of s.paradas!) mapaParada.set(p.motivo, (mapaParada.get(p.motivo) ?? 0) + p.n);

  return {
    filtros: f,
    amostraMinima: cfg.amostraMinima,
    avisos,
    completude: { sessoes: { x: ss.length, y: ss.length }, custo: cont((s) => s.creditos), reais: cont((s) => s.reais), enviadas: cont((s) => s.enviadas), lidas: cont((s) => s.lidas), respondidas: cont((s) => s.respondidas), falhas: cont((s) => s.falhas) },
    cartoes: { custoCreditos: creditos, custoReais: reais, enviadas, lidas, respondidas, falhas, cprReais: razao(ss, (s) => s.reais, (s) => s.respondidas), cprCreditos: razao(ss, (s) => s.creditos, (s) => s.respondidas) },
    funil,
    serie,
    sessoes: ss,
    modelos: agrupar(ss.filter((s) => s.tipo === 'Template'), (s) => s.modeloId, (s) => s.modeloNome ?? s.titulo ?? s.modeloId ?? '?', cfg.amostraMinima),
    fluxos: agrupar(ss.filter((s) => s.tipo === 'Bot'), (s) => s.botId ?? s.botNome, (s) => s.botNome ?? s.botId ?? '?', cfg.amostraMinima),
    estimativa: estimar(cfg, ss, refs),
    paradas: bots.length ? { itens: [...mapaParada].map(([motivo, n]) => ({ motivo, n })).sort((a, b) => b.n - a.n), sessoesComDado: comParada.length, sessoesDeBot: bots.length } : null,
  };
}

/* ---------- CSV ---------- */
const celula = (x: string | number | null): string => {
  if (x == null) return '';
  let t = typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toFixed(4).replace(/0+$/, '').replace('.', ',')) : x;
  if (typeof x === 'string' && /^[=+\-@\t\r]/.test(t)) t = `'${t}`; // não deixa o Excel tratar texto como fórmula
  return /[;"\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

export function gerarCsv(p: PainelUmbler): string {
  const cab = ['data', 'titulo', 'tipo', 'canal', 'template_ou_fluxo', 'enviadas', 'lidas', 'respondidas', 'falhas', 'creditos', 'reais', 'custo_por_resposta_reais', 'campos_disponiveis', 'motivos_de_ausencia'];
  const linhas = [
    `# Quark Dados · Umbler · período ${p.filtros.de} a ${p.filtros.ate} · escopo ${p.filtros.escopo === 'marketing' ? 'apenas o que está fixado como Marketing' : 'todas as sessões'}`,
    '# Célula vazia = dado indisponível (nunca zero). O motivo de cada ausência está na última coluna.',
    cab.join(';'),
    ...p.sessoes.map((s) => {
      const motivos = [['enviadas', s.enviadas], ['lidas', s.lidas], ['respondidas', s.respondidas], ['falhas', s.falhas], ['creditos', s.creditos], ['reais', s.reais], ['custo_por_resposta', s.cprReais]]
        .filter(([, v]) => (v as V).v == null)
        .map(([n, v]) => `${n}: ${(v as V).m}`)
        .join(' | ');
      return [s.dia, s.titulo, s.tipo, s.canalNome, s.tipo === 'Bot' ? s.botNome : s.modeloNome, s.enviadas.v, s.lidas.v, s.respondidas.v, s.falhas.v, s.creditos.v, s.reais.v, s.cprReais.v, `${s.completude.campos} de ${s.completude.de}`, motivos || null].map(celula).join(';');
    }),
  ];
  return `﻿${linhas.join('\r\n')}\r\n`;
}


/* ---------- referência de custo por template (cenário: tudo como marketing) ---------- */
export type LinhaReferencia = {
  id: string;
  nome: string;
  categoria: string | null;
  status: string | null;
  /** Mensagens e créditos observados nas cobranças reais da Umbler (linhas de tipo Template). */
  mensagensObs: number;
  creditosObs: number;
  creditosPorMsgObs: number | null;
  envios: number;
  /** Créditos por mensagem usados na conta: o observado, se o template é de marketing e tem cobrança; senão a tarifa de referência de marketing. */
  taxaUsada: number | null;
  origem: 'observado (marketing)' | 'referência de marketing' | 'sem base';
  creditosEst: number | null;
};
export type TabelaReferencia = {
  de: string;
  ate: string;
  /** Tarifa de referência: créditos por mensagem de template de marketing, média ponderada das cobranças observadas. */
  referenciaMarketing: { creditosPorMsg: number | null; mensagens: number; templates: number; origem: 'categoria marketing' | 'todos os templates cobrados' | 'sem cobrança observada' };
  precoCredito: number | null;
  linhas: LinhaReferencia[];
  totais: { envios: number; enviosTemplate: number; enviosFluxo: number; enviosSemBase: number; creditos: number | null; reais: number | null; sessoes: number };
};

const ehMarketing = (c: string | null) => !!c && /market/i.test(c);

export function tabelaReferencia(
  cfg: ConfigUmbler,
  sessoes: Sessao[],
  templates: TemplateCatalogo[],
  linhasExtras: { id: string; linhas: CustoLinha[] }[],
  de: string,
  ate: string,
  precoOverride?: number | null,
): TabelaReferencia {
  // cobranças observadas por sessão (as do período mandam sobre as da amostra extra)
  const porSessao = new Map<string, CustoLinha[]>();
  for (const x of linhasExtras) porSessao.set(x.id, x.linhas);
  for (const s of sessoes) if (s.custoLinhas) porSessao.set(s.id, s.custoLinhas);

  const obs = new Map<string, { nome: string; msgs: number; cred: number }>();
  for (const linhas of porSessao.values()) {
    for (const l of linhas) {
      if (l.tipo !== 'Template' || !l.templateId || l.count <= 0 || l.credits <= 0) continue;
      const o = obs.get(l.templateId) ?? { nome: l.templateNome ?? l.templateId, msgs: 0, cred: 0 };
      o.msgs += l.count; o.cred += l.credits;
      obs.set(l.templateId, o);
    }
  }
  const cat = new Map(templates.map((t) => [t.id, t]));

  // tarifa de referência de marketing
  const soma = (ids: string[]) => ids.reduce((a, id) => ({ m: a.m + obs.get(id)!.msgs, c: a.c + obs.get(id)!.cred }), { m: 0, c: 0 });
  const mkt = [...obs.keys()].filter((id) => ehMarketing(cat.get(id)?.categoria ?? null));
  const todos = [...obs.keys()];
  let ref: TabelaReferencia['referenciaMarketing'];
  if (mkt.length) { const t = soma(mkt); ref = { creditosPorMsg: t.c / t.m, mensagens: t.m, templates: mkt.length, origem: 'categoria marketing' }; }
  else if (todos.length) { const t = soma(todos); ref = { creditosPorMsg: t.c / t.m, mensagens: t.m, templates: todos.length, origem: 'todos os templates cobrados' }; }
  else ref = { creditosPorMsg: null, mensagens: 0, templates: 0, origem: 'sem cobrança observada' };

  // envios do período por template (sessões de Template) e por fluxo
  const envios = new Map<string, number>();
  let enviosTemplate = 0, enviosFluxo = 0, enviosTplSemId = 0;
  for (const s of sessoes) {
    const n = s.enviadas.v ?? 0;
    if (s.tipo === 'Bot') enviosFluxo += n;
    else if (s.modeloId) { envios.set(s.modeloId, (envios.get(s.modeloId) ?? 0) + n); enviosTemplate += n; }
    else enviosTplSemId += n;
  }

  const ids = new Set<string>([...obs.keys(), ...envios.keys(), ...templates.map((t) => t.id)]);
  const linhas: LinhaReferencia[] = [...ids].map((id): LinhaReferencia => {
    const o = obs.get(id);
    const c = cat.get(id);
    const nome = c?.nome ?? o?.nome ?? sessoes.find((s) => s.modeloId === id)?.modeloNome ?? id;
    const obsRate = o ? o.cred / o.msgs : null;
    const usaObs = obsRate != null && ehMarketing(c?.categoria ?? null);
    const taxa = usaObs ? obsRate : ref.creditosPorMsg;
    const nEnvios = envios.get(id) ?? 0;
    return {
      id, nome, categoria: c?.categoria ?? null, status: c?.status ?? null,
      mensagensObs: o?.msgs ?? 0, creditosObs: o?.cred ?? 0, creditosPorMsgObs: obsRate,
      envios: nEnvios, taxaUsada: taxa, origem: taxa == null ? 'sem base' : usaObs ? 'observado (marketing)' : 'referência de marketing',
      creditosEst: taxa == null ? null : nEnvios * taxa,
    };
  }).sort((a, b) => b.envios - a.envios || b.mensagensObs - a.mensagensObs || a.nome.localeCompare(b.nome, 'pt-BR'));

  // total do cenário "tudo como marketing": templates pelo seu ritmo, fluxos e templates sem ID pela tarifa de referência
  const fora = enviosFluxo + enviosTplSemId;
  const temRef = ref.creditosPorMsg != null;
  const creditos = (() => {
    if (!temRef && linhas.some((l) => l.envios > 0 && l.taxaUsada == null)) return null;
    const dosTemplates = linhas.reduce((a, l) => a + (l.creditosEst ?? 0), 0);
    return Math.round(dosTemplates + (temRef ? fora * ref.creditosPorMsg! : 0));
  })();
  const semBase = (!temRef ? fora + linhas.filter((l) => l.envios > 0 && l.taxaUsada == null).reduce((a, l) => a + l.envios, 0) : 0);
  const preco = precoOverride !== undefined ? precoOverride : precoVigente(cfg, ate);
  return {
    de, ate, referenciaMarketing: ref, precoCredito: preco,
    linhas: linhas.filter((l) => l.envios > 0 || l.mensagensObs > 0),
    totais: { envios: enviosTemplate + enviosFluxo + enviosTplSemId, enviosTemplate, enviosFluxo, enviosSemBase: semBase, creditos, reais: creditos != null && preco != null ? creditos * preco : null, sessoes: sessoes.length },
  };
}
