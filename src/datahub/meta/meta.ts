/**
 * Cliente da Meta Marketing API (SOMENTE LEITURA) e mapeamento dos relatorios para as tabelas mkt.meta_*.
 * Documentacao consultada em 2026-10-09/13: Insights (level=ad, time_increment=1), versao v26.0 fixada abaixo, cota por conta de anuncios
 * (cabecalho X-Business-Use-Case-Usage), `paging.next` para paginar. O token vai no cabecalho Authorization e NUNCA e impresso; as URLs de
 * paginacao devolvidas pela Meta trazem o token e por isso nunca entram em mensagem de erro nem em log.
 * IDs da Meta (~18 digitos) passam sempre como TEXTO: Number() perderia os ultimos digitos (limite de 2^53).
 */
export const META_VERSAO = 'v26.0';
const BASE = `https://graph.facebook.com/${META_VERSAO}`;

export interface MetaConta { id: string; produto: 'rh' | 'clinic' }
export interface MetaCredenciais { token: string; contas: MetaConta[] }

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(nome: string): string | null };
  json(): Promise<any>;
}>;

export function metaCredenciaisFromEnv(env: Record<string, string | undefined>): MetaCredenciais {
  const token = env.META_ACCESS_TOKEN;
  const contas: MetaConta[] = [];
  for (const [chave, produto] of [['META_AD_ACCOUNT_RH', 'rh'], ['META_AD_ACCOUNT_CLINIC', 'clinic']] as const) {
    const id = env[chave]?.replace(/^act_/, '');
    if (id) contas.push({ id, produto });
  }
  if (!token || !contas.length) throw new Error('Faltam META_ACCESS_TOKEN e/ou META_AD_ACCOUNT_RH / META_AD_ACCOUNT_CLINIC no .env.local');
  return { token, contas };
}

/** Campos de desempenho pedidos por anuncio e dia (os de video nao podem ser pedidos com quebra por hora; aqui nao ha quebra). */
export const CAMPOS_INSIGHTS = [
  'ad_id', 'adset_id', 'campaign_id', 'spend', 'impressions', 'reach', 'clicks', 'inline_link_clicks', 'actions', 'video_play_actions',
  'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions', 'video_p95_watched_actions', 'video_p100_watched_actions',
  'video_thruplay_watched_actions', 'video_avg_time_watched_actions',
].join(',');
/** Sem DELETED: a Meta recusa pedir objetos excluidos nas listas (erro 100/1815001); os apagados que tem desempenho sao buscados pelo ID. */
export const STATUS_TODOS = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PENDING_REVIEW', 'DISAPPROVED', 'PENDING_BILLING_INFO', 'PREAPPROVED'];

/** Erro da Meta sem a URL (a URL de paginacao carrega o token). */
export class MetaErro extends Error {
  constructor(readonly status: number, readonly codigo: number | null, mensagem: string) {
    super(`Meta API (${status}${codigo != null ? `, codigo ${codigo}` : ''}): ${mensagem}`);
    this.name = 'MetaErro';
  }
}

export interface UsoCota { callCount: number; cpu: number; tempo: number; esperaMin: number }
export interface ThrottleInsights { app: number; conta: number; nivel: string | null }

/** Parada por cota: a rodada para (nao espera) e fica parcial; nada do bloco em leitura e gravado. */
export class MetaCotaErro extends Error {
  constructor(readonly motivo: string) {
    super(`Meta: rodada interrompida por cota (${motivo})`);
    this.name = 'MetaCotaErro';
  }
}

/** Limite de parada do protocolo: 75% do consumo da cota. */
export const META_PARAR_EM = 75;
const HOST = 'graph.facebook.com';
/** So https e so graph.facebook.com (sem usuario/porta). */
export function urlPermitida(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && x.hostname === HOST && x.port === '' && x.username === '' && x.password === '';
  } catch {
    return false;
  }
}

/** SOMENTE LEITURA por construcao: a classe so tem `get` (HTTP GET, sem corpo) e `todas`; nao existe metodo de escrita (teste le este arquivo). */
export class MetaClient {
  requisicoes = 0;
  /** Ultimo valor do cabecalho x-fb-ads-insights-throttle (uso do app e da conta nos insights). */
  throttle: ThrottleInsights = { app: 0, conta: 0, nivel: null };
  parada: string | null = null;
  /** O maior uso visto na rodada (so para relatar). */
  usoMaximo: UsoCota = { callCount: 0, cpu: 0, tempo: 0, esperaMin: 0 };
  /** O uso da ULTIMA resposta: e ele que manda esperar (o maximo nunca desce e travaria a rodada para sempre). */
  usoAtual: UsoCota = { callCount: 0, cpu: 0, tempo: 0, esperaMin: 0 };
  constructor(
    private readonly token: string,
    private readonly doFetch: FetchLike = fetch as unknown as FetchLike,
    private readonly espera: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly limiteParada: number = META_PARAR_EM,
  ) {}

