import { describe, it, expect, beforeEach } from 'vitest';
import { ingest } from '../src/pipeline/ingest';
import type { IngestRequest } from '../src/pipeline/types';
import { MemoryStore } from './helpers/memory-store';

const TOKEN = 'token-vercel-de-teste';
const NOW = new Date('2026-10-03T12:00:00Z');
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

let store: MemoryStore;
const errors: string[] = [];
const deps = () => ({
  store,
  shadowMode: true,
  now: () => NOW,
  log: { error: (m: string) => void errors.push(m) },
});

const payload = (over: Record<string, unknown> = {}) => ({
  source_slug: 'lp-vercel',
  form_id: 'form-demo',
  lp_id: 'lp-vercel',
  event_id: 'evt-0001',
  lead_id: null,
  event_type: 'form_submit',
  occurred_at: '2026-10-03T11:59:00Z',
  contact: { name: 'Maria', email: ' Maria@Empresa.COM ', phone: '(84) 99999-9999', company: 'Acme', company_size: 15, role: 'RH' },
  answers: { interesse: 'demo' },
  attribution: {
    utm_source: 'meta',
    utm_medium: 'paid_social',
    utm_campaign: '111',
    utm_content: '333',
    fbclid: 'ABC',
    fbc: 'fb.1.1.ABC',
    landing_url: 'https://lp.quark.com.br/rh/?utm_source=meta#x',
    referrer: '',
  },
  consent: { marketing: true, analytics: true },
  ...over,
});

const req = (body: unknown, over: Partial<IngestRequest> = {}): IngestRequest => ({
  body,
  query: {},
  headers: { 'x-quark-token': TOKEN, 'user-agent': 'Mozilla/5.0 teste' },
  ip: '200.100.50.25',
  ...over,
});

const counts = () => ({
  leads: store.state.leads.length,
  touchpoints: store.state.touchpoints.length,
  events: store.state.events.length,
  decisions: store.state.decisions.length,
});

beforeEach(() => {
  store = new MemoryStore();
  store.addSource({ slug: 'lp-vercel', tipo: 'vercel', produto: 'rh', token: TOKEN });
  store.addSource({ slug: 'elementor-site-rh', tipo: 'elementor', produto: 'rh', token: 'tok-elementor' });
  store.addSource({ slug: 'fonte-inativa', tipo: 'vercel', ativo: false, token: 'tok-inativa' });
  store.addSource({ slug: 'lov', tipo: 'lovable', token: 'tok-lov' });
  errors.length = 0;
});

describe('autenticação por fonte (seção 13)', () => {
  it('401 para slug desconhecido, ausente, token errado, ausente e fonte inativa — sem gravar nada', async () => {
    const cases: IngestRequest[] = [
      req(payload({ source_slug: 'nao-existe' })),
      req({ ...payload(), source_slug: undefined }),
      req(payload(), { headers: { 'x-quark-token': 'errado' } }),
      req(payload(), { headers: {} }),
      req(payload({ source_slug: 'fonte-inativa' }), { headers: { 'x-quark-token': 'tok-inativa' } }),
    ];
    for (const c of cases) {
      const r = await ingest(c, deps());
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: 'unauthorized' });
    }
    expect(counts()).toEqual({ leads: 0, touchpoints: 0, events: 0, decisions: 0 });
  });

  it('o token na URL só vale para fontes que não conseguem enviar cabeçalho (Elementor)', async () => {
    const viaQuery = req(payload(), { headers: {}, query: { token: TOKEN } });
    expect((await ingest(viaQuery, deps())).status).toBe(401);

    const elementor = req(
      { email: 'a@x.com', name: 'A', event_id: 'evt-el-1', form_id: 'f' },
      { headers: {}, query: { source: 'elementor-site-rh', token: 'tok-elementor' } },
    );
    expect((await ingest(elementor, deps())).status).toBe(200);
  });

  it('501 para tipo de fonte sem adaptador ainda (lovable)', async () => {
    const r = await ingest(req(payload({ source_slug: 'lov' }), { headers: { 'x-quark-token': 'tok-lov' } }), deps());
    expect(r.status).toBe(501);
  });
});

