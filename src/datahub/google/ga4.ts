/**
 * Cliente do GA4 Data API (SOMENTE LEITURA) e mapeamento dos relatorios para as tabelas mkt.ga4_*.
 * Autenticacao: conta de servico (JWT RS256 assinado com node:crypto, sem biblioteca), escopo analytics.readonly.
 * Documentacao consultada em 2026-10-08: runReport (limit maximo 250.000 linhas por pagina, paginacao por offset), cotas por propriedade
 * (200 mil tokens/dia, 40 mil/hora, 10 requisicoes simultaneas), nomes de dimensoes/metricas confirmados no getMetadata da propriedade.
 */
import { createSign } from 'node:crypto';

export interface Ga4Credentials {
  clientEmail: string;
  privateKey: string;
  propertyId: string;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
}>;

export interface ReportRequest {
  dateRanges: Array<{ startDate: string; endDate: string }>;
  dimensions: Array<{ name: string }>;
  metrics: Array<{ name: string }>;
  dimensionFilter?: unknown;
  limit?: number;
  offset?: number;
  returnPropertyQuota?: boolean;
}
export interface ReportRow {
  dimensionValues: Array<{ value: string }>;
  metricValues: Array<{ value: string }>;
}
export interface ReportPage {
  rows?: ReportRow[];
  rowCount?: number;
  propertyQuota?: unknown;
}

export const PAGE_SIZE = 100_000;
export const SEM_PAGINA = '(sem pagina)';
export const SEM_HOST = '(sem host)';
/** Eventos automaticos e de alto volume: ja estao em sessoes/paginas, entao NAO sao gravados em mkt.ga4_eventos_dia (economia de espaco). */
export const EVENTOS_FORA = ['page_view', 'session_start', 'first_visit', 'user_engagement', 'scroll', 'click'] as const;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Le as credenciais do ambiente; a chave privada fica em uma linha com \n escapado (JSON). */
export function ga4CredentialsFromEnv(env: Record<string, string | undefined>): Ga4Credentials {
  const clientEmail = env.GOOGLE_SA_CLIENT_EMAIL;
  const raw = env.GOOGLE_SA_PRIVATE_KEY;
  const propertyId = env.GA4_PROPERTY_ID;
  if (!clientEmail || !raw || !propertyId) throw new Error('Faltam GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_PRIVATE_KEY ou GA4_PROPERTY_ID no .env.local');
  const privateKey = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw.replace(/\\n/g, '\n');
  return { clientEmail, privateKey, propertyId };
}

export class Ga4Client {
  private token: { value: string; expira: number } | null = null;
  requisicoes = 0;
  constructor(
    private readonly cred: Ga4Credentials,
    private readonly doFetch: FetchLike = fetch as unknown as FetchLike,
    private readonly espera: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get propertyId(): string {
    return this.cred.propertyId;
  }

  private async accessToken(): Promise<string> {
    const agora = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expira - 60 > agora) return this.token.value;
    const corpo = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: this.cred.clientEmail,
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: agora,
      exp: agora + 3600,
    })}`;
    const assinatura = createSign('RSA-SHA256').update(corpo).sign(this.cred.privateKey, 'base64url');
    const r = await this.doFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${corpo}.${assinatura}` }).toString(),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Falha ao autenticar no Google: ${j.error ?? r.status} ${j.error_description ?? ''}`.trim());
    this.token = { value: j.access_token as string, expira: agora + Number(j.expires_in ?? 3600) };
    return this.token.value;
  }

  /** Uma pagina de relatorio, com novas tentativas em 429 e 5xx (espera crescente). */
  async runReport(req: ReportRequest): Promise<ReportPage> {
    const url = `https://analyticsdata.googleapis.com/v1beta/properties/${this.cred.propertyId}:runReport`;
    for (let tentativa = 0; ; tentativa++) {
      const token = await this.accessToken();
      this.requisicoes++;
      const r = await this.doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(req),
      });
      const j = await r.json();
      if (r.ok) return j as ReportPage;
      const temporario = r.status === 429 || r.status >= 500;
      if (!temporario || tentativa >= 4) throw new Error(`GA4 runReport falhou (${r.status}): ${j?.error?.status ?? ''} ${j?.error?.message ?? ''}`.trim());
      await this.espera(2000 * 2 ** tentativa);
    }
  }

  /** Todas as linhas de um relatorio (pagina por pagina). */
  async runReportAll(req: ReportRequest): Promise<ReportRow[]> {
    const todas: ReportRow[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const p = await this.runReport({ ...req, limit: PAGE_SIZE, offset });
      todas.push(...(p.rows ?? []));
      if (!p.rows || p.rows.length < PAGE_SIZE) return todas;
    }
  }
}

