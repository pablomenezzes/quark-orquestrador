import { describe, it, expect, beforeEach } from 'vitest';
import { ingest } from '../src/pipeline/ingest';
import { ipBucketKey } from '../src/security/rate-limit';
import type { IngestRequest } from '../src/pipeline/types';
import type { RateLimitConfig } from '../config/rate-limits';
import { MemoryStore } from './helpers/memory-store';

const TOKEN = 'tok-rl';
const SALT = 'sal-de-teste';
const CFG: RateLimitConfig = {
  browserPerIp: { limit: 3, windowSec: 600 },
  perSource: { browser: { limit: 10, windowSec: 3600 }, server: { limit: 5, windowSec: 3600 } },
};
let store: MemoryStore;
let t: number;
const errors: string[] = [];

const deps = (over: object = {}) => ({
  store,
  shadowMode: true,
  now: () => new Date(t),
  rateLimit: { salt: SALT, config: CFG },
  log: { error: (m: string) => void errors.push(m) },
  ...over,
});
const body = (n: number, over: Record<string, unknown> = {}) => ({
  source_slug: 'lp-vercel',
  form_id: 'f',
  event_id: `evt-rl-${String(n).padStart(4, '0')}`,
  event_type: 'form_submit',
  contact: { email: `p${n}@x.com` },
  attribution: {},
  consent: { marketing: true, analytics: true },
  ...over,
});
const req = (b: unknown, ip: string | null = '1.1.1.1', over: Partial<IngestRequest> = {}): IngestRequest => ({
  body: b,
  query: {},
  headers: { 'x-quark-token': TOKEN },
  ip,
  ...over,
});

beforeEach(() => {
  t = Date.parse('2026-10-05T12:00:00Z');
  store = new MemoryStore();
  store.now = () => t;
  store.addSource({ slug: 'lp-vercel', tipo: 'vercel', token: TOKEN });
  store.addSource({ slug: 'elementor-x', tipo: 'elementor', token: 'tok-el' });
  errors.length = 0;
});

describe('ipBucketKey', () => {
  it('não contém o IP em claro e é estável por fonte+IP+sal', () => {
    const k = ipBucketKey('src-1', '203.0.113.9', SALT);
    expect(k).not.toContain('203.0.113.9');
    expect(k).toBe(ipBucketKey('src-1', '203.0.113.9', SALT));
    expect(k).not.toBe(ipBucketKey('src-2', '203.0.113.9', SALT));
    expect(k).not.toBe(ipBucketKey('src-1', '203.0.113.10', SALT));
    expect(k).not.toBe(ipBucketKey('src-1', '203.0.113.9', 'outro-sal'));
  });
});

describe('limite por IP (fontes que o visitante acessa direto)', () => {
  it('permite até o limite e depois responde 429 com Retry-After, sem gravar nada', async () => {
    for (let i = 1; i <= 3; i++) expect((await ingest(req(body(i)), deps())).status).toBe(200);
    const before = store.state.touchpoints.length;
    const r = await ingest(req(body(4)), deps());
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: 'rate_limited' });
    expect(Number(r.headers?.['retry-after'])).toBeGreaterThan(0);
    expect(Number(r.headers?.['retry-after'])).toBeLessThanOrEqual(600);
    expect(store.state.touchpoints.length).toBe(before);
    expect(store.state.leads.some((l) => l.email_norm === 'p4@x.com')).toBe(false);
  });

  it('IPs diferentes têm contagens independentes', async () => {
    for (let i = 1; i <= 3; i++) await ingest(req(body(i), '1.1.1.1'), deps());
    expect((await ingest(req(body(4), '1.1.1.1'), deps())).status).toBe(429);
    expect((await ingest(req(body(5), '2.2.2.2'), deps())).status).toBe(200);
  });

  it('a janela vira e o IP volta a ser aceito', async () => {
    for (let i = 1; i <= 4; i++) await ingest(req(body(i)), deps());
    expect((await ingest(req(body(5)), deps())).status).toBe(429);
    t += 601_000;
    expect((await ingest(req(body(6)), deps())).status).toBe(200);
  });

  it('o IP não vai para o banco em claro (só o hash do balde)', async () => {
    await ingest(req(body(1), '198.51.100.77'), deps());
    expect(JSON.stringify([...store.hits.keys()])).not.toContain('198.51.100.77');
  });

  it('sem IP conhecido, só vale o limite da fonte', async () => {
    for (let i = 1; i <= 6; i++) expect((await ingest(req(body(i), null), deps())).status).toBe(200);
  });

  it('fonte de servidor (Elementor) não sofre limite por IP: o IP é o do fornecedor', async () => {
    const mk = (n: number) =>
      req({ email: `e${n}@x.com`, name: 'N', event_id: `evt-el-${String(n).padStart(4, '0')}`, form_id: 'f' }, '9.9.9.9', {
        headers: {},
        query: { source: 'elementor-x', token: 'tok-el' },
      });
    for (let i = 1; i <= 5; i++) expect((await ingest(mk(i), deps())).status).toBe(200);
  });
});

