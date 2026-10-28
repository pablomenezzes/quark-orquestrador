import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { FetchLike as FetchLikeGsc } from "../src/datahub/google/ga4";
import { ATRASO_DIAS, GSC_PAGE_SIZE, GscClient, gscSitesFromEnv, hostECaminho, blocosMensais, mapGscConsultas, mapGscPaginas, relatorioGsc, type GscRow } from '../src/datahub/google/gsc';
import { intervaloGsc } from '../src/datahub/google/gsc-sync';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const cred = { clientEmail: 'robo@projeto-ficticio.iam.gserviceaccount.com', privateKey };
const linha = (keys: string[], clicks: number, impressions: number, position: number): GscRow => ({ keys, clicks, impressions, ctr: clicks / impressions, position });

describe('GSC: propriedades por marca', () => {
  it('RH vem de GSC_SITE_URL e Clinic de GSC_SITE_URL_CLINIC (opcional)', () => {
    expect(gscSitesFromEnv({ GSC_SITE_URL: 'sc-domain:quarkrh.com.br' })).toEqual([{ marca: 'rh', siteUrl: 'sc-domain:quarkrh.com.br' }]);
    expect(gscSitesFromEnv({ GSC_SITE_URL: 'https://www.quarkrh.com.br/', GSC_SITE_URL_CLINIC: 'sc-domain:quarkclinic.com.br' })).toHaveLength(2);
    expect(gscSitesFromEnv({})).toEqual([]);
  });
  it('aceita várias por marca, separadas por ponto e vírgula, e ignora o prefixo que o domínio já cobre', () => {
    const r = gscSitesFromEnv({ GSC_SITE_URL: 'sc-domain:quarkrh.com.br; https://www.quarkrh.com.br/; https://campanha.quark.tec.br/' });
    expect(r).toEqual([{ marca: 'rh', siteUrl: 'sc-domain:quarkrh.com.br' }, { marca: 'rh', siteUrl: 'https://campanha.quark.tec.br/' }]);
  });
  it('formato inválido é recusado', () => {
    expect(() => gscSitesFromEnv({ GSC_SITE_URL: 'quarkrh.com.br' })).toThrow(/sc-domain/);
    expect(() => gscSitesFromEnv({ GSC_SITE_URL: 'https://www.quarkrh.com.br' })).toThrow(/terminando/);
  });
});

describe('GSC: mapeamento', () => {
  it('separa host e caminho, sem parâmetros nem âncora', () => {
    expect(hostECaminho('https://www.quarkrh.com.br/software-rh?utm_source=x#topo')).toEqual({ host: 'www.quarkrh.com.br', pagina: '/software-rh' });
    expect(hostECaminho('https://www.quarkrh.com.br')).toEqual({ host: 'www.quarkrh.com.br', pagina: '/' });
  });
  it('páginas com a mesma chave depois de tirar parâmetros se somam e a posição é ponderada pelas impressoes', () => {
    const r = mapGscPaginas([
      linha(['2026-10-01', 'https://a.com/p?x=1'], 10, 100, 4),
      linha(['2026-10-01', 'https://a.com/p?x=2'], 5, 300, 8),
    ]);
    expect(r).toEqual([{ dia: '2026-10-01', host: 'a.com', pagina: '/p', cliques: 15, impressoes: 400, pos_x_imp: 2800 }]);
    expect(r[0]!.pos_x_imp / r[0]!.impressoes).toBe(7);
  });
  it('consultas: agregadas por mês; com menos de 10 impressões no mês e sem clique ficam de fora', () => {
    const r = mapGscConsultas([
      linha(['https://a.com/p', 'raro'], 0, 9, 9),
      linha(['https://a.com/p', 'um clique'], 1, 1, 3),
      linha(['https://a.com/p?x=1', 'normal'], 2, 50, 6),
      linha(['https://a.com/p?x=2', 'normal'], 1, 50, 8),
    ], '2026-10-01');
    expect(r.map((x) => [x.dia, x.consulta, x.impressoes])).toEqual([['2026-10-01', 'um clique', 1], ['2026-10-01', 'normal', 100]]);
  });
  it('blocos mensais: meses inteiros, o último termina no fim do intervalo', () => {
    expect(blocosMensais('2026-08-14', '2026-10-25')).toEqual([{ inicio: '2026-08-01', fim: '2026-08-31' }, { inicio: '2026-09-01', fim: '2026-09-30' }, { inicio: '2026-10-01', fim: '2026-10-25' }]);
  });
  it('consulta ou página gigante (estoura o índice do banco) fica de fora', () => {
    const longa = 'x'.repeat(2800);
    expect(mapGscConsultas([linha(['https://a.com/p', longa], 5, 50, 3), linha(['https://a.com/p', 'ok'], 5, 50, 3)], '2026-10-01').map((x) => x.consulta)).toEqual(['ok']);
    expect(mapGscPaginas([linha(['2026-10-01', `https://a.com/${longa}`], 5, 50, 3)])).toEqual([]);
  });
  it('relatório de páginas usa data e página; o de consultas acrescenta a consulta; sempre dado final', () => {
    expect(relatorioGsc('gsc_pagina', '2026-10-01', '2026-10-02').dimensions).toEqual(['date', 'page']);
    expect(relatorioGsc('gsc_consulta', '2026-10-01', '2026-10-31')).toMatchObject({ dimensions: ['page', 'query'], dataState: 'final' });
  });
});

