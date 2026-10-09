import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  Ga4Client, PAGE_SIZE, SEM_HOST, SEM_PAGINA, blocosDeDatas, dataGa4, ga4CredentialsFromEnv,
  mapAds, mapDia, mapEventos, mapPaginas, mapSessoes, relatorio, EVENTOS_FORA, type FetchLike, type ReportRow,
} from '../src/datahub/google/ga4';
import { intervalo, REVISAO_DIAS } from '../src/datahub/google/ga4-sync';

const row = (d: string[], m: Array<string | number>): ReportRow => ({ dimensionValues: d.map((value) => ({ value })), metricValues: m.map((v) => ({ value: String(v) })) });
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const cred = { clientEmail: 'robo@projeto-ficticio.iam.gserviceaccount.com', privateKey, propertyId: '111' };

describe('GA4: credenciais', () => {
  it('lê do ambiente, com a chave em uma linha (JSON) ou com \\n', () => {
    const env = { GOOGLE_SA_CLIENT_EMAIL: 'a@b', GA4_PROPERTY_ID: '5' };
    expect(ga4CredentialsFromEnv({ ...env, GOOGLE_SA_PRIVATE_KEY: JSON.stringify('L1\nL2') }).privateKey).toBe('L1\nL2');
    expect(ga4CredentialsFromEnv({ ...env, GOOGLE_SA_PRIVATE_KEY: 'L1\\nL2' }).privateKey).toBe('L1\nL2');
  });
  it('falta de variável vira erro claro, sem vazar valor', () => {
    expect(() => ga4CredentialsFromEnv({ GOOGLE_SA_CLIENT_EMAIL: 'a@b' })).toThrow(/Faltam/);
  });
});

describe('GA4: mapeamento dos relatórios', () => {
  it('data AAAAMMDD vira AAAA-MM-DD e data estranha é recusada', () => {
    expect(dataGa4('20261008')).toBe('2026-10-08');
    expect(() => dataGa4('2026-10-08')).toThrow();
  });
  it('sessões: "(not set)" na página vira (sem pagina), campanha vazia fica vazia e linhas iguais se somam', () => {
    const m = mapSessoes([
      row(['20261001', 'site.test', '(not set)', 'google', 'cpc', '(not set)', '(not set)', '(not set)'], [10, 4, 6, 12]),
      row(['20261001', 'site.test', '', 'google', 'cpc', '', '', ''], [5, 1, 2, 6]),
      row(['20261001', 'site.test', '/lp', 'google', 'cpc', 'camp', '99', '123'], [3, 3, 1, 4]),
    ]);
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ landing_page: SEM_PAGINA, campanha: '', sessoes: 15, usuarios_novos: 5, sessoes_engajadas: 8, visualizacoes: 18, campanha_id: null });
    expect(m[1]).toMatchObject({ landing_page: '/lp', campanha_id: '99', gads_campanha_id: '123' });
  });
  it('eventos e páginas: host e página ausentes são marcados, não descartados', () => {
    expect(mapEventos([row(['20261001', '(not set)', '(not set)', 'form_x'], [3, 2])])[0]).toMatchObject({ host: SEM_HOST, pagina: SEM_PAGINA, eventos: 3, usuarios: 2 });
    const p = mapPaginas([row(['20261001', 'h', '/a'], [4, 3]), row(['20261001', 'h', '/a'], [1, 1])]);
    expect(p).toEqual([{ dia: '2026-10-01', host: 'h', pagina: '/a', visualizacoes: 5, usuarios_ativos: 4 }]);
  });
  it('totais por dia: uma linha por dia, só com a dimensão data (usuários ativos não se somam entre páginas)', () => {
    const r = relatorio('ga4_dia', '2026-10-01', '2026-10-02');
    expect(r.dimensions).toEqual([{ name: 'date' }]);
    expect(r.metrics.map((m) => m.name)).toEqual(['sessions', 'activeUsers', 'newUsers', 'engagedSessions', 'screenPageViews']);
    expect(mapDia([row(['20261001'], [10, 8, 5, 6, 30])])).toEqual([{ dia: '2026-10-01', sessoes: 10, usuarios_ativos: 8, usuarios_novos: 5, sessoes_engajadas: 6, visualizacoes: 30 }]);
  });
  it('custo do Google Ads: usa as dimensões de campanha, soma duplicatas e não guarda linhas zeradas', () => {
    const r = relatorio('ga4_ads', '2026-10-01', '2026-10-02');
    expect(r.dimensions.map((d) => d.name)).toEqual(['date', 'sessionGoogleAdsCampaignId', 'sessionGoogleAdsCampaignName']);
    expect(r.metrics.map((m) => m.name)).toEqual(['advertiserAdCost', 'advertiserAdClicks', 'advertiserAdImpressions']);
    const m = mapAds([
      row(['20261001', '123', 'Campanha A'], [10.456, 3, 100]),
      row(['20261001', '123', 'Campanha A'], [1.004, 1, 10]),
      row(['20261001', '(not set)', '(not set)'], [0, 0, 0]), // sem custo, cliques nem impressões: descartada
      row(['20261002', '(not set)', '(not set)'], [0, 0, 7]), // só impressões: fica
    ]);
    expect(m).toEqual([
      { dia: '2026-10-01', campanha_id: '123', campanha: 'Campanha A', custo: 11.46, cliques: 4, impressoes: 110 },
      { dia: '2026-10-02', campanha_id: '', campanha: '', custo: 0, cliques: 0, impressoes: 7 },
    ]);
  });
  it('o relatório de eventos deixa de fora os eventos automáticos de alto volume', () => {
    const r = relatorio('ga4_eventos', '2026-10-01', '2026-10-02');
    expect(JSON.stringify(r.dimensionFilter)).toContain('notExpression');
    for (const e of EVENTOS_FORA) expect(JSON.stringify(r.dimensionFilter)).toContain(e);
  });
  it('sessões usa só dimensões e métricas que o GA4 confirmou (sem a métrica antiga "conversions")', () => {
    const r = relatorio('ga4_sessoes', '2026-10-01', '2026-10-02');
    expect(r.metrics.map((m) => m.name)).toEqual(['sessions', 'newUsers', 'engagedSessions', 'screenPageViews']);
    expect(r.dimensions.length).toBeLessThanOrEqual(9); // limite do GA4
  });
});

