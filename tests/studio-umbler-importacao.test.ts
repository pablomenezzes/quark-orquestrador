import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { analisarMensagens, lerConversa } from '../studio/lib/umbler/mensagens';
import { importarUmbler } from '../studio/lib/umbler/importador';
import { montarRelatorio, tarifaMarketing, grupoDe } from '../studio/lib/umbler/relatorio';
import { PgBanco, type Banco, type MensagemBanco, type SessaoBanco } from '../studio/lib/umbler/banco';
import { normalizaCusto, normalizaCustoLinhas, type Sessao, type TemplateCatalogo } from '../studio/lib/umbler/normaliza';

const H = 3_600_000;
const T0 = Date.parse('2026-09-28T12:00:00Z');
const msg = (id: string, dh: number, src: string, extra: Record<string, unknown> = {}) => ({ id, eventAtUTC: new Date(T0 + dh * H).toISOString(), source: src, messageType: 'Text', ...extra });

describe('Umbler: interação depois do template (mensagens da conversa)', () => {
  it('conta responder, clicar em botão e atendente, sempre dentro de 24 h do template mais recente', () => {
    const r = analisarMensagens([
      msg('t1', 0, 'Bot', { templateId: 'tplA' }),
      msg('c1', 1, 'Contact', { messageType: 'ButtonReply' }),
      msg('m1', 2, 'Member'),
      msg('t2', 48, 'Bot', { templateId: 'tplB' }), // dois dias depois: outro disparo
      msg('c2', 100, 'Contact'), // 52 h depois do t2: fora da janela
      msg('t3', 200, 'Bot', { templateId: 'tplA' }),
      msg('m3', 201, 'Member'), // atendente sem resposta do contato não conta
      msg('c3', 205, 'Contact'),
    ]);
    const por = Object.fromEntries(r.map((x) => [x.id, x]));
    expect(por.t1).toMatchObject({ templateId: 'tplA', respondeu: true, clicou: true, humano: true });
    expect(por.t2).toMatchObject({ respondeu: false, clicou: false, humano: false });
    expect(por.t3).toMatchObject({ respondeu: true, clicou: false, humano: false });
    expect(r).toHaveLength(3);
  });

  it('ignora mensagens do contato como disparo, mensagens sem ID e templates que falharam', () => {
    const r = analisarMensagens([
      msg('x1', 0, 'Contact', { templateId: 'tplA' }),
      { eventAtUTC: new Date(T0).toISOString(), source: 'Bot', templateId: 'tplA' }, // sem id
      msg('x3', 1, 'Bot', { templateId: 'tplA', messageState: 'Failed' }),
      msg('x4', 2, 'Bot', { templateId: 'tplA', messageState: 'Read' }),
      { id: 'x5', source: 'Bot', templateId: 'tplA' }, // sem horário
    ]);
    expect(r.map((x) => x.id)).toEqual(['x4']);
  });

  it('não guarda texto, nome nem telefone: a saída só tem ID, template, horário e três indicadores', () => {
    const r = analisarMensagens([msg('a', 0, 'Bot', { templateId: 'tpl', content: 'Olá Maria 11 99999-0000', contactName: 'Maria' })]);
    expect(Object.keys(r[0]!).sort()).toEqual(['clicou', 'enviadoEm', 'humano', 'id', 'respondeu', 'templateId']);
    expect(JSON.stringify(r)).not.toMatch(/Maria|99999/);
  });

  it('lê a conversa paginando pelo horário da última mensagem, sem repetir', async () => {
    const pagina1 = Array.from({ length: 100 }, (_, i) => msg(`p1-${i}`, i * 0.01, 'Bot'));
    const pagina2 = [pagina1[99], msg('p2-0', 5, 'Contact')];
    const chamadas: string[] = [];
    const leitor = { async get(rota: string, q?: Record<string, unknown>) { chamadas.push(String(q?.FromEventUTC)); return { messages: chamadas.length === 1 ? pagina1 : pagina2 }; } };
    const r = await lerConversa(leitor as never, 'org', 'chat1', '2026-09-28T12:00:00Z');
    expect(r.mensagens).toHaveLength(101);
    expect(r.chamadas).toBe(2);
    expect(chamadas[0]).toBe('2026-09-28T12:00:00Z');
    expect(chamadas[1]).toBe(String(pagina1[99]!.eventAtUTC));
  });
});

