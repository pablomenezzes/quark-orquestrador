/**
 * Cliente do Google Search Console (Search Analytics, SOMENTE LEITURA) e mapeamento para mkt.gsc_*.
 * Autenticacao: a mesma conta de servico do GA4 (GOOGLE_SA_*), com o escopo webmasters.readonly. A conta de servico precisa ser adicionada
 * como usuario (permissao "Restrita" basta) em cada propriedade do Search Console.
 * O GSC guarda ~16 meses, entrega o dado FINAL com 2 a 3 dias de atraso e devolve ate 25.000 linhas por pagina (paginacao por startRow).
 */
import { createSign } from 'node:crypto';
import type { FetchLike, Ga4Credentials, MarcaGa4 } from './ga4.js';

export interface GscSite { marca: MarcaGa4; siteUrl: string }

/**
 * Propriedades do Search Console de cada marca. Cada variavel aceita UMA ou VARIAS, separadas por ";" (ou ","): "sc-domain:quarkrh.com.br" (dominio)
 * ou "https://www.quarkrh.com.br/" (prefixo de URL, com a barra no fim). Prefixo que ja esta dentro de uma propriedade de dominio da mesma lista
 * (ex.: https://www.quarkrh.com.br/ dentro de sc-domain:quarkrh.com.br) e ignorado: seria o mesmo dado lido duas vezes.
 */
export function gscSitesFromEnv(env: Record<string, string | undefined>): GscSite[] {
  const ids: Array<[MarcaGa4, string | undefined]> = [['rh', env.GSC_SITE_URL], ['clinic', env.GSC_SITE_URL_CLINIC]];
  const out: GscSite[] = [];
  for (const [marca, v] of ids) {
    const lista = (v ?? '').split(/[;,\s]+/).filter(Boolean);
    for (const siteUrl of lista) {
      if (!/^(sc-domain:[a-z0-9.-]+|https?:\/\/\S+\/)$/i.test(siteUrl)) throw new Error(`GSC (${marca}): "${siteUrl}" invalido. Use "sc-domain:dominio.com.br" ou a URL com https:// terminando em "/".`);
    }
    const dominios = lista.filter((x) => x.startsWith('sc-domain:')).map((x) => x.slice(10).toLowerCase());
    const cobre = (x: string) => {
      if (x.startsWith('sc-domain:')) return false;
      const h = new URL(x).hostname.toLowerCase();
      return dominios.some((d) => h === d || h.endsWith(`.${d}`));
    };
    for (const siteUrl of [...new Set(lista)]) if (!cobre(siteUrl)) out.push({ marca, siteUrl });
  }
  return out;
}

export type GscEntidade = 'gsc_pagina' | 'gsc_consulta';
export const GSC_ENTIDADES: readonly GscEntidade[] = ['gsc_pagina', 'gsc_consulta'];
export const GSC_PAGE_SIZE = 25_000;
/** O dado final do GSC chega com 2 a 3 dias de atraso: o ultimo dia lido e (hoje - ATRASO_DIAS) e os ultimos dias sao relidos a cada rodada. */
export const ATRASO_DIAS = 3;
export const REVISAO_DIAS = 5;
export const BLOCO_DIAS = 31;
/**
 * Consultas sao guardadas AGREGADAS POR MES (uma linha por pagina, consulta e mes; `dia` = primeiro dia do mes): por dia eram 1,9 milhao de linhas
 * e 700 MB e o banco entrou em modo somente leitura (2026-10-28). So entram consultas com MIN_IMPRESSOES_CONSULTA ou mais impressoes no mes, ou algum clique.
 */
export const MIN_IMPRESSOES_CONSULTA = 10;
/** Consulta ou caminho gigante (texto colado, spam) estoura o limite do indice do banco (~2.700 bytes) e nao serve para SEO: fica de fora. */
export const MAX_CONSULTA = 300;
export const MAX_PAGINA = 800;

