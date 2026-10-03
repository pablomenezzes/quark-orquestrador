import { describe, it, expect } from 'vitest';
import { hashToken, verifyToken, generateToken } from '../src/security/verify-token';

describe('token por fonte (seção 13)', () => {
  it('hashToken é SHA-256 hexadecimal (64 caracteres) e determinístico', () => {
    const h = hashToken('segredo');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('segredo')).toBe(h);
    expect(hashToken('outro')).not.toBe(h);
  });

  it('verifyToken aceita o token certo e recusa o errado', () => {
    const stored = hashToken('segredo');
    expect(verifyToken('segredo', stored)).toBe(true);
    expect(verifyToken('segredo ', stored)).toBe(false);
    expect(verifyToken('errado', stored)).toBe(false);
  });

  it('verifyToken recusa token ausente ou vazio e hash armazenado malformado', () => {
    const stored = hashToken('segredo');
    expect(verifyToken(null, stored)).toBe(false);
    expect(verifyToken(undefined, stored)).toBe(false);
    expect(verifyToken('', stored)).toBe(false);
    expect(verifyToken('segredo', 'nao-e-hex')).toBe(false);
    expect(verifyToken('segredo', '')).toBe(false);
  });

  it('generateToken gera tokens longos, url-safe e diferentes', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});