  private lerThrottle(cabecalho: string | null) {
    if (!cabecalho) return;
    try {
      const t = JSON.parse(cabecalho) as Record<string, unknown>;
      this.throttle = { app: Number(t.app_id_util_pct ?? 0) || 0, conta: Number(t.acc_id_util_pct ?? 0) || 0, nivel: typeof t.ads_api_access_tier === 'string' ? t.ads_api_access_tier : null };
    } catch {
      /* fora do formato: ignora */
    }
  }

  /** O maior percentual de uso visto na ULTIMA resposta (chamadas, cpu, tempo, throttle de insights do app e da conta). */
  usoPct(): number {
    const u = this.usoAtual;
    return Math.max(u.callCount, u.cpu, u.tempo, this.throttle.app, this.throttle.conta);
  }
  /** O maior percentual visto em toda a rodada (para o cartao). */
  usoMaximoPct = 0;

  private lerUso(cabecalho: string | null) {
    if (!cabecalho) return;
    try {
      this.usoAtual = { callCount: 0, cpu: 0, tempo: 0, esperaMin: 0 };
      for (const lista of Object.values(JSON.parse(cabecalho) as Record<string, Array<Record<string, number>>>)) {
        for (const u of lista) {
          this.usoAtual = {
            callCount: Math.max(this.usoAtual.callCount, u.call_count ?? 0), cpu: Math.max(this.usoAtual.cpu, u.total_cputime ?? 0),
            tempo: Math.max(this.usoAtual.tempo, u.total_time ?? 0), esperaMin: Math.max(this.usoAtual.esperaMin, u.estimated_time_to_regain_access ?? 0),
          };
          this.usoMaximo = {
            callCount: Math.max(this.usoMaximo.callCount, u.call_count ?? 0),
            cpu: Math.max(this.usoMaximo.cpu, u.total_cputime ?? 0),
            tempo: Math.max(this.usoMaximo.tempo, u.total_time ?? 0),
            esperaMin: Math.max(this.usoMaximo.esperaMin, u.estimated_time_to_regain_access ?? 0),
          };
        }
      }
    } catch {
      /* cabecalho fora do formato: ignora */
    }
  }

  /** Uma pagina (URL relativa a versao, ou a URL completa de `paging.next`). Repete em limite de cota e erros temporarios, com espera crescente. */
  async get(caminhoOuUrl: string, params: Record<string, string> = {}): Promise<any> {
    if (this.parada) throw new MetaCotaErro(this.parada);
    // so graph.facebook.com por https: a URL de paginacao vem da resposta e nunca e confiada (ela carrega o token)
    if (/^[a-z][a-z0-9+.-]*:/i.test(caminhoOuUrl) && !urlPermitida(caminhoOuUrl)) throw new MetaErro(0, null, 'URL fora de https://graph.facebook.com recusada');
    if (caminhoOuUrl.startsWith('//')) throw new MetaErro(0, null, 'URL fora de https://graph.facebook.com recusada');
    const url = urlPermitida(caminhoOuUrl) ? caminhoOuUrl : `${BASE}/${caminhoOuUrl}?${new URLSearchParams(params).toString()}`;
    for (let tentativa = 0; ; tentativa++) {
      this.requisicoes++;
      // tempo limite: uma chamada que nao responde nao pode travar a rodada (ja travou por horas); cai na repeticao abaixo
      let r: Awaited<ReturnType<FetchLike>>;
      try {
        r = await this.doFetch(url, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(90_000) });
      } catch {
        if (tentativa >= 5) throw new MetaErro(0, null, 'sem resposta da Meta (tempo esgotado ou rede)');
        await this.espera(5000 * 2 ** tentativa);
        continue;
      }
      this.lerUso(r.headers.get('x-business-use-case-usage'));
      this.lerThrottle(r.headers.get('x-fb-ads-insights-throttle'));
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        // protocolo: ao chegar em 75% da cota o cliente PARA (nao espera e continua); a chamada atual devolve normalmente, a PROXIMA recusa
        const pct = this.usoPct();
        this.usoMaximoPct = Math.max(this.usoMaximoPct, pct);
        if (pct >= this.limiteParada && !this.parada) this.parada = `uso da cota em ${pct}% (limite de parada: ${this.limiteParada}%)`;
        return j;
      }
      const cod = (j?.error?.code as number | undefined) ?? null;
      const limite = r.status === 429 || [4, 17, 32, 613, 80000, 80003, 80004, 80014].includes(cod ?? -1);
      // limite de cota atingido: PARA (protocolo); nao fica esperando nem insistindo
      if (limite) {
        this.parada = `a Meta recusou por limite de cota (HTTP ${r.status}${cod != null ? `, codigo ${cod}` : ''})`;
        throw new MetaCotaErro(this.parada);
      }
      const temporario = r.status >= 500 || cod === 1 || cod === 2; // 1 e 2: erro temporario da Meta
      if (!temporario || tentativa >= 5) throw new MetaErro(r.status, cod, String(j?.error?.message ?? 'sem detalhe').slice(0, 300));
      await this.espera(2000 * 2 ** tentativa);
    }
  }

  /** Todas as linhas de uma lista (segue paging.next). */
  async todas(caminho: string, params: Record<string, string>): Promise<any[]> {
    const out: any[] = [];
    let j = await this.get(caminho, { limit: '500', ...params });
    for (;;) {
      out.push(...(j.data ?? []));
      if (!j.paging?.next) return out;
      j = await this.get(String(j.paging.next)); // get() recusa qualquer host que nao seja graph.facebook.com
    }
  }
}