describe('modo sombra (caminho feliz)', () => {
  it('grava lead, touchpoint, evento e decisão em modo sombra, tudo normalizado', async () => {
    const r = await ingest(req(payload()), deps());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, duplicate: false, canal: 'paid_social_meta', modo: 'sombra' });

    const lead = store.state.leads[0]!;
    expect(lead).toMatchObject({ email_norm: 'maria@empresa.com', phone_e164: '+5584999999999', nome: 'Maria', empresa: 'Acme', porte: 15, cargo: 'RH', produto: 'rh' });

    const tp = store.state.touchpoints[0]!;
    expect(tp).toMatchObject({
      lead_id: lead.id,
      event_id: 'evt-0001',
      canal: 'paid_social_meta',
      utm_source: 'meta',
      utm_content: '333',
      fbc: 'fb.1.1.ABC',
      landing_url: 'https://lp.quark.com.br/rh',
      referrer: null,
      occurred_at: '2026-10-03T11:59:00.000Z',
    });

    const ev = store.state.events[0]!;
    expect(ev).toMatchObject({ tipo: 'form_submit', lead_id: lead.id, touchpoint_id: tp.id });
    expect(ev.dados).toMatchObject({
      form_id: 'form-demo',
      lp_id: 'lp-vercel',
      consent: { marketing: true, analytics: true },
      ip: '200.100.50.25',
      user_agent: 'Mozilla/5.0 teste',
      fbclid: 'ABC',
      answers: { interesse: 'demo' },
    });

    expect(store.state.decisions).toEqual([
      expect.objectContaining({ event_id: ev.id, modo: 'sombra', status: 'ok', erro: null }),
    ]);
  });

  it('o canal é derivado pelo servidor; um canal enviado pelo cliente é ignorado', async () => {
    const body = payload({ canal: 'direct' }) as Record<string, any>;
    body.attribution.canal = 'direct';
    await ingest(req(body), deps());
    expect(store.state.touchpoints[0]!.canal).toBe('paid_social_meta');
  });

  it('o ip enviado pelo navegador é ignorado; vale o do servidor', async () => {
    const body = payload() as Record<string, any>;
    body.attribution.ip = '9.9.9.9';
    await ingest(req(body), deps());
    expect(store.state.events[0]!.dados.ip).toBe('200.100.50.25');
  });

  it('o payload bruto guardado não contém o token', async () => {
    await ingest(req(payload()), deps());
    expect(JSON.stringify(store.state.events[0]!.payload_bruto)).not.toContain(TOKEN);
  });

  it('first_touch vai para o evento', async () => {
    await ingest(req(payload({ first_touch: { utm_source: 'google', gclid: 'G1' } })), deps());
    expect(store.state.events[0]!.dados.first_touch).toEqual({ utm_source: 'google', gclid: 'G1' });
  });

  it('occurred_at ausente ou muito no futuro vira o horário de recebimento', async () => {
    await ingest(req(payload({ occurred_at: undefined, event_id: 'evt-0003-c' })), deps());
    await ingest(req(payload({ occurred_at: '2030-01-01T00:00:00Z', event_id: 'evt-0004-d' })), deps());
    expect(store.state.touchpoints.map((t) => t.occurred_at)).toEqual([NOW.toISOString(), NOW.toISOString()]);
  });

  it('SHADOW_MODE diferente de true: o endpoint se recusa a operar', async () => {
    const r = await ingest(req(payload()), { ...deps(), shadowMode: false });
    expect(r.status).toBe(500);
    expect(counts().leads).toBe(0);
  });
});

describe('idempotência por event_id (seção 10)', () => {
  it('evento repetido: 200 duplicate, nada novo é gravado (nem decisão)', async () => {
    const first = await ingest(req(payload()), deps());
    const before = counts();
    const again = await ingest(req(payload()), deps());
    expect(first.body.duplicate).toBe(false);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, duplicate: true });
    expect(counts()).toEqual(before);
  });

  it('mesmo event_id com dados diferentes continua sendo duplicado e não altera o lead', async () => {
    await ingest(req(payload()), deps());
    const before = counts();
    const r = await ingest(req(payload({ contact: { name: 'Outra', email: 'outra@x.com' } })), deps());
    expect(r.body.duplicate).toBe(true);
    expect(counts()).toEqual(before);
    expect(store.state.leads.find((l) => l.email_norm === 'outra@x.com')).toBeUndefined();
  });

  it('event_ids diferentes do mesmo lead: um lead, dois touchpoints', async () => {
    await ingest(req(payload({ event_id: 'evt-0001-a' })), deps());
    await ingest(req(payload({ event_id: 'evt-0002-b' })), deps());
    expect(counts()).toMatchObject({ leads: 1, touchpoints: 2, events: 2, decisions: 2 });
  });

  it('corrida: conflito no insert do touchpoint vira duplicado e desfaz o lead criado', async () => {
    store.failOn = 'insertTouchpointConflict';
    const r = await ingest(req(payload()), deps());
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(true);
    expect(counts()).toEqual({ leads: 0, touchpoints: 0, events: 0, decisions: 0 });
  });
});

