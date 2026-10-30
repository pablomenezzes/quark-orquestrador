/**
 * Serviço do painel Umbler: junta cliente (somente leitura), cache de 15 min, configuração (arquivo ou ops.cfg_umbler) e agregações.
 * Nada vai para a Umbler nem para o Pipedrive; as únicas escritas são a configuração e o cache local (em /tmp na Vercel).
 */
import { UmblerErro, ocultarToken, type Consulta } from './cliente.js';
import { CacheUmbler } from './cache.js';
import type { ConfigStore } from './config-store.js';
import {
  ConfigInvalida, acrescentarPreco, definirAmostra, definirFixado, definirOrganizacao, pertenceAoMarketing,
  TIPOS_ITEM, type ConfigUmbler, type ItemFixado, type TipoItem,
} from './config.js';
import {
  diaBR, itensDe, normalizaBots, normalizaCanais, normalizaCusto, normalizaEtiquetas, normalizaOrganizacoes, normalizaSessao, normalizaSetores, pick, temTotais,
  type ItemCatalogo, type Sessao,
} from './normaliza.js';
import { filtrar, gerarCsv, montarPainel, type Estimativa, type Filtros, type PainelUmbler, type Referencias, type Soma } from './painel.js';

export type Leitor = { get(rota: string, consulta?: Consulta): Promise<unknown> };

export class OrganizacaoPendente extends Error {
  constructor(readonly organizacoes: { id: string; nome: string }[]) {
    super('A conta tem mais de uma organização na Umbler. Escolha qual usar na aba Configuração.');
  }
}
export class SemToken extends Error {}

export type ItemTela = ItemCatalogo & { fixado: boolean; alteradoEm: string | null; presente: boolean };
export type SecaoCatalogo = { itens: ItemTela[]; erro: string | null };
export type Catalogo = {
  organizacoes: { id: string; nome: string }[];
  organizacaoId: string | null;
  canais: SecaoCatalogo;
  bots: SecaoCatalogo;
  setores: SecaoCatalogo;
  etiquetas: SecaoCatalogo;
  config: ConfigUmbler;
  geradoEm: number;
};

export type ResumoMes = {
  mes: string; de: string; ate: string; sessoes: number;
  enviadas: Soma; lidas: Soma; respondidas: Soma; falhas: Soma; creditos: Soma; reais: Soma;
  completudeCusto: { x: number; y: number };
  estimativa: Estimativa;
};
export type PassoFluxo = { passo: string; rotulo: string; tipo: string | null; alcancaram: number; pararam: number; ordem: number };
export type Passos = { lidas: number; total: number | null; porPasso: PassoFluxo[]; porStatus: { status: string; n: number }[]; completo: boolean; rotulosOk: boolean };

const PENDENTE = Symbol('pendente');
const TIPOS_PASSO: Record<string, string> = {
  SendMessageActionModel: 'Mensagem', TemplateMessageStepModel: 'Template', WaitingActionModel: 'Espera', MemberTransferActionModel: 'Transferir para atendente',
  TagActionModel: 'Etiqueta', CloseChatActionModel: 'Encerrar conversa', NotifyMemberActionModel: 'Avisar atendente', WebhookActionModel: 'Integração (webhook)',
  DayOfTheWeekStepModel: 'Dia da semana', TimeOfDayStepModel: 'Horário', FlowchartBotManualStartedEventModel: 'Início do fluxo',
};
const TAKE = 100; // a API aceita até 250 por página
const MAX_PAGINAS = 200;

export class ServicoUmbler {
  /** Última contagem de GETs feita por este serviço (para a conferência real). */
  chamadas = 0;

  constructor(
    private readonly o: {
      leitor: Leitor | null;
      cache: CacheUmbler;
      store: ConfigStore;
      token?: string;
      agora?: () => number;
      /** Tempo máximo (ms) de consultas à Umbler por requisição; o que sobrar fica para a próxima (o cache guarda o progresso). Sem valor = sem limite. */
      orcamentoMs?: number;
    },
  ) {}

  private agora = () => (this.o.agora ?? Date.now)();

  configurado(): { ok: boolean; motivo: string | null } {
    return this.o.leitor ? { ok: true, motivo: null } : { ok: false, motivo: 'Falta UMBLER_TOKEN no .env.local. O painel só lê da Umbler; sem o token não há dados.' };
  }