/* ---------- mapeamento ---------- */
const reais = (v: unknown): number | null => (v == null || v === '' ? null : Math.round(Number(v)) / 100); // a Meta devolve orcamento em centavos
const inteiro = (v: unknown): number => Math.round(Number(v ?? 0)) || 0;
const dec2 = (v: unknown): number => Math.round((Number(v ?? 0) || 0) * 100) / 100;
const data = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const id = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
/** Chave de nome para ligar por NOME (igual a mkt.chave_nome_meta no banco): minusculas e sem nenhum espaco. */
export const chaveNomeMeta = (t: string | null | undefined): string | null => (t ? t.toLowerCase().replace(/\s+/g, '') || null : null);

export interface Campanha { campanha_id: string; conta_id: string; nome: string | null; nome_chave: string | null; objetivo: string | null; status: string | null; orcamento_diario: number | null; orcamento_total: number | null; criada_em: string | null; atualizada_em: string | null }
export interface Conjunto { conjunto_id: string; campanha_id: string | null; conta_id: string; nome: string | null; nome_chave: string | null; status: string | null; otimizacao: string | null; orcamento_diario: number | null; orcamento_total: number | null; criado_em: string | null; atualizado_em: string | null }
export interface Anuncio { anuncio_id: string; conjunto_id: string | null; campanha_id: string | null; conta_id: string; nome: string | null; nome_chave: string | null; status: string | null; criativo_id: string | null; criativo_nome: string | null; url_tags: string | null; criado_em: string | null; atualizado_em: string | null }

export const mapCampanha = (r: any, conta: string): Campanha => ({
  campanha_id: String(r.id), conta_id: conta, nome: r.name ?? null, nome_chave: chaveNomeMeta(r.name), objetivo: r.objective ?? null, status: r.effective_status ?? r.status ?? null,
  orcamento_diario: reais(r.daily_budget), orcamento_total: reais(r.lifetime_budget), criada_em: data(r.created_time), atualizada_em: data(r.updated_time),
});
export const mapConjunto = (r: any, conta: string): Conjunto => ({
  conjunto_id: String(r.id), campanha_id: id(r.campaign_id), conta_id: conta, nome: r.name ?? null, nome_chave: chaveNomeMeta(r.name), status: r.effective_status ?? r.status ?? null,
  otimizacao: r.optimization_goal ?? null, orcamento_diario: reais(r.daily_budget), orcamento_total: reais(r.lifetime_budget), criado_em: data(r.created_time), atualizado_em: data(r.updated_time),
});
export const mapAnuncio = (r: any, conta: string): Anuncio => ({
  anuncio_id: String(r.id), conjunto_id: id(r.adset_id), campanha_id: id(r.campaign_id), conta_id: conta, nome: r.name ?? null, nome_chave: chaveNomeMeta(r.name),
  status: r.effective_status ?? r.status ?? null, criativo_id: id(r.creative?.id), criativo_nome: r.creative?.name ?? null, url_tags: r.creative?.url_tags ?? null,
  criado_em: data(r.created_time), atualizado_em: data(r.updated_time),
});

