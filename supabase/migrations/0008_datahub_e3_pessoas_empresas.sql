-- 0008: Data Hub, ENTREGA 3 (pessoas, empresas e vinculo com os leads do orquestrador).
-- Derivada de docs/datahub/proposta-schema.sql (bloco ENTREGA 3), ajustada pela sondagem de 2026-10-07 (D-38):
--   * 35.428 pessoas e 23.146 empresas desde 2025-01-01; uma pessoa tem ate 15 e-mails e 20 telefones (todos guardados);
--   * o Pipedrive NAO lista pessoas/empresas excluidas: quem some da lista completa e MARCADO (is_deleted), nunca apagado.
-- Dados pessoais: o Painel nao enxerga raw nem crm; so as views de analytics, que NAO trazem e-mail nem telefone.
-- Somente aditiva (so ADD/CREATE; as views existentes so ganham colunas no fim). Nada em public; core e orq nao sao alterados:
-- o orq_sync apenas LE 3 colunas de core.leads (id, email_norm, phone_e164), para o vinculo.

create table raw.pd_persons (
  source_id bigint primary key,
  payload jsonb not null,                          -- JSON original (inclui e-mails, telefones, notas, endereco...)
  payload_hash text not null,
  source_add_time timestamptz,
  source_update_time timestamptz,
  first_seen_at timestamptz not null default now(),
  synced_at timestamptz not null default now()
);
create table raw.pd_organizations (like raw.pd_persons including all);

create table crm.persons (
  person_id bigint primary key,
  nome text,
  emails jsonb,                                    -- todos, como vieram ({value, primary, label})
  telefones jsonb,
  emails_norm text[] not null default '{}',        -- todos, na mesma normalizacao do orquestrador (minusculas, sem espacos)
  telefones_e164 text[] not null default '{}',     -- todos, em E.164 (os que nao der para normalizar ficam so no JSON)
  email_principal_norm text,
  telefone_principal_e164 text,
  org_id bigint,
  owner_id bigint,
  cargo text,
  add_time timestamptz,
  update_time timestamptz,
  is_deleted boolean not null default false,       -- marcado, nunca apagado
  deleted_detected_at timestamptz,
  custom_fields jsonb,                             -- com o ID original (hash de 40 caracteres)
  synced_at timestamptz not null default now()
);
create table crm.organizations (
  org_id bigint primary key,
  nome text,
  owner_id bigint,
  website text,
  setor text,
  funcionarios int,
  add_time timestamptz,
  update_time timestamptz,
  is_deleted boolean not null default false,
  deleted_detected_at timestamptz,
  custom_fields jsonb,
  synced_at timestamptz not null default now()
);
create index persons_emails_idx on crm.persons using gin (emails_norm);
create index persons_phones_idx on crm.persons using gin (telefones_e164);
create index persons_org_idx on crm.persons (org_id);
create index persons_owner_idx on crm.persons (owner_id);

-- Vinculo negocio -> lead do orquestrador (so em crm; core e orq nao mudam). Uma pessoa pode bater com mais de um lead.
create table crm.deal_lead_links (
  deal_id bigint not null references crm.deals(pipedrive_id),
  lead_id uuid not null references core.leads(id),
  vinculado_por text not null check (vinculado_por in ('email', 'telefone')),
  vinculado_em timestamptz not null default now(),
  primary key (deal_id, lead_id, vinculado_por)
);
create index deal_lead_links_lead_idx on crm.deal_lead_links (lead_id);

alter table raw.pd_persons enable row level security;
alter table raw.pd_organizations enable row level security;
alter table crm.persons enable row level security;
alter table crm.organizations enable row level security;
alter table crm.deal_lead_links enable row level security;

grant select, insert, update on raw.pd_persons, raw.pd_organizations, crm.persons, crm.organizations to orq_sync;
grant select, insert on crm.deal_lead_links to orq_sync;
create policy orq_sync_all on raw.pd_persons for all to orq_sync using (true) with check (true);
create policy orq_sync_all on raw.pd_organizations for all to orq_sync using (true) with check (true);
create policy orq_sync_all on crm.persons for all to orq_sync using (true) with check (true);
create policy orq_sync_all on crm.organizations for all to orq_sync using (true) with check (true);
create policy orq_sync_all on crm.deal_lead_links for all to orq_sync using (true) with check (true);

-- leitura de SO 3 colunas dos leads (nunca nome, empresa, cargo...), para casar e-mail e telefone
grant select (id, email_norm, phone_e164) on core.leads to orq_sync;
create policy orq_sync_read_leads on core.leads for select to orq_sync using (true);

-- ---------- views do Painel (sem e-mail e sem telefone) ----------
create view analytics.pessoas as
select p.person_id, p.nome, p.cargo,
       p.org_id, o.nome as organizacao,
       p.owner_id, u.nome as responsavel,
       cardinality(p.emails_norm) as qtd_emails, cardinality(p.telefones_e164) as qtd_telefones,
       (cardinality(p.emails_norm) > 0) as tem_email, (cardinality(p.telefones_e164) > 0) as tem_telefone,
       p.add_time as criado_em, p.update_time as atualizado_em,
       p.is_deleted,
       (select count(*)::int from crm.deals d where d.person_id = p.person_id) as qtd_negocios,
       exists (select 1 from crm.deals d join crm.deal_lead_links l on l.deal_id = d.pipedrive_id where d.person_id = p.person_id) as vinculada_a_lead
from crm.persons p
left join crm.organizations o on o.org_id = p.org_id
left join crm.users u on u.user_id = p.owner_id;

create view analytics.organizacoes as
select o.org_id, o.nome, o.website, o.setor, o.funcionarios,
       o.owner_id, u.nome as responsavel,
       o.add_time as criado_em, o.update_time as atualizado_em,
       o.is_deleted,
       (select count(*)::int from crm.persons p where p.org_id = o.org_id and not p.is_deleted) as qtd_pessoas,
       (select count(*)::int from crm.deals d where d.org_id = o.org_id) as qtd_negocios
from crm.organizations o
left join crm.users u on u.user_id = o.owner_id;

-- Negocios ligados a leads do orquestrador (so IDs; sem nome nem contato do lead)
create view analytics.vinculos as
select l.deal_id, l.lead_id, l.vinculado_por, l.vinculado_em,
       d.titulo, d.pipeline, d.etapa, d.status, d.produto as produto_negocio, ld.produto as produto_lead
from crm.deal_lead_links l
join analytics.deals d on d.deal_id = l.deal_id
join core.leads ld on ld.id = l.lead_id;

grant select on analytics.pessoas, analytics.organizacoes, analytics.vinculos to orq_panel;