  config(): Promise<ConfigUmbler> {
    return this.o.store.ler();
  }
  get origemConfig() { return this.o.store.origem; }

  private leitor(): Leitor {
    if (!this.o.leitor) throw new SemToken('Falta UMBLER_TOKEN no .env.local.');
    return this.o.leitor;
  }

  private async get(rota: string, consulta: Consulta, fresh: boolean, guardar = true): Promise<unknown> {
    const chave = `${rota}?${JSON.stringify(consulta)}`;
    if (!fresh) {
      const c = this.o.cache.ler<unknown>(chave);
      if (c) return c.dado;
    }
    this.chamadas++;
    const dado = await this.leitor().get(rota, consulta);
    if (guardar) this.o.cache.gravar(chave, dado);
    return dado;
  }

  private msg(e: unknown): string {
    const t = e instanceof Error ? e.message : String(e);
    return this.o.token ? ocultarToken(t, this.o.token) : t;
  }

  private async paginado(rota: string, consulta: Consulta, fresh: boolean): Promise<unknown[]> {
    const todos: unknown[] = [];
    for (let pg = 0; pg < MAX_PAGINAS; pg++) {
      const r = await this.get(rota, { ...consulta, Skip: pg * TAKE, Take: TAKE, Behavior: 'GetSliceOnly' }, fresh);
      const it = itensDe(r);
      todos.push(...it);
      if (it.length < TAKE) break;
    }
    return todos;
  }

  /* ---------- organização ---------- */
  async organizacao(fresh = false): Promise<{ id: string; todas: { id: string; nome: string }[] }> {
    // a resposta de /members/me traz nome e e-mail do usuário: só a lista de organizações vai para o cache
    let todas = fresh ? null : (this.o.cache.ler<{ id: string; nome: string }[]>('organizacoes')?.dado ?? null);
    if (!todas) {
      this.chamadas++;
      todas = normalizaOrganizacoes(await this.leitor().get('/v1/members/me/'));
      this.o.cache.gravar('organizacoes', todas);
    }
    const cfg = await this.config();
    if (cfg.organizacaoId) return { id: cfg.organizacaoId, todas };
    if (todas.length === 1) return { id: todas[0]!.id, todas };
    throw new OrganizacaoPendente(todas);
  }

  /* ---------- catálogo para a Configuração ---------- */
  async catalogo(fresh = false): Promise<Catalogo> {
    const cfg = await this.config();
    let todas: { id: string; nome: string }[] = [];
    let org: string | null = cfg.organizacaoId;
    try {
      const o = await this.organizacao(fresh);
      org = o.id;
      todas = o.todas;
    } catch (e) {
      if (e instanceof OrganizacaoPendente) todas = e.organizacoes;
      else throw e;
    }
    const vazio = (erro: string): SecaoCatalogo => ({ itens: [], erro });
    const secao = async (tipo: TipoItem, buscar: () => Promise<ItemCatalogo[]>): Promise<SecaoCatalogo> => {
      if (!org) return vazio('Escolha a organização primeiro.');
      try {
        return { itens: mesclar(cfg[tipo], await buscar()), erro: null };
      } catch (e) {
        // rota falhou: mostra o que já está fixado, com o motivo
        return { itens: mesclar(cfg[tipo], []), erro: this.msg(e) };
      }
    };
    const q: Consulta = { organizationId: org };
    const [canais, bots, setores, etiquetas] = [
      await secao('canais', async () => normalizaCanais(await this.get('/v1/channels/', q, fresh))),
      await secao('bots', async () => normalizaBots(await this.paginado('/v1/bots/', q, fresh))),
      await secao('setores', async () => normalizaSetores(await this.get('/v1/sectors/', q, fresh))),
      await secao('etiquetas', async () => normalizaEtiquetas(await this.paginado('/v1/tags/', q, fresh))),
    ];
    return { organizacoes: todas, organizacaoId: org, canais, bots, setores, etiquetas, config: cfg, geradoEm: this.agora() };
  }

