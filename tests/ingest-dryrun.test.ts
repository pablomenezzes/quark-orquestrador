import { describe, it, expect, beforeEach } from 'vitest';
import { ingest } from '../src/pipeline/ingest';
import type { IngestRequest } from '../src/pipeline/types';
import { MemoryStore } from './helpers/memory-store';

const TOKEN = 'tok-dry';
const UUID_A = '11111111-1111-4111-8111-111111111111';
let store: MemoryStore;

const body = (over: Record<string, unknown> = {}) => ({
  source_slug: 'lp-vercel',
  form_id: 'form-demo',
  lp_id: 'studio-demo',
  event_id: 'evt-dry-0001',
  event_type: 'form_submit',
  contact: { name: 'Maria', email: ' Maria@X.com ', phone: '(84) 99999-9999', company: 'Acme', company_size: 15, role: 'RH' },
  attribution: { utm_source: 'google', utm_medium: 'cpc', gclid: 'G1', landing_url: 'https://x.test/lp/?a=1' },
  consent: { marketing: true, analytics: false },
  ...over,
});
const req = (b: unknown): IngestRequest => ({ body: b, query: {}, headers: { 'x-quark-token': TOKEN }, ip: null });
const dry = () => ({ store, shadowMode: true, dryRun: true });
const real = () => ({ store, shadowMode: true });
const counts = () => ({
  leads: store.state.leads.length,
  touchpoints: store.state.touchpoints.length,
  events: store.state.events.length,
  decisions: store.state.decisions.length,
});
const ZERO = { leads: 0, touchpoints: 0, events: 0, decisions: 0 };

beforeEach(() => {
  store = new MemoryStore();
  store.addSource({ slug: 'lp-vercel', tipo: 'vercel', produto: 'rh', token: TOKEN });
});

describe('ingest em modo simulação (dryRun)', () => {
  it('devolve o que seria gravado, mas não grava nada', async () => {
    const r = await ingest(req(body()), dry());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, dry_run: true, duplicate: false, canal: 'paid_search_google', modo: 'sombra' });
    const p = r.body.preview as any;
    expect(p.lead).toMatchObject({ created: true, matched_by: 'created', email_norm: 'maria@x.com', phone_e164: '+5584999999999', nome: 'Maria', produto: 'rh' });
    expect(p.touchpoint).toMatchObject({ canal: 'paid_search_google', gclid: 'G1', landing_url: 'https://x.test/lp', utm_source: 'google' });
    expect(p.event).toMatchObject({ tipo: 'form_submit' });
    expect(p.event.dados.consent).toEqual({ marketing: true, analytics: false });
    expect(p.decision).toMatchObject({ modo: 'sombra', status: 'ok', acao: 'pendente_motor_regras' });
    expect(counts()).toEqual(ZERO);
  });

  it('o mesmo event_id pode ser simulado várias vezes (nada foi gravado, nada vira duplicado)', async () => {
    const a = await ingest(req(body()), dry());
    const b = await ingest(req(body()), dry());
    expect(a.body.duplicate).toBe(false);
    expect(b.body.duplicate).toBe(false);
    expect(counts()).toEqual(ZERO);
  });

  it('event_id que já foi gravado de verdade aparece como duplicado na simulação', async () => {
    await ingest(req(body()), real());
    const before = counts();
    const r = await ingest(req(body()), dry());
    expect(r.body).toMatchObject({ ok: true, duplicate: true });
    expect(counts()).toEqual(before);
  });

  it('simula o dedupe contra leads reais existentes, sem alterá-los', async () => {
    store.state.leads.push({ id: UUID_A, email_norm: 'maria@x.com', phone_e164: null, nome: 'Maria Antiga' });
    const r = await ingest(req(body({ event_id: 'evt-dry-0002' })), dry());
    const p = r.body.preview as any;
    expect(p.lead).toMatchObject({ created: false, matched_by: 'email', lead_id: UUID_A });
    expect(store.state.leads).toHaveLength(1);
    expect(store.state.leads[0]!.phone_e164).toBeNull(); // o telefone NÃO foi preenchido
  });

  it('falha na simulação: 500 sem registrar evento de erro (nada persiste)', async () => {
    store.failOn = 'insertEvent';
    const r = await ingest(req(body({ event_id: 'evt-dry-0003' })), dry());
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ dry_run: true });
    expect(counts()).toEqual(ZERO);
  });

  it('autenticação e validação continuam valendo na simulação', async () => {
    expect((await ingest({ ...req(body()), headers: { 'x-quark-token': 'errado' } }, dry())).status).toBe(401);
    expect((await ingest(req(body({ event_id: undefined })), dry())).status).toBe(400);
    expect((await ingest(req(body({ website_hp: 'bot' })), dry())).body).toMatchObject({ discarded: true });
  });

  it('sem dryRun o comportamento normal não muda (grava)', async () => {
    const r = await ingest(req(body()), real());
    expect(r.body.dry_run).toBeUndefined();
    expect(counts()).toMatchObject({ leads: 1, touchpoints: 1, events: 1, decisions: 1 });
  });
});
