import { describe, it, expect } from 'vitest';
import { normalizeEmail, normalizePhone, normalizeLandingUrl } from '../src/normalize';

describe('normalizeEmail (seção 7)', () => {
  it('põe em minúsculas e remove espaços', () => {
    expect(normalizeEmail('  Maria.Silva@Empresa.COM ')).toBe('maria.silva@empresa.com');
    expect(normalizeEmail('ma ria@x.com')).toBe('maria@x.com');
  });
  it('retorna null para vazio ou inválido', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail('sem-arroba')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
  });
});

describe('normalizePhone (E.164)', () => {
  it('converte celular BR com máscara', () => {
    expect(normalizePhone('(84) 99999-9999')).toBe('+5584999999999');
    expect(normalizePhone('84 99999 9999')).toBe('+5584999999999');
  });
  it('aceita número já com código do país', () => {
    expect(normalizePhone('+55 84 99999-9999')).toBe('+5584999999999');
    expect(normalizePhone('5584999999999')).toBe('+5584999999999');
  });
  it('retorna null para vazio ou inválido', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
  });
});

describe('normalizeLandingUrl', () => {
  it('remove query string, fragmento e barra final', () => {
    expect(normalizeLandingUrl('https://quark.com.br/lp/rh/?utm_source=meta#topo')).toBe('https://quark.com.br/lp/rh');
  });
  it('remove a barra da raiz', () => {
    expect(normalizeLandingUrl('https://quark.com.br/')).toBe('https://quark.com.br');
  });
  it('põe o host em minúsculas e preserva o caminho', () => {
    expect(normalizeLandingUrl('https://Quark.com.br/LP/RH')).toBe('https://quark.com.br/LP/RH');
  });
  it('retorna null para vazio ou inválido', () => {
    expect(normalizeLandingUrl('')).toBeNull();
    expect(normalizeLandingUrl(null)).toBeNull();
    expect(normalizeLandingUrl('não é url')).toBeNull();
  });
});
