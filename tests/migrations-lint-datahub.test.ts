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
  new Set(stmts.flatMap((s) => [...s.sql.matchAll(/\b(?:raw|crm|ops|core|orq|analytics)\.[a-z_]+/g)].map((m) => m[0])));

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
      const tbl = [...s.sql.matchAll(/\bon ((?:ops)\.[a-z_]+(?:, ops\.[a-z_]+)*) to/g)].flatMap((m) => m[1]!.split(', '));
      expect(tbl.length, s.sql).toBeGreaterThan(0);
      for (const t of tbl) expect(t, s.sql).toMatch(/^ops\.(cfg_[a-z_]+|sync_settings)$/);
      if (tbl.includes('ops.sync_settings')) expect(s.sql).toMatch(/update \(/); // só colunas listadas
    }
  });
  it('lê as views de analytics', () => {
    expect(grantsTo('orq_panel').some((s) => s.sql.includes('analytics.'))).toBe(true);
  });
});

describe('analytics tem só views', () => {
  it('nenhuma tabela é criada no schema analytics', () => {
    expect(all.filter((s) => /^create table (if not exists )?analytics\./.test(s.sql))).toEqual([]);
  });
});
