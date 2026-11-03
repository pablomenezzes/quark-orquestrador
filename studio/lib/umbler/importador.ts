/**
 * Importação da Umbler para o banco (ops.umbler_*), em etapas que cabem no tempo de uma requisição da Vercel e podem ser retomadas:
 *   A) sessões de envio desde `de` (totais, template/fluxo, custo registrado), de TODOS os canais;
 *   B) catálogo de templates (nome e categoria);
 *   C) mensagens de template e interação, só nas conversas das sessões do canal escolhido.
 * Cada chamada trabalha até `orcamentoMs` e devolve o que falta; a tela repete até `concluido`. Somente GET na Umbler.
 */
import type { Leitor } from './servico.js';
import { diaBR, itensDe, normalizaCusto, normalizaCustoLinhas, normalizaSessao, normalizaTemplates, pick, type Sessao } from './normaliza.js';
import { analisarMensagens, lerConversa } from './mensagens.js';
import type { Banco, SessaoBanco } from './banco.js';

export type Progresso = {
  concluido: boolean;
  fase: 'sessoes' | 'templates' | 'conversas' | 'fim';
  sessoes: { total: number; atualizadas: number };
  conversas: { sessoes: number; sessoesFeitas: number; verificadas: number; mensagens: number };
  chamadas: number;
  avisos: string[];
};

const TAKE_SESSOES = 100;
const TAKE_CHATS = 250;
const DIA_MS = 86_400_000;

export type ImportarOpts = { org: string; de: string; canalId: string | null; orcamentoMs: number; agora?: () => number; reescanearAteDias?: number };

