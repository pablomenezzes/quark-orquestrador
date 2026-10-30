/**
 * Normalização tolerante (D-33) das respostas da Umbler. Aceita variações de nome de campo, nunca quebra por campo ausente
 * e transforma ausência em `null` COM MOTIVO (nunca "", "N/A" nem zero no lugar de ausência).
 */

/** Valor numérico que pode estar ausente: `v` é null quando faltou, e `m` diz por quê. */
export type V = { v: number | null; m: string | null };
export const ok = (v: number): V => ({ v, m: null });
/** Início do motivo quando a Umbler não tem custo gravado para a sessão (base da estimativa). */
export const SEM_REGISTRO = 'A Umbler não tem registro de custo';
export const falta = (m: string): V => ({ v: null, m });

type Obj = Record<string, unknown>;
const ehObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);

export function pick(o: unknown, ...nomes: string[]): unknown {
  if (!ehObj(o)) return undefined;
  for (const n of nomes) if (o[n] !== undefined && o[n] !== null) return o[n];
  // segunda chance: mesmo nome sem diferença de maiúsculas
  const baixas = new Map(Object.keys(o).map((k) => [k.toLowerCase(), k]));
  for (const n of nomes) {
    const k = baixas.get(n.toLowerCase());
    if (k !== undefined && o[k] !== undefined && o[k] !== null) return o[k];
  }
  return undefined;
}
const texto = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x : typeof x === 'number' ? String(x) : null);
const numero = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : null);

/** Lista de uma resposta que pode ser um array puro ou um objeto paginado ({ items }). */
export function itensDe(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const it = pick(raw, 'items', 'Items', 'data', 'results');
  return Array.isArray(it) ? it : [];
}
export function paginaDe(raw: unknown): { totalItems: number | null; maxTake: number | null } {
  const p = pick(raw, 'page', 'Page');
  return { totalItems: numero(pick(p, 'totalItems', 'total')), maxTake: numero(pick(p, 'maxTake')) };
}

export function diaBR(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  return p; // AAAA-MM-DD
}

/* ---------- catálogo (canais, bots, setores, etiquetas) ---------- */
export type ItemCatalogo = { id: string; nome: string; extra: string | null };

export function normalizaCanais(raw: unknown): ItemCatalogo[] {
  return itensDe(raw)
    .map((c) => {
      const id = texto(pick(c, 'id', 'Id'));
      if (!id) return null;
      const estado = texto(pick(c, 'state', 'status'));
      const tipo = texto(pick(c, 'channelType', 'type'));
      return { id, nome: texto(pick(c, 'name', 'title', 'displayName')) ?? `(sem nome) ${id}`, extra: [tipo, estado].filter(Boolean).join(' · ') || null };
    })
    .filter((x): x is ItemCatalogo => !!x);
}
export function normalizaBots(raw: unknown): ItemCatalogo[] {
  return itensDe(raw)
    .map((b) => {
      const id = texto(pick(b, 'id', 'Id'));
      if (!id) return null;
      const ativo = pick(b, 'active');
      return { id, nome: texto(pick(b, 'title', 'name', 'botName')) ?? `(sem nome) ${id}`, extra: ativo === true ? 'ativo' : ativo === false ? 'inativo' : null };
    })
    .filter((x): x is ItemCatalogo => !!x);
}
export const normalizaSetores = normalizaBots;
export function normalizaEtiquetas(raw: unknown): ItemCatalogo[] {
  return itensDe(raw)
    .map((t) => {
      const id = texto(pick(t, 'id', 'Id'));
      return id ? ({ id, nome: texto(pick(t, 'name', 'title', 'label')) ?? `(sem nome) ${id}`, extra: null } as ItemCatalogo) : null;
    })
    .filter((x): x is ItemCatalogo => !!x);
}

/** Organizações da conta (GET /v1/members/me). */
export function normalizaOrganizacoes(raw: unknown): { id: string; nome: string }[] {
  const lista = pick(raw, 'organizations', 'Organizations');
  return (Array.isArray(lista) ? lista : [])
    .map((o) => {
      const id = texto(pick(o, 'id', 'Id'));
      // organização inativa (a conta pode ter uma antiga) responde 403 em tudo: fica de fora
      return id && pick(o, 'active') !== false ? { id, nome: texto(pick(o, 'name', 'title')) ?? id } : null;
    })
    .filter((x): x is { id: string; nome: string } => !!x);
}

/* ---------- sessões de envio ---------- */
export type Parada = { motivo: string; n: number };
export type Sessao = {
  id: string;
  criadaEm: string | null;
  dia: string | null;
  titulo: string | null;
  tipo: 'Template' | 'Bot' | null;
  canalId: string | null;
  botId: string | null;
  botNome: string | null;
  gatilho: string | null;
  modeloId: string | null;
  modeloNome: string | null;
  modeloCategoria: string | null;
  enviadas: V;
  lidas: V;
  respondidas: V;
  falhas: V;
  creditos: V;
  /** Motivos de parada dos fluxos (só em sessões de Bot); null = não informado. */
  paradas: Parada[] | null;
};

