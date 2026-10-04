import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { PgStore } from '../../src/db/pg-store';
import { ingest } from '../../src/pipeline/ingest';
import { hashToken } from '../../src/security/verify-token';
import type { IngestRequest } from '../../src/pipeline/types';
import { connect, hasDbConfig, schemaReady, snapshot } from './helpers';

/**
 * Pipeline completo contra o Postgres real, dentro de uma transação que termina em ROLLBACK.
 * Nenhum dado de teste permanece (regra 5 da seção 4). Pulado sem SUPABASE_DB_URL ou sem migrations.
 */
let client: pg.Client | null = null;
let before: Record<string, number> = {};
let ready = false;

if (hasDbConfig) {
  client = await connect();
  ready = await schemaReady(client);
  if (ready) before = await snapshot(client);
  else await client.end();
}

const run = describe.skipIf(!ready);

run('ingest + Postgres (transação com rollback)', () => {
  const c = () => client!;
  const uid = crypto.randomUUID().slice(0, 8);
  const TOKEN = `tok-${crypto.randomUUID()}`;
  const slug = `it-lp-${uid}`;
  const deps = () => ({ store: PgStore.fromOpenTransaction(c()), shadowMode: true });

  const body = (over: Record<string, unknown> = {}) => ({
    source_slug: slug,
    form_id: 'form-demo',
    lp_id: slug,
    event_id: `it-evt-${crypto.randomUUID()}`,
    lead_id: null,
    event_type: 'form_submit',
    contact: { name: 'Teste', email: `it-${crypto.randomUUID()}@teste.invalid`, phone: '', company: 'Acme', company_size: 12, role: 'RH' },
    attribution: { utm_source: 'google', utm_medium: 'cpc', gclid: 'G1', landing_url: 'https://lp.teste.invalid/rh/?x=1' },
    consent: { marketing: true, analytics: true },
    ...over,
  });
  const req = (b: unknown): IngestRequest => ({ body: b, query: {}, headers: { 'x-quark-token': TOKEN, 'user-agent': 'vitest' }, ip: '10.0.0.1' });
  const count = async (sql: string, p: unknown[] = []) => Number((await c().query(sql, p)).rows[0].n);

  beforeAll(async () => {
    await c().query('begin');
    await c().query(`insert into orq.sources (slug, tipo, produto, token_hash) values ($1, 'vercel', 'rh', $2)`, [slug, hashToken(TOKEN)]);
  });

  afterAll(async () => {
    await c().query('rollback');
    const after = await snapshot(c());
    await c().end();
    expect(after).toEqual(before);
  });

  it('grava lead, touchpoint, evento imutável e decisão em modo sombra', async () => {
    const b = body();
    const r = await ingest(req(b), deps());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ duplicate: false, canal: 'paid_search_google', modo: 'sombra' });

    const tp = (await c().query(`select * from orq.touchpoints where event_id = $1`, [b.event_id])).rows[0];
    expect(tp).toMatchObject({ canal: 'paid_search_google', gclid: 'G1', landing_url: 'https://lp.teste.invalid/rh' });

    const ev = (await c().query(`select * from orq.events where touchpoint_id = $1`, [tp.id])).rows[0];
    expect(ev.tipo).toBe('form_submit');
    expect(ev.dados.consent).toEqual({ marketing: true, analytics: true });
    expect(ev.dados.ip).toBe('10.0.0.1');

    const d = (await c().query(`select * from orq.decisions where event_id = $1`, [ev.id])).rows[0];
    expect(d).toMatchObject({ modo: 'sombra', status: 'ok' });
  });

  it('simulação (dryRun) roda o pipeline inteiro no Postgres e desfaz tudo', async () => {
    const b = body();
    const n = async () => [
      await count(`select count(*)::int as n from core.leads`),
      await count(`select count(*)::int as n from orq.touchpoints`),
      await count(`select count(*)::int as n from orq.events`),
      await count(`select count(*)::int as n from orq.decisions`),
    ];
    const before = await n();
    const r = await ingest(req(b), { ...deps(), dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dry_run: true, canal: 'paid_search_google' });
    expect((r.body.preview as any).lead.created).toBe(true);
    expect(await n()).toEqual(before);
    // o mesmo event_id continua livre: a simulação não o consumiu
    const again = await ingest(req(b), { ...deps(), dryRun: true });
    expect(again.body.duplicate).toBe(false);
  });

  it('idempotência: o mesmo event_id não grava de novo', async () => {
    const b = body();
    await ingest(req(b), deps());
    const n1 = await count(`select count(*)::int as n from orq.events`);
    const again = await ingest(req(b), deps());
    expect(again.body).toMatchObject({ ok: true, duplicate: true });
    expect(await count(`select count(*)::int as n from orq.events`)).toBe(n1);
    expect(await count(`select count(*)::int as n from orq.touchpoints where event_id = $1`, [b.event_id])).toBe(1);
  });

  it('e-mail pesa mais que o cookie: lead_id de A com e-mail de outra pessoa não anexa ao A', async () => {
    const first = body();
    const a = await ingest(req(first), deps());
    const leadA = a.body.lead_id as string;

    const second = body({ lead_id: leadA, contact: { name: 'Outra Pessoa', email: `it-${crypto.randomUUID()}@teste.invalid` } });
    const b = await ingest(req(second), deps());
    expect(b.status).toBe(200);
    expect(b.body.lead_id).not.toBe(leadA);

    const tp = (await c().query(`select lead_id from orq.touchpoints where event_id = $1`, [second.event_id])).rows[0];
    expect(tp.lead_id).not.toBe(leadA);
    const leadRow = (await c().query(`select nome from core.leads where id = $1`, [leadA])).rows[0];
    expect(leadRow.nome).toBe('Teste');
  });

  it('o mesmo e-mail reaproveita o lead (dedupe) e completa só o que falta', async () => {
    const email = `it-${crypto.randomUUID()}@teste.invalid`;
    const a = await ingest(req(body({ contact: { email } })), deps());
    const b = await ingest(req(body({ contact: { email: email.toUpperCase(), name: 'Nome Novo' } })), deps());
    expect(b.body.lead_id).toBe(a.body.lead_id);
    const lead = (await c().query(`select nome, email_norm from core.leads where id = $1`, [a.body.lead_id])).rows[0];
    expect(lead).toMatchObject({ nome: 'Nome Novo', email_norm: email });
  });

  it('erro no meio: nada parcial, e o evento bruto fica registrado com decisão em erro', async () => {
    const b = body({ contact: { email: `it-${crypto.randomUUID()}@teste.invalid` } });
    // Força a falha no INSERT do evento: occurred_at inválido para timestamptz não passa pelo zod
    // (ele é normalizado), então simulamos a falha com um store que quebra na 1ª inserção de evento com lead.
    const store = PgStore.fromOpenTransaction(c());
    const real = store.withTransaction.bind(store);
    let armed = true;
    store.withTransaction = (async (fn: any) =>
      real(async (tx: any) => {
        const insertEvent = tx.insertEvent.bind(tx);
        tx.insertEvent = async (e: any) => {
          if (armed && e.lead_id !== null) {
            armed = false;
            throw new Error('falha simulada');
          }
          return insertEvent(e);
        };
        return fn(tx);
      })) as typeof store.withTransaction;

    const r = await ingest(req(b), { store, shadowMode: true });
    expect(r.status).toBe(500);
    expect(await count(`select count(*)::int as n from orq.touchpoints where event_id = $1`, [b.event_id])).toBe(0);
    const ev = (await c().query(`select id, lead_id, payload_bruto from orq.events where payload_bruto->>'event_id' = $1`, [b.event_id])).rows[0];
    expect(ev.lead_id).toBeNull();
    const d = (await c().query(`select status, erro from orq.decisions where event_id = $1`, [ev.id])).rows[0];
    expect(d).toMatchObject({ status: 'erro', erro: 'falha simulada' });

    // A retentativa não é duplicada.
    const retry = await ingest(req(b), deps());
    expect(retry.body.duplicate).toBe(false);
  });
});
