import { describe, it, expect } from 'vitest';
import {
  parsePipeline, parseStage, parseUser, parseFieldDef, payloadHash, stableStringify, toIso, ParseError,
} from '../src/datahub/parse';

describe('toIso (datas do Pipedrive)', () => {
  it('v2: RFC 3339 já vem certo', () => {
    expect(toIso('2026-01-02T03:04:05Z')).toBe('2026-01-02T03:04:05.000Z');
  });
  it('v1: "AAAA-MM-DD HH:MM:SS" é UTC', () => {
    expect(toIso('2026-01-02 03:04:05')).toBe('2026-01-02T03:04:05.000Z');
  });
  it('vazio, nulo ou inválido: null', () => {
    for (const v of [null, undefined, '', 'ontem', 12]) expect(toIso(v as never)).toBeNull();
  });
});

describe('payloadHash / stableStringify', () => {
  it('a ordem das chaves não muda o hash', () => {
    expect(payloadHash({ a: 1, b: { c: 2, d: 3 } })).toBe(payloadHash({ b: { d: 3, c: 2 }, a: 1 }));
  });
  it('qualquer mudança de valor muda o hash', () => {
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
    expect(payloadHash({ a: [1, 2] })).not.toBe(payloadHash({ a: [2, 1] }));
  });
  it('hash hexadecimal de 64 caracteres', () => {
    expect(payloadHash({})).toMatch(/^[0-9a-f]{64}$/);
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe('parsePipeline', () => {
  it('extrai id, nome, ordem, ativo e data de atualização', () => {
    expect(parsePipeline({ id: 3, name: 'Vendas RH', order_nr: 2, is_deleted: false, add_time: '2025-01-01T00:00:00Z', update_time: '2026-02-01T10:00:00Z' })).toEqual({
      pipeline_id: 3, nome: 'Vendas RH', ordem: 2, ativo: true, source_add_time: '2025-01-01T00:00:00.000Z', source_update_time: '2026-02-01T10:00:00.000Z',
    });
  });
  it('aceita a forma antiga (active / active_flag) e a nova (is_deleted)', () => {
    expect(parsePipeline({ id: 1, name: 'A', active: false }).ativo).toBe(false);
    expect(parsePipeline({ id: 1, name: 'A', active_flag: true }).ativo).toBe(true);
    expect(parsePipeline({ id: 1, name: 'A', is_deleted: true }).ativo).toBe(false);
    expect(parsePipeline({ id: 1, name: 'A' }).ativo).toBeNull();
  });
  it('sem id numérico ou sem nome: ParseError (o item é registrado, a rodada continua)', () => {
    expect(() => parsePipeline({ name: 'A' })).toThrow(ParseError);
    expect(() => parsePipeline({ id: 'x', name: 'A' })).toThrow(ParseError);
    expect(() => parsePipeline({ id: 1 })).toThrow(ParseError);
    expect(() => parsePipeline(null)).toThrow(ParseError);
  });
  it('o ID vem sempre como número, mesmo se chegar como texto numérico', () => {
    expect(parsePipeline({ id: '12', name: 'A' }).pipeline_id).toBe(12);
  });
});

describe('parseStage', () => {
  it('extrai ids, ordem e probabilidade', () => {
    expect(parseStage({ id: 10, pipeline_id: 3, name: 'Reunião', order_nr: 4, deal_probability: 50, is_deleted: false, update_time: '2026-02-01T10:00:00Z' })).toMatchObject({
      stage_id: 10, pipeline_id: 3, nome: 'Reunião', ordem: 4, probabilidade: 50, ativo: true,
    });
  });
  it('exige pipeline_id (etapa sem pipeline não é aceita)', () => {
    expect(() => parseStage({ id: 10, name: 'X' })).toThrow(ParseError);
  });
});

describe('parseUser', () => {
  it('extrai id, nome, e-mail (minúsculas) e ativo', () => {
    expect(parseUser({ id: 5, name: 'Ana Souza', email: ' Ana@Quark.com ', active_flag: true })).toEqual({
      user_id: 5, nome: 'Ana Souza', email: 'ana@quark.com', ativo: true,
    });
  });
  it('aceita is_active e ausência do campo', () => {
    expect(parseUser({ id: 5, name: 'A', is_active: false }).ativo).toBe(false);
    expect(parseUser({ id: 5 }).ativo).toBeNull();
  });
  it('sem id: ParseError', () => {
    expect(() => parseUser({ name: 'A' })).toThrow(ParseError);
  });
});

describe('parseFieldDef (guarda o ID original, o hash de 40 caracteres)', () => {
  const hash40 = 'a'.repeat(40);
  it('v2: field_code é o ID; field_name é o nome de hoje', () => {
    expect(parseFieldDef('deal', { field_code: hash40, field_name: 'Origem do lead', field_type: 'enum', options: [{ id: 1, label: 'Google' }], order_nr: 7 })).toEqual({
      entity: 'deal', field_key: hash40, nome: 'Origem do lead', tipo: 'enum', opcoes: [{ id: 1, label: 'Google' }], ordem: 7,
    });
  });
  it('v1: key / name', () => {
    expect(parseFieldDef('person', { key: 'email', name: 'E-mail', field_type: 'varchar' })).toMatchObject({ entity: 'person', field_key: 'email', nome: 'E-mail' });
  });
  it('sem chave: ParseError', () => {
    expect(() => parseFieldDef('deal', { field_name: 'X' })).toThrow(ParseError);
  });
  it('entidade inválida: ParseError', () => {
    expect(() => parseFieldDef('produto' as never, { field_code: 'x', field_name: 'X' })).toThrow(ParseError);
  });
});
