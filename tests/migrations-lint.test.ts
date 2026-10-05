import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Impõe as regras obrigatórias do banco (seção 4 do MD) sobre os arquivos de migration:
 * - nada no schema public;
 * - somente aditivas: sem DROP, RENAME, mudança de tipo, TRUNCATE ou DELETE;
 * - todo objeto qualificado por schema;
 * - toda tabela criada tem RLS ativado.
 */
const DIR = join(__dirname, '..', 'supabase', 'migrations');
const OWN_SCHEMAS = ['core', 'orq', 'crm', 'mkt', 'analytics', 'raw', 'ops'];

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

function strip(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Divide em comandos respeitando corpos $$ ... $$ (funções). */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      cur += '$$';
      i++;
      continue;
    }
    const ch = sql[i]!;
    if (ch === ';' && !inDollar) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const all = files.map((f) => ({
  file: f,
  raw: readFileSync(join(DIR, f), 'utf8'),
}));
const stmts = all.flatMap(({ file, raw }) =>
  statements(strip(raw)).map((s) => ({ file, sql: s.replace(/\s+/g, ' ').toLowerCase() })),
);
const bodyOnly = (s: string) => s.replace(/\$\$[\s\S]*?\$\$/g, ' ');

describe('migrations (regras da seção 4)', () => {
  it('existem migrations', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('nomes seguem NNNN_descricao.sql, em ordem crescente', () => {
    for (const f of files) expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });

  it('regra 1: não toca no schema public', () => {
    for (const { file, sql } of stmts) {
      expect(sql, file).not.toMatch(/\bpublic\./);
      expect(sql, file).not.toMatch(/\bschema\s+public\b/);
      expect(sql, file).not.toMatch(/\bsearch_path\s*=\s*public\b/);
    }
  });

  it('regra 3: sem DROP, RENAME, mudança de tipo, TRUNCATE ou DELETE', () => {
    for (const { file, sql } of stmts) {
      const s = bodyOnly(sql);
      expect(s, `${file}: ${s.slice(0, 80)}`).not.toMatch(/\bdrop\b/);
      expect(s, file).not.toMatch(/\brename\b/);
      expect(s, file).not.toMatch(/\balter\s+column\b.*\btype\b/);
      expect(s, file).not.toMatch(/^truncate\b/);
      expect(s, file).not.toMatch(/^delete\s+from\b/);
      expect(s, file).not.toMatch(/^update\b/);
    }
  });

  it('tabelas, views e funções são criadas em schema próprio', () => {
    const re = /^create (?:or replace )?(?:table|view|function)(?: if not exists)? ([a-z_]+)\./;
    for (const { file, sql } of stmts) {
      if (!/^create (?:or replace )?(?:table|view|function)\b/.test(sql)) continue;
      const m = re.exec(sql);
      expect(m, `${file}: ${sql.slice(0, 80)}`).not.toBeNull();
      expect(OWN_SCHEMAS, file).toContain(m![1]);
    }
  });

  it('índices apontam para tabelas de schema próprio', () => {
    for (const { file, sql } of stmts) {
      if (!/^create (?:unique )?index\b/.test(sql)) continue;
      const m = / on ([a-z_]+)\./.exec(sql);
      expect(m, `${file}: ${sql.slice(0, 80)}`).not.toBeNull();
      expect(OWN_SCHEMAS).toContain(m![1]);
    }
  });

  it('schemas criados são apenas os do orquestrador', () => {
    for (const { sql } of stmts) {
      const m = /^create schema(?: if not exists)? ([a-z_]+)/.exec(sql);
      if (m) expect(OWN_SCHEMAS).toContain(m[1]);
    }
  });

  it('toda tabela criada tem RLS ativado', () => {
    const created = stmts
      .map((s) => /^create table(?: if not exists)? ([a-z_]+\.[a-z_]+)/.exec(s.sql)?.[1])
      .filter((x): x is string => !!x);
    expect(created.length).toBeGreaterThan(0);
    const enabled = new Set(
      stmts
        .map((s) => /^alter table ([a-z_]+\.[a-z_]+) enable row level security$/.exec(s.sql)?.[1])
        .filter((x): x is string => !!x),
    );
    for (const t of created) expect(enabled.has(t), `RLS ausente em ${t}`).toBe(true);
  });

  it('orq.events é protegida contra UPDATE, DELETE e TRUNCATE por trigger', () => {
    const triggers = stmts.filter((s) => /^create trigger\b/.test(s.sql) && s.sql.includes(' on orq.events'));
    const joined = triggers.map((t) => t.sql).join(' | ');
    expect(joined).toMatch(/before update or delete/);
    expect(joined).toMatch(/before truncate/);
  });
});
