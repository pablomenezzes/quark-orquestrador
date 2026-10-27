import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createStudioServer } from '../studio/server';
import { PgBiRepo, type BiFiltros, type BiRepo } from '../studio/lib/bi';

const base: BiFiltros = { de: '2026-09-20', ate: '2026-10-26', produto: 'rh' };
const capturar = () => {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const pool = { query: async (sql: string, params: unknown[] = []) => { consultas.push({ sql: sql.replace(/\s+/g, ' '), params }); return { rows: [] }; } } as never;
  return { consultas, repo: new PgBiRepo(pool) };
};

describe('BI: campanhas da Meta fora do CPL (consultas)', () => {
  it('em todas as análises da Meta, o gasto e os negócios ligados às campanhas escolhidas saem, com os IDs como parâmetro', async () => {
    const { consultas, repo } = capturar();
    const ids = ['120251054032640158', '120251058961320158'];
    const metas = repo.catalogo().filter((a) => a.pagina === 'meta');
    expect(metas.length).toBeGreaterThan(5);
    for (const a of metas) await repo.rodar(a.id, { ...base, excluirCampanhas: ids }).catch(() => null);
    const gasto = consultas.filter((c) => c.sql.includes('analytics.meta_desempenho_dia'));
    const negocios = consultas.filter((c) => c.sql.includes('analytics.negocios_bi'));
    expect(gasto.length).toBeGreaterThan(5);
    expect(negocios.length).toBeGreaterThan(5);
    for (const c of gasto) {
      expect(c.sql).toMatch(/\(m\.campanha_id is null or m\.campanha_id <> all\(\$\d+::bigint\[\]\)\)/);
      expect(c.params).toContainEqual(ids);
    }
    for (const c of negocios) {
      expect(c.sql).toMatch(/not exists \(select 1 from analytics\.negocios_meta x where x\.deal_id = \w+\.deal_id and x\.campanha_id = any\(\$\d+::bigint\[\]\)\)/);
      expect(c.params).toContainEqual(ids);
    }
    expect(consultas.map((c) => c.sql).join(' ')).not.toContain(ids[0]!); // o ID nunca entra no texto do SQL
  });
  it('sem o filtro nada muda: nenhuma cláusula nova e nenhum aviso', async () => {
    const { consultas, repo } = capturar();
    const metas = repo.catalogo().filter((a) => a.pagina === 'meta');
    const avisos: string[] = [];
    for (const a of metas) { const r = await repo.rodar(a.id, base).catch(() => null); if (r) avisos.push(...r.avisos); }
    expect(consultas.some((c) => c.sql.includes('x.campanha_id = any') || c.sql.includes('m.campanha_id <> all'))).toBe(false);
    expect(avisos.some((a) => a.includes('Filtro temporário'))).toBe(false);
  });
  it('toda análise avisa que o filtro temporário está ligado, no singular e no plural', async () => {
    const { repo } = capturar();
    const id = repo.catalogo().find((a) => a.pagina === 'meta')!.id;
    const um = await repo.rodar(id, { ...base, excluirCampanhas: ['1'] });
    const dois = await repo.rodar(id, { ...base, excluirCampanhas: ['1', '2'] });
    expect(um.avisos[0]).toMatch(/1 campanha da Meta fora .* a ela/);
    expect(dois.avisos[0]).toMatch(/2 campanhas da Meta fora .* a elas/);
    expect(dois.avisos[0]).toContain('Campanhas Meta fora do CPL');
  });
  it('as outras páginas do BI também deixam de contar os negócios dessas campanhas', async () => {
    const { consultas, repo } = capturar();
    for (const a of repo.catalogo().filter((x) => x.pagina === 'geral')) await repo.rodar(a.id, { ...base, excluirCampanhas: ['1'] }).catch(() => null);
    const comNegocios = consultas.filter((c) => c.sql.includes('analytics.negocios_bi'));
    expect(comNegocios.length).toBeGreaterThan(0);
    expect(comNegocios.every((c) => c.sql.includes('analytics.negocios_meta x'))).toBe(true);
  });
  it('a lista de campanhas traz só as com gasto no período, maiores primeiro, e filtra por produto com parâmetro', async () => {
    const consultas: Array<{ sql: string; params: unknown[] }> = [];
    const pool = { query: async (sql: string, params: unknown[] = []) => { consultas.push({ sql: sql.replace(/\s+/g, ' '), params }); return { rows: [{ id: '120251054032640158', nome: '[Growth][77] Diag', produto: 'rh', gasto: 5000.5 }, { id: '9', nome: null, produto: null, gasto: 10 }] }; } } as never;
    const l = await new PgBiRepo(pool).campanhasMeta({ de: '2026-09-01', ate: '2026-10-01', produto: 'rh' });
    expect(l).toEqual([{ id: '120251054032640158', nome: '[Growth][77] Diag', produto: 'rh', gasto: 5000.5 }, { id: '9', nome: '#9', produto: null, gasto: 10 }]);
    expect(consultas[0]!.sql).toContain('having sum(m.gasto) > 0 order by sum(m.gasto) desc');
    expect(consultas[0]!.sql).toContain('m.produto = $3');
    expect(consultas[0]!.params).toEqual(['2026-09-01', '2026-10-01', 'rh']);
    expect(consultas[0]!.sql).toContain('analytics.meta_desempenho_dia');
    expect(consultas[0]!.sql).not.toMatch(/\b(crm|mkt|raw|orq)\./);
  });
});

