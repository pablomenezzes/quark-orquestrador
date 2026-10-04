import { describe, it, expect, beforeEach } from 'vitest';
import { createHandler, type HandlerDeps } from '../src/http/handler';
import type { IngestRequest, IngestResponse } from '../src/pipeline/types';

const LP = 'https://lp.quarkrh.com.br';

function fakeRes() {
  const r = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    payload: undefined as unknown,
    setHeader(k: string, v: string) {
      r.headers[k.toLowerCase()] = v;
      return r;
    },
    status(c: number) {
      r.statusCode = c;
      return r;
    },
    json(b: unknown) {
      r.payload = b;
      return r;
    },
    end() {
      return r;
    },
  };
  return r;
}

let calls: IngestRequest[];
let result: IngestResponse;
const base = (over: Partial<HandlerDeps> = {}): HandlerDeps => ({
  ingest: async (req) => {
    calls.push(req);
    return result;
  },
  store: {} as never,
  shadowMode: true,
  rateLimit: { salt: 's', config: { browserPerIp: { limit: 1, windowSec: 1 }, perSource: { browser: { limit: 1, windowSec: 1 }, server: { limit: 1, windowSec: 1 } } } },
  allowedOrigins: async () => [LP],
  log: { error: () => {} },
  ...over,
});
const call = async (deps: HandlerDeps, req: object) => {
  const res = fakeRes();
  await createHandler(deps)(req as never, res as never);
  return res;
};
const post = (headers: Record<string, string> = {}, body: unknown = { a: 1 }) => ({ method: 'POST', headers, query: {}, body });

beforeEach(() => {
  calls = [];
  result = { status: 200, body: { ok: true } };
});

describe('CORS por origem cadastrada (orq.sources.url)', () => {
  it('OPTIONS de origem cadastrada: 204 com as permissões e Vary', async () => {
    const r = await call(base(), { method: 'OPTIONS', headers: { origin: LP }, query: {}, body: null });
    expect(r.statusCode).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe(LP);
    expect(r.headers['access-control-allow-headers']).toContain('x-quark-token');
    expect(r.headers['access-control-allow-methods']).toContain('POST');
    expect(r.headers['vary']).toContain('Origin');
  });

  it('OPTIONS de origem NÃO cadastrada: 204 sem nenhuma permissão (o navegador bloqueia)', async () => {
    const r = await call(base(), { method: 'OPTIONS', headers: { origin: 'https://site-malicioso.com' }, query: {}, body: null });
    expect(r.statusCode).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['access-control-allow-headers']).toBeUndefined();
    expect(r.headers['vary']).toContain('Origin');
  });

  it('OPTIONS sem Origin: sem permissões', async () => {
    const r = await call(base(), { method: 'OPTIONS', headers: {}, query: {}, body: null });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('POST de origem não cadastrada: 403 e o pipeline nem é chamado', async () => {
    const r = await call(base(), post({ origin: 'https://site-malicioso.com', 'x-quark-token': 't' }));
    expect(r.statusCode).toBe(403);
    expect(r.payload).toEqual({ error: 'origin_not_allowed' });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('POST de origem cadastrada: segue para o pipeline e devolve a permissão de leitura', async () => {
    const r = await call(base(), post({ origin: LP, 'x-quark-token': 't' }));
    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe(LP);
    expect(calls).toHaveLength(1);
  });

  it('POST sem Origin (Elementor, Fillout, Meta: servidor a servidor): segue, sem cabeçalho CORS', async () => {
    const r = await call(base(), post({ 'x-quark-token': 't' }));
    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('erro ao listar as origens: navegador fica bloqueado (fecha), servidor a servidor segue', async () => {
    const deps = base({ allowedOrigins: async () => { throw new Error('banco fora'); } });
    expect((await call(deps, post({ origin: LP }))).statusCode).toBe(403);
    expect((await call(deps, post({}))).statusCode).toBe(200);
  });
});

describe('método e corpo', () => {
  it('métodos diferentes de POST recebem 405', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const r = await call(base(), { method, headers: {}, query: {}, body: null });
      expect(r.statusCode).toBe(405);
    }
  });

  it('JSON malformado: 400 invalid_json (e não 500), sem chamar o pipeline', async () => {
    const req = { method: 'POST', headers: { 'x-quark-token': 't' }, query: {}, get body() { throw new Error('Invalid JSON'); } };
    const r = await call(base(), req);
    expect(r.statusCode).toBe(400);
    expect(r.payload).toEqual({ error: 'invalid_json' });
    expect(calls).toHaveLength(0);
  });
});

describe('respostas do pipeline', () => {
  it('repassa status, corpo e cabeçalhos (Retry-After do 429)', async () => {
    result = { status: 429, body: { error: 'rate_limited', retry_after_s: 42 }, headers: { 'retry-after': '42' } };
    const r = await call(base(), post({ origin: LP, 'x-quark-token': 't' }));
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('42');
    expect(r.payload).toMatchObject({ error: 'rate_limited' });
    // o navegador da LP consegue ler o erro
    expect(r.headers['access-control-allow-origin']).toBe(LP);
  });

  it('o pipeline recebe a configuração de limite e o modo sombra', async () => {
    let seen: unknown;
    const deps = base({ ingest: async (req, d) => { seen = d; calls.push(req); return result; } });
    await call(deps, post({}));
    expect(seen).toMatchObject({ shadowMode: true, rateLimit: { salt: 's' } });
    expect((seen as { dryRun?: boolean }).dryRun).toBeUndefined();
  });

  it('exceção inesperada: 500 genérico, sem vazar detalhes', async () => {
    const deps = base({ ingest: async () => { throw new Error('senha=segredo postgres://u:p@h'); } });
    const r = await call(deps, post({}));
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.payload)).toBe('{"error":"internal_error"}');
  });
});

describe('configuração inválida', () => {
  it('configError: toda requisição (menos OPTIONS) recebe 500 misconfigured e o pipeline não roda', async () => {
    const deps = base({ configError: 'INGEST_DB_URL ausente' });
    const r = await call(deps, post({ 'x-quark-token': 't' }));
    expect(r.statusCode).toBe(500);
    expect(r.payload).toEqual({ error: 'misconfigured' });
    expect(calls).toHaveLength(0);
    const o = await call(deps, { method: 'OPTIONS', headers: { origin: LP }, query: {}, body: null });
    expect(o.statusCode).toBe(204);
  });
});