/* ---------- banco em memória ---------- */
class BancoMem implements Banco {
  sess = new Map<string, SessaoBanco>();
  msgs = new Map<string, MensagemBanco>();
  tpl: TemplateCatalogo[] = [];
  tplEm: string | null = null;
  imports: unknown[] = [];
  agora = () => Date.now();
  async sessoes(desde: string) { return [...this.sess.values()].filter((s) => s.dia >= desde); }
  async gravarSessao(_org: string, s: Sessao, canalNome: string | null, situacao: SessaoBanco['custoSituacao']) {
    const ex = this.sess.get(s.id);
    this.sess.set(s.id, { id: s.id, criadaEm: s.criadaEm!, dia: s.dia!, tipo: s.tipo, canalId: s.canalId, canalNome, botId: s.botId, botNome: s.botNome, modeloId: s.modeloId, modeloNome: s.modeloNome, modeloCategoria: s.modeloCategoria, titulo: s.titulo,
      enviadas: s.enviadas.v, lidas: s.lidas.v, falhas: s.falhas.v, creditos: s.creditos.v, custoSituacao: situacao, linhasCusto: s.custoLinhas, scanCursor: ex?.scanCursor ?? 0, scanTotal: ex?.scanTotal ?? null, scanCompleto: ex?.scanCompleto ?? false, scanEm: ex?.scanEm ?? null, atualizadoEm: new Date(this.agora()).toISOString() });
  }
  async gravarTemplates(t: TemplateCatalogo[]) { this.tpl = t; this.tplEm = new Date(this.agora()).toISOString(); }
  async templatesEm() { return this.tplEm; }
  async templates() { return this.tpl; }
  async gravarMensagens(sessaoId: string, canalId: string | null, _bot: string | null, m: { id: string; templateId: string; dia: string; respondeu: boolean; clicou: boolean; humano: boolean }[]) {
    for (const x of m) { const ex = this.msgs.get(x.id); this.msgs.set(x.id, { id: x.id, sessaoId: ex?.sessaoId ?? sessaoId, templateId: x.templateId, dia: x.dia, canalId, respondeu: (ex?.respondeu ?? false) || x.respondeu, clicou: (ex?.clicou ?? false) || x.clicou, humano: (ex?.humano ?? false) || x.humano }); }
  }
  async atualizarScan(id: string, cursor: number, total: number | null, completo: boolean) { const s = this.sess.get(id)!; this.sess.set(id, { ...s, scanCursor: cursor, scanTotal: total ?? s.scanTotal, scanCompleto: completo, scanEm: completo ? new Date(this.agora()).toISOString() : s.scanEm }); }
  async reiniciarScan(id: string) { const s = this.sess.get(id)!; this.sess.set(id, { ...s, scanCursor: 0, scanCompleto: false }); }
  async mensagens(canalId: string, de: string, ate: string) { return [...this.msgs.values()].filter((m) => m.canalId === canalId && m.dia >= de && m.dia <= ate); }
  async registrarImportacao(...a: unknown[]) { this.imports.push(a); }
  async ultimaImportacao() { return null; }
}

