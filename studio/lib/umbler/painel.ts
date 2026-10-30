/**
 * Agregações do painel Umbler. Funções puras sobre as sessões já normalizadas: nada aqui fala com a rede ou com o disco.
 * Regras: ausência é null com motivo; toda soma diz de quantas sessões veio (completude); abaixo da amostra mínima não ranqueia.
 */
import { falta, ok, type Parada, type Sessao, type V } from './normaliza.js';
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
};

export function montarPainel(cfg: ConfigUmbler, todas: Sessao[], canalNomes: Map<string, string>, f: Filtros): PainelUmbler {
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