describe('BI: campanhas da Meta fora do CPL (rotas e tela)', () => {
  const recebidos: BiFiltros[] = [];
  const chamadasLista: unknown[] = [];
  const repo = {
    catalogo: () => [],
    async opcoes() { return { pipelines: [], produtos: [], primeiro_negocio: null, fontes: [], tipos: [], paginas: [] }; },
    async rodar(_id: string, f: BiFiltros) { recebidos.push(f); return { grafico: { tipo: 'kpis', itens: [] }, tabela: { colunas: [], linhas: [] }, avisos: [] }; },
    async campanhasMeta(f: unknown) { chamadasLista.push(f); return [{ id: '1', nome: 'C', produto: 'rh', gasto: 1 }]; },
  } as unknown as BiRepo;
  let a: Server, b: Server, ua: string, ub: string, dir: string;
  const mk = (bi: BiRepo) => createStudioServer({ formsDir: join(dir, 'f'), publicDir: join(dir, 'p'), trackingDir: join(dir, 't'), sources: [], dbInfo: () => ({ connected: true }), submit: async () => ({ status: 200, body: {} }), bi } as never);
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'studio-bi-excl-'));
    for (const d of ['f', 'p', 't']) mkdirSync(join(dir, d));
    a = mk(repo);
    const { campanhasMeta, ...semLista } = repo as unknown as Record<string, unknown>; void campanhasMeta;
    b = mk(semLista as unknown as BiRepo);
    await Promise.all([a, b].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    ua = `http://127.0.0.1:${(a.address() as AddressInfo).port}`; ub = `http://127.0.0.1:${(b.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await Promise.all([a, b].map((s) => new Promise((r) => s.close(r)))); rmSync(dir, { recursive: true, force: true }); });
  const periodo = 'de=2026-09-20&ate=2026-10-26';

  it('excluir_campanhas chega à análise como lista sem repetição; só dígitos, até 200', async () => {
    expect((await fetch(`${ua}/api/bi/analise/x?${periodo}&excluir_campanhas=120251054032640158,120251058961320158,120251054032640158`)).status).toBe(200);
    expect(recebidos.at(-1)!.excluirCampanhas).toEqual(['120251054032640158', '120251058961320158']);
    expect((await fetch(`${ua}/api/bi/analise/x?${periodo}`)).status).toBe(200);
    expect(recebidos.at(-1)!.excluirCampanhas).toBeUndefined();
    for (const ruim of ['abc', '1,2;drop table x', "1' or '1'='1", '1,,2', '9'.repeat(21), Array.from({ length: 201 }, (_, i) => i + 1).join(',')]) {
      expect((await fetch(`${ua}/api/bi/analise/x?${periodo}&excluir_campanhas=${encodeURIComponent(ruim)}`)).status, ruim.slice(0, 30)).toBe(400);
    }
  });
  it('/api/bi/campanhas valida o período e o produto; sem o método no repositório responde 404', async () => {
    const r = await fetch(`${ua}/api/bi/campanhas?${periodo}&produto=rh`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([{ id: '1', nome: 'C', produto: 'rh', gasto: 1 }]);
    expect(chamadasLista.at(-1)).toEqual({ de: '2026-09-20', ate: '2026-10-26', produto: 'rh' });
    expect((await fetch(`${ua}/api/bi/campanhas?de=2026-10-26&ate=2026-09-20`)).status).toBe(400);
    expect((await fetch(`${ua}/api/bi/campanhas?de=ontem&ate=2026-09-20`)).status).toBe(400);
    expect((await fetch(`${ua}/api/bi/campanhas?${periodo}&produto=outro`)).status).toBe(400);
    expect((await fetch(`${ub}/api/bi/campanhas?${periodo}`)).status).toBe(404);
  });
  it('a tela tem o filtro, manda excluir_campanhas e o guarda só na aba (sessionStorage), não para sempre', () => {
    const html = readFileSync(new URL('../studio/public/bi.html', import.meta.url), 'utf8');
    expect(html).toContain('id="ms-camp"');
    expect(html).toContain('Campanhas Meta fora do CPL');
    const js = readFileSync(new URL('../studio/public/bi.js', import.meta.url), 'utf8');
    for (const t of ["p.set('excluir_campanhas'", '/api/bi/campanhas', "sessao.guardar('bi.excluirCampanhas'", 'data-camp-toggle', 'camp-busca']) expect(js).toContain(t);
    expect(js).not.toMatch(/(^|[^.])guardar\('bi\.excluirCampanhas'/m); // o guardar() solto é o localStorage; este usa sessao.guardar
  });
});