export interface GscRow { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }
export interface GscRequest { startDate: string; endDate: string; dimensions: string[]; rowLimit: number; startRow: number; dataState: 'final' | 'all'; type: 'web' }

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export class GscClient {
  private token: { value: string; expira: number } | null = null;
  requisicoes = 0;
  constructor(
    private readonly cred: Pick<Ga4Credentials, 'clientEmail' | 'privateKey'>,
    readonly siteUrl: string,
    private readonly doFetch: FetchLike = fetch as unknown as FetchLike,
    private readonly espera: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async accessToken(): Promise<string> {
    const agora = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expira - 60 > agora) return this.token.value;
    const corpo = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: this.cred.clientEmail, scope: 'https://www.googleapis.com/auth/webmasters.readonly', aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600 })}`;
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

  /** Uma pagina, com novas tentativas em 429 e 5xx (espera crescente). */
  async query(req: GscRequest): Promise<GscRow[]> {
    const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(this.siteUrl)}/searchAnalytics/query`;
    for (let tentativa = 0; ; tentativa++) {
      const token = await this.accessToken();
      this.requisicoes++;
      const r = await this.doFetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(req) });
      const j = await r.json();
      if (r.ok) return (j.rows ?? []) as GscRow[];
      const temporario = r.status === 429 || r.status >= 500;
      if (!temporario || tentativa >= 4) throw new Error(`Search Console falhou (${r.status}): ${j?.error?.status ?? ''} ${j?.error?.message ?? ''}`.trim());
      await this.espera(2000 * 2 ** tentativa);
    }
  }

  async queryAll(req: Omit<GscRequest, 'rowLimit' | 'startRow'>): Promise<GscRow[]> {
    const todas: GscRow[] = [];
    for (let startRow = 0; ; startRow += GSC_PAGE_SIZE) {
      const rows = await this.query({ ...req, rowLimit: GSC_PAGE_SIZE, startRow });
      todas.push(...rows);
      if (rows.length < GSC_PAGE_SIZE) return todas;
    }
  }
}

export function relatorioGsc(entidade: GscEntidade, inicio: string, fim: string): Omit<GscRequest, 'rowLimit' | 'startRow'> {
  return { startDate: inicio, endDate: fim, dimensions: entidade === 'gsc_pagina' ? ['date', 'page'] : ['page', 'query'], dataState: 'final', type: 'web' };
}

/** Separa a URL em host e caminho (sem parametros nem #): e a mesma chave que o GA4 usa (hostName + pagePath). */
export function hostECaminho(url: string): { host: string; pagina: string } {
  try {
    const u = new URL(url);
    return { host: u.hostname, pagina: u.pathname || '/' };
  } catch {
    return { host: '(sem host)', pagina: url };
  }
}

export interface GscPaginaDia { dia: string; host: string; pagina: string; cliques: number; impressoes: number; pos_x_imp: number }
export interface GscConsultaDia extends GscPaginaDia { consulta: string }

const arred = (n: number) => Math.round(n * 100) / 100;

/** Linhas que caem na mesma chave depois de tirar parametros da URL (?a=1 e ?a=2) se somam; a posicao fica ponderada pelas impressoes. */
function somar<T extends GscPaginaDia>(linhas: T[], chave: (l: T) => string): T[] {
  const m = new Map<string, T>();
  for (const l of linhas) {
    const k = chave(l);
    const a = m.get(k);
    if (a) {
      a.cliques += l.cliques;
      a.impressoes += l.impressoes;
      a.pos_x_imp = arred(a.pos_x_imp + l.pos_x_imp);
    } else m.set(k, { ...l });
  }
  return [...m.values()];
}

export function mapGscPaginas(rows: GscRow[]): GscPaginaDia[] {
  const l = rows.filter((r) => r.keys[1]!.length <= MAX_PAGINA).map((r) => ({ dia: r.keys[0]!, ...hostECaminho(r.keys[1]!), cliques: Math.round(r.clicks), impressoes: Math.round(r.impressions), pos_x_imp: arred(r.position * r.impressions) }));
  return somar(l, (x) => [x.dia, x.host, x.pagina].join('\u0001'));
}

/** `mes` = primeiro dia do mes lido (AAAA-MM-01). As linhas vem do GSC sem a dimensao de data: chaves = [pagina, consulta]. */
export function mapGscConsultas(rows: GscRow[], mes: string): GscConsultaDia[] {
  const l = rows
    .filter((r) => r.impressions >= MIN_IMPRESSOES_CONSULTA || r.clicks > 0)
    .filter((r) => r.keys[1]!.length <= MAX_CONSULTA && r.keys[0]!.length <= MAX_PAGINA)
    .map((r) => ({ dia: mes, ...hostECaminho(r.keys[0]!), consulta: r.keys[1]!, cliques: Math.round(r.clicks), impressoes: Math.round(r.impressions), pos_x_imp: arred(r.position * r.impressions) }));
  return somar(l, (x) => [x.dia, x.host, x.pagina, x.consulta].join(''));
}

/** Meses (inteiros) que cobrem o intervalo; o ultimo termina em `fim` se o mes ainda nao acabou. */
export function blocosMensais(inicio: string, fim: string): Array<{ inicio: string; fim: string }> {
  const out: Array<{ inicio: string; fim: string }> = [];
  const d = (x: string) => new Date(`${x}T00:00:00Z`);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  for (let c = new Date(Date.UTC(d(inicio).getUTCFullYear(), d(inicio).getUTCMonth(), 1)); c <= d(fim); c = new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 1))) {
    const ultimo = new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 0));
    out.push({ inicio: iso(c), fim: iso(ultimo < d(fim) ? ultimo : d(fim)) });
  }
  return out;
}
