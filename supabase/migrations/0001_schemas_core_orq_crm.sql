-- 0001: schemas e tabelas core, orq e crm (secoes 8.1 e 8.2 do orquestrador-marketing-quark.md).
-- Somente aditiva. Nada no schema public (secao 4, regras 1 e 3).

create schema if not exists core;
create schema if not exists orq;
create schema if not exists crm;

comment on schema core is 'Identidade: leads e empresas';
comment on schema orq is 'Orquestracao: fontes, touchpoints, eventos, regras, decisoes';
comment on schema crm is 'Espelho do Pipedrive';

-- ---------------------------------------------------------------------------
-- Funcoes auxiliares
-- ---------------------------------------------------------------------------

create function core.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Principio 5: eventos sao imutaveis. Nunca editar nem apagar registros de orq.events.
create function orq.block_event_mutation() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'orq.events e imutavel (principio 5): % bloqueado', tg_op
    using errcode = 'restrict_violation';
end;
$$;

-- ---------------------------------------------------------------------------
-- core (secao 8.1)
-- ---------------------------------------------------------------------------

create table core.leads (
  id uuid primary key default gen_random_uuid(),
  email_norm text unique,
  phone_e164 text unique,
  nome text,
  empresa text,
  porte int,
  cargo text,
  produto text check (produto in ('rh','clinic')),
  status text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create trigger leads_set_updated_at
  before update on core.leads
  for each row execute function core.set_updated_at();

-- ---------------------------------------------------------------------------
-- orq (secao 8.1)
-- ---------------------------------------------------------------------------

create table orq.sources (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  tipo text check (tipo in ('elementor','vercel','lovable','fillout','meta_form')),
  produto text,
  url text,
  token_hash text not null,
  ativo boolean default true
);

create table orq.touchpoints (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references core.leads(id),
  source_id uuid references orq.sources(id),
  event_id text unique,
  canal text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  ad_id text,
  gclid text,
  gbraid text,
  wbraid text,
  fbp text,
  fbc text,
  ga_client_id text,
  landing_url text,
  referrer text,
  occurred_at timestamptz not null
);

create table orq.events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references core.leads(id),
  touchpoint_id uuid references orq.touchpoints(id),
  tipo text not null,
  dados jsonb,
  payload_bruto jsonb,
  occurred_at timestamptz not null
);

create trigger events_block_update_delete
  before update or delete on orq.events
  for each row execute function orq.block_event_mutation();

create trigger events_block_truncate
  before truncate on orq.events
  for each statement execute function orq.block_event_mutation();

create table orq.rules (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  prioridade int not null,
  condicoes jsonb not null,
  acao text check (acao in ('criar_deal','marcar_evento','convidar_diagnostico','validar_lead','ignorar')),
  parametros jsonb,
  versao int default 1,
  ativo boolean default true
);

create table orq.decisions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references orq.events(id),
  rule_id uuid references orq.rules(id),
  rule_versao int,
  acao text,
  modo text check (modo in ('sombra','real')),
  status text check (status in ('pendente','ok','erro')),
  erro text,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- crm (secao 8.2)
-- ---------------------------------------------------------------------------

create table crm.deals (
  pipedrive_id bigint primary key,
  lead_id uuid references core.leads(id),
  pipeline text,
  estagio text,
  status text check (status in ('open','won','lost')),
  valor numeric,
  motivo_perda text,
  owner text,
  created_at timestamptz,
  won_at timestamptz,
  updated_at timestamptz
);

create table crm.stage_history (
  deal_id bigint references crm.deals(pipedrive_id),
  estagio text,
  entrou_em timestamptz,
  primary key (deal_id, estagio, entrou_em)
);

-- ---------------------------------------------------------------------------
-- Indices (acrescimo ao DDL do documento: chaves estrangeiras e consultas do caminho critico)
-- ---------------------------------------------------------------------------

create index touchpoints_lead_id_idx on orq.touchpoints (lead_id);
create index touchpoints_source_id_idx on orq.touchpoints (source_id);
create index touchpoints_occurred_at_idx on orq.touchpoints (occurred_at);
create index events_lead_id_idx on orq.events (lead_id);
create index events_touchpoint_id_idx on orq.events (touchpoint_id);
create index events_tipo_occurred_at_idx on orq.events (tipo, occurred_at);
create index decisions_event_id_idx on orq.decisions (event_id);
create index decisions_rule_id_idx on orq.decisions (rule_id);
create index rules_prioridade_idx on orq.rules (prioridade) where ativo;
create index deals_lead_id_idx on crm.deals (lead_id);
