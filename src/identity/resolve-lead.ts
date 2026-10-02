/** Identificação e deduplicação do lead (seção 10). */

export type LeadRow = {
  id: string;
  email_norm: string | null;
  phone_e164: string | null;
  nome?: string | null;
  empresa?: string | null;
  porte?: number | null;
  cargo?: string | null;
  produto?: 'rh' | 'clinic' | null;
  status?: string | null;
};

/** Acesso a core.leads. A implementação Supabase fica em src/db; os testes usam um fake. */
export interface LeadRepo {
  findById(id: string): Promise<LeadRow | null>;
  findByEmail(emailNorm: string): Promise<LeadRow | null>;
  findByPhone(phoneE164: string): Promise<LeadRow | null>;
  create(data: Partial<LeadRow>): Promise<LeadRow>;
  fillMissing(id: string, patch: Partial<LeadRow>): Promise<void>;
}

export type LeadIdentity = {
  lead_id: string | null;
  email_norm: string | null;
  phone_e164: string | null;
  nome?: string | null;
  empresa?: string | null;
  porte?: number | null;
  cargo?: string | null;
  produto?: 'rh' | 'clinic' | null;
};

export type ResolvedLead = {
  lead_id: string;
  created: boolean;
  matched_by: 'lead_id' | 'email' | 'phone' | 'created';
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export async function resolveLead(identity: LeadIdentity, repo: LeadRepo): Promise<ResolvedLead> {
  const validLid = isUuid(identity.lead_id) ? identity.lead_id : null;

  // 1. lead_id válido (formato) e existente
  if (validLid) {
    const byId = await repo.findById(validLid);
    if (byId) {
      await fillContact(byId, identity, repo);
      return { lead_id: byId.id, created: false, matched_by: 'lead_id' };
    }
  }

  // 2. e-mail
  if (identity.email_norm) {
    const byEmail = await repo.findByEmail(identity.email_norm);
    if (byEmail) {
      await fillContact(byEmail, identity, repo);
      return { lead_id: byEmail.id, created: false, matched_by: 'email' };
    }
  }

  // 3. telefone
  if (identity.phone_e164) {
    const byPhone = await repo.findByPhone(identity.phone_e164);
    if (byPhone) {
      await fillContact(byPhone, identity, repo);
      return { lead_id: byPhone.id, created: false, matched_by: 'phone' };
    }
  }

  // 4. lead novo (reaproveita o UUID do cookie, para o navegador e o banco concordarem)
  const row = await repo.create({
    ...(validLid ? { id: validLid } : {}),
    email_norm: identity.email_norm,
    phone_e164: identity.phone_e164,
    nome: identity.nome ?? null,
    empresa: identity.empresa ?? null,
    porte: identity.porte ?? null,
    cargo: identity.cargo ?? null,
    produto: identity.produto ?? null,
  });
  return { lead_id: row.id, created: true, matched_by: 'created' };
}

/** Preenche só o que falta no lead, sem sobrescrever e sem violar a unicidade de e-mail/telefone. */
async function fillContact(lead: LeadRow, identity: LeadIdentity, repo: LeadRepo): Promise<void> {
  const patch: Partial<LeadRow> = {};

  if (!lead.email_norm && identity.email_norm) {
    const owner = await repo.findByEmail(identity.email_norm);
    if (!owner) patch.email_norm = identity.email_norm;
  }
  if (!lead.phone_e164 && identity.phone_e164) {
    const owner = await repo.findByPhone(identity.phone_e164);
    if (!owner) patch.phone_e164 = identity.phone_e164;
  }
  if (!lead.nome && identity.nome) patch.nome = identity.nome;
  if (!lead.empresa && identity.empresa) patch.empresa = identity.empresa;
  if (lead.porte == null && identity.porte != null) patch.porte = identity.porte;
  if (!lead.cargo && identity.cargo) patch.cargo = identity.cargo;
  if (!lead.produto && identity.produto) patch.produto = identity.produto;

  if (Object.keys(patch).length > 0) await repo.fillMissing(lead.id, patch);
}