  /* ---------- alterações da configuração ---------- */
  private async grava(c: ConfigUmbler): Promise<ConfigUmbler> {
    await this.o.store.salvar(c);
    return c;
  }
  async fixar(tipo: unknown, id: unknown, nome: unknown, fixado: unknown): Promise<ConfigUmbler> {
    if (!(TIPOS_ITEM as readonly unknown[]).includes(tipo)) throw new ConfigInvalida('Tipo de item inválido.');
    if (typeof id !== 'string' || typeof fixado !== 'boolean') throw new ConfigInvalida('Dados inválidos.');
    return this.grava(definirFixado(await this.config(), tipo as TipoItem, id, typeof nome === 'string' ? nome : id, fixado, new Date(this.agora())));
  }
  async preco(desde: unknown, preco: unknown): Promise<ConfigUmbler> {
    return this.grava(acrescentarPreco(await this.config(), desde, preco, new Date(this.agora())));
  }
  async amostra(valor: unknown): Promise<ConfigUmbler> {
    return this.grava(definirAmostra(await this.config(), valor, new Date(this.agora())));
  }
  async escolherOrganizacao(id: unknown): Promise<ConfigUmbler> {
    if (typeof id !== 'string') throw new ConfigInvalida('Organização inválida.');
    return this.grava(definirOrganizacao(await this.config(), id, new Date(this.agora())));
  }

  /* ---------- sessões ---------- */
  /** Sessões criadas desde `de` (dia do Brasil), da mais nova para a mais antiga. Guarda o JSON original no cache. */
  private async sessoesBrutas(org: string, de: string, fresh: boolean): Promise<unknown[]> {
    const chave = `sessoes:${org}:${de}`;
    if (!fresh) {
      const c = this.o.cache.ler<unknown[]>(chave);
      if (c) return c.dado;
    }
    const todas: unknown[] = [];
    for (let pg = 0; pg < MAX_PAGINAS; pg++) {
      this.chamadas++;
      const r = await this.leitor().get('/v1/bulk-send-session/', { organizationId: org, Skip: pg * TAKE, Take: TAKE, OrderBy: 'CreatedAtUTC', Order: 'Desc', Behavior: 'GetSliceOnly' });
      const it = itensDe(r);
      todas.push(...it);
      const ultimo = it[it.length - 1];
      const dia = diaBR(typeof pick(ultimo, 'createdAtUTC') === 'string' ? (pick(ultimo, 'createdAtUTC') as string) : null);
      if (it.length < TAKE || (dia != null && dia < de)) break;
    }
    this.o.cache.gravar(chave, todas);
    return todas;
  }

  /** Consulta com o orçamento de tempo: devolve PENDENTE (sem ir à rede) quando o tempo acabou e o dado não está no cache. */
  private async getComOrcamento(rota: string, consulta: Consulta, fresh: boolean, estourou: () => boolean): Promise<unknown | typeof PENDENTE> {
    if (estourou()) {
      const c = fresh ? null : this.o.cache.ler<unknown>(`${rota}?${JSON.stringify(consulta)}`);
      return c ? c.dado : PENDENTE;
    }
    return this.get(rota, consulta, fresh);
  }