/** Umbler de mentira: 2 sessões no canal c1 (uma de fluxo Geladeira com 3 conversas, uma de template com 1) e 1 sessão de outro canal. */
function umblerFalsa() {
  const chamadas: string[] = [];
  const agora = Date.parse('2026-11-03T12:00:00Z');
  const sessoes = [
    { id: 's-gel', createdAtUTC: '2026-09-28T12:00:00Z', title: 'Geladeira', type: 'Bot', channel: { id: 'c1' }, messagesSent: 0, bot: { id: 'b1', botName: 'Geladeira Proposta QuarkRH', triggerName: 'g' } },
    { id: 's-avulso', createdAtUTC: '2026-10-10T12:00:00Z', title: 'Promo', type: 'Template', channel: { id: 'c1' }, messagesSent: 1, template: { id: 'tplP', label: 'promo_out' } },
    { id: 's-outro', createdAtUTC: '2026-10-11T12:00:00Z', title: 'Outro canal', type: 'Template', channel: { id: 'c2' }, messagesSent: 5, template: { id: 'tplQ', label: 'q' } },
  ];
  const detalhe = (id: string) => { const s = sessoes.find((x) => x.id === id)!; return { ...s, totalSent: id === 's-gel' ? 3 : (s.messagesSent as number), totalRead: 0, totalFailed: 0, totalAnswered: null, messageStates: id === 's-gel' ? [] : [{ state: 'Read', count: 1 }], scheduleStates: [] }; };
  const chatsDe: Record<string, string[]> = { 's-gel': ['ch1', 'ch2', 'ch3'], 's-avulso': ['ch4'] };
  const conversa: Record<string, unknown[]> = {
    ch1: [msg('g1', 0, 'Bot', { templateId: 'tplG' }), msg('g1r', 1, 'Contact', { messageType: 'ButtonReply' }), msg('g1h', 2, 'Member'), msg('g1b', 24 * 15, 'Bot', { templateId: 'tplG' })],
    ch2: [msg('g2', 0, 'Bot', { templateId: 'tplG' })],
    ch3: [msg('g3', 0, 'Bot', { templateId: 'tplG' }), msg('g3r', 3, 'Contact')],
    ch4: [{ id: 'a1', eventAtUTC: '2026-10-10T12:00:05Z', source: 'Bot', messageType: 'Text', templateId: 'tplP' }, { id: 'a1r', eventAtUTC: '2026-10-10T13:00:00Z', source: 'Contact', messageType: 'Text' }],
  };
  const leitor = {
    async get(rota: string, q: Record<string, unknown> = {}) {
      chamadas.push(rota);
      if (rota === '/v1/bulk-send-session/') return { items: Number(q.Skip) === 0 ? sessoes.map(({ messagesSent, ...r }) => ({ ...r, messagesSent })) : [] };
      if (rota === '/v1/channels/') return [{ id: 'c1', name: 'QuarkRH Insights' }, { id: 'c2', name: 'Outro' }];
      if (rota === '/v1/templates/') return { items: [{ id: 'tplG', label: 'geladeira_1', category: 'MARKETING' }, { id: 'tplP', label: 'promo_out', category: 'MARKETING' }] };
      let m = /\/v1\/bulk-send-session\/([\w-]+)\/costs\/$/.exec(rota);
      if (m) return m[1] === 's-outro' ? { totalCredits: 7800, lines: [{ creditType: 'Template', templateId: 'tplQ', templateName: 'q', count: 2, credits: 7800 }] } : { totalCredits: 0, lines: [] };
      m = /\/v1\/bulk-send-session\/([\w-]+)\/messages-sent\/$/.exec(rota);
      if (m) { const ids = chatsDe[m[1]!] ?? []; return { page: { totalItems: ids.length }, items: ids.slice(Number(q.Skip), Number(q.Skip) + Number(q.Take)).map((chatId) => ({ chatId, contactName: 'NOME', contactPhoneNumber: '+5511' })) }; }
      m = /\/v1\/bulk-send-session\/([\w-]+)\/$/.exec(rota);
      if (m) return detalhe(m[1]!);
      m = /\/v1\/chats\/(\w+)\/relative-messages\/$/.exec(rota);
      if (m) return { messages: conversa[m[1]!] ?? [] };
      throw new Error(`rota inesperada ${rota}`);
    },
  };
  return { leitor, chamadas, agora };
}

