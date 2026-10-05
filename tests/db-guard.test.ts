import { describe, it, expect } from 'vitest';
import { assertSafeDbTarget, assertLeastPrivilegeUser, assertRoleUser } from '../src/db/guard';

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

describe('assertLeastPrivilegeUser (o endpoint nunca usa o postgres)', () => {
  const url = (user: string) => `postgresql://${user}:senha@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`;

  it('aceita o papel mínimo pelo pooler (orq_ingest.<ref>)', () => {
    expect(() => assertLeastPrivilegeUser(url(`orq_ingest.${REF}`))).not.toThrow();
  });

  it('aceita o papel mínimo em conexão direta', () => {
    expect(() => assertLeastPrivilegeUser(url('orq_ingest'))).not.toThrow();
  });

  it('recusa postgres, postgres.<ref>, service_role e supabase_admin', () => {
    for (const u of ['postgres', `postgres.${REF}`, 'service_role', 'supabase_admin']) {
      expect(() => assertLeastPrivilegeUser(url(u))).toThrow(/privil|orq_ingest/i);
    }
  });

  it('recusa URL vazia, inválida ou sem usuário', () => {
    expect(() => assertLeastPrivilegeUser('')).toThrow();
    expect(() => assertLeastPrivilegeUser('não é url')).toThrow();
    expect(() => assertLeastPrivilegeUser('postgresql://aws-0.pooler.supabase.com:5432/postgres')).toThrow();
  });

  it('a mensagem de erro não vaza a senha', () => {
    try {
      assertLeastPrivilegeUser(`postgresql://postgres.${REF}:MinhaSenhaSecreta@h:5432/postgres`);
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('MinhaSenhaSecreta');
    }
  });
});

describe('assertRoleUser (papéis do Data Hub)', () => {
  const url = (user: string) => `postgresql://${user}:senha@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`;
  it.each(['orq_sync', 'orq_panel'])('aceita %s e %s.<ref>', (role) => {
    expect(() => assertRoleUser(url(role), role)).not.toThrow();
    expect(() => assertRoleUser(url(`${role}.${REF}`), role)).not.toThrow();
  });
  it('recusa postgres, o papel trocado e prefixos parecidos', () => {
    expect(() => assertRoleUser(url(`postgres.${REF}`), 'orq_sync')).toThrow(/orq_sync/);
    expect(() => assertRoleUser(url('orq_panel'), 'orq_sync')).toThrow();
    expect(() => assertRoleUser(url('orq_syncx'), 'orq_sync')).toThrow();
    expect(() => assertRoleUser('', 'orq_sync')).toThrow();
  });
  it('não vaza a senha', () => {
    try {
      assertRoleUser(`postgresql://postgres:SenhaSecreta@h/db`, 'orq_sync');
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('SenhaSecreta');
    }
  });
});