/* ---------- relatorios e mapeamento ---------- */
export type Ga4Entidade = 'ga4_dia' | 'ga4_sessoes' | 'ga4_eventos' | 'ga4_paginas' | 'ga4_ads';
export const GA4_ENTIDADES: readonly Ga4Entidade[] = ['ga4_dia', 'ga4_sessoes', 'ga4_eventos', 'ga4_paginas', 'ga4_ads'];

export function relatorio(entidade: Ga4Entidade, inicio: string, fim: string): ReportRequest {
  const dateRanges = [{ startDate: inicio, endDate: fim }];
  if (entidade === 'ga4_ads') {
    // custo do Google Ads que o GA4 importa (conta vinculada). As métricas advertiser* só combinam com dimensões de campanha.
    return {
      dateRanges,
      dimensions: ['date', 'sessionGoogleAdsCampaignId', 'sessionGoogleAdsCampaignName'].map((name) => ({ name })),
      metrics: ['advertiserAdCost', 'advertiserAdClicks', 'advertiserAdImpressions'].map((name) => ({ name })),
    };
  }
  if (entidade === 'ga4_dia') {
    // total do dia, sem outras dimensoes: usuarios ativos NAO se somam entre paginas nem entre dias, por isso a consulta propria
    return { dateRanges, dimensions: [{ name: 'date' }], metrics: ['sessions', 'activeUsers', 'newUsers', 'engagedSessions', 'screenPageViews'].map((name) => ({ name })) };
  }
  if (entidade === 'ga4_sessoes') {
    return {
      dateRanges,
      dimensions: ['date', 'hostName', 'landingPage', 'sessionSource', 'sessionMedium', 'sessionCampaignName', 'sessionCampaignId', 'sessionGoogleAdsCampaignId'].map((name) => ({ name })),
      metrics: ['sessions', 'newUsers', 'engagedSessions', 'screenPageViews'].map((name) => ({ name })),
    };
  }
  if (entidade === 'ga4_eventos') {
    return {
      dateRanges,
      dimensions: ['date', 'hostName', 'pagePath', 'eventName'].map((name) => ({ name })),
      metrics: ['eventCount', 'totalUsers'].map((name) => ({ name })),
      dimensionFilter: { notExpression: { filter: { fieldName: 'eventName', inListFilter: { values: [...EVENTOS_FORA] } } } },
    };
  }
  return {
    dateRanges,
    dimensions: ['date', 'hostName', 'pagePath'].map((name) => ({ name })),
    metrics: ['screenPageViews', 'activeUsers'].map((name) => ({ name })),
  };
}

/** GA4 devolve a data como AAAAMMDD. */
export function dataGa4(v: string): string {
  if (!/^\d{8}$/.test(v)) throw new Error(`Data inesperada do GA4: ${v}`);
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}
const pagina = (v: string) => (!v || v === '(not set)' ? SEM_PAGINA : v);
const host = (v: string) => (!v || v === '(not set)' ? SEM_HOST : v);
const num = (v: string | undefined) => Math.round(Number(v ?? 0)) || 0;
const semNaoDefinido = (v: string) => (v === '(not set)' ? '' : v);

export interface SessaoDia {
  dia: string; host: string; landing_page: string; fonte: string; midia: string; campanha: string;
  campanha_id: string | null; gads_campanha_id: string | null;
  sessoes: number; usuarios_novos: number; sessoes_engajadas: number; visualizacoes: number;
}
export interface EventoDia { dia: string; host: string; pagina: string; evento: string; eventos: number; usuarios: number }
export interface PaginaDia { dia: string; host: string; pagina: string; visualizacoes: number; usuarios_ativos: number }

/** Junta linhas que ficam com a mesma chave depois da normalizacao (ex.: "(not set)" e vazio), somando os numeros. */
function juntar<T extends object>(linhas: T[], chave: (l: T) => string, somar: (a: T, b: T) => void): T[] {
  const m = new Map<string, T>();
  for (const l of linhas) {
    const k = chave(l);
    const atual = m.get(k);
    if (atual) somar(atual, l);
    else m.set(k, { ...l });
  }
  return [...m.values()];
}