  async sessoes(f: Filtros, fresh = false): Promise<{ sessoes: Sessao[]; avisos: string[]; pendentes: number; refs: Referencias }> {
    const cfg = await this.config();
    const avisos: string[] = [];
    const inicio = this.agora();
    const estourou = () => this.o.orcamentoMs != null && this.agora() - inicio > this.o.orcamentoMs;
    let pendentes = 0;
    const { id: org } = await this.organizacao(fresh);
    const brutas = await this.sessoesBrutas(org, f.de, fresh);
    const base = brutas.map((b) => ({ b, s: normalizaSessao(b) })).filter((x): x is { b: unknown; s: Sessao } => !!x.s && !!x.s.dia && x.s.dia >= f.de && x.s.dia <= f.ate);

    // detalhe só de quem a listagem não detalhou (e que pode entrar no filtro)
    let falhaDetalhe = 0;
    const comDetalhe: Sessao[] = [];
    for (const { b, s } of base) {
      const pode = f.escopo === 'tudo' || (s.canalId && cfg.canais.some((c) => c.fixado && c.id === s.canalId));
      const precisa = pode && (!temTotais(b) || (s.tipo === 'Bot' && !s.botId));
      if (!precisa) {
        comDetalhe.push(s);
        continue;
      }
      try {
        const d = await this.getComOrcamento(`/v1/bulk-send-session/${s.id}/`, { organizationId: org }, fresh, estourou);
        if (d === PENDENTE) { pendentes++; comDetalhe.push(s); continue; }
        comDetalhe.push(normalizaSessao(d) ?? s);
      } catch {
        falhaDetalhe++;
        comDetalhe.push(s);
      }
    }
    if (falhaDetalhe) avisos.push(`A rota de detalhe da sessão falhou em ${falhaDetalhe} sessão(ões); esses números aparecem como indisponíveis.`);

    // custo só das sessões que de fato entram no painel
    const alvo = filtrar(cfg, comDetalhe, f);
    const ids = new Set(alvo.map((s) => s.id));
    let falhaCusto = 0;
    let primeiroErro = '';
    const final: Sessao[] = [];
    for (const s of comDetalhe) {
      if (!ids.has(s.id)) {
        final.push(s);
        continue;
      }
      try {
        const c = await this.getComOrcamento(`/v1/bulk-send-session/${s.id}/costs/`, { organizationId: org }, fresh, estourou);
        if (c === PENDENTE) { pendentes++; final.push({ ...s, creditos: { v: null, m: 'Ainda não consultado: o limite de tempo da requisição acabou. A tela continua sozinha.' } }); continue; }
        final.push({ ...s, creditos: normalizaCusto(c) });
      } catch (e) {
        falhaCusto++;
        primeiroErro ||= this.msg(e);
        final.push({ ...s, creditos: { v: null, m: `A rota de custo falhou para esta sessão: ${this.msg(e)}` } });
      }
    }
    if (falhaCusto) avisos.push(`A rota de custo falhou em ${falhaCusto} sessão(ões) (${primeiroErro}). O custo aparece como indisponível nelas.`);
    const refs = await this.referencias(org, brutas, fresh, estourou, () => { pendentes++; });
    if (pendentes) avisos.push(`Carregamento parcial: ${pendentes} consulta(s) à Umbler ainda pendente(s). A tela pede o resto sozinha.`);
    return { sessoes: final, avisos, pendentes, refs };
  }

  /**
   * Base da estimativa: créditos por envio das sessões MAIS RECENTES (de qualquer canal) que têm custo registrado, por tipo.
   * Olha no máximo 40 sessões e para quando acha 5 de cada tipo. Nunca entra no custo real.
   */
  private async referencias(org: string, brutas: unknown[], fresh: boolean, estourou: () => boolean, pendente: () => void): Promise<Referencias> {
    const acum: Record<'Template' | 'Bot', { cred: number; env: number; n: number }> = { Template: { cred: 0, env: 0, n: 0 }, Bot: { cred: 0, env: 0, n: 0 } };
    let vistas = 0;
    for (const b of brutas) {
      if (vistas >= 40 || (acum.Template.n >= 5 && acum.Bot.n >= 5)) break;
      const s0 = normalizaSessao(b);
      if (!s0?.tipo || acum[s0.tipo].n >= 5) continue;
      vistas++;
      try {
        const d = await this.getComOrcamento(`/v1/bulk-send-session/${s0.id}/`, { organizationId: org }, fresh, estourou);
        if (d === PENDENTE) { pendente(); continue; }
        const s = normalizaSessao(d);
        if (!s || !s.enviadas.v) continue;
        const c = await this.getComOrcamento(`/v1/bulk-send-session/${s0.id}/costs/`, { organizationId: org }, fresh, estourou);
        if (c === PENDENTE) { pendente(); continue; }
        const custo = normalizaCusto(c);
        if (custo.v == null || custo.v <= 0) continue;
        const a = acum[s0.tipo];
        a.cred += custo.v; a.env += s.enviadas.v; a.n++;
      } catch { /* sem base desta sessão: segue */ }
    }
    const refs: Referencias = {};
    for (const t of ['Template', 'Bot'] as const) if (acum[t].n > 0 && acum[t].env > 0) refs[t] = { creditosPorEnvio: acum[t].cred / acum[t].env, amostra: acum[t].n };
    return refs;
  }