describe('GA4: datas e intervalo da sincronização', () => {
  it('divide o período em blocos sem sobrepor nem pular dias', () => {
    const b = blocosDeDatas('2026-01-01', '2026-03-05', 31);
    expect(b[0]).toEqual({ inicio: '2026-01-01', fim: '2026-01-31' });
    expect(b[1]).toEqual({ inicio: '2026-02-01', fim: '2026-03-03' });
    expect(b.at(-1)).toEqual({ inicio: '2026-03-04', fim: '2026-03-05' });
  });
  it('sem marca d\'água lê tudo desde o início; com marca, só revisa os últimos dias', () => {
    expect(intervalo('2025-01-01', null, '2026-10-09')).toEqual({ inicio: '2025-01-01', fim: '2026-10-08', modo: 'backfill' });
    const i = intervalo('2025-01-01', '2026-10-08', '2026-10-09');
    expect(i.modo).toBe('incremental');
    expect(i.inicio).toBe('2026-10-02'); // marca - (REVISAO_DIAS - 1)
    expect(REVISAO_DIAS).toBe(7);
  });
  it('a revisão nunca volta antes do início configurado', () => {
    expect(intervalo('2026-10-05', '2026-10-06', '2026-10-09').inicio).toBe('2026-10-05');
  });
});

describe('GA4: cliente', () => {
  const resp = (ok: boolean, status: number, body: unknown) => ({ ok, status, json: async () => body });
  it('autentica uma vez (token em cache), envia só leitura e pagina por offset', async () => {
    const urls: string[] = [];
    const bodies: any[] = [];
    const f: FetchLike = async (url, init) => {
      urls.push(url);
      if (url.includes('oauth2')) {
        expect(String(init?.body)).toContain('jwt-bearer'); // o corpo leva a assertion assinada, nunca a chave
        expect(String(init?.body)).not.toContain('PRIVATE KEY');
        return resp(true, 200, { access_token: 'tok', expires_in: 3600 });
      }
      const b = JSON.parse(init!.body!);
      bodies.push(b);
      expect(init!.headers!.authorization).toBe('Bearer tok');
      const n = b.offset === 0 ? PAGE_SIZE : 3;
      return resp(true, 200, { rows: Array.from({ length: n }, () => row(['20261001'], [1])) });
    };
    const c = new Ga4Client(cred, f, async () => {});
    const rows = await c.runReportAll({ dateRanges: [], dimensions: [{ name: 'date' }], metrics: [{ name: 'sessions' }] });
    expect(rows).toHaveLength(PAGE_SIZE + 3);
    expect(bodies.map((b) => b.offset)).toEqual([0, PAGE_SIZE]);
    expect(urls.filter((u) => u.includes('oauth2'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/properties/111:runReport'))).toHaveLength(2);
    expect(urls.every((u) => !/:batchUpdate|admin/i.test(u))).toBe(true);
  });
  it('tenta de novo em 429/5xx e desiste com erro claro depois de várias tentativas', async () => {
    let n = 0;
    const esperas: number[] = [];
    const f: FetchLike = async (url) => {
      if (url.includes('oauth2')) return resp(true, 200, { access_token: 't', expires_in: 3600 });
      n++;
      return n < 3 ? resp(false, 429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'cota' } }) : resp(true, 200, { rows: [] });
    };
    const c = new Ga4Client(cred, f, async (ms) => void esperas.push(ms));
    await c.runReport({ dateRanges: [], dimensions: [], metrics: [] });
    expect(n).toBe(3);
    expect(esperas).toEqual([2000, 4000]);
    const sempre: FetchLike = async (url) => (url.includes('oauth2') ? resp(true, 200, { access_token: 't', expires_in: 3600 }) : resp(false, 503, { error: { status: 'UNAVAILABLE', message: 'x' } }));
    await expect(new Ga4Client(cred, sempre, async () => {}).runReport({ dateRanges: [], dimensions: [], metrics: [] })).rejects.toThrow(/503/);
  });
  it('erro 403 (sem acesso à propriedade) não é repetido e não vaza a chave', async () => {
    let n = 0;
    const f: FetchLike = async (url) => {
      if (url.includes('oauth2')) return resp(true, 200, { access_token: 't', expires_in: 3600 });
      n++;
      return resp(false, 403, { error: { status: 'PERMISSION_DENIED', message: 'sem acesso' } });
    };
    const err = await new Ga4Client(cred, f, async () => {}).runReport({ dateRanges: [], dimensions: [], metrics: [] }).catch((e: Error) => e);
    expect(n).toBe(1);
    expect((err as Error).message).toContain('PERMISSION_DENIED');
    expect((err as Error).message).not.toContain('PRIVATE');
  });
  it('autenticação recusada vira erro claro', async () => {
    const f: FetchLike = async () => resp(false, 400, { error: 'invalid_grant', error_description: 'Invalid JWT' });
    await expect(new Ga4Client(cred, f, async () => {}).runReport({ dateRanges: [], dimensions: [], metrics: [] })).rejects.toThrow(/invalid_grant/);
  });
});