describe('GSC: intervalo', () => {
  it('termina no último dia com dado final (hoje menos o atraso)', () => {
    expect(ATRASO_DIAS).toBe(3);
    expect(intervaloGsc('2025-07-01', null, '2026-10-28')).toEqual({ inicio: '2025-07-01', fim: '2026-10-25', modo: 'backfill' });
  });
  it('depois da carga relê só os últimos dias (a marca d’água menos a revisão)', () => {
    expect(intervaloGsc('2025-07-01', '2026-10-25', '2026-10-28')).toEqual({ inicio: '2026-10-21', fim: '2026-10-25', modo: 'incremental' });
  });
});

describe('GSC: cliente', () => {
  const resposta = (ok: boolean, status: number, corpo: unknown) => ({ ok, status, json: async () => corpo });
  it('autentica com o escopo do Search Console e pagina por startRow até a última página', async () => {
    const chamadas: Array<{ url: string; body?: string }> = [];
    const cheia = Array.from({ length: GSC_PAGE_SIZE }, (_, i) => linha(['2026-10-01', `https://a.com/${i}`], 1, 1, 1));
    const doFetch: FetchLikeGsc = async (url, init) => {
      chamadas.push({ url, body: init?.body });
      if (url.includes('oauth2')) return resposta(true, 200, { access_token: 't', expires_in: 3600 });
      const start = JSON.parse(init!.body!).startRow;
      return resposta(true, 200, { rows: start === 0 ? cheia : [linha(['2026-10-01', 'https://a.com/ultima'], 1, 1, 1)] });
    };
    const c = new GscClient(cred, 'sc-domain:a.com', doFetch);
    const rows = await c.queryAll(relatorioGsc('gsc_pagina', '2026-10-01', '2026-10-01'));
    expect(rows).toHaveLength(GSC_PAGE_SIZE + 1);
    const token = chamadas.find((x) => x.url.includes('oauth2'))!;
    expect(decodeURIComponent(token.body!)).toContain('assertion=');
    const consulta = chamadas.filter((x) => x.url.includes('searchAnalytics'));
    expect(consulta[0]!.url).toContain(encodeURIComponent('sc-domain:a.com'));
    expect(consulta).toHaveLength(2);
  });
  it('repete em 429 e para em 403 com mensagem clara', async () => {
    let n = 0;
    const esperas: number[] = [];
    const doFetch: FetchLikeGsc = async (url) => {
      if (url.includes('oauth2')) return resposta(true, 200, { access_token: 't' });
      n++;
      return n === 1 ? resposta(false, 429, {}) : resposta(false, 403, { error: { status: 'PERMISSION_DENIED', message: 'sem acesso' } });
    };
    const c = new GscClient(cred, 'sc-domain:a.com', doFetch, async (ms) => { esperas.push(ms); });
    await expect(c.query({ ...relatorioGsc('gsc_pagina', '2026-10-01', '2026-10-01'), rowLimit: 10, startRow: 0 })).rejects.toThrow(/403.*PERMISSION_DENIED/);
    expect(esperas).toEqual([2000]);
  });
});