export interface AdDia {
  anuncio_id: string; dia: string; conta_id: string; conjunto_id: string | null; campanha_id: string | null;
  gasto: number; impressoes: number; alcance: number; cliques: number; cliques_link: number; visitas_pagina: number; leads_meta: number;
  video_reproducoes: number; video_3s: number; video_p25: number; video_p50: number; video_p75: number; video_p95: number; video_p100: number; video_thruplay: number;
  video_tempo_medio: number | null;
}
/** Soma os valores de uma lista de acoes da Meta ([{action_type, value}]), ou so do tipo pedido. */
function acao(lista: any, tipo?: string): number {
  if (!Array.isArray(lista)) return 0;
  return lista.filter((a) => (tipo ? a.action_type === tipo : true)).reduce((s, a) => s + inteiro(a.value), 0);
}
export function mapAdDia(r: any, conta: string): AdDia {
  const tempo = Array.isArray(r.video_avg_time_watched_actions) ? r.video_avg_time_watched_actions[0]?.value : undefined;
  return {
    anuncio_id: String(r.ad_id), dia: String(r.date_start), conta_id: conta, conjunto_id: id(r.adset_id), campanha_id: id(r.campaign_id),
    gasto: dec2(r.spend), impressoes: inteiro(r.impressions), alcance: inteiro(r.reach), cliques: inteiro(r.clicks), cliques_link: inteiro(r.inline_link_clicks),
    visitas_pagina: acao(r.actions, 'landing_page_view'), leads_meta: acao(r.actions, 'lead'),
    video_reproducoes: acao(r.video_play_actions), video_3s: acao(r.actions, 'video_view'),
    video_p25: acao(r.video_p25_watched_actions), video_p50: acao(r.video_p50_watched_actions), video_p75: acao(r.video_p75_watched_actions),
    video_p95: acao(r.video_p95_watched_actions), video_p100: acao(r.video_p100_watched_actions), video_thruplay: acao(r.video_thruplay_watched_actions),
    video_tempo_medio: tempo == null ? null : dec2(tempo),
  };
}
/** Linhas sem gasto, impressoes nem cliques nao sao guardadas (economia de espaco). */
export const temAtividade = (a: AdDia) => a.gasto > 0 || a.impressoes > 0 || a.cliques > 0;

/* ---------- consultas ---------- */
const filtroStatus = () => JSON.stringify(STATUS_TODOS);
export async function lerEstrutura(c: MetaClient, conta: MetaConta) {
  const act = `act_${conta.id}`;
  const comuns = { effective_status: filtroStatus() };
  const [campanhas, conjuntos, anuncios, info] = await Promise.all([
    c.todas(`${act}/campaigns`, { ...comuns, fields: 'id,name,objective,effective_status,daily_budget,lifetime_budget,created_time,updated_time' }),
    c.todas(`${act}/adsets`, { ...comuns, fields: 'id,name,campaign_id,effective_status,optimization_goal,daily_budget,lifetime_budget,created_time,updated_time' }),
    c.todas(`${act}/ads`, { ...comuns, fields: 'id,name,adset_id,campaign_id,effective_status,created_time,updated_time,creative{id,name,url_tags}' }),
    c.get(act, { fields: 'name,currency,timezone_name' }),
  ]);
  return {
    conta: { conta_id: conta.id, produto: conta.produto, nome: info.name ?? null, moeda: info.currency ?? null, fuso: info.timezone_name ?? null },
    campanhas: campanhas.map((r) => mapCampanha(r, conta.id)),
    conjuntos: conjuntos.map((r) => mapConjunto(r, conta.id)),
    anuncios: anuncios.map((r) => mapAnuncio(r, conta.id)),
  };
}
export async function lerInsights(c: MetaClient, conta: MetaConta, inicio: string, fim: string): Promise<AdDia[]> {
  const linhas = await c.todas(`act_${conta.id}/insights`, {
    // paginas de 100 linhas: com 500 por pagina a Meta devolveu erro 500 (codigo 1, "reduza a quantidade de dados") em meses grandes da conta QuarkClinic
    level: 'ad', time_increment: '1', fields: CAMPOS_INSIGHTS, limit: '100', time_range: JSON.stringify({ since: inicio, until: fim }),
  });
  return linhas.map((r) => mapAdDia(r, conta.id)).filter(temAtividade);
}
