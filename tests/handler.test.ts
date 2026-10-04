import { describe, it, expect } from 'vitest';
import handler from '../api/ingest';

function fakeRes() {
  const r = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    payload: undefined as unknown,
    ended: false,
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
      r.ended = true;
      return r;
    },
  };
  return r;
}

const call = async (req: object) => {
  const res = fakeRes();
  await handler(req as any, res as any);
  return res;
};

describe('api/ingest (partes sem banco)', () => {
  it('OPTIONS responde 204 e reflete a origem no CORS, permitindo o header do token', async () => {
    const res = await call({ method: 'OPTIONS', headers: { origin: 'https://lp.quark.com.br' }, query: {}, body: null });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://lp.quark.com.br');
    expect(res.headers['access-control-allow-headers']).toContain('x-quark-token');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('métodos diferentes de POST recebem 405', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await call({ method, headers: {}, query: {}, body: null });
      expect(res.statusCode).toBe(405);
    }
  });
});
