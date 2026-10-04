import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { PgStore } from '../../src/db/pg-store';
import { ingest } from '../../src/pipeline/ingest';
import { hashToken } from '../../src/security/verify-token';
import { connect, hasDbConfig, schemaReady, snapshot } from './helpers';

/**
 * Prova do privilégio mínimo: dentro de uma transação (rollback no fim), assume o papel orq_ingest
 * (SET LOCAL ROLE) e confere (1) que o pipeline completo funciona e (2) que o resto está proibido.
 * Pulado até a migration 0003 ser aplicada.
 */
let client: pg.Client | null = null;
let before: Record<string, number> = {};
let ready = false;

if (hasDbConfig) {
  client = await connect();
  ready = await schemaReady(client);
  if (ready) {
    const r = await client.query(`select exists (select 1 from pg_roles where rolname = 'orq_ingest') as ok, to_regclass('orq.rate_limits') is not null as rl`);
    ready = r.rows[0].ok === true && r.rows[0].rl === true;
  }
  if (ready) before = await snapshot(client);
  else await client.end();
}

const run = describe.skipIf(!ready);

run('orq_ingest (transação com rollback)', () => {
  const c = () => client!;
  const uid = crypto.randomUUID().slice(0, 8);
  const TOKEN = `tok-${crypto.randomUUID()}`;
  const slug = `it-role-${uid}`;
  const body = (over: Record<string, unknown> = {}) => ({
    source_slug: slug, form_id: 'f', event_id: `it-role-${crypto.randomUUID()}`, event_type: 'form_submit',
    contact: { name: 'Teste Papel', email: `it-${crypto.randomUUID()}@teste.invalid`, phone: '', company: 'Acme' },
    attribution: { utm_source: 'google', utm_medium: 'cpc', gclid: 'G1', landing_url: 'https://lp.teste.invalid/x?y=1' },
    consent: { marketing: true, analytics: true }, ...over,
  });
  const req = (b: unknown) => ({ body: b, query: {}, headers: { 'x-quark-token': TOKEN }, ip: '10.0.0.1' });

  async function denied(sql: string, params: unknown[] = []): Promise<string> {
    await c().query('savepoint d');
    try {
      await c().query(sql, params);
      return 'NO_ERROR';
    } catch (e) {
      return (e as { code?: string }).code ?? 'UNKNOWN';
    } finally {
      await c().query('rollback to savepoint d');
    }
  }

  beforeAll(async () => {
    await c().query('begin');
    // a fonte é criada como dono; depois assume o papel mínimo
    await c().query(`insert into orq.sources (slug, tipo, produto, token_hash, url) values ($1, 'vercel', 'rh', $2, 'https://lp.teste.invalid')`, [slug, hashToken(TOKEN)]);
    await c().query('set local role orq_ingest');
  });

  afterAll(async () => {
    await c().query('reset role');
    await c().query('rollback');
    expect(await snapshot(c())).toEqual(before);
    await c().end();
  });

  it('o pipeline completo funciona só com os privilégios do papel (grava lead, touchpoint, evento e decisão)', async () => {
    const r = await ingest(req(body()), { store: PgStore.fromOpenTransaction(c()), shadowMode: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, duplicate: false, modo: 'sombra' });
  });

  it('o dedupe (SELECT em leads) e o preenchimento (UPDATE por coluna) funcionam', async () => {
    const email = `it-${crypto.randomUUID()}@teste.invalid`;
    const a = await ingest(req(body({ contact: { email } })), { store: PgStore.fromOpenTransaction(c()), shadowMode: true });
    const b = await ingest(req(body({ contact: { email, name: 'Nome Novo' } })), { store: PgStore.fromOpenTransaction(c()), shadowMode: true });
    expect(b.body.lead_id).toBe(a.body.lead_id);
  });

  it('o contador de limite funciona e conta a partir de 1', async () => {
    const store = PgStore.fromOpenTransaction(c());
    const bucket = `it-bucket-${crypto.randomUUID()}`;
    const a = await store.hit(bucket, 600);
    const b = await store.hit(bucket, 600);
    expect(a.hits).toBe(1);
    expect(b.hits).toBe(2);
    expect(b.resetInSec).toBeGreaterThan(0);
    expect(b.resetInSec).toBeLessThanOrEqual(600);
  });

  it('lista as origens das fontes ativas', async () => {
    const urls = await PgStore.fromOpenTransaction(c()).listSourceUrls();
    expect(urls).toContain('https://lp.teste.invalid');
  });

  it('NÃO pode alterar nem apagar eventos, decisões nem touchpoints', async () => {
    for (const sql of [
      `update orq.events set tipo = 'x'`, `delete from orq.events`, `truncate orq.events`,
      `update orq.decisions set status = 'ok'`, `delete from orq.decisions`,
      `update orq.touchpoints set canal = 'x'`, `delete from orq.touchpoints`,
      `delete from core.leads`, `truncate core.leads`,
    ]) expect(await denied(sql), sql).toBe('42501');
  });

  it('NÃO pode ler o conteúdo dos eventos (payload_bruto, dados) nem os campos pessoais de touchpoints', async () => {
    expect(await denied(`select payload_bruto from orq.events`)).toBe('42501');
    expect(await denied(`select dados from orq.events`)).toBe('42501');
    expect(await denied(`select landing_url from orq.touchpoints`)).toBe('42501');
    expect(await denied(`select * from orq.decisions`)).toBe('42501');
  });

  it('NÃO pode alterar fontes nem regras, e NÃO enxerga crm', async () => {
    expect(await denied(`update orq.sources set ativo = false`)).toBe('42501');
    expect(await denied(`insert into orq.sources (slug, tipo, token_hash) values ('x','vercel','h')`)).toBe('42501');
    expect(await denied(`select * from orq.rules`)).toBe('42501');
    expect(await denied(`select * from crm.deals`)).toBe('42501');
    expect(await denied(`select * from crm.stage_history`)).toBe('42501');
  });

  it('NÃO pode criar objetos nem mexer em privilégios', async () => {
    expect(await denied(`create table core.invasor (x int)`)).toBe('42501');
    expect(await denied(`create schema invasor`)).toBe('42501');
    expect(await denied(`create role invasor`)).toBe('42501');
    expect(await denied(`grant all on core.leads to public`)).toBe('42501');
    expect(await denied(`alter role orq_ingest superuser`)).toBe('42501');
  });

  it('o papel não é superusuário e não ignora RLS', async () => {
    const r = await c().query(`select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication from pg_roles where rolname = current_user`);
    expect(r.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false });
    expect((await c().query('select current_user as u')).rows[0].u).toBe('orq_ingest');
  });

  it('o schema public continua sem tabelas acessíveis', async () => {
    const r = await c().query(`select count(*)::int as n from information_schema.tables where table_schema = 'public'`);
    expect(r.rows[0].n).toBe(0);
  });
});
