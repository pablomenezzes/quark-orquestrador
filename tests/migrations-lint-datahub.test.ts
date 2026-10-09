import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Privilégio mínimo dos papéis do Data Hub:
 *  - orq_sync  grava a sincronização (raw, crm, controle); NUNCA apaga; nunca toca em orq.*; em core só lê 3 colunas de leads.
 *  - orq_panel lê analytics e ops; grava SÓ a configuração; não enxerga raw, crm, core nem orq.
 */
const DIR = join(__dirname, '..', 'supabase', 'migrations');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const all = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .flatMap((f) => strip(readFileSync(join(DIR, f), 'utf8')).split(';').map((s) => ({ file: f, sql: s.replace(/\s+/g, ' ').trim().toLowerCase() })).filter((s) => s.sql));

const grantsTo = (role: string) => all.filter((s) => /^grant /.test(s.sql) && new RegExp(`\\bto ${role}\\b`).test(s.sql));
const policiesFor = (role: string) => all.filter((s) => /^create policy /.test(s.sql) && new RegExp(`\\bto ${role}\\b`).test(s.sql));
const tablesIn = (stmts: Array<{ sql: string }>) =>
  new Set(stmts.flatMap((s) => [...s.sql.matchAll(/\b(?:raw|crm|ops|core|orq|mkt|analytics)\.[a-z0-9_]+/g)].map((m) => m[0])));

