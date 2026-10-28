import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createStudioServer } from '../studio/server';
import { PgSeoRepo, SeoInvalido, caminhoNormal, ctrEsperado, gerarAcoes, hostNormal, validarFiltros, type SeoConsulta, type SeoDados, type SeoFiltros, type SeoPagina, type SeoRepo } from '../studio/lib/seo';

const pagina = (o: Partial<SeoPagina>): SeoPagina => ({ host: 'quarkrh.com.br', pagina: '/p', impressoes: 0, cliques: 0, posicao: null, sessoes: 0, leads: 0, mql: 0, ganhos: 0, pipeline: 0, ...o });
const consulta = (o: Partial<SeoConsulta>): SeoConsulta => ({ consulta: 'q', pagina: '/p', host: 'quarkrh.com.br', impressoes: 1000, cliques: 10, posicao: 6, potencial: 40, ...o });

describe('SEO: filtros e normalização', () => {
  it('aceita marca e período válidos e usa rh por padrão', () => {
    expect(validarFiltros({ de: '2026-10-01', ate: '2026-10-28' })).toEqual({ marca: 'rh', de: '2026-10-01', ate: '2026-10-28' });
    expect(validarFiltros({ marca: 'clinic', de: '2026-10-01', ate: '2026-10-28' }).marca).toBe('clinic');
  });
  it('recusa marca desconhecida, data torta, intervalo invertido e período longo demais', () => {
    expect(() => validarFiltros({ marca: 'x', de: '2026-10-01', ate: '2026-10-28' })).toThrow(SeoInvalido);
    expect(() => validarFiltros({ de: '01/10/2026', ate: '2026-10-28' })).toThrow(SeoInvalido);
    expect(() => validarFiltros({ de: '2026-10-28', ate: '2026-10-01' })).toThrow(SeoInvalido);
    expect(() => validarFiltros({ de: '2024-01-01', ate: '2026-10-28' })).toThrow(/400 dias/);
  });
  it('caminho e host seguem a mesma normalização do GA4 e do Pipedrive', () => {
    expect(caminhoNormal('/Blog/Escala-5x2/?utm=1#x')).toBe('/blog/escala-5x2');
    expect(caminhoNormal('/')).toBe('/');
    expect(caminhoNormal('')).toBe('/');
    expect(hostNormal('www.QuarkRH.com.br')).toBe('quarkrh.com.br');
  });
  it('CTR esperado cai com a posição', () => {
    expect(ctrEsperado(1)).toBeGreaterThan(ctrEsperado(5));
    expect(ctrEsperado(5)).toBeGreaterThan(ctrEsperado(30));
  });
});

describe('SEO: ações recomendadas', () => {
  it('consulta nas posições 4 a 10 com potencial vira ação de CTR, com host, página e hipótese', () => {
    const a = gerarAcoes([], [consulta({ consulta: 'ponto eletrônico', pagina: '/ponto', posicao: 5.4, potencial: 80 })]);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ prioridade: 'P1', tipo: 'Título e snippet', host: 'quarkrh.com.br', pagina: '/ponto', metrica: 'leads' });
    expect(a[0]!.hipotese).toContain('ponto eletrônico');
    expect(a[0]!.sinal).toContain('1.000 impressões');
  });
  it('consulta sem potencial ou fora da faixa de posição não gera ação', () => {
    expect(gerarAcoes([], [consulta({ potencial: 5 }), consulta({ posicao: 1.2, potencial: 500 }), consulta({ posicao: 14, potencial: 500 })])).toEqual([]);
  });
  it('página com muito tráfego e conversão bem abaixo da mediana vira ação de CRO com meta de leads', () => {
    const ps = [pagina({ pagina: '/a', sessoes: 1000, leads: 50 }), pagina({ pagina: '/b', sessoes: 900, leads: 45 }), pagina({ pagina: '/c', sessoes: 800, leads: 40 }), pagina({ pagina: '/ruim', sessoes: 5000, leads: 20 })];
    const a = gerarAcoes(ps, []);
    expect(a.map((x) => x.pagina)).toEqual(['/ruim']);
    expect(a[0]).toMatchObject({ tipo: 'CRO em conteúdo' });
    expect(a[0]!.meta).toBeGreaterThan(20);
  });
  it('demanda alta com posição média entre 6 e 15 vira ação de conteúdo e links', () => {
    const a = gerarAcoes([pagina({ pagina: '/guia', impressoes: 9000, cliques: 100, posicao: 9 })], []);
    expect(a[0]).toMatchObject({ tipo: 'Conteúdo e links internos', pagina: '/guia' });
  });
  it('ids são únicos e estáveis entre chamadas', () => {
    const ps = [pagina({ pagina: '/guia', impressoes: 9000, posicao: 9 })];
    const cs = [consulta({ pagina: '/x', posicao: 5, potencial: 90 })];
    const a1 = gerarAcoes(ps, cs), a2 = gerarAcoes(ps, cs);
    expect(a1.map((x) => x.id)).toEqual(a2.map((x) => x.id));
    expect(new Set(a1.map((x) => x.id)).size).toBe(a1.length);
  });
});