export function mapSessoes(rows: ReportRow[]): SessaoDia[] {
  const l = rows.map((r) => {
    const d = r.dimensionValues.map((x) => x.value);
    const m = r.metricValues.map((x) => num(x.value));
    return {
      dia: dataGa4(d[0]!), host: host(d[1]!), landing_page: pagina(d[2]!),
      fonte: d[3]!, midia: d[4]!, campanha: semNaoDefinido(d[5]!),
      campanha_id: semNaoDefinido(d[6]!) || null, gads_campanha_id: semNaoDefinido(d[7]!) || null,
      sessoes: m[0]!, usuarios_novos: m[1]!, sessoes_engajadas: m[2]!, visualizacoes: m[3]!,
    } satisfies SessaoDia;
  });
  return juntar(l, (x) => [x.dia, x.host, x.landing_page, x.fonte, x.midia, x.campanha].join('\u0001'), (a, b) => {
    a.sessoes += b.sessoes; a.usuarios_novos += b.usuarios_novos; a.sessoes_engajadas += b.sessoes_engajadas; a.visualizacoes += b.visualizacoes;
    a.campanha_id ||= b.campanha_id; a.gads_campanha_id ||= b.gads_campanha_id;
  });
}

export function mapEventos(rows: ReportRow[]): EventoDia[] {
  const l = rows.map((r) => {
    const d = r.dimensionValues.map((x) => x.value);
    const m = r.metricValues.map((x) => num(x.value));
    return { dia: dataGa4(d[0]!), host: host(d[1]!), pagina: pagina(d[2]!), evento: d[3]!, eventos: m[0]!, usuarios: m[1]! } satisfies EventoDia;
  });
  return juntar(l, (x) => [x.dia, x.host, x.pagina, x.evento].join('\u0001'), (a, b) => { a.eventos += b.eventos; a.usuarios += b.usuarios; });
}

export function mapPaginas(rows: ReportRow[]): PaginaDia[] {
  const l = rows.map((r) => {
    const d = r.dimensionValues.map((x) => x.value);
    const m = r.metricValues.map((x) => num(x.value));
    return { dia: dataGa4(d[0]!), host: host(d[1]!), pagina: pagina(d[2]!), visualizacoes: m[0]!, usuarios_ativos: m[1]! } satisfies PaginaDia;
  });
  return juntar(l, (x) => [x.dia, x.host, x.pagina].join('\u0001'), (a, b) => { a.visualizacoes += b.visualizacoes; a.usuarios_ativos += b.usuarios_ativos; });
}

export interface AdsDia { dia: string; campanha_id: string; campanha: string; custo: number; cliques: number; impressoes: number }

/** Custo por campanha e dia. Linhas zeradas (sem custo, cliques nem impressões) não são guardadas: economia de espaço. */
export function mapAds(rows: ReportRow[]): AdsDia[] {
  const l = rows.map((r) => {
    const d = r.dimensionValues.map((x) => x.value);
    const m = r.metricValues.map((x) => Number(x.value) || 0);
    return { dia: dataGa4(d[0]!), campanha_id: semNaoDefinido(d[1]!), campanha: semNaoDefinido(d[2]!), custo: Math.round(m[0]! * 100) / 100, cliques: Math.round(m[1]!), impressoes: Math.round(m[2]!) } satisfies AdsDia;
  });
  return juntar(l, (x) => [x.dia, x.campanha_id, x.campanha].join('\u0001'), (a, b) => {
    a.custo = Math.round((a.custo + b.custo) * 100) / 100; a.cliques += b.cliques; a.impressoes += b.impressoes;
  }).filter((x) => x.custo > 0 || x.cliques > 0 || x.impressoes > 0);
}

export interface TotalDia { dia: string; sessoes: number; usuarios_ativos: number; usuarios_novos: number; sessoes_engajadas: number; visualizacoes: number }

export function mapDia(rows: ReportRow[]): TotalDia[] {
  const l = rows.map((r) => {
    const m = r.metricValues.map((x) => num(x.value));
    return { dia: dataGa4(r.dimensionValues[0]!.value), sessoes: m[0]!, usuarios_ativos: m[1]!, usuarios_novos: m[2]!, sessoes_engajadas: m[3]!, visualizacoes: m[4]! } satisfies TotalDia;
  });
  return juntar(l, (x) => x.dia, (a, b) => {
    a.sessoes += b.sessoes; a.usuarios_ativos += b.usuarios_ativos; a.usuarios_novos += b.usuarios_novos; a.sessoes_engajadas += b.sessoes_engajadas; a.visualizacoes += b.visualizacoes;
  });
}

/** Datas AAAA-MM-DD em blocos de ate `dias` dias (o relatorio de um intervalo grande e dividido para caber na memoria e retomar). */
export function blocosDeDatas(inicio: string, fim: string, dias: number): Array<{ inicio: string; fim: string }> {
  const out: Array<{ inicio: string; fim: string }> = [];
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  for (let c = d(inicio); c <= d(fim); ) {
    const f = new Date(Math.min(c.getTime() + (dias - 1) * 86_400_000, d(fim).getTime()));
    out.push({ inicio: iso(c), fim: iso(f) });
    c = new Date(f.getTime() + 86_400_000);
  }
  return out;
}