describe.each(['orq_sync', 'orq_panel'])('papel %s', (role) => {
  it('é criado sem superusuário, sem criar banco/papéis, sem herdar, sem replicação e com limite de conexões', () => {
    const c = all.find((s) => new RegExp(`^create role ${role}\\b`).test(s.sql));
    expect(c, 'create role ausente').toBeTruthy();
    for (const f of ['login', 'nosuperuser', 'nocreatedb', 'nocreaterole', 'noinherit', 'noreplication']) expect(c!.sql).toContain(f);
    expect(c!.sql).toMatch(/connection limit \d+/);
    expect(c!.sql).not.toMatch(/bypassrls|\bpassword\b/);
  });

  it('não há senha em nenhuma migration (é definida por script)', () => {
    for (const s of all.filter((x) => x.sql.includes(role))) expect(s.sql).not.toMatch(/\bpassword\b\s*'/);
  });

  it('tem timeouts de instrução e de transação ociosa', () => {
    const sets = all.filter((s) => new RegExp(`^alter role ${role} set `).test(s.sql)).map((s) => s.sql).join(' | ');
    expect(sets).toContain('statement_timeout');
    expect(sets).toContain('idle_in_transaction_session_timeout');
  });

  it('nunca recebe "grant all", "with grant option", delete, truncate nem acesso para public/anon/authenticated', () => {
    for (const s of grantsTo(role)) {
      expect(s.sql).not.toMatch(/^grant all\b/);
      expect(s.sql).not.toMatch(/with grant option/);
      expect(s.sql).not.toMatch(/\b(delete|truncate|references|trigger)\b/);
    }
  });

  it('cada tabela que o papel acessa tem política de RLS para ele', () => {
    const granted = new Set(
      grantsTo(role)
        .filter((s) => !/^grant usage on schema/.test(s.sql))
        .flatMap((s) => [...s.sql.matchAll(/\bon (?:table )?((?:[a-z_]+\.[a-z_]+)(?:, [a-z_]+\.[a-z_]+)*) to/g)].flatMap((m) => m[1]!.split(', ')))
        .filter((t) => !t.startsWith('analytics.')), // analytics são views (sem RLS próprio)
    );
    const withPolicy = tablesIn(policiesFor(role));
    expect(granted.size).toBeGreaterThan(0);
    for (const t of granted) expect(withPolicy.has(t), `${role} sem política em ${t}`).toBe(true);
  });
});

describe('orq_sync (grava a sincronização)', () => {
  it('não tem NENHUM acesso a orq.* (eventos, touchpoints, decisões, fontes)', () => {
    const t = [...tablesIn(grantsTo('orq_sync'))];
    expect(t.filter((x) => x.startsWith('orq.'))).toEqual([]);
  });
  it('em core só lê colunas de core.leads (nunca a tabela inteira, nunca escreve)', () => {
    const core = grantsTo('orq_sync').filter((s) => s.sql.includes(' core.') && !/^grant usage/.test(s.sql));
    for (const s of core) {
      expect(s.sql).toMatch(/^grant select \(/);
      expect(s.sql).toContain('core.leads');
      expect(s.sql).not.toMatch(/\b(insert|update)\b/);
    }
  });
  it('grava em raw e crm só com select/insert/update', () => {
    for (const s of grantsTo('orq_sync').filter((x) => /\b(raw|crm)\./.test(x.sql))) {
      expect(s.sql).toMatch(/^grant (select|select, insert|select, insert, update) on /);
    }
  });
});

describe('orq_panel (Painel local)', () => {
  it('não tem NENHUM acesso a raw, crm, core nem orq (dados pessoais só pelas views)', () => {
    const t = [...tablesIn(grantsTo('orq_panel'))];
    expect(t.filter((x) => /^(raw|crm|core|orq)\./.test(x))).toEqual([]);
  });
  it('só escreve nas tabelas de configuração e nas colunas de frequência da sincronização', () => {
    const writers = grantsTo('orq_panel').filter((s) => /^grant (insert|update|select, insert|select, insert, update|update \()/.test(s.sql));
    expect(writers.length).toBeGreaterThan(0);
    for (const s of writers) {
      const tbl = [...s.sql.matchAll(/\bon ((?:ops|mkt)\.[a-z_]+(?:, (?:ops|mkt)\.[a-z_]+)*) to/g)].flatMap((m) => m[1]!.split(', '));
      expect(tbl.length, s.sql).toBeGreaterThan(0);
      // configuração: ops.cfg_*, frequência da sincronização e as regras de conversão do site (mkt.conversao_regras, sem delete)
      for (const t of tbl) expect(t, s.sql).toMatch(/^(ops\.(cfg_[a-z_]+|sync_settings)|mkt\.conversao_regras)$/);
      if (tbl.includes('ops.sync_settings')) expect(s.sql).toMatch(/update \(/); // só colunas listadas
    }
  });
  it('lê as views de analytics', () => {
    expect(grantsTo('orq_panel').some((s) => s.sql.includes('analytics.'))).toBe(true);
  });
});

describe('regras do funil (0005): status do negócio, MQL por motivo de perda, status que conta como lead', () => {
  const m5 = all.filter((s) => s.file.startsWith('0005_'));
  const sql5 = m5.map((s) => s.sql).join(' ; ');
  it('a etapa só guarda "chegou até aqui" (sql, reuniao, proposta): ganho, perdido, mql e lead ficam de fora', () => {
    const c = m5.find((s) => /add constraint cfg_stage_marco_chegou_ate/.test(s.sql));
    expect(c, 'restrição ausente').toBeTruthy();
    const lista = /marco in \(([^)]*)\)/.exec(c!.sql)![1]!.replace(/[' ]/g, '').split(',').sort();
    expect(lista).toEqual(['proposta', 'reuniao', 'sql']);
  });
  it('MQL nasce com exatamente os motivos 398, 185, 184 e 587 (IDs originais do Pipedrive)', () => {
    const ins = m5.find((s) => /^insert into ops\.cfg_motivo_perda/.test(s.sql))!;
    const ids = [...ins.sql.matchAll(/\((\d+), true\)/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
    expect(ids).toEqual([184, 185, 398, 587]);
  });
  it('os 4 status existem e "excluído" começa fora da contagem de leads', () => {
    const ins = m5.find((s) => /^insert into ops\.cfg_status_contagem/.test(s.sql))!;
    for (const st of ['open', 'won', 'lost']) expect(ins.sql).toContain(`('${st}', true)`);
    expect(ins.sql).toContain(`('deleted', false)`);
    expect(sql5).toMatch(/status in \('open','won','lost','deleted'\)/);
  });
  it('as duas tabelas têm RLS; o Painel só edita (sem delete) e o orq_sync só lê', () => {
    for (const t of ['ops.cfg_motivo_perda', 'ops.cfg_status_contagem']) {
      expect(sql5).toContain(`alter table ${t} enable row level security`);
    }
    expect(sql5).toMatch(/grant select on ops\.cfg_motivo_perda, ops\.cfg_status_contagem to orq_sync/);
    expect(sql5).toMatch(/grant select, insert, update on ops\.cfg_motivo_perda, ops\.cfg_status_contagem to orq_panel/);
  });
  it('as views novas existem e o Painel as lê', () => {
    expect(sql5).toMatch(/create view analytics\.motivos_perda/);
    expect(sql5).toMatch(/create view analytics\.contagem_status/);
    expect(sql5).toMatch(/grant select on analytics\.motivos_perda, analytics\.contagem_status to orq_panel/);
  });
});

describe('orq_chat (conector do Claude Desktop): só leitura, só analytics, sem dados pessoais', () => {
  const mine = all.filter((s) => s.file.startsWith('0012_'));
  const grants = grantsTo('orq_chat');
  it('é criado sem superusuário, sem criar banco/papéis, sem herdar, sem replicação, com limite de conexões e sem senha', () => {
    const cr = all.find((s) => /^create role orq_chat\b/.test(s.sql));
    expect(cr, 'create role ausente').toBeTruthy();
    for (const f of ['login', 'nosuperuser', 'nocreatedb', 'nocreaterole', 'noinherit', 'noreplication']) expect(cr!.sql).toContain(f);
    expect(cr!.sql).toMatch(/connection limit \d+/);
    expect(cr!.sql).not.toMatch(/bypassrls|\bpassword\b/);
    for (const s of all.filter((x) => x.sql.includes('orq_chat'))) expect(s.sql).not.toMatch(/\bpassword\b\s*'/);
  });
  it('tem tempo máximo de consulta e fica em modo somente leitura por padrão', () => {
    const sets = all.filter((s) => /^alter role orq_chat set /.test(s.sql)).map((s) => s.sql).join(' | ');
    expect(sets).toContain('statement_timeout');
    expect(sets).toContain('idle_in_transaction_session_timeout');
    expect(sets).toContain('default_transaction_read_only = on');
  });
  it('só recebe SELECT (nunca escrita, grant all, with grant option nem acesso para public)', () => {
    expect(grants.length).toBeGreaterThan(0);
    for (const s of grants.filter((x) => !/^grant usage on schema/.test(x.sql))) {
      expect(s.sql, s.sql).toMatch(/^grant select\b/);
      expect(s.sql).not.toMatch(/\b(insert|update|delete|truncate|references|trigger)\b|with grant option|grant all/);
    }
  });
  it('só enxerga o schema analytics', () => {
    const t = [...tablesIn(grants)];
    expect(t.filter((x) => !x.startsWith('analytics.'))).toEqual([]);
    expect(grants.filter((x) => /^grant usage on schema/.test(x.sql)).map((x) => x.sql)).toEqual(['grant usage on schema analytics to orq_chat']);
  });
  it('nunca recebe visões com dados pessoais', () => {
    const t = [...tablesIn(grants)];
    for (const v of ['pessoas', 'organizacoes', 'vinculos', 'usuarios', 'campos', 'deal_campos']) expect(t, v).not.toContain(`analytics.${v}`);
  });
  it('as visões com o título do negócio (nome de pessoa) só são liberadas por COLUNA, sem o título', () => {
    for (const v of ['analytics.deals', 'analytics.negocios_bi']) {
      const g = grants.filter((x) => new RegExp(`\\bon ${v.replace('.', '\\.')}\\b`).test(x.sql));
      expect(g.length, v).toBe(1);
      expect(g[0]!.sql, v).toMatch(/^grant select \(/);
      expect(g[0]!.sql, v).not.toMatch(/\btitulo\b/);
    }
    expect(mine.length).toBeGreaterThan(0);
  });
});

describe('analytics tem só views', () => {
  it('nenhuma tabela é criada no schema analytics', () => {
    expect(all.filter((s) => /^create table (if not exists )?analytics\./.test(s.sql))).toEqual([]);
  });
});
