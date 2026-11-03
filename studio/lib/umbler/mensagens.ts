/**
 * Leitura das mensagens de uma conversa para medir o interesse do lead depois de cada template enviado.
 * Só sai daqui o que não identifica ninguém: ID opaco da mensagem, ID do template, horário, três indicadores e, quando o lead clicou num
 * botão, o texto desse botão (definido pelo template). Texto livre do lead, nome e telefone não são guardados.
 *
 * Regras (janela de 24 h depois de cada template):
 * - respondeu: o contato mandou qualquer mensagem dentro da janela (a resposta conta para o template mais recente antes dela);
 * - clicou: a resposta do contato foi por botão ou lista (tipo ButtonReply, ListReply...); guarda-se só o texto do botão (CTA);
 * - humano: depois da resposta, um atendente escreveu dentro da janela.
 */
import { pick } from './normaliza.js';

export const JANELA_MS = 24 * 3_600_000;

export type MensagemTemplate = { id: string; enviadoEm: string; templateId: string; respondeu: boolean; clicou: boolean; humano: boolean; /** Texto do botão clicado (só botão/lista; nunca texto livre). */ cta: string | null };

type Msg = { id: string | null; t: number; src: string; tipo: string; tpl: string | null; estado: string; conteudo: string | null };

function normaliza(m: unknown): Msg | null {
  const t = Date.parse(String(pick(m, 'eventAtUTC', 'createdAtUTC') ?? ''));
  if (Number.isNaN(t)) return null;
  const id = pick(m, 'id');
  const tpl = pick(m, 'templateId');
  return {
    id: typeof id === 'string' ? id : null,
    t,
    src: String(pick(m, 'source') ?? ''),
    tipo: String(pick(m, 'messageType') ?? ''),
    tpl: typeof tpl === 'string' && tpl ? tpl : null,
    estado: String(pick(m, 'messageState') ?? ''),
    conteudo: typeof pick(m, 'content') === 'string' ? (pick(m, 'content') as string) : null,
  };
}

export function analisarMensagens(brutas: unknown[], janelaMs = JANELA_MS): MensagemTemplate[] {
  const msgs = brutas.map(normaliza).filter((m): m is Msg => !!m).sort((a, b) => a.t - b.t);
  const tpls = msgs
    .filter((m) => m.tpl && m.id && m.src !== 'Contact' && !/^(Failed|Error)$/i.test(m.estado))
    .map((m) => ({ id: m.id!, t: m.t, templateId: m.tpl!, respondeu: false, clicou: false, humano: false, cta: null as string | null }));
  const ultimo = (t: number) => {
    for (let i = tpls.length - 1; i >= 0; i--) if (tpls[i]!.t < t && t - tpls[i]!.t <= janelaMs) return tpls[i]!;
    return null;
  };
  for (const m of msgs) {
    if (m.tpl) continue; // a própria mensagem de template não é resposta
    const alvo = ultimo(m.t);
    if (!alvo) continue;
    if (m.src === 'Contact') {
      alvo.respondeu = true;
      if (/reply$/i.test(m.tipo)) {
        alvo.clicou = true;
        // o texto de um botão é definido no template; texto livre (tipo Text) nunca é guardado
        if (!alvo.cta && /^(button|list)reply$/i.test(m.tipo) && m.conteudo && m.conteudo.trim().length <= 80) alvo.cta = m.conteudo.trim();
      }
    } else if (m.src === 'Member' && alvo.respondeu) {
      alvo.humano = true;
    }
  }
  return tpls.map((x) => ({ id: x.id, enviadoEm: new Date(x.t).toISOString(), templateId: x.templateId, respondeu: x.respondeu, clicou: x.clicou, humano: x.humano, cta: x.cta }));
}

/** Mensagens de uma conversa a partir do envio, paginando pelo horário da última (no máximo 5 páginas de 100). */
export async function lerConversa(leitor: { get(rota: string, q?: Record<string, string | number | boolean | null | undefined>): Promise<unknown> }, org: string, chatId: string, desdeIso: string): Promise<{ mensagens: unknown[]; chamadas: number }> {
  const todas: unknown[] = [];
  const vistos = new Set<string>();
  let desde = desdeIso;
  let chamadas = 0;
  for (let pg = 0; pg < 5; pg++) {
    chamadas++;
    const r = await leitor.get(`/v1/chats/${chatId}/relative-messages/`, { organizationId: org, FromEventUTC: desde, Take: 100, Direction: 'TakeAfter' });
    const lista = pick(r, 'messages');
    const arr = Array.isArray(lista) ? lista : [];
    let novas = 0;
    for (const m of arr) {
      const id = pick(m, 'id');
      if (typeof id === 'string') { if (vistos.has(id)) continue; vistos.add(id); }
      todas.push(m);
      novas++;
    }
    if (arr.length < 100 || !novas) break;
    const ult = pick(arr[arr.length - 1], 'eventAtUTC', 'createdAtUTC');
    if (typeof ult !== 'string') break;
    desde = ult;
  }
  return { mensagens: todas, chamadas };
}