describe('Umbler: importação para o banco', () => {
  it('importa as sessões de todos os canais e lê as conversas só do canal escolhido', async () => {
    const f = umblerFalsa();
    const banco = new BancoMem();
    const p = await importarUmbler(f.leitor, banco, { org: 'o', de: '2026-07-01', canalId: 'c1', orcamentoMs: 60_000, agora: () => f.agora });
    expect(p.concluido).toBe(true);
    expect(banco.sess.size).toBe(3);
    expect(banco.sess.get('s-outro')).toMatchObject({ custoSituacao: 'registrado', creditos: 7800, canalNome: 'Outro' });
    expect(banco.sess.get('s-gel')).toMatchObject({ custoSituacao: 'sem_registro', scanCompleto: true, scanCursor: 3, canalNome: 'QuarkRH Insights' });
    expect(banco.sess.get('s-outro')!.scanCompleto).toBe(false); // outro canal: sem leitura de conversas
    expect(banco.msgs.size).toBe(5); // g1, g1b (acompanhamento 15 dias depois), g2, g3 (fluxo) e a1 (avulso)
    expect([...banco.msgs.values()].filter((m) => m.respondeu).map((m) => m.id).sort()).toEqual(['a1', 'g1', 'g3']);
    expect(banco.msgs.get('g1')).toMatchObject({ clicou: true, humano: true });
    expect(banco.tpl.map((t) => t.id)).toEqual(['tplG', 'tplP']);
    expect(banco.imports).toHaveLength(0); // o registro da importação é feito pelo serviço
    // só GET e só rotas da Umbler, e nenhuma conversa de outro canal
    expect(f.chamadas.every((r) => r.startsWith('/v1/'))).toBe(true);
    expect(f.chamadas.filter((r) => r.includes('relative-messages'))).toHaveLength(4);
  });

  it('retoma de onde parou quando o orçamento de tempo acaba e termina sem duplicar mensagens', async () => {
    const f = umblerFalsa();
    const banco = new BancoMem();
    let t = f.agora;
    banco.agora = () => t;
    const leitorLento = { get: async (r: string, q?: Record<string, unknown>) => { t += 2_000; return f.leitor.get(r, q); } };
    let rodadas = 0;
    let p;
    do { p = await importarUmbler(leitorLento, banco, { org: 'o', de: '2026-07-01', canalId: 'c1', orcamentoMs: 9_000, agora: () => t }); rodadas++; } while (!p.concluido && rodadas < 40);
    expect(p.concluido).toBe(true);
    expect(rodadas).toBeGreaterThan(1);
    expect(banco.msgs.size).toBe(5);
    expect([...banco.sess.values()].filter((s) => s.canalId === 'c1').every((s) => s.scanCompleto)).toBe(true);
    // uma segunda importação logo depois não refaz nada: sessões atualizadas há pouco e conversas já lidas
    const antes = f.chamadas.length;
    t += 1_000;
    const p2 = await importarUmbler(leitorLento, banco, { org: 'o', de: '2026-07-01', canalId: 'c1', orcamentoMs: 600_000, agora: () => t });
    expect(p2.concluido).toBe(true);
    expect(p2.sessoes.atualizadas).toBe(0);
    expect(p2.conversas.sessoes).toBe(0);
    expect(f.chamadas.length - antes).toBeLessThan(8); // só a listagem e o catálogo de canais
  });

  it('a mesma mensagem lida em duas sessões é contada uma vez (a primeira sessão fica com ela)', async () => {
    const banco = new BancoMem();
    await banco.gravarMensagens('sA', 'c1', 'b', [{ id: 'm1', templateId: 't', dia: '2026-09-28', respondeu: false, clicou: false, humano: false }]);
    await banco.gravarMensagens('sB', 'c1', 'b', [{ id: 'm1', templateId: 't', dia: '2026-09-28', respondeu: true, clicou: false, humano: false }]);
    expect(banco.msgs.size).toBe(1);
    expect(banco.msgs.get('m1')).toMatchObject({ sessaoId: 'sA', respondeu: true });
  });
});