describe('honeypot e validação', () => {
  it('honeypot preenchido: 200 descartado, nada gravado', async () => {
    const r = await ingest(req(payload({ website_hp: 'http://spam' })), deps());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, discarded: true });
    expect(counts()).toEqual({ leads: 0, touchpoints: 0, events: 0, decisions: 0 });
  });

  it('400 sem event_id, e nada é gravado', async () => {
    const r = await ingest(req(payload({ event_id: undefined })), deps());
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_payload');
    expect(counts()).toEqual({ leads: 0, touchpoints: 0, events: 0, decisions: 0 });
  });

  it('o erro de validação não devolve os dados do contato', async () => {
    const r = await ingest(req(payload({ event_id: undefined })), deps());
    expect(JSON.stringify(r.body)).not.toContain('maria@empresa');
    expect(JSON.stringify(r.body)).not.toContain('Maria');
  });

  it('400 para event_type que as fontes públicas não podem enviar (deal_ganho)', async () => {
    const r = await ingest(req(payload({ event_type: 'deal_ganho' })), deps());
    expect(r.status).toBe(400);
    expect(counts().events).toBe(0);
  });

  it('diagnostico_concluido é aceito', async () => {
    const r = await ingest(req(payload({ event_type: 'diagnostico_concluido', answers: { score: 72 } })), deps());
    expect(r.status).toBe(200);
    expect(store.state.events[0]!.tipo).toBe('diagnostico_concluido');
  });

  it('413 para corpo grande demais', async () => {
    const r = await ingest(req(payload(), { bodyBytes: 5_000_000 }), deps());
    expect(r.status).toBe(413);
  });

  it('aceita evento só com telefone, ou sem contato nenhum (anônimo)', async () => {
    const a = await ingest(req(payload({ event_id: 'evt-tel-0001', contact: { phone: '84 99999-9999' } })), deps());
    const b = await ingest(req(payload({ event_id: 'evt-anon-001', contact: {} })), deps());
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe('e-mail pesa mais que o cookie (D-06)', () => {
  beforeEach(async () => {
    store.state.leads.push({ id: UUID_A, email_norm: 'a@x.com', phone_e164: null });
    store.state.leads.push({ id: UUID_B, email_norm: 'b@x.com', phone_e164: null });
  });

  it('lead_id do cookie existe, mas o e-mail enviado é diferente: o evento NÃO é anexado a ele', async () => {
    const r = await ingest(req(payload({ lead_id: UUID_A, contact: { email: 'novo@x.com', name: 'Novo' } })), deps());
    expect(r.status).toBe(200);
    expect(r.body.lead_id).not.toBe(UUID_A);
    const tp = store.state.touchpoints[0]!;
    expect(tp.lead_id).not.toBe(UUID_A);
    expect(store.state.events[0]!.lead_id).not.toBe(UUID_A);
    // o lead A segue intacto
    expect(store.state.leads.find((l) => l.id === UUID_A)).toMatchObject({ email_norm: 'a@x.com' });
    expect(store.state.leads.find((l) => l.id === UUID_A)?.nome).toBeUndefined();
  });

  it('cookie de A, e-mail de B: o evento vai para B', async () => {
    const r = await ingest(req(payload({ lead_id: UUID_A, contact: { email: 'b@x.com' } })), deps());
    expect(r.body.lead_id).toBe(UUID_B);
    expect(store.state.touchpoints[0]!.lead_id).toBe(UUID_B);
  });

  it('cookie de A e o mesmo e-mail de A: anexa ao A', async () => {
    const r = await ingest(req(payload({ lead_id: UUID_A, contact: { email: ' A@X.com ' } })), deps());
    expect(r.body.lead_id).toBe(UUID_A);
  });
});

describe('falha no meio do processamento (decisão registrada em erro)', () => {
  it('500, nada parcial é gravado, e o evento bruto fica registrado com decisão em erro', async () => {
    store.failOn = 'insertEvent';
    const r = await ingest(req(payload()), deps());
    expect(r.status).toBe(500);
    expect(errors.length).toBeGreaterThan(0);
    // nenhuma sujeira do processamento principal
    expect(store.state.leads).toHaveLength(0);
    expect(store.state.touchpoints).toHaveLength(0);
    // o dado não se perde: evento sem lead, com payload bruto, e decisão de erro
    expect(store.state.events).toHaveLength(1);
    expect(store.state.events[0]).toMatchObject({ lead_id: null, touchpoint_id: null, tipo: 'form_submit' });
    expect(store.state.events[0]!.payload_bruto).toMatchObject({ event_id: 'evt-0001' });
    expect(store.state.decisions).toEqual([
      expect.objectContaining({ event_id: store.state.events[0]!.id, modo: 'sombra', status: 'erro', erro: expect.stringContaining('falha simulada') }),
    ]);
  });

  it('a retentativa depois do erro NÃO é tratada como duplicada', async () => {
    store.failOn = 'insertEvent';
    store.failOnce = true;
    expect((await ingest(req(payload()), deps())).status).toBe(500);
    const retry = await ingest(req(payload()), deps());
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(false);
    expect(store.state.touchpoints).toHaveLength(1);
  });
});
