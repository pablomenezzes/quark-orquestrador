import { describe, it, expect, beforeEach } from 'vitest';
import { resolveLead, type LeadRepo, type LeadRow } from '../src/identity/resolve-lead';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_NEW = '33333333-3333-4333-8333-333333333333';

class FakeRepo implements LeadRepo {
  rows: LeadRow[] = [];
  created: Array<Partial<LeadRow>> = [];
  filled: Array<{ id: string; patch: Partial<LeadRow> }> = [];
  async findById(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async findByEmail(e: string) {
    return this.rows.find((r) => r.email_norm === e) ?? null;
  }
  async findByPhone(p: string) {
    return this.rows.find((r) => r.phone_e164 === p) ?? null;
  }
  async create(data: Partial<LeadRow>) {
    const row: LeadRow = { id: data.id ?? UUID_NEW, email_norm: null, phone_e164: null, ...data };
    this.created.push(data);
    this.rows.push(row);
    return row;
  }
  async fillMissing(id: string, patch: Partial<LeadRow>) {
    this.filled.push({ id, patch });
    const r = this.rows.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
  }
}

let repo: FakeRepo;
beforeEach(() => {
  repo = new FakeRepo();
  repo.rows.push({ id: UUID_A, email_norm: 'a@x.com', phone_e164: '+5584999999999' });
  repo.rows.push({ id: UUID_B, email_norm: 'b@x.com', phone_e164: null });
});

describe('resolveLead (seção 10)', () => {
  it('1. usa lead_id válido que existe no banco', async () => {
    const r = await resolveLead({ lead_id: UUID_A, email_norm: 'a@x.com', phone_e164: null }, repo);
    expect(r).toMatchObject({ lead_id: UUID_A, created: false, matched_by: 'lead_id' });
  });

  describe('o e-mail pesa mais que o cookie (D-06)', () => {
    it('lead_id existe mas o e-mail enviado é de outra pessoa: NÃO anexa ao lead do cookie', async () => {
      // cookie aponta para A (a@x.com), mas quem enviou foi b@x.com
      const r = await resolveLead({ lead_id: UUID_A, email_norm: 'b@x.com', phone_e164: null }, repo);
      expect(r.lead_id).toBe(UUID_B);
      expect(r.matched_by).toBe('email');
      expect(repo.filled).toEqual([]);
    });

    it('e-mail novo + cookie de outro lead: cria lead novo com UUID NOVO, nunca com o UUID do cookie', async () => {
      const r = await resolveLead({ lead_id: UUID_A, email_norm: 'novo@x.com', phone_e164: null }, repo);
      expect(r.created).toBe(true);
      expect(r.lead_id).not.toBe(UUID_A);
      expect(repo.created[0]?.id).toBeUndefined();
      expect(repo.rows.find((x) => x.id === UUID_A)?.email_norm).toBe('a@x.com');
    });

    it('e-mail diferente com telefone do lead do cookie: ainda não anexa (e-mail manda)', async () => {
      const r = await resolveLead({ lead_id: UUID_A, email_norm: 'novo@x.com', phone_e164: '+5584999999999' }, repo);
      expect(r.lead_id).not.toBe(UUID_A);
      expect(r.created).toBe(true);
      // o telefone é unique e continua com o lead A
      expect(repo.created[0]?.phone_e164).toBeNull();
      expect(repo.rows.find((x) => x.id === UUID_A)?.phone_e164).toBe('+5584999999999');
    });

    it('evento sem e-mail: o lead_id do cookie vale', async () => {
      const r = await resolveLead({ lead_id: UUID_A, email_norm: null, phone_e164: null }, repo);
      expect(r).toMatchObject({ lead_id: UUID_A, matched_by: 'lead_id', created: false });
    });

    it('lead do cookie sem e-mail, mas o e-mail enviado já é de outro lead: vai para o dono do e-mail', async () => {
      repo.rows.push({ id: UUID_NEW, email_norm: null, phone_e164: null });
      const r = await resolveLead({ lead_id: UUID_NEW, email_norm: 'b@x.com', phone_e164: null }, repo);
      expect(r).toMatchObject({ lead_id: UUID_B, matched_by: 'email' });
    });

    it('lead do cookie sem e-mail: o lead_id vale e o e-mail é preenchido', async () => {
      repo.rows.push({ id: UUID_NEW, email_norm: null, phone_e164: null });
      const r = await resolveLead({ lead_id: UUID_NEW, email_norm: 'recem@x.com', phone_e164: null }, repo);
      expect(r).toMatchObject({ lead_id: UUID_NEW, matched_by: 'lead_id', created: false });
      expect(repo.filled).toEqual([{ id: UUID_NEW, patch: { email_norm: 'recem@x.com' } }]);
    });
  });

  it('lead_id com formato inválido é ignorado e cai para o e-mail', async () => {
    const r = await resolveLead({ lead_id: 'nao-uuid', email_norm: 'a@x.com', phone_e164: null }, repo);
    expect(r).toMatchObject({ lead_id: UUID_A, matched_by: 'email', created: false });
  });

  it('lead_id válido mas inexistente cai para o e-mail', async () => {
    const r = await resolveLead({ lead_id: UUID_NEW, email_norm: 'b@x.com', phone_e164: null }, repo);
    expect(r).toMatchObject({ lead_id: UUID_B, matched_by: 'email' });
  });

  it('2. busca por e-mail', async () => {
    const r = await resolveLead({ lead_id: null, email_norm: 'b@x.com', phone_e164: null }, repo);
    expect(r).toMatchObject({ lead_id: UUID_B, matched_by: 'email', created: false });
  });

  it('3. busca por telefone quando e-mail não acha', async () => {
    const r = await resolveLead({ lead_id: null, email_norm: 'novo@x.com', phone_e164: '+5584999999999' }, repo);
    expect(r).toMatchObject({ lead_id: UUID_A, matched_by: 'phone', created: false });
  });

  it('e-mail tem precedência sobre telefone quando apontam leads diferentes', async () => {
    const r = await resolveLead({ lead_id: null, email_norm: 'b@x.com', phone_e164: '+5584999999999' }, repo);
    expect(r.lead_id).toBe(UUID_B);
    expect(r.matched_by).toBe('email');
  });

  it('4. cria lead novo quando nada casa', async () => {
    const r = await resolveLead(
      { lead_id: null, email_norm: 'novo@x.com', phone_e164: '+5511988887777', nome: 'Novo' },
      repo,
    );
    expect(r.created).toBe(true);
    expect(r.matched_by).toBe('created');
    expect(repo.created).toHaveLength(1);
    expect(repo.created[0]).toMatchObject({ email_norm: 'novo@x.com', phone_e164: '+5511988887777', nome: 'Novo' });
  });

  it('ao criar, reaproveita o lead_id do cookie (UUID válido) como id', async () => {
    const r = await resolveLead({ lead_id: UUID_NEW, email_norm: 'novo@x.com', phone_e164: null }, repo);
    expect(r.created).toBe(true);
    expect(r.lead_id).toBe(UUID_NEW);
    expect(repo.created[0]?.id).toBe(UUID_NEW);
  });

  it('cria lead mesmo sem e-mail nem telefone (evento anônimo)', async () => {
    const r = await resolveLead({ lead_id: null, email_norm: null, phone_e164: null }, repo);
    expect(r.created).toBe(true);
  });

  it('completa telefone ausente no lead achado por e-mail, se o telefone for livre', async () => {
    await resolveLead({ lead_id: null, email_norm: 'b@x.com', phone_e164: '+5511977776666' }, repo);
    expect(repo.filled).toEqual([{ id: UUID_B, patch: { phone_e164: '+5511977776666' } }]);
  });

  it('não completa telefone que já pertence a outro lead (unique)', async () => {
    await resolveLead({ lead_id: null, email_norm: 'b@x.com', phone_e164: '+5584999999999' }, repo);
    expect(repo.filled).toEqual([]);
  });

  it('não sobrescreve campos que o lead já tem', async () => {
    await resolveLead({ lead_id: null, email_norm: 'a@x.com', phone_e164: '+5511977776666' }, repo);
    expect(repo.filled).toEqual([]);
  });
});
