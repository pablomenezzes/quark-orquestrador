/**
 * Serviço do painel Umbler: junta cliente (somente leitura), cache de 15 min, configuração em JSON e agregações.
 * Nada é gravado no banco nem no Pipedrive; a única escrita é o arquivo de configuração e o cache local.
 */
import { UmblerErro, ocultarToken, type Consulta } from './cliente.js';
import { CacheUmbler } from './cache.js';
import {
  ConfigInvalida, acrescentarPreco, definirAmostra, definirFixado, definirOrganizacao, lerConfig, pertenceAoMarketing, salvarConfig,
  TIPOS_ITEM, type ConfigUmbler, type ItemFixado, type TipoItem,
} from './config.js';
import {
  diaBR, itensDe, normalizaBots, normalizaCanais, normalizaCusto, normalizaEtiquetas, normalizaOrganizacoes, normalizaSessao, normalizaSetores, pick, temTotais,
  type ItemCatalogo, type Sessao,
} from './normaliza.js';
import { filtrar, gerarCsv, montarPainel, type Filtros, type PainelUmbler } from './painel.js';

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

export type Passos = { lidas: number; total: number | null; porPasso: { passo: string; n: number }[]; porStatus: { status: string; n: number }[]; completo: boolean };

const TAKE = 100; // a API aceita até 250 por página
const MAX_PAGINAS = 200;

export class ServicoUmbler {
  /** Última contagem de GETs feita por este serviço (para a conferência real). */
  chamadas = 0;

  constructor(
    private readonly o: {
      leitor: Leitor | null;
      cache: CacheUmbler;
      configPath: string;
      token?: string;
      agora?: () => number;
    },
  ) {}

  private agora = () => (this.o.agora ?? Date.now)();

  configurado(): { ok: boolean; motivo: string | null } {
    return this.o.leitor ? { ok: true, motivo: null } : { ok: false, motivo: 'Falta UMBLER_TOKEN no .env.local. O painel só lê da Umbler; sem o token não há dados.' };
  }

  config(): ConfigUmbler {
    return lerConfig(this.o.configPath);
  }

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
    const cfg = this.config();
    if (cfg.organizacaoId) return { id: cfg.organizacaoId, todas };
    if (todas.length === 1) return { id: todas[0]!.id, todas };
    throw new OrganizacaoPendente(todas);
  }

  /* ---------- catálogo para a Configuração ---------- */
  async catalogo(fresh = false): Promise<Catalogo> {
    const cfg = this.config();
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
  private grava(c: ConfigUmbler): ConfigUmbler {
    salvarConfig(this.o.configPath, c);
    return c;
  }
  fixar(tipo: unknown, id: unknown, nome: unknown, fixado: unknown): ConfigUmbler {
    if (!(TIPOS_ITEM as readonly unknown[]).includes(tipo)) throw new ConfigInvalida('Tipo de item inválido.');
    if (typeof id !== 'string' || typeof fixado !== 'boolean') throw new ConfigInvalida('Dados inválidos.');
    return this.grava(definirFixado(this.config(), tipo as TipoItem, id, typeof nome === 'string' ? nome : id, fixado, new Date(this.agora())));
  }
  preco(desde: unknown, preco: unknown): ConfigUmbler {
    return this.grava(acrescentarPreco(this.config(), desde, preco, new Date(this.agora())));
  }
  amostra(valor: unknown): ConfigUmbler {
    return this.grava(definirAmostra(this.config(), valor, new Date(this.agora())));
  }
  escolherOrganizacao(id: unknown): ConfigUmbler {
    if (typeof id !== 'string') throw new ConfigInvalida('Organização inválida.');
    return this.grava(definirOrganizacao(this.config(), id, new Date(this.agora())));
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

  async sessoes(f: Filtros, fresh = false): Promise<{ sessoes: Sessao[]; avisos: string[] }> {
    const cfg = this.config();
    const avisos: string[] = [];
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
        comDetalhe.push(normalizaSessao(await this.get(`/v1/bulk-send-session/${s.id}/`, { organizationId: org }, fresh)) ?? s);
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
        final.push({ ...s, creditos: normalizaCusto(await this.get(`/v1/bulk-send-session/${s.id}/costs/`, { organizationId: org }, fresh)) });
      } catch (e) {
        falhaCusto++;
        primeiroErro ||= this.msg(e);
        final.push({ ...s, creditos: { v: null, m: `A rota de custo falhou para esta sessão: ${this.msg(e)}` } });
      }
    }
    if (falhaCusto) avisos.push(`A rota de custo falhou em ${falhaCusto} sessão(ões) (${primeiroErro}). O custo aparece como indisponível nelas.`);
    return { sessoes: final, avisos };
  }

  async nomesDeCanais(fresh = false): Promise<Map<string, string>> {
    const { id: org } = await this.organizacao(fresh);
    try {
      return new Map(normalizaCanais(await this.get('/v1/channels/', { organizationId: org }, fresh)).map((c) => [c.id, c.nome]));
    } catch {
      return new Map();
    }
  }

  async painel(f: Filtros, fresh = false): Promise<PainelUmbler & { geradoEm: number; chamadas: number }> {
    const antes = this.chamadas;
    const { sessoes, avisos } = await this.sessoes(f, fresh);
    const p = montarPainel(this.config(), sessoes, await this.nomesDeCanais(fresh), f);
    p.avisos.push(...avisos);
    return { ...p, geradoEm: this.agora(), chamadas: this.chamadas - antes };
  }

  async csv(f: Filtros): Promise<string> {
    return gerarCsv((await this.painel(f)) as PainelUmbler);
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
    const passos = new Map<string, number>();
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
        const ultimo = Array.isArray(nav) && nav.length ? nav[nav.length - 1] : null;
        const sid = ultimo ? pick(ultimo, 'stepId') : null;
        const k = typeof sid === 'string' ? sid : '(sem passo registrado)';
        passos.set(k, (passos.get(k) ?? 0) + 1);
        const st = pick(inst, 'status');
        const sk = typeof st === 'string' ? st : '(sem status)';
        status.set(sk, (status.get(sk) ?? 0) + 1);
      }
      if (it.length < 100) {
        completo = true;
        break;
      }
    }
    const out: Passos = {
      lidas, total, completo,
      porPasso: [...passos].map(([passo, n]) => ({ passo, n })).sort((a, b) => b.n - a.n),
      porStatus: [...status].map(([s, n]) => ({ status: s, n })).sort((a, b) => b.n - a.n),
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
