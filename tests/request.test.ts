import { describe, it, expect } from 'vitest';
import { buildIngestRequest } from '../src/http/request';

const req = (headers: Record<string, string | string[] | undefined>, over: object = {}) =>
  buildIngestRequest({ headers, body: { a: 1 }, query: { source: 's' }, ...over });

describe('buildIngestRequest', () => {
  it('põe os cabeçalhos em minúsculas e achata arrays', () => {
    const r = req({ 'X-Quark-Token': 'abc', 'x-multi': ['a', 'b'] });
    expect(r.headers['x-quark-token']).toBe('abc');
    expect(r.headers['x-multi']).toBe('a');
  });

  it('IP: x-vercel-forwarded-for > x-real-ip > primeiro de x-forwarded-for', () => {
    expect(req({ 'x-vercel-forwarded-for': '1.1.1.1', 'x-real-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3' }).ip).toBe('1.1.1.1');
    expect(req({ 'x-real-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3' }).ip).toBe('2.2.2.2');
    expect(req({ 'x-forwarded-for': '3.3.3.3, 4.4.4.4' }).ip).toBe('3.3.3.3');
    expect(req({}).ip).toBeNull();
  });

  it('bodyBytes vem do content-length quando é número válido', () => {
    expect(req({ 'content-length': '123' }).bodyBytes).toBe(123);
    expect(req({ 'content-length': 'abc' }).bodyBytes).toBeUndefined();
  });

  it('query com arrays fica com o primeiro valor', () => {
    const r = buildIngestRequest({ headers: {}, body: null, query: { source: ['a', 'b'], token: 't' } });
    expect(r.query).toEqual({ source: 'a', token: 't' });
  });
});