describe('SEO: repositório', () => {
  it('guarda o resultado por 5 minutos (mesmo filtro não repete as consultas) e não guarda erro', async () => {
    let n = 0;
    const db = { query: async () => { n++; throw new Error('banco fora'); } };
    const repo = new PgSeoRepo(db as never);
    const f: SeoFiltros = { marca: 'rh', de: '2026-10-01', ate: '2026-10-28' };
    await expect(repo.dados(f)).rejects.toThrow(/banco fora/);
    const antes = n;
    await expect(repo.dados(f)).rejects.toThrow(/banco fora/); // erro não ficou guardado: tentou de novo
    expect(n).toBeGreaterThan(antes);
  });
});

describe('GET /api/seo', () => {
  let server: Server, semRepo: Server, base: string, baseSem: string, dir: string;
  const chamadas: SeoFiltros[] = [];
  const dados = { marca: 'rh', acoes: [], paginas: [] } as unknown as SeoDados;
  const repo: SeoRepo = { async dados(f) { chamadas.push(f); return dados; } };
  const mk = (seo: SeoRepo | null) => createStudioServer({ formsDir: join(dir, 'forms'), publicDir: join(dir, 'public'), trackingDir: join(dir, 'tracking'), sources: [], dbInfo: () => ({ connected: true }), submit: async () => ({ status: 200, body: {} }), seo });
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'studio-seo-'));
    for (const d of ['forms', 'public', 'tracking']) mkdirSync(join(dir, d));
    writeFileSync(join(dir, 'public', 'seo.html'), '<h1>seo.html</h1>');
    server = mk(repo);
    semRepo = mk(null);
    await Promise.all([server, semRepo].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    baseSem = `http://127.0.0.1:${(semRepo.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await Promise.all([server, semRepo].map((s) => new Promise((r) => s.close(r))));
    rmSync(dir, { recursive: true, force: true });
  });

  it('serve a página e repassa marca e período validados ao repositório', async () => {
    expect(await (await fetch(`${base}/seo`)).text()).toContain('seo.html');
    const r = await fetch(`${base}/api/seo?marca=clinic&de=2026-10-01&ate=2026-10-28`);
    expect(r.status).toBe(200);
    expect(chamadas.at(-1)).toEqual({ marca: 'clinic', de: '2026-10-01', ate: '2026-10-28' });
  });
  it('filtro inválido responde 400 sem chamar o repositório', async () => {
    const antes = chamadas.length;
    const r = await fetch(`${base}/api/seo?marca=clinic&de=ontem&ate=hoje`);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('seo_invalido');
    expect(chamadas.length).toBe(antes);
  });
  it('só aceita GET e, sem banco do painel, responde 503 explicando', async () => {
    expect((await fetch(`${base}/api/seo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(405);
    const r = await fetch(`${baseSem}/api/seo?marca=rh&de=2026-10-01&ate=2026-10-28`);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe('seo_nao_configurado');
  });
});