  async nomesDeCanais(fresh = false): Promise<Map<string, string>> {
    const { id: org } = await this.organizacao(fresh);
    try {
      return new Map(normalizaCanais(await this.get('/v1/channels/', { organizationId: org }, fresh)).map((c) => [c.id, c.nome]));
    } catch {
      return new Map();
    }
  }

  async painel(f: Filtros, fresh = false): Promise<PainelUmbler & { geradoEm: number; chamadas: number; pendentes: number }> {
    const antes = this.chamadas;
    const { sessoes, avisos, pendentes, refs } = await this.sessoes(f, fresh);
    const p = montarPainel(await this.config(), sessoes, await this.nomesDeCanais(fresh), f, refs);
    p.avisos.push(...avisos);
    return { ...p, geradoEm: this.agora(), chamadas: this.chamadas - antes, pendentes };
  }

  /** Resultado mês a mês (um mês = 1º ao último dia, ou até hoje no mês corrente), para comparar setembro, outubro etc. */
  async mensal(escopo: 'marketing' | 'tudo', meses: number, fresh = false): Promise<{ meses: ResumoMes[]; avisos: string[]; pendentes: number; geradoEm: number }> {
    const n = Math.min(Math.max(Math.trunc(meses) || 6, 1), 12);
    const hoje = new Date(this.agora() - 3 * 3_600_000); // dia do Brasil
    const ate = hoje.toISOString().slice(0, 10);
    const ini = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - (n - 1), 1)).toISOString().slice(0, 10);
    const { sessoes, avisos, pendentes, refs } = await this.sessoes({ de: ini, ate, escopo }, fresh);
    const cfg = await this.config();
    const nomes = await this.nomesDeCanais(fresh);
    const out: ResumoMes[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const d0 = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - i, 1));
      const de = d0.toISOString().slice(0, 10);
      const fim = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      const fimReal = fim < ate ? fim : ate;
      const p = montarPainel(cfg, sessoes, nomes, { de, ate: fimReal, escopo }, refs);
      const c = p.cartoes;
      out.push({ mes: de.slice(0, 7), de, ate: fimReal, sessoes: p.sessoes.length, enviadas: c.enviadas, lidas: c.lidas, respondidas: c.respondidas, falhas: c.falhas, creditos: c.custoCreditos, reais: c.custoReais, completudeCusto: p.completude.custo, estimativa: p.estimativa });
    }
    return { meses: out, avisos, pendentes, geradoEm: this.agora() };
  }

  async csv(f: Filtros): Promise<string> {
    const p = await this.painel(f);
    if (p.pendentes) throw new ConfigInvalida('O painel ainda está carregando partes do período. Espere a tela terminar de carregar e exporte de novo.');
    return gerarCsv(p as PainelUmbler);
  }

  /**
   * Onde os contatos páram nos fluxos: percorre as instâncias do fluxo no período e guarda SÓ contagens.
   * O JSON bruto não vai para o cache (traz dados de conversa).
   */
  async passos(botId: string, de: string, ate: string, fresh = false, maxPaginas = 5): Promise<Passos> {
    if (!/^[\w.\-:]{1,100}$/.test(botId)) throw new ConfigInvalida('Fluxo inválido.');
    const chave = `passos:${botId}:${de}:${ate}:${maxPaginas}`;
    if (!fresh) {
      const c = this.o.cache.ler<Passos>(chave);
      if (c) return c.dado;
    }
    const { id: org } = await this.organizacao(fresh);
    // nomes dos passos: o detalhe do fluxo traz tipo e (em alguns) título/mensagem de cada passo
    const rotulos = new Map<string, { rotulo: string; tipo: string | null }>();
    let rotulosOk = false;
    try {
      const det = await this.get(`/v1/bots/${botId}/`, { organizationId: org }, fresh);
      const steps = pick(pick(det, 'bot'), 'steps') ?? pick(det, 'steps');
      for (const st of Array.isArray(steps) ? steps : []) {
        const id = pick(st, 'id');
        if (typeof id !== 'string') continue;
        const tipo = typeof pick(st, '_t') === 'string' ? (pick(st, '_t') as string) : null;
        const titulo = pick(st, 'title', 'triggerName', 'name');
        const msg = pick(st, 'message');
        const base = (tipo && TIPOS_PASSO[tipo]) || (tipo ? tipo.replace(/(ActionModel|StepModel|EventModel|Model)$/, '').replace(/([a-z])([A-Z])/g, '$1 $2') : 'Passo');
        const extra = typeof titulo === 'string' && titulo.trim() ? titulo.trim() : typeof msg === 'string' && msg.trim() ? msg.trim().replace(/\s+/g, ' ') : '';
        rotulos.set(id, { rotulo: extra ? `${base}: ${extra.slice(0, 60)}` : base, tipo });
      }
      rotulosOk = rotulos.size > 0;
    } catch { /* sem nomes: mostra o ID do passo */ }

    const alcancou = new Map<string, number>();
    const parou = new Map<string, number>();
    const posicao = new Map<string, { soma: number; n: number }>();
    const status = new Map<string, number>();
    let lidas = 0;
    let total: number | null = null;
    let completo = false;
    for (let pg = 0; pg < maxPaginas; pg++) {
      this.chamadas++;
      const r = await this.leitor().get('/v1/bots/flowchart/botinstances/', { organizationId: org, botId, startUTC: `${de}T03:00:00Z`, endUTC: `${ate}T23:59:59Z`, Skip: pg * 100, Take: 100, Behavior: pg === 0 ? 'CountAllAndGetSlice' : 'GetSliceOnly' });
      if (pg === 0) {
        const t = pick(pick(r, 'page'), 'totalItems');
        total = typeof t === 'number' ? t : null;
      }
      const it = itensDe(r);
      for (const inst of it) {
        lidas++;
        const nav = pick(inst, 'navigationPath');
        const caminho = (Array.isArray(nav) ? nav : []).map((n) => pick(n, 'stepId')).filter((x): x is string => typeof x === 'string');
        [...new Set(caminho)].forEach((sid) => alcancou.set(sid, (alcancou.get(sid) ?? 0) + 1));
        caminho.forEach((sid, idx) => { const p = posicao.get(sid) ?? { soma: 0, n: 0 }; p.soma += idx; p.n++; posicao.set(sid, p); });
        const ult = caminho[caminho.length - 1] ?? '(sem passo registrado)';
        parou.set(ult, (parou.get(ult) ?? 0) + 1);
        const st = pick(inst, 'status');
        const sk = typeof st === 'string' ? st : '(sem status)';
        status.set(sk, (status.get(sk) ?? 0) + 1);
      }
      if (it.length < 100) {
        completo = true;
        break;
      }
    }
    const ids = new Set([...alcancou.keys(), ...parou.keys()]);
    const out: Passos = {
      lidas, total, completo, rotulosOk,
      porPasso: [...ids].map((sid) => ({ passo: sid, rotulo: rotulos.get(sid)?.rotulo ?? `Passo ${sid.slice(0, 6)}`, tipo: rotulos.get(sid)?.tipo ?? null, alcancaram: alcancou.get(sid) ?? 0, pararam: parou.get(sid) ?? 0, ordem: posicao.has(sid) ? posicao.get(sid)!.soma / posicao.get(sid)!.n : 1e9 }))
        .sort((a, b) => a.ordem - b.ordem),
      porStatus: [...status].map(([st2, n]) => ({ status: st2, n })).sort((a, b) => b.n - a.n),
    };
    this.o.cache.gravar(chave, out);
    return out;
  }
}

function mesclar(fixos: ItemFixado[], vindos: ItemCatalogo[]): ItemTela[] {
  const porId = new Map(fixos.map((x) => [x.id, x]));
  const lista: ItemTela[] = vindos.map((v) => {
    const f = porId.get(v.id);
    return { ...v, fixado: f?.fixado ?? false, alteradoEm: f?.alteradoEm || null, presente: true };
  });
  const vistos = new Set(vindos.map((v) => v.id));
  for (const f of fixos) if (!vistos.has(f.id)) lista.push({ id: f.id, nome: f.nome, extra: 'não retornado agora pela API', fixado: f.fixado, alteradoEm: f.alteradoEm || null, presente: false });
  return lista.sort((a, b) => Number(b.fixado) - Number(a.fixado) || a.nome.localeCompare(b.nome, 'pt-BR'));
}

export { UmblerErro, pertenceAoMarketing };