export async function importarUmbler(leitor: Leitor, banco: Banco, o: ImportarOpts): Promise<Progresso> {
  const agora = o.agora ?? Date.now;
  const inicio = agora();
  const estourou = () => agora() - inicio > o.orcamentoMs;
  const p: Progresso = { concluido: false, fase: 'sessoes', sessoes: { total: 0, atualizadas: 0 }, conversas: { sessoes: 0, sessoesFeitas: 0, verificadas: 0, mensagens: 0 }, chamadas: 0, avisos: [] };
  const get = (rota: string, q: Record<string, string | number | boolean | null | undefined> = {}) => { p.chamadas++; return leitor.get(rota, q); };
  const q0 = { organizationId: o.org };

  /* ---------- A) sessões ---------- */
  const brutas: unknown[] = [];
  for (let pg = 0; pg < 200; pg++) {
    const r = await get('/v1/bulk-send-session/', { ...q0, Skip: pg * TAKE_SESSOES, Take: TAKE_SESSOES, OrderBy: 'CreatedAtUTC', Order: 'Desc', Behavior: 'GetSliceOnly' });
    const it = itensDe(r);
    brutas.push(...it);
    const ult = it[it.length - 1];
    const dia = diaBR(typeof pick(ult, 'createdAtUTC') === 'string' ? (pick(ult, 'createdAtUTC') as string) : null);
    if (it.length < TAKE_SESSOES || (dia != null && dia < o.de)) break;
  }
  const noPeriodo = brutas.map((b) => normalizaSessao(b)).filter((s): s is Sessao => !!s && !!s.dia && s.dia >= o.de);
  p.sessoes.total = noPeriodo.length;
  const existentes = new Map((await banco.sessoes(o.de)).map((s) => [s.id, s]));

  // canal de cada sessão (nome) vem do catálogo de canais
  const canais = new Map<string, string>();
  try {
    for (const c of itensDe(await get('/v1/channels/', q0))) { const id = pick(c, 'id'); const nome = pick(c, 'name'); if (typeof id === 'string' && typeof nome === 'string') canais.set(id, nome); }
  } catch { p.avisos.push('A lista de canais falhou: os nomes dos canais podem faltar.'); }

  p.fase = 'sessoes';
  for (const s0 of noPeriodo) {
    const ex = existentes.get(s0.id);
    const idadeDias = (agora() - Date.parse(s0.criadaEm!)) / DIA_MS;
    const velho = !ex || ex.custoSituacao === 'falhou' || ex.custoSituacao === 'nao_consultado' || (idadeDias < 45 && agora() - Date.parse(ex.atualizadoEm) > 6 * 3_600_000);
    if (!velho) continue;
    if (estourou()) return p; // volta na próxima chamada
    let det: unknown = null;
    let custo: unknown = null;
    let situacao: SessaoBanco['custoSituacao'] = 'nao_consultado';
    try { det = await get(`/v1/bulk-send-session/${s0.id}/`, q0); } catch (e) { p.avisos.push(`Detalhe falhou (${msg(e)}).`); }
    try {
      custo = await get(`/v1/bulk-send-session/${s0.id}/costs/`, q0);
      const c = normalizaCusto(custo);
      situacao = c.v != null ? 'registrado' : 'sem_registro';
    } catch { situacao = 'falhou'; }
    const s = (det ? normalizaSessao(det) : null) ?? s0;
    const completa: Sessao = { ...s, creditos: custo ? normalizaCusto(custo) : s.creditos, custoLinhas: custo ? normalizaCustoLinhas(custo) : null };
    await banco.gravarSessao(o.org, { ...completa }, canais.get(completa.canalId ?? '') ?? null, situacao, { detalhe: det, custo });
    p.sessoes.atualizadas++;
  }

  /* ---------- B) templates ---------- */
  p.fase = 'templates';
  const tEm = await banco.templatesEm();
  if (!tEm || agora() - Date.parse(tEm) > DIA_MS) {
    if (estourou()) return p;
    try {
      const todos = [];
      for (let pg = 0; pg < 50; pg++) {
        const it = itensDe(await get('/v1/templates/', { ...q0, Skip: pg * TAKE_SESSOES, Take: TAKE_SESSOES, Behavior: 'GetSliceOnly' }));
        todos.push(...it);
        if (it.length < TAKE_SESSOES) break;
      }
      await banco.gravarTemplates(normalizaTemplates(todos));
    } catch (e) { p.avisos.push(`A lista de templates falhou (${msg(e)}).`); }
  }

  /* ---------- C) conversas do canal escolhido ---------- */
  p.fase = 'conversas';
  if (!o.canalId) { p.fase = 'fim'; p.concluido = true; return p; }
  const doCanal = (await banco.sessoes(o.de)).filter((s) => s.canalId === o.canalId);
  const limiteReescan = (o.reescanearAteDias ?? 45) * DIA_MS;
  const pendentes: SessaoBanco[] = [];
  for (const s of doCanal) {
    if (!s.scanCompleto) { pendentes.push(s); continue; }
    const idade = agora() - Date.parse(s.criadaEm);
    if (idade < limiteReescan && (!s.scanEm || agora() - Date.parse(s.scanEm) > DIA_MS)) { await banco.reiniciarScan(s.id); pendentes.push({ ...s, scanCursor: 0, scanCompleto: false }); }
  }
  p.conversas.sessoes = pendentes.length;
  for (const s of pendentes.sort((a, b) => a.criadaEm.localeCompare(b.criadaEm))) {
    let cursor = s.scanCursor;
    let total: number | null = s.scanTotal;
    let completo = false;
    const fila: { id: string; enviadoEm: string; templateId: string; respondeu: boolean; clicou: boolean; humano: boolean; dia: string }[] = [];
    const descarrega = async () => { if (fila.length) { await banco.gravarMensagens(s.id, s.canalId, s.botId, fila.splice(0)); } };
    for (;;) {
      if (estourou()) { await descarrega(); await banco.atualizarScan(s.id, cursor, total, false); return p; }
      const r = await get(`/v1/bulk-send-session/${s.id}/messages-sent/`, { ...q0, Skip: cursor, Take: TAKE_CHATS, Behavior: cursor === 0 ? 'CountAllAndGetSlice' : 'GetSliceOnly' });
      if (cursor === 0) { const t = pick(pick(r, 'page'), 'totalItems'); if (typeof t === 'number') total = t; }
      const chats = itensDe(r).map((x) => pick(x, 'chatId')).filter((x): x is string => typeof x === 'string');
      for (const chat of chats) {
        if (estourou()) { await descarrega(); await banco.atualizarScan(s.id, cursor, total, false); return p; }
        try {
          const { mensagens, chamadas } = await lerConversa({ get: (rota, qq) => leitor.get(rota, qq as never) }, o.org, chat, s.criadaEm);
          p.chamadas += chamadas;
          const achadas = analisarMensagens(mensagens).map((m) => ({ ...m, dia: diaBR(m.enviadoEm)! }));
          fila.push(...achadas);
          p.conversas.mensagens += achadas.length;
        } catch { p.avisos.push('Uma conversa não pôde ser lida e foi pulada.'); }
        cursor++;
        p.conversas.verificadas++;
        if (fila.length >= 200) await descarrega();
      }
      if (chats.length < TAKE_CHATS) { completo = true; break; }
    }
    await descarrega();
    await banco.atualizarScan(s.id, cursor, total ?? cursor, completo);
    p.conversas.sessoesFeitas++;
  }
  p.fase = 'fim';
  p.concluido = true;
  return p;
}

const msg = (e: unknown) => (e instanceof Error ? e.message.replace(/Bearer\s+\S+/g, 'Bearer ***') : 'erro');