describe('limite por fonte', () => {
  it('fonte de navegador: 429 quando passa do teto da janela, mesmo com IPs diferentes', async () => {
    for (let i = 1; i <= 10; i++) expect((await ingest(req(body(i), `10.0.0.${i}`), deps())).status).toBe(200);
    const r = await ingest(req(body(11), '10.0.0.99'), deps());
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('rate_limited');
  });
  it('fonte de servidor tem teto próprio', async () => {
    const mk = (n: number) =>
      req({ email: `e${n}@x.com`, event_id: `evt-el-${String(n).padStart(4, '0')}`, form_id: 'f' }, null, { headers: {}, query: { source: 'elementor-x', token: 'tok-el' } });
    for (let i = 1; i <= 5; i++) await ingest(mk(i), deps());
    expect((await ingest(mk(6), deps())).status).toBe(429);
  });
  it('IP bloqueado não consome o orçamento da fonte', async () => {
    for (let i = 1; i <= 3; i++) await ingest(req(body(i), '1.1.1.1'), deps());
    for (let i = 4; i <= 9; i++) await ingest(req(body(i), '1.1.1.1'), deps()); // 6 bloqueadas
    // fonte consumiu só 3; ainda cabem 7 de outros IPs
    for (let i = 20; i <= 26; i++) expect((await ingest(req(body(i), `7.7.7.${i}`), deps())).status).toBe(200);
  });
});

describe('o que NÃO conta no limite', () => {
  it('requisição não autenticada não consome nada (e nem toca no contador)', async () => {
    for (let i = 0; i < 20; i++) await ingest(req(body(1), '1.1.1.1', { headers: { 'x-quark-token': 'errado' } }), deps());
    expect(store.hits.size).toBe(0);
  });
  it('payload inválido de quem TEM token conta no limite (evita spam de lixo com o token público)', async () => {
    for (let i = 0; i < 3; i++) expect((await ingest(req(body(1, { event_id: undefined })), deps())).status).toBe(400);
    expect((await ingest(req(body(2, { event_id: undefined })), deps())).status).toBe(429);
  });
  it('simulação (dryRun) não consome o limite', async () => {
    for (let i = 1; i <= 10; i++) expect((await ingest(req(body(i)), deps({ dryRun: true }))).status).toBe(200);
    expect(store.hits.size).toBe(0);
  });
  it('sem configuração de limite (Studio, testes antigos) nada é contado', async () => {
    for (let i = 1; i <= 8; i++) expect((await ingest(req(body(i)), deps({ rateLimit: undefined }))).status).toBe(200);
    expect(store.hits.size).toBe(0);
  });
});

describe('falha do contador', () => {
  it('se o contador quebra, o lead entra mesmo assim (falha aberta) e o erro é registrado', async () => {
    store.failHit = true;
    const r = await ingest(req(body(1)), deps());
    expect(r.status).toBe(200);
    expect(errors.some((e) => /limite/i.test(e))).toBe(true);
    expect(store.state.touchpoints).toHaveLength(1);
  });
});

describe('401 imediato sem token (não consulta o banco)', () => {
  it('sem token em lugar nenhum: 401 sem buscar a fonte', async () => {
    let lookups = 0;
    const orig = store.findSourceBySlug.bind(store);
    store.findSourceBySlug = async (s: string) => { lookups++; return orig(s); };
    const r = await ingest(req(body(1), '1.1.1.1', { headers: {} }), deps());
    expect(r.status).toBe(401);
    expect(lookups).toBe(0);
  });
  it('com token (mesmo errado) ainda consulta, para a resposta ser igual à de fonte inexistente', async () => {
    let lookups = 0;
    const orig = store.findSourceBySlug.bind(store);
    store.findSourceBySlug = async (s: string) => { lookups++; return orig(s); };
    await ingest(req(body(1), '1.1.1.1', { headers: { 'x-quark-token': 'errado' } }), deps());
    expect(lookups).toBe(1);
  });
});