describe('Umbler: relatório mês a mês', () => {
  const sessao = (o: Partial<SessaoBanco>): SessaoBanco => ({ id: 's', criadaEm: '2026-09-28T12:00:00Z', dia: '2026-09-28', tipo: 'Bot', canalId: 'c1', canalNome: 'QuarkRH Insights', botId: 'b', botNome: 'Geladeira Proposta', modeloId: null, modeloNome: null, modeloCategoria: null, titulo: 'x', enviadas: 10, lidas: null, falhas: 0, creditos: null, custoSituacao: 'sem_registro', linhasCusto: null, scanCursor: 10, scanTotal: 10, scanCompleto: true, scanEm: null, atualizadoEm: '', ...o });
  const m = (id: string, sessaoId: string, dia: string, tpl: string, r = false, c = false, h = false): MensagemBanco => ({ id, sessaoId, templateId: tpl, dia, respondeu: r, clicou: c, humano: h, canalId: 'c1' });
  const templates: TemplateCatalogo[] = [{ id: 'tG', nome: 'geladeira_1', categoria: 'MARKETING', status: 'APPROVED' }];
  const registrada = sessao({ id: 'ref', canalId: 'c9', custoSituacao: 'registrado', creditos: 7800, linhasCusto: [{ tipo: 'Template', templateId: 'x', templateNome: 'x', count: 2, credits: 7800 }] });

  it('classifica Geladeira, outros fluxos e disparos avulsos', () => {
    expect(grupoDe({ tipo: 'Bot', botNome: 'Geladeira Proposta QuarkRH (30D)', titulo: '' })).toBe('Geladeira');
    expect(grupoDe({ tipo: 'Bot', botNome: 'Carbone Class', titulo: '' })).toBe('Outros fluxos');
    expect(grupoDe({ tipo: 'Template', botNome: null, titulo: 'Promo' })).toBe('Disparos avulsos');
  });

  it('tarifa de marketing = média ponderada das cobranças de template registradas', () => {
    const t = tarifaMarketing([registrada, sessao({ custoSituacao: 'sem_registro' }), sessao({ custoSituacao: 'registrado', linhasCusto: [{ tipo: 'Template', templateId: 'y', templateNome: 'y', count: 6, credits: 23400 }, { tipo: 'Message', templateId: null, templateNome: null, count: 5, credits: 50 }] })]);
    expect(t).toMatchObject({ creditosPorMsg: 3900, mensagens: 8, sessoes: 2 });
    expect(tarifaMarketing([sessao({})])).toBeNull();
  });

  it('agrupa por mês do disparo (não da sessão), calcula gasto estimado e taxas de interesse', () => {
    const sessoes = [sessao({ id: 'gel' }), sessao({ id: 'av', tipo: 'Template', botNome: null, dia: '2026-10-10', enviadas: 1 }), registrada];
    const msgs = [m('1', 'gel', '2026-09-28', 'tG', true, true, true), m('2', 'gel', '2026-09-28', 'tG'), m('3', 'gel', '2026-10-13', 'tG', true), m('4', 'av', '2026-10-10', 'tP', true, true)];
    const r = montarRelatorio({ canal: { id: 'c1', nome: 'QuarkRH Insights' }, de: '2026-07-01', ate: '2026-11-03', sessoes, mensagens: msgs, templates, precoCredito: 0.0001 });
    expect(r.meses.map((x) => x.mes)).toEqual(['2026-09', '2026-10']);
    const [set, out] = r.meses;
    expect(set!.grupos.Geladeira).toMatchObject({ sessoes: 1, envios: 10, disparos: 2, respondeu: 1, clicou: 1, humano: 1 });
    expect(out!.grupos.Geladeira).toMatchObject({ sessoes: 0, disparos: 1, respondeu: 1 }); // acompanhamento do fluxo enviado em outubro
    expect(out!.grupos['Disparos avulsos']).toMatchObject({ sessoes: 1, disparos: 1, clicou: 1 });
    expect(r.total).toMatchObject({ disparos: 4, respondeu: 3, clicou: 2 });
    expect(r.total.creditosEst).toBe(4 * 3900);
    expect(r.total.reaisEst).toBeCloseTo(4 * 3900 * 0.0001);
    const tg = r.templates.find((x) => x.templateId === 'tG')!;
    expect(tg).toMatchObject({ nome: 'geladeira_1', categoria: 'MARKETING', disparos: 3, respondeu: 2, primeiro: '2026-09-28', ultimo: '2026-10-13' });
    expect(r.templates.find((x) => x.templateId === 'tP')!.nome).toBe('tP'); // sem catálogo: mostra o ID, nunca inventa nome
    expect(r.cobertura).toMatchObject({ sessoes: 2, sessoesLidas: 2, mensagens: 4 });
  });

  it('R$ por mensagem informado vale direto: 1 disparo a R$ 0,3217 custa R$ 0,3217, e o preço do crédito não multiplica por 3.900 por engano', () => {
    const sessoes = [sessao({ id: 'gel' }), registrada];
    const base = { canal: { id: 'c1', nome: null }, de: '2026-07-01', ate: '2026-11-03', sessoes, mensagens: [m('1', 'gel', '2026-08-10', 'tG')], templates };
    const r = montarRelatorio({ ...base, precoCredito: null, precoPorMsg: 0.3217 });
    expect(r.total.reaisEst).toBeCloseTo(0.3217);
    expect(r.precoPorMsg).toBe(0.3217);
    expect(r.templates[0]!.reaisEst).toBeCloseTo(0.3217);
    // sem tarifa registrada, ainda dá para calcular o R$ pelo preço por mensagem
    const semTarifa = montarRelatorio({ ...base, sessoes: [sessao({ id: 'gel' })], precoCredito: null, precoPorMsg: 0.3217 });
    expect(semTarifa.total.creditosEst).toBeNull();
    expect(semTarifa.total.reaisEst).toBeCloseTo(0.3217);
    // o preço do crédito continua funcionando: 3.900 créditos x 0,0001 = R$ 0,39 por mensagem
    expect(montarRelatorio({ ...base, precoCredito: 0.0001 }).precoPorMsg).toBeCloseTo(0.39);
  });

  it('sem tarifa não inventa gasto; sem preço do crédito não inventa R$; sessão sem leitura de conversas aparece na cobertura', () => {
    const r = montarRelatorio({ canal: { id: 'c1', nome: null }, de: '2026-07-01', ate: '2026-11-03', sessoes: [sessao({ scanCompleto: false })], mensagens: [m('1', 's', '2026-09-28', 'tG')], templates, precoCredito: null });
    expect(r.tarifa).toBeNull();
    expect(r.total.creditosEst).toBeNull();
    expect(r.total.reaisEst).toBeNull();
    expect(r.cobertura.sessoesLidas).toBe(0);
    const comTarifa = montarRelatorio({ canal: { id: 'c1', nome: null }, de: '2026-07-01', ate: '2026-11-03', sessoes: [registrada, sessao({})], mensagens: [m('1', 's', '2026-09-28', 'tG')], templates, precoCredito: null });
    expect(comTarifa.total.creditosEst).toBe(3900);
    expect(comTarifa.total.reaisEst).toBeNull();
  });
});

