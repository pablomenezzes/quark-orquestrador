import { describe, it, expect } from 'vitest';
import { assertSafeDbTarget } from '../src/db/guard';

const REF = 'avxuerlobmrfsretwuwd';
const OLD = 'igidjtfhqqezmuakprnw';

describe('assertSafeDbTarget', () => {
  it('aceita a URL da API do projeto esperado', () => {
    expect(() => assertSafeDbTarget({ target: `https://${REF}.supabase.co`, expectedRef: REF })).not.toThrow();
  });

  it('aceita a connection string do pooler que contém o ref no usuário', () => {
    const url = `postgresql://postgres.${REF}:senha@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`;
    expect(() => assertSafeDbTarget({ target: url, expectedRef: REF })).not.toThrow();
  });

  it('recusa quando o ref esperado não está configurado', () => {
    expect(() => assertSafeDbTarget({ target: `https://${REF}.supabase.co`, expectedRef: '' })).toThrow(/SUPABASE_PROJECT_REF/);
  });

  it('recusa alvo que não contém o ref esperado', () => {
    expect(() => assertSafeDbTarget({ target: 'https://outroprojeto.supabase.co', expectedRef: REF })).toThrow(/ref/i);
  });

  it('recusa o ref do projeto antigo, mesmo se for o "esperado"', () => {
    expect(() => assertSafeDbTarget({ target: `https://${OLD}.supabase.co`, expectedRef: OLD })).toThrow(/antigo|bloquead/i);
  });

  it('recusa alvo vazio', () => {
    expect(() => assertSafeDbTarget({ target: '', expectedRef: REF })).toThrow();
  });
});
