import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createStudioServer } from '../studio/server';
import {
  LINHAS, PgScorecardRepo, ScorecardInvalido, configVazia, inicioSemana, montarScorecard, periodos, validarMetrica,
  type CatalogoVisoes, type MetricaCustom, type ScorecardRepo,
} from '../studio/lib/scorecard';

const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 domingo ... 5 sexta, 6 sábado

describe('Scorecard: períodos', () => {
  it('a semana vai de sábado a sexta, em qualquer dia da semana', () => {
    for (const hoje of ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']) {
      const ini = inicioSemana(hoje);
      expect(dow(ini), hoje).toBe(6);
      expect(ini <= hoje && hoje < new Date(Date.parse(`${ini}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10), hoje).toBe(true);
    }
    expect(inicioSemana('2026-10-30')).toBe('2026-10-24'); // sexta: ainda a semana que começou no sábado 24
    expect(inicioSemana('2026-10-31')).toBe('2026-10-31'); // sábado: começa uma semana nova
    expect(inicioSemana('2026-11-03')).toBe('2026-10-31');
  });

  it('lista os últimos N períodos, do mais antigo ao atual, e marca o atual como em andamento', () => {
    const s = periodos('semana', '2026-11-03', 4);
    expect(s.map((p) => p.de)).toEqual(['2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31']);
    expect(s.every((p) => dow(p.de) === 6 && dow(p.ate) === 5)).toBe(true);
    expect(s.map((p) => p.parcial)).toEqual([false, false, false, true]);
    expect(s[0]!.rotulo).toBe('10/10 a 16/10');
    const sextaFim = periodos('semana', '2026-11-06', 1)[0]!; // a sexta fecha a semana
    expect(sextaFim.parcial).toBe(false);
  });

  it('meses vão do dia 1 ao último dia (inclusive fevereiro) e o corrente fica em andamento', () => {
    const m = periodos('mes', '2026-03-10', 3);
    expect(m.map((p) => [p.de, p.ate, p.parcial])).toEqual([['2026-01-01', '2026-01-31', false], ['2026-02-01', '2026-02-28', false], ['2026-03-01', '2026-03-31', true]]);
    expect(periodos('mes', '2026-01-15', 2).map((p) => p.de)).toEqual(['2025-12-01', '2026-01-01']); // vira o ano
  });
});

/* ---------- banco de mentira: responde pelas consultas que o scorecard faz ---------- */
function dbFalso(opts: { config?: unknown; sem42P01?: boolean } = {}) {
  const sqls: { sql: string; params?: unknown[] }[] = [];
  const query = async (sql: string, params?: unknown[]) => {
    sqls.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ');
    if (s.includes('from ops.cfg_scorecard')) {
      if (opts.sem42P01) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      return { rows: opts.config ? [{ config: opts.config }] : [] };
    }
    if (s.includes('count(*) filter (where d.conta_como_lead)')) return { rows: [
      { dia: '2026-10-30', g: 'meta', leads: 10, mql: 6 }, // sexta: semana de 24/10
      { dia: '2026-10-31', g: 'meta', leads: 20, mql: 10 }, // sábado: semana de 31/10
      { dia: '2026-10-31', g: 'google', leads: 5, mql: 3 },
      { dia: '2026-11-02', g: 'organico', leads: 15, mql: 5 },
    ] };
    if (s.includes("d.status = 'won'")) return { rows: [{ dia: '2026-11-02', g: 'meta', n: 2 }] };
    if (s.includes("d.status = 'lost'")) return { rows: [{ dia: '2026-11-02', g: 'meta', n: 4 }] };
    if (s.includes('with th as')) return { rows: [
      { dia: '2026-10-31', g: 'meta', etapa: 'sql', n: 8 }, { dia: '2026-10-31', g: 'google', etapa: 'sql', n: 2 }, { dia: '2026-11-01', g: 'organico', etapa: 'sql', n: 5 },
      { dia: '2026-11-02', g: 'meta', etapa: 'agend', n: 4 }, { dia: '2026-11-02', g: 'meta', etapa: 'prop', n: 2 }, { dia: '2026-11-03', g: 'meta', etapa: 'fech', n: 1 }, { dia: '2026-11-03', g: 'meta', etapa: 'contr', n: 1 },
    ] };
    if (s.includes('from analytics.meta_desempenho_dia')) return { rows: [{ dia: '2026-10-30', gasto: 500 }, { dia: '2026-10-31', gasto: 1000 }, { dia: '2026-11-02', gasto: 500 }] };
    if (s.includes('from analytics.ads_investimento_dia')) return { rows: [{ dia: '2026-10-31', custo: 500 }] };
    if (s.includes('from ops.umbler_mensagem')) return { rows: [{ dia: '2026-11-02', n: 40 }] };
    if (s.includes('from information_schema.columns')) return { rows: [
      { table_name: 'site_dia', column_name: 'dia', data_type: 'date' }, { table_name: 'site_dia', column_name: 'sessoes', data_type: 'bigint' }, { table_name: 'site_dia', column_name: 'host', data_type: 'text' },
      { table_name: 'meta_x', column_name: 'dia', data_type: 'date' }, { table_name: 'meta_x', column_name: 'produto', data_type: 'text' }, { table_name: 'meta_x', column_name: 'gasto', data_type: 'double precision' },
    ] };
    if (s.includes('from analytics."site_dia"') || s.includes('from analytics."meta_x"')) return { rows: [{ dia: '2026-10-31', s: 100, c: 1, m: 100 }, { dia: '2026-11-01', s: 50, c: 1, m: 50 }] };
    return { rows: [] };
  };
  return { db: { query } as any, sqls }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe('Scorecard: números por semana (sábado a sexta)', () => {
  it('cada dia cai na semana certa e as taxas e custos saem das somas', async () => {
    const { db } = dbFalso();
    const r = await montarScorecard(db, configVazia(), { produto: 'rh', visao: 'semana', n: 2, hoje: '2026-11-03' });
    expect(r.periodos.map((p) => p.de)).toEqual(['2026-10-24', '2026-10-31']);
    const v = (id: string) => r.linhas.find((l) => l.id === id)!.valores;
    // sexta 30/10 pertence à semana de 24/10; sábado 31/10 abre a semana seguinte
    expect(v('leads_total')).toEqual([10, 40]);
    expect(v('leads_meta')).toEqual([10, 20]);
    expect(v('leads_organico')).toEqual([0, 15]);
    expect(v('mql_total')).toEqual([6, 18]);
    expect(v('inv_meta')).toEqual([500, 1500]);
    expect(v('inv_google')).toEqual([0, 500]);
    expect(v('inv_total')).toEqual([500, 2000]);
    expect(v('cpl_meta')).toEqual([50, 75]); // 1500 / 20
    expect(v('cpl_google')).toEqual([null, 100]); // 500 / 5
    expect(v('cpl_pago')).toEqual([50, 80]); // 2000 / (20 + 5)
    expect(v('sql_total')).toEqual([0, 15]);
    expect(v('sql_org')).toEqual([0, 5]);
    expect(v('cv_mql_sql')).toEqual([0, 15 / 18]);
    expect(v('cv_lead_sql_meta')).toEqual([0, 8 / 20]);
    expect(v('agend_total')[1]).toBe(4);
    expect(v('cv_sql_agend')[1]).toBeCloseTo(4 / 15);
    expect(v('cv_agend_prop')[1]).toBeCloseTo(2 / 4);
    expect(v('cv_prop_fech')[1]).toBeCloseTo(1 / 2);
    expect(v('cv_fech_contr')[1]).toBe(1);
    expect(v('ganhos')).toEqual([0, 2]);
    expect(v('perdidos')).toEqual([0, 4]);
    expect(v('taxa_ganho')).toEqual([null, 2 / 6]);
    expect(v('custo_sql')).toEqual([null, 2000 / 10]); // mídia paga: 2000 / (SQL meta 8 + google 2)
    expect(v('custo_sql_meta')).toEqual([null, 1500 / 8]);
    expect(v('custo_agend')[1]).toBe(2000 / 4);
    expect(v('cac_ganho')[1]).toBe(2000 / 2);
    expect(v('pct_pago')).toEqual([1, 25 / 40]);
    expect(v('wa_disparos')).toEqual([0, 40]);
  });

  it('sem base, o valor é null (nunca zero) e o período em andamento é avisado', async () => {
    const { db } = dbFalso();
    const r = await montarScorecard(db, configVazia(), { produto: 'rh', visao: 'semana', n: 2, hoje: '2026-11-03' });
    expect(r.linhas.find((l) => l.id === 'cpl_google')!.valores[0]).toBeNull();
    expect(r.linhas.find((l) => l.id === 'taxa_ganho')!.valores[0]).toBeNull();
    expect(r.avisos.join(' ')).toMatch(/em andamento/);
    expect(r.periodos[1]!.parcial).toBe(true);
  });

  it('filtra só leads de fonte de Marketing do produto, por parâmetros', async () => {
    const { db, sqls } = dbFalso();
    await montarScorecard(db, configVazia(), { produto: 'clinic', visao: 'mes', n: 2, hoje: '2026-11-03' });
    const leads = sqls.find((q) => q.sql.includes('d.conta_como_lead'))!;
    expect(leads.sql).toMatch(/d\.produto = \$2/);
    expect(leads.sql).toMatch(/d\.fonte = any\(\$3::text\[\]\)/);
    expect(leads.sql).toMatch(/d\.tipo = 'Marketing'/);
    expect(leads.params).toEqual(['2026-10-01', 'clinic', ['Marketing [Google ADS]', 'Marketing [Meta ADS]', 'Marketing [Orgânico]', 'Marketing [Social]']]);
    expect(sqls.find((q) => q.sql.includes('ads_investimento_dia'))!.params).toEqual(['2026-10-01', 'clinic']);
  });

  it('só lê: nenhuma consulta escreve ou apaga nas visões de analytics', async () => {
    const { db, sqls } = dbFalso();
    await montarScorecard(db, configVazia(), { produto: 'rh', visao: 'semana', n: 2, hoje: '2026-11-03' });
    for (const q of sqls) expect(q.sql).not.toMatch(/\b(insert|update|delete|drop|truncate|alter)\b/i);
    const fonte = readFileSync('studio/lib/scorecard.ts', 'utf8');
    expect([...fonte.matchAll(/\b(?:insert into|update(?! set)|delete from)\s+([a-z_.]+)/gi)].map((m) => m[1])).toEqual(['ops.cfg_scorecard']);
  });

  it('todas as linhas pedidas existem: SQL, agendamento, proposta, fechamento, contratação, ganhos, perdidos, taxas e custos', () => {
    const ids = LINHAS.map((l) => l.id);
    for (const id of ['sql_total', 'agend_total', 'prop_total', 'fech_total', 'contr_total', 'ganhos', 'perdidos', 'cv_sql_agend', 'cv_agend_prop', 'cv_prop_fech', 'cv_fech_contr', 'custo_sql', 'custo_agend', 'custo_prop', 'custo_fech', 'custo_contr', 'cac_ganho']) expect(ids, id).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('o scorecard padrão funciona antes de a tabela das métricas próprias existir', async () => {
    const { db } = dbFalso({ sem42P01: true });
    const r = await new PgScorecardRepo(db).scorecard({ produto: 'rh', visao: 'semana', n: 2 });
    expect(r.linhas.length).toBe(LINHAS.length);
  });
});

describe('Scorecard: métricas acrescentadas à mão', () => {
  const cat: CatalogoVisoes = {
    site_dia: { colunas: [{ nome: 'dia', tipo: 'data' }, { nome: 'sessoes', tipo: 'numero' }, { nome: 'host', tipo: 'outro' }], temProduto: false },
    meta_x: { colunas: [{ nome: 'dia', tipo: 'data' }, { nome: 'produto', tipo: 'outro' }, { nome: 'gasto', tipo: 'numero' }], temProduto: true },
  };
  const ok = { tipo: 'coluna', rotulo: 'Sessões do site', visao: 'site_dia', colData: 'dia', colValor: 'sessoes', agg: 'soma', fmt: 'int' };

  it('aceita coluna que existe e devolve versão limpa com ID próprio', () => {
    const m = validarMetrica(ok, cat, []) as Extract<MetricaCustom, { tipo: 'coluna' }>;
    expect(m).toMatchObject({ tipo: 'coluna', id: 'c_sessoes_do_site', visao: 'site_dia', colValor: 'sessoes', porProduto: false });
    expect(validarMetrica(ok, cat, [m]).id).toBe('c_sessoes_do_site_2'); // repetido ganha sufixo
    expect((validarMetrica({ ...ok, visao: 'meta_x', colValor: 'gasto' }, cat, []) as typeof m).porProduto).toBe(true);
    expect((validarMetrica({ ...ok, agg: 'contagem', colValor: null }, cat, []) as typeof m).colValor).toBeNull();
  });

  it('recusa nome que não existe no banco, injeção de SQL, coluna do tipo errado, formato e nome inválidos', () => {
    const erro = (m: unknown) => expect(() => validarMetrica(m, cat, [])).toThrow(ScorecardInvalido);
    erro({ ...ok, visao: 'deals; drop table x' });
    erro({ ...ok, visao: 'crm.deals' });
    erro({ ...ok, visao: 'nao_existe' });
    erro({ ...ok, colData: 'sessoes' }); // número não é data
    erro({ ...ok, colValor: 'host' }); // texto não é número
    erro({ ...ok, colValor: 'sessoes"); delete from x; --' });
    erro({ ...ok, fmt: 'euros' });
    erro({ ...ok, agg: 'drop' });
    erro({ ...ok, rotulo: '  ' });
    erro({ ...ok, rotulo: 'x'.repeat(81) });
    erro({ tipo: 'qualquer' });
    erro(null);
  });

  it('razão: só entre métricas que existem; a métrica própria entra na tabela', async () => {
    const col = validarMetrica(ok, cat, []);
    expect(validarMetrica({ tipo: 'razao', rotulo: 'Leads por sessão', a: 'leads_total', b: col.id, fmt: 'pct' }, cat, [col])).toMatchObject({ tipo: 'razao', a: 'leads_total', b: 'c_sessoes_do_site' });
    expect(() => validarMetrica({ tipo: 'razao', rotulo: 'x', a: 'leads_total', b: 'nada', fmt: 'pct' }, cat, [col])).toThrow(ScorecardInvalido);

    const { db, sqls } = dbFalso();
    const razao = validarMetrica({ tipo: 'razao', rotulo: 'Leads por sessão', a: 'leads_total', b: col.id, fmt: 'pct' }, cat, [col]);
    const r = await montarScorecard(db, { versao: 1, metricas: [col, razao] }, { produto: 'rh', visao: 'semana', n: 2, hoje: '2026-11-03' });
    const sess = r.linhas.find((l) => l.id === 'c_sessoes_do_site')!;
    expect(sess).toMatchObject({ custom: true, grupo: 'Minhas métricas' });
    expect(sess.valores).toEqual([0, 150]); // semana de 24/10 sem linhas = 0 (soma); semana de 31/10 = 100 + 50
    expect(r.linhas.find((l) => l.id === razao.id)!.valores).toEqual([null, 40 / 150]); // 0 no denominador = sem base
    const consulta = sqls.find((q) => q.sql.includes('analytics."site_dia"'))!;
    expect(consulta.sql).toMatch(/"dia"::date between \$1::date and \$2::date/);
    expect(consulta.params).toEqual(['2026-10-24', '2026-11-03']); // valores como parâmetros
  });

  it('a visão com coluna produto é filtrada pelo produto escolhido', async () => {
    const col = validarMetrica({ ...ok, rotulo: 'Gasto x', visao: 'meta_x', colValor: 'gasto', fmt: 'brl' }, cat, []);
    const { db, sqls } = dbFalso();
    await montarScorecard(db, { versao: 1, metricas: [col] }, { produto: 'clinic', visao: 'semana', n: 2, hoje: '2026-11-03' });
    const q = sqls.find((x) => x.sql.includes('analytics."meta_x"'))!;
    expect(q.sql).toMatch(/and produto = \$3/);
    expect(q.params).toEqual(['2026-10-24', '2026-11-03', 'clinic']);
  });

  it('uma métrica cuja visão sumiu do banco vira aviso, não quebra a tela', async () => {
    const fantasma = { tipo: 'coluna', id: 'c_fantasma', rotulo: 'Fantasma', visao: 'view_que_sumiu', colData: 'dia', colValor: null, agg: 'contagem', fmt: 'int', porProduto: false } as MetricaCustom;
    const { db } = dbFalso();
    const r = await montarScorecard(db, { versao: 1, metricas: [fantasma] }, { produto: 'rh', visao: 'semana', n: 2, hoje: '2026-11-03' });
    expect(r.linhas.find((l) => l.id === 'c_fantasma')).toBeUndefined();
    expect(r.avisos.join(' ')).toMatch(/Fantasma/);
    expect(r.linhas.length).toBe(LINHAS.length);
  });

  it('grava e remove pelo repositório (e a razão que dependia da métrica removida some junto)', async () => {
    let guardado: unknown = null;
    const db = { query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('information_schema')) return (await dbFalso().db.query(sql)) as never;
      if (/insert into ops\.cfg_scorecard/.test(sql)) { guardado = JSON.parse(String(params![0])); return { rows: [] }; }
      if (sql.includes('from ops.cfg_scorecard')) return { rows: guardado ? [{ config: guardado }] : [] };
      return { rows: [] };
    } };
    const repo = new PgScorecardRepo(db as never);
    const a = await repo.adicionar(ok);
    await repo.adicionar({ tipo: 'razao', rotulo: 'Leads por sessão', a: 'leads_total', b: a.id, fmt: 'pct' });
    expect((guardado as { metricas: unknown[] }).metricas).toHaveLength(2);
    await repo.remover(a.id);
    expect((guardado as { metricas: unknown[] }).metricas).toHaveLength(0);
    await expect(repo.remover('c_nao_existe')).rejects.toThrow(ScorecardInvalido);
  });
});

describe('Scorecard: migration 0037', () => {
  it('é aditiva, só dá acesso ao papel do painel e não guarda dado', () => {
    const sql = readFileSync('supabase/migrations/0037_scorecard_config.sql', 'utf8').replace(/--.*$/gm, '');
    expect(sql).toMatch(/create table ops\.cfg_scorecard/);
    expect(sql).not.toMatch(/\b(drop|delete|truncate|rename)\b/i);
    expect(sql).not.toMatch(/\b(public|core|orq|crm|raw|mkt)\./);
    expect([...sql.matchAll(/alter table [^;]+;/gi)].every((x) => /enable row level security/i.test(x[0]))).toBe(true);
    expect([...sql.matchAll(/(?:grant [^;]+|create policy [^;]+) to ([a-z_]+)/gi)].every((x) => x[1] === 'orq_panel')).toBe(true);
  });
});

describe('Scorecard: rotas do Studio', () => {
  let server: Server, base: string, dir: string;
  const chamadas: unknown[] = [];
  const repo: ScorecardRepo = {
    scorecard: async (o) => { chamadas.push(o); return { produto: o.produto, visao: o.visao, periodos: [], linhas: [], avisos: [], geradoEm: '' }; },
    catalogo: async () => ({ visoes: {}, padrao: [], personalizadas: [] }),
    adicionar: async (m) => { if ((m as { tipo?: string })?.tipo !== 'razao') throw new ScorecardInvalido('inválida'); return { tipo: 'razao', id: 'c_x', rotulo: 'x', a: 'a', b: 'b', fmt: 'pct' }; },
    remover: async (id) => { chamadas.push(id); },
  };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sc-srv-'));
    server = createStudioServer({ formsDir: join(dir, 'f'), publicDir: join(process.cwd(), 'studio', 'public'), trackingDir: dir, sources: [], dbInfo: () => ({ connected: false }), submit: async () => ({ status: 200, body: {} }), scorecard: repo });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  const j = (rota: string, method = 'GET', corpo?: unknown) => fetch(base + rota, { method, headers: { 'content-type': 'application/json' }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });

  it('abre a página e valida produto, visão e quantidade de períodos', async () => {
    expect((await fetch(`${base}/scorecard`)).status).toBe(200);
    expect((await j('/api/scorecard?produto=rh&visao=semana&n=12')).status).toBe(200);
    expect(chamadas.at(-1)).toEqual({ produto: 'rh', visao: 'semana', n: 12 });
    expect((await j('/api/scorecard')).status).toBe(200); // padrão: rh, semana, 12
    expect((await j('/api/scorecard?produto=x')).status).toBe(400);
    expect((await j('/api/scorecard?visao=ano')).status).toBe(400);
    expect((await j('/api/scorecard?n=500')).status).toBe(400);
    expect((await j('/api/scorecard?n=1')).status).toBe(400);
  });

  it('acrescenta e remove métricas com validação', async () => {
    expect((await j('/api/scorecard/metricas', 'POST', { tipo: 'razao' })).status).toBe(201);
    expect((await j('/api/scorecard/metricas', 'POST', { tipo: 'coluna' })).status).toBe(400);
    expect((await j('/api/scorecard/metricas/c_sessoes_do_site', 'DELETE', {})).status).toBe(200);
    expect(chamadas.at(-1)).toBe('c_sessoes_do_site');
    expect((await j('/api/scorecard/metricas/leads_total', 'DELETE', {})).status).toBe(404); // só IDs de métricas próprias (c_...)
    expect((await fetch(`${base}/api/scorecard/metricas`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' }, body: '{}' })).status).toBe(403);
  });

  it('sem banco do painel responde 503 com o que falta', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'sc-srv2-'));
    const s2 = createStudioServer({ formsDir: dir2, publicDir: join(process.cwd(), 'studio', 'public'), trackingDir: dir2, sources: [], dbInfo: () => ({ connected: false }), submit: async () => ({ status: 200, body: {} }) });
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    try {
      const r = await fetch(`http://127.0.0.1:${(s2.address() as AddressInfo).port}/api/scorecard`);
      expect(r.status).toBe(503);
      expect(((await r.json()) as { detail: string }).detail).toMatch(/PANEL_DB_URL/);
    } finally { s2.close(); rmSync(dir2, { recursive: true, force: true }); }
  });

  it('na versão publicada só o admin acrescenta ou remove métricas', () => {
    const fonte = readFileSync('studio/server.ts', 'utf8');
    expect(fonte).toMatch(/path\.startsWith\('\/api\/scorecard\/'\)\) && method !== 'GET'/);
  });
});