describe('Umbler: banco (SQL)', () => {
  it('PgBanco só usa ops.umbler_*, parâmetros e nenhum DELETE/DROP; mensagens não são sobrescritas para baixo', async () => {
    const sqls: string[] = [];
    const pool = { query: async (sql: string) => { sqls.push(sql); return { rows: [] }; } };
    const b = new PgBanco(pool as never);
    await b.sessoes('2026-07-01');
    await b.gravarMensagens('s', 'c', 'b', [{ id: 'm', enviadoEm: '2026-09-28T12:00:00Z', templateId: 't', dia: '2026-09-28', respondeu: true, clicou: false, humano: false } as never]);
    await b.atualizarScan('s', 1, 2, false);
    await b.mensagens('c', '2026-07-01', '2026-11-03');
    await b.registrarImportacao('2026-07-01', 'c', {}, null);
    const todo = sqls.join(' ');
    expect(todo).not.toMatch(/\b(delete|drop|truncate)\b/i);
    expect(todo).not.toMatch(/\b(public|core|orq|crm)\./i);
    // mensagem repetida no mesmo lote vira uma só (o upsert do Postgres recusa duas linhas iguais no mesmo comando)
    let params: unknown[] = [];
    const b2 = new PgBanco({ query: async (_s: string, p?: unknown[]) => { params = p ?? []; return { rows: [] }; } } as never);
    await b2.gravarMensagens('s', 'c', 'b', [
      { id: 'm', enviadoEm: '2026-09-28T12:00:00Z', templateId: 't', dia: '2026-09-28', respondeu: false, clicou: false, humano: false },
      { id: 'm', enviadoEm: '2026-09-28T12:00:00Z', templateId: 't', dia: '2026-09-28', respondeu: true, clicou: false, humano: false },
    ]);
    expect(params[0]).toEqual(['m']);
    expect(params[7]).toEqual([true]);
    expect(todo).toMatch(/respondeu_24h = ops\.umbler_mensagem\.respondeu_24h or excluded\.respondeu_24h/);
  });

  it('a migration 0035 é aditiva, sem dado pessoal e só dá acesso ao papel do painel', () => {
    const sql = readFileSync('supabase/migrations/0035_umbler_dados.sql', 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\b(drop|delete|truncate|rename)\b/i);
    expect([...sql.matchAll(/alter table [^;]+;/gi)].every((x) => /enable row level security/i.test(x[0]))).toBe(true);
    expect(sql).not.toMatch(/\b(nome_contato|telefone|phone|email|texto|conteudo|chat_id)\b/i);
    expect(sql).not.toMatch(/\bpublic\./);
    const alvos = [...sql.matchAll(/(?:grant [^;]+|create policy [^;]+) to ([a-z_]+)/gi)].map((x) => x[1]);
    expect(alvos.length).toBeGreaterThan(0);
    expect(alvos.every((x) => x === 'orq_panel')).toBe(true);
  });

  it('custo: linhas de cobrança e total registrado', () => {
    const raw = { totalCredits: 8000, lines: [{ creditType: 'Template', templateId: 't', templateName: 'T', count: 2, credits: 7800 }, { creditType: 'Message', templateId: null, templateName: null, count: 1, credits: 200 }, { creditType: 'Template', templateId: 'z', count: 0, credits: 0 }] };
    expect(normalizaCusto(raw).v).toBe(8000);
    expect(normalizaCustoLinhas(raw)).toHaveLength(2); // linha com count 0 sai
  });
});