const contaEstado = (lista: unknown, ...estados: string[]): number | null => {
  if (!Array.isArray(lista)) return null;
  let achou = false;
  let soma = 0;
  for (const e of lista) {
    const st = texto(pick(e, 'state', 'status'));
    const n = numero(pick(e, 'count', 'total'));
    if (st && n != null && estados.includes(st)) {
      achou = true;
      soma += n;
    }
  }
  return achou ? soma : null;
};

/** A sessão da listagem já traz os totais? Se não, o serviço busca o detalhe. */
export function temTotais(raw: unknown): boolean {
  return pick(raw, 'totalSent', 'messageStates', 'totalRead', 'totalFailed') !== undefined;
}

export function normalizaSessao(raw: unknown): Sessao | null {
  const id = texto(pick(raw, 'id', 'Id'));
  if (!id) return null;
  const criadaEm = texto(pick(raw, 'createdAtUTC', 'createdAt'));
  const tipoRaw = texto(pick(raw, 'type', 'Type'));
  const tipo = tipoRaw === 'Template' || tipoRaw === 'Bot' ? tipoRaw : null;
  const estados = pick(raw, 'messageStates');

  // Conferido na API real: em sessões de Bot `messagesSent` vem 0 e o total enviado está em `totalSent` (= scheduleStates Sent).
  const sent = numero(pick(raw, 'totalSent')) ?? contaEstado(pick(raw, 'scheduleStates'), 'Sent');
  const enviadasCampo = numero(pick(raw, 'messagesSent', 'sent'));
  const enviadas = sent != null ? ok(sent) : enviadasCampo != null ? ok(enviadasCampo) : falta('A API não informou o total de mensagens enviadas desta sessão.');

  // Conferido na API real: sessões de Bot trazem messageStates vazio e totalRead/totalFailed = 0. Esse 0 é "não rastreado", não "ninguém leu".
  const semRastro = Array.isArray(estados) && estados.length === 0 && tipo === 'Bot';
  const lidasN = semRastro ? null : numero(pick(raw, 'totalRead')) ?? contaEstado(estados, 'Read', 'Played');
  const falhasN = semRastro ? contaEstado(pick(raw, 'scheduleStates'), 'Error') ?? 0 : numero(pick(raw, 'totalFailed')) ?? contaEstado(estados, 'Failed', 'Error');
  const respN = numero(pick(raw, 'totalAnswered'));
  const flow = texto(pick(raw, 'answersFlowId'));

  const bot = pick(raw, 'bot');
  const tpl = pick(raw, 'template');
  const paradasRaw = pick(raw, 'botStopReasons');
  const paradas = Array.isArray(paradasRaw)
    ? paradasRaw
        .map((p) => ({ motivo: texto(pick(p, 'state')) ?? '?', n: numero(pick(p, 'count')) ?? 0 }))
        .filter((p) => p.n > 0)
    : null;

  return {
    id,
    criadaEm,
    dia: diaBR(criadaEm),
    titulo: texto(pick(raw, 'title', 'name')),
    tipo,
    canalId: texto(pick(pick(raw, 'channel'), 'id', 'Id')),
    botId: texto(pick(bot, 'id', 'Id')),
    botNome: texto(pick(bot, 'botName', 'name', 'title')),
    gatilho: texto(pick(bot, 'triggerName')),
    modeloId: texto(pick(tpl, 'id', 'Id')),
    modeloNome: texto(pick(tpl, 'label', 'name')),
    modeloCategoria: texto(pick(tpl, 'category')),
    enviadas,
    lidas: lidasN != null ? ok(lidasN) : falta(semRastro ? 'A API não rastreia leitura das mensagens enviadas por fluxo (Bot): o total vem zerado e sem estados.' : 'A API não informou quantas mensagens foram lidas nesta sessão.'),
    respondidas:
      respN != null
        ? ok(respN)
        : falta(flow || tipo === 'Template' ? 'A API não informou as respostas desta sessão.' : 'A API só conta respostas de formulário (WhatsApp Flow); este envio não tem contagem de respostas.'),
    falhas: falhasN != null ? ok(falhasN) : falta('A API não informou as falhas desta sessão.'),
    creditos: falta('Custo ainda não consultado.'),
    paradas,
  };
}

/** Custo (GET /v1/bulk-send-session/{id}/costs/). */
export function normalizaCusto(raw: unknown): V {
  const total = numero(pick(raw, 'totalCredits', 'total'));
  const linhas = pick(raw, 'lines');
  // Conferido na API real: sessões antigas (antes de ~set/2026) devolvem totalCredits 0 e nenhuma linha. Isso é "sem registro de custo", não "custou zero".
  if (total === 0 && Array.isArray(linhas) && linhas.length === 0) return falta(`${SEM_REGISTRO} para esta sessão (total 0 e nenhuma linha de cobrança; comum em sessões antigas).`);
  if (total != null) return ok(total);
  if (Array.isArray(linhas)) {
    const somas = linhas.map((l) => numero(pick(l, 'credits'))).filter((n): n is number => n != null);
    if (somas.length === linhas.length) return ok(somas.reduce((a, b) => a + b, 0));
  }
  return falta('A API não devolveu o custo desta sessão (campo ausente).');
}
