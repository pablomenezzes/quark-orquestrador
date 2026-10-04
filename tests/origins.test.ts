import { describe, it, expect } from 'vitest';
import { parseSourceOrigins, isOriginAllowed, OriginCache } from '../src/security/origins';

describe('parseSourceOrigins (orq.sources.url)', () => {
  it('extrai só a origem (sem caminho, query nem fragmento)', () => {
    expect(parseSourceOrigins('https://lp.quarkrh.com.br/rh/?utm=1#topo')).toEqual(['https://lp.quarkrh.com.br']);
  });
  it('aceita várias URLs separadas por espaço, vírgula, ponto e vírgula ou quebra de linha', () => {
    expect(parseSourceOrigins('https://a.com/x, https://b.com;https://c.com\nhttps://d.com')).toEqual([
      'https://a.com', 'https://b.com', 'https://c.com', 'https://d.com',
    ]);
  });
  it('mantém a porta, normaliza o host para minúsculas e remove duplicadas', () => {
    expect(parseSourceOrigins('http://LOCALHOST:3000/a https://Quark.com.br https://quark.com.br/b')).toEqual([
      'http://localhost:3000', 'https://quark.com.br',
    ]);
  });
  it('ignora valores inválidos e esquemas que não são http(s)', () => {
    expect(parseSourceOrigins('javascript:alert(1) ftp://x.com não-é-url data:text/html,x https://ok.com')).toEqual(['https://ok.com']);
  });
  it('null, vazio ou só espaços: nenhuma origem', () => {
    expect(parseSourceOrigins(null)).toEqual([]);
    expect(parseSourceOrigins('')).toEqual([]);
    expect(parseSourceOrigins('   ')).toEqual([]);
  });
});

describe('isOriginAllowed', () => {
  const allowed = ['https://lp.quarkrh.com.br', 'http://localhost:3000'];
  it('exige origem exatamente igual (esquema, host e porta)', () => {
    expect(isOriginAllowed('https://lp.quarkrh.com.br', allowed)).toBe(true);
    expect(isOriginAllowed('HTTPS://LP.QUARKRH.COM.BR', allowed)).toBe(true);
    expect(isOriginAllowed('http://lp.quarkrh.com.br', allowed)).toBe(false);
    expect(isOriginAllowed('https://lp.quarkrh.com.br:8443', allowed)).toBe(false);
    expect(isOriginAllowed('http://localhost:3001', allowed)).toBe(false);
  });
  it('não cai em truques de sufixo/prefixo', () => {
    expect(isOriginAllowed('https://lp.quarkrh.com.br.evil.com', allowed)).toBe(false);
    expect(isOriginAllowed('https://evil.com/https://lp.quarkrh.com.br', allowed)).toBe(false);
    expect(isOriginAllowed('https://xlp.quarkrh.com.br', allowed)).toBe(false);
  });
  it('origem "null", vazia ou ausente nunca é permitida', () => {
    expect(isOriginAllowed('null', allowed)).toBe(false);
    expect(isOriginAllowed('', allowed)).toBe(false);
    expect(isOriginAllowed(undefined, allowed)).toBe(false);
    expect(isOriginAllowed('https://lp.quarkrh.com.br', [])).toBe(false);
  });
});

describe('OriginCache', () => {
  it('carrega uma vez dentro do prazo e recarrega depois dele', async () => {
    let t = 1000;
    let calls = 0;
    const c = new OriginCache(async () => { calls++; return [`https://a${calls}.com`]; }, 60_000, () => t);
    expect(await c.get()).toEqual(['https://a1.com']);
    t += 59_000;
    expect(await c.get()).toEqual(['https://a1.com']);
    t += 2_000;
    expect(await c.get()).toEqual(['https://a2.com']);
    expect(calls).toBe(2);
  });
  it('chamadas simultâneas compartilham a mesma carga', async () => {
    let calls = 0;
    const c = new OriginCache(async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return ['https://a.com']; }, 60_000);
    const r = await Promise.all([c.get(), c.get(), c.get()]);
    expect(r.every((x) => x[0] === 'https://a.com')).toBe(true);
    expect(calls).toBe(1);
  });
  it('falha ao carregar: devolve lista vazia (fecha) e tenta de novo logo, sem esperar o prazo todo', async () => {
    let t = 0;
    let calls = 0;
    const errors: unknown[] = [];
    const c = new OriginCache(async () => { calls++; if (calls === 1) throw new Error('banco fora'); return ['https://a.com']; }, 60_000, () => t, (e) => errors.push(e));
    expect(await c.get()).toEqual([]);
    expect(errors).toHaveLength(1);
    t += 6_000; // passou o retry curto (5s), muito antes dos 60s
    expect(await c.get()).toEqual(['https://a.com']);
  });
  it('se já tinha uma lista boa e a recarga falha, mantém a última boa', async () => {
    let t = 0;
    let calls = 0;
    const c = new OriginCache(async () => { calls++; if (calls === 2) throw new Error('x'); return ['https://a.com']; }, 10_000, () => t, () => {});
    expect(await c.get()).toEqual(['https://a.com']);
    t += 11_000;
    expect(await c.get()).toEqual(['https://a.com']);
  });
});
