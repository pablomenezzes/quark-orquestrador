import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Princípio do privilégio mínimo para o papel do endpoint (orq_ingest).
 * Lê todas as migrations e confere o que elas concedem a esse papel.
 */
const DIR = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; cur += '$$'; i++; continue; }
    const ch = sql[i]!;
    if (ch === ';' && !inDollar) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const all = files.flatMap((f) => statements(strip(readFileSync(join(DIR, f), 'utf8'))).map((s) => ({ file: f, sql: s.replace(/\s+/g, ' ').toLowerCase() })));
const forRole = all.filter((s) => s.sql.includes('orq_ingest'));

describe('papel orq_ingest (privilégio mínimo)', () => {
  it('existe uma migration que cria o papel', () => {
    expect(all.some((s) => /^create role orq_ingest\b/.test(s.sql))).toBe(true);
  });

  it('o papel é criado sem superusuário, sem criar banco/papéis, sem herdar e sem BYPASSRLS', () => {
    const c = all.find((s) => /^create role orq_ingest\b/.test(s.sql))!.sql;
    expect(c).toMatch(/\blogin\b/);
    for (const flag of ['nosuperuser', 'nocreatedb', 'nocreaterole', 'noinherit', 'noreplication']) expect(c).toContain(flag);
    expect(c).not.toMatch(/\bbypassrls\b|\bsuperuser\b(?<!no\bsuperuser)/);
    expect(c).toMatch(/connection limit \d+/);
  });

  it('a migration não contém senha (ela é definida por script, fora do versionamento)', () => {
    for (const s of forRole) expect(s.sql, s.file).not.toMatch(/\bpassword\b\s*'/);
  });

  it('tem timeouts de instrução e de transação ociosa', () => {
    const sets = all.filter((s) => /^alter role orq_ingest set /.test(s.sql)).map((s) => s.sql).join(' | ');
    expect(sets).toContain('statement_timeout');
    expect(sets).toContain('idle_in_transaction_session_timeout');
  });

  it('nunca recebe grant all, grant em schema crm/mkt/analytics/public, nem para PUBLIC/anon/authenticated', () => {
    for (const s of forRole.filter((x) => /^grant /.test(x.sql))) {
      expect(s.sql, s.file).not.toMatch(/^grant all\b/);
      expect(s.sql, s.file).not.toMatch(/\b(crm|mkt|analytics|public)\./);
      expect(s.sql, s.file).not.toMatch(/\bto (public|anon|authenticated|service_role)\b/);
      expect(s.sql, s.file).not.toMatch(/\bwith grant option\b/);
    }
  });

  it('em orq.events só pode inserir e ler a coluna id: sem update, delete nem truncate', () => {
    const ev = forRole.filter((s) => /^grant /.test(s.sql) && s.sql.includes(' orq.events '));
    expect(ev.length).toBeGreaterThan(0);
    for (const s of ev) {
      expect(s.sql).not.toMatch(/\b(update|delete|truncate|references|trigger)\b/);
      if (/\bselect\b/.test(s.sql)) expect(s.sql).toMatch(/select \(id\)/);
    }
  });

  it('em core.leads não recebe delete nem truncate, e update só em colunas listadas', () => {
    const l = forRole.filter((s) => /^grant /.test(s.sql) && s.sql.includes(' core.leads '));
    for (const s of l) {
      expect(s.sql).not.toMatch(/\b(delete|truncate)\b/);
      if (/\bupdate\b/.test(s.sql)) expect(s.sql).toMatch(/update \(/);
    }
  });

  it('as policies de RLS do papel são todas "to orq_ingest" e nunca usam "to public"', () => {
    const pol = all.filter((s) => /^create policy /.test(s.sql) && s.sql.includes('orq_ingest'));
    expect(pol.length).toBeGreaterThan(0);
    for (const s of pol) {
      expect(s.sql).toMatch(/ to orq_ingest\b/);
      expect(s.sql).not.toMatch(/ to public\b/);
    }
  });

  it('cada tabela que o papel acessa tem pelo menos uma policy para ele', () => {
    const granted = new Set(forRole.filter((s) => /^grant /.test(s.sql)).map((s) => / on (?:table )?([a-z_]+\.[a-z_]+) /.exec(s.sql + ' ')?.[1]).filter((x): x is string => !!x));
    const withPolicy = new Set(all.filter((s) => /^create policy /.test(s.sql)).map((s) => / on ([a-z_]+\.[a-z_]+) /.exec(s.sql + ' ')?.[1]).filter((x): x is string => !!x));
    expect(granted.size).toBeGreaterThan(0);
    for (const t of granted) expect(withPolicy.has(t), `sem policy para orq_ingest em ${t}`).toBe(true);
  });
});
