-- ============================================================================
-- PROPOSTA (NAO APLICADA) - Data Hub do Pipedrive, organizacao das tabelas.
-- Entrega 0 do comando "Data Hub de Marketing". Fica em docs/ de proposito: nao e migration.
-- Cada bloco vira UMA migration, aplicada so na entrega correspondente, com dump previo
-- e com a confirmacao do Pablo (regras 2 e 4 da secao 4 do MD).
-- Tudo aditivo: nenhum DROP, RENAME ou mudanca de tipo. Nada no schema public.
-- ============================================================================

-- ############################################################################
-- ENTREGA 1 - base: schemas, papeis, pipelines, etapas, usuarios, campos, configuracao, controle
-- ############################################################################

create schema if not exists raw;        -- payload original do Pipedrive, uma tabela por entidade
create schema if not exists ops;        -- controle de sincronizacao e configuracao editavel
create schema if not exists analytics;  -- SO views; e o que o Painel e as analises leem

comment on schema raw is 'Pipedrive: payload original (nada e descartado na origem)';
comment on schema ops is 'Controle de sincronizacao e configuracao (pipeline->produto, etapa->marco, nomes de campos)';
comment on schema analytics is 'Somente views. O Painel le daqui';

-- ---------- papeis (sem senha aqui; a senha e definida por script, fora do versionamento) ----------
-- orq_sync  : roda a sincronizacao (grava raw, crm e controle). Nao apaga nada. Le core.leads so para o vinculo.
-- orq_panel : usado pelo Painel local. Le analytics e ops; grava SO nas tabelas de configuracao.
create role orq_sync  login nosuperuser nocreatedb nocreaterole noinherit noreplication connection limit 10;
create role orq_panel login nosuperuser nocreatedb nocreaterole noinherit noreplication connection limit 5;
alter role orq_sync  set statement_timeout = '120s';
alter role orq_sync  set idle_in_transaction_session_timeout = '60s';
alter role orq_panel set statement_timeout = '30s';
alter role orq_panel set idle_in_transaction_session_timeout = '30s';
grant orq_sync to postgres;   -- permite os testes assumirem o papel (SET ROLE), como no orq_ingest
grant orq_panel to postgres;
grant usage on schema raw, crm, ops to orq_sync;
grant usage on schema core to orq_sync;
grant usage on schema ops, analytics to orq_panel;

-- ---------- raw (E1): pipelines, etapas, usuarios, definicao de campos ----------
create table raw.pd_pipelines (
  source_id bigint primary key,
  payload jsonb not null,
  payload_hash text not null,
  source_add_time timestamptz,
  source_update_time timestamptz,
  first_seen_at timestamptz not null default now(),
  synced_at timestamptz not null default now()
);
create table raw.pd_stages (like raw.pd_pipelines including all);
create table raw.pd_users  (like raw.pd_pipelines including all);

create table raw.pd_field_defs (
  entity text not null check (entity in ('deal','person','organization','activity')),
  field_key text not null,                 -- id original (hash de 40 caracteres nos campos personalizados)
  payload jsonb not null,
  payload_hash text not null,
  first_seen_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  primary key (entity, field_key)
);

-- ---------- crm (E1): normalizadas ----------
create table crm.pipelines (
  pipeline_id bigint primary key,
  nome text not null,
  ordem int,
  ativo boolean,
  source_update_time timestamptz,
  synced_at timestamptz not null default now()
);
create table crm.stages (
  stage_id bigint primary key,
  pipeline_id bigint not null references crm.pipelines(pipeline_id),
  nome text not null,
  ordem int,
  probabilidade int,
  ativo boolean,
  source_update_time timestamptz,
  synced_at timestamptz not null default now()
);
create table crm.users (
  user_id bigint primary key,
  nome text,
  email text,
  ativo boolean,
  synced_at timestamptz not null default now()
);
create table crm.field_definitions (
  entity text not null check (entity in ('deal','person','organization','activity')),
  field_key text not null,
  nome text,                               -- nome que o Pipedrive mostra hoje (pode mudar)
  tipo text,
  opcoes jsonb,
  ordem int,
  synced_at timestamptz not null default now(),
  primary key (entity, field_key)
);
create index stages_pipeline_id_idx on crm.stages (pipeline_id);

-- ---------- ops: configuracao editavel no Painel ----------
create table ops.cfg_pipeline_produto (
  pipeline_id bigint primary key references crm.pipelines(pipeline_id),
  produto text check (produto in ('rh','clinic')),   -- null = ainda nao definido
  atualizado_em timestamptz not null default now()
);
create table ops.cfg_stage_marco (
  stage_id bigint primary key references crm.stages(stage_id),
  marco text check (marco in ('lead','mql','sql','reuniao','proposta','ganho','perdido')),
  atualizado_em timestamptz not null default now()
);
create table ops.cfg_field_rotulo (
  entity text not null check (entity in ('deal','person','organization','activity')),
  field_key text not null,
  rotulo text not null,                    -- nome legivel escolhido por voce; o id original nunca muda
  atualizado_em timestamptz not null default now(),
  primary key (entity, field_key)
);

-- ---------- ops: controle da sincronizacao ----------
create table ops.sync_settings (
  entity text primary key,
  habilitada boolean not null default true,
  intervalo_minutos int not null default 240 check (intervalo_minutos >= 15),   -- 4 horas; editavel no Painel
  desde date not null default date '2025-01-01',
  max_share_tokens numeric not null default 0.4 check (max_share_tokens > 0 and max_share_tokens <= 1),
  atualizado_em timestamptz not null default now()
);
create table ops.sync_jobs (
  job_id uuid primary key default gen_random_uuid(),
  entity text not null,
  modo text not null check (modo in ('backfill','incremental')),
  origem text not null check (origem in ('agendada','manual')),
  iniciou_em timestamptz not null default now(),
  terminou_em timestamptz,
  status text not null check (status in ('rodando','ok','parcial','erro')),
  lidos int not null default 0,
  gravados int not null default 0,
  atualizados int not null default 0,
  ignorados int not null default 0,
  falhas int not null default 0,
  tokens_gastos int not null default 0,
  cursor_final jsonb,
  erro text
);
create table ops.sync_checkpoints (
  entity text primary key,
  marca_dagua timestamptz,                 -- maior update_time ja processado
  cursor_atual jsonb,                      -- onde parou, para continuar sem duplicar
  ultimo_sucesso_em timestamptz,
  ultimo_job uuid references ops.sync_jobs(job_id),
  backfill_concluido boolean not null default false
);
create table ops.sync_errors (
  id bigint generated always as identity primary key,
  job_id uuid references ops.sync_jobs(job_id),
  entity text not null,
  source_id bigint,
  mensagem text not null,
  payload jsonb,
  criado_em timestamptz not null default now()
);
create table ops.api_usage_daily (
  dia date primary key,
  tokens_gastos int not null default 0,
  requisicoes int not null default 0,
  limite_429 int not null default 0
);
create index sync_jobs_entity_iniciou_idx on ops.sync_jobs (entity, iniciou_em desc);

-- ---------- RLS e privilegios da Entrega 1 (o padrao se repete nas entregas seguintes) ----------
alter table raw.pd_pipelines enable row level security;
alter table raw.pd_stages enable row level security;
alter table raw.pd_users enable row level security;
alter table raw.pd_field_defs enable row level security;
alter table crm.pipelines enable row level security;
alter table crm.stages enable row level security;
alter table crm.users enable row level security;
alter table crm.field_definitions enable row level security;
alter table ops.cfg_pipeline_produto enable row level security;
alter table ops.cfg_stage_marco enable row level security;
alter table ops.cfg_field_rotulo enable row level security;
alter table ops.sync_settings enable row level security;
alter table ops.sync_jobs enable row level security;
alter table ops.sync_checkpoints enable row level security;
alter table ops.sync_errors enable row level security;
alter table ops.api_usage_daily enable row level security;

-- orq_sync: grava raw e crm (sem delete), grava o controle, le a configuracao
grant select, insert, update on raw.pd_pipelines, raw.pd_stages, raw.pd_users, raw.pd_field_defs to orq_sync;
grant select, insert, update on crm.pipelines, crm.stages, crm.users, crm.field_definitions to orq_sync;
grant select, insert, update on ops.sync_settings, ops.sync_jobs, ops.sync_checkpoints, ops.api_usage_daily to orq_sync;
grant select, insert on ops.sync_errors to orq_sync;
grant select on ops.cfg_pipeline_produto, ops.cfg_stage_marco, ops.cfg_field_rotulo to orq_sync;
create policy orq_sync_all on raw.pd_pipelines for all to orq_sync using (true) with check (true);
create policy orq_sync_all on raw.pd_stages for all to orq_sync using (true) with check (true);
create policy orq_sync_all on raw.pd_users for all to orq_sync using (true) with check (true);
create policy orq_sync_all on raw.pd_field_defs for all to orq_sync using (true) with check (true);
create policy orq_sync_all on crm.pipelines for all to orq_sync using (true) with check (true);
create policy orq_sync_all on crm.stages for all to orq_sync using (true) with check (true);
create policy orq_sync_all on crm.users for all to orq_sync using (true) with check (true);
create policy orq_sync_all on crm.field_definitions for all to orq_sync using (true) with check (true);
create policy orq_sync_all on ops.sync_settings for all to orq_sync using (true) with check (true);
create policy orq_sync_all on ops.sync_jobs for all to orq_sync using (true) with check (true);
create policy orq_sync_all on ops.sync_checkpoints for all to orq_sync using (true) with check (true);
create policy orq_sync_all on ops.api_usage_daily for all to orq_sync using (true) with check (true);
create policy orq_sync_all on ops.sync_errors for all to orq_sync using (true) with check (true);
create policy orq_sync_read on ops.cfg_pipeline_produto for select to orq_sync using (true);
create policy orq_sync_read on ops.cfg_stage_marco for select to orq_sync using (true);
create policy orq_sync_read on ops.cfg_field_rotulo for select to orq_sync using (true);

-- orq_panel: le o controle e a configuracao; GRAVA SO a configuracao (e a frequencia da sincronizacao)
grant select on ops.sync_settings, ops.sync_jobs, ops.sync_checkpoints, ops.sync_errors, ops.api_usage_daily to orq_panel;
grant select, insert, update on ops.cfg_pipeline_produto, ops.cfg_stage_marco, ops.cfg_field_rotulo to orq_panel;
grant update (habilitada, intervalo_minutos, desde, max_share_tokens, atualizado_em) on ops.sync_settings to orq_panel;
create policy orq_panel_read on ops.sync_settings for select to orq_panel using (true);
create policy orq_panel_update on ops.sync_settings for update to orq_panel using (true) with check (true);
create policy orq_panel_read on ops.sync_jobs for select to orq_panel using (true);
create policy orq_panel_read on ops.sync_checkpoints for select to orq_panel using (true);
create policy orq_panel_read on ops.sync_errors for select to orq_panel using (true);
create policy orq_panel_read on ops.api_usage_daily for select to orq_panel using (true);
create policy orq_panel_all on ops.cfg_pipeline_produto for all to orq_panel using (true) with check (true);
create policy orq_panel_all on ops.cfg_stage_marco for all to orq_panel using (true) with check (true);
create policy orq_panel_all on ops.cfg_field_rotulo for all to orq_panel using (true) with check (true);
-- orq_panel nao tem NENHUM acesso a raw, crm ou core: so ve dados pessoais por views de analytics.
alter default privileges in schema analytics grant select on tables to orq_panel;

-- ############################################################################
-- ENTREGA 2 - deals (evolui crm.deals de forma aditiva; crm.deals hoje tem 0 linhas)
-- ############################################################################

create table raw.pd_deals (
  source_id bigint primary key,
  payload jsonb not null,
  payload_hash text not null,
  source_add_time timestamptz,
  source_update_time timestamptz,
  is_archived boolean not null default false,
  is_deleted boolean not null default false,       -- marcado, nunca apagado
  deleted_detected_at timestamptz,
  first_seen_at timestamptz not null default now(),
  synced_at timestamptz not null default now()
);

-- crm.deals ja tem: pipedrive_id, lead_id, pipeline (nome), estagio (nome), status, valor, motivo_perda,
-- owner (nome), created_at (= add_time), won_at, updated_at (= update_time). Acrescenta os IDs e o resto:
alter table crm.deals
  add column pipeline_id bigint,
  add column stage_id bigint,
  add column owner_id bigint,
  add column titulo text,
  add column moeda text,
  add column person_id bigint,
  add column org_id bigint,
  add column stage_change_time timestamptz,
  add column close_time timestamptz,
  add column lost_time timestamptz,
  add column expected_close_date date,
  add column origin text,
  add column origin_id text,
  add column channel text,
  add column channel_id text,
  add column is_archived boolean not null default false,
  add column is_deleted boolean not null default false,
  add column deleted_detected_at timestamptz,
  add column custom_fields jsonb,                  -- campos personalizados com o ID original (hash)
  add column historico_status text check (historico_status in ('completo','parcial','desconhecido')),
  add column synced_at timestamptz;
-- O status continua 'open' | 'won' | 'lost' (a CHECK existente nao muda). Deal excluido no Pipedrive
-- fica com is_deleted = true e o ultimo status conhecido: nao mudamos o tipo nem a restricao.

create index deals_pipeline_stage_idx on crm.deals (pipeline_id, stage_id);
create index deals_person_idx on crm.deals (person_id);
create index deals_org_idx on crm.deals (org_id);
create index deals_update_idx on crm.deals (updated_at);

-- vinculo com o orquestrador SEM alterar core nem orq
create table crm.deal_lead_links (
  deal_id bigint not null references crm.deals(pipedrive_id),
  lead_id uuid not null references core.leads(id),
  vinculado_por text not null check (vinculado_por in ('campo_lead_id','email','telefone')),
  vinculado_em timestamptz not null default now(),
  primary key (deal_id, lead_id)
);
create index deal_lead_links_lead_idx on crm.deal_lead_links (lead_id);

alter table raw.pd_deals enable row level security;
alter table crm.deal_lead_links enable row level security;
grant select, insert, update on raw.pd_deals to orq_sync;
grant select, insert, update on crm.deals to orq_sync;
grant select, insert on crm.deal_lead_links to orq_sync;
grant select (id, email_norm, phone_e164) on core.leads to orq_sync;
create policy orq_sync_all on raw.pd_deals for all to orq_sync using (true) with check (true);
create policy orq_sync_all on crm.deals for all to orq_sync using (true) with check (true);
create policy orq_sync_all on crm.deal_lead_links for all to orq_sync using (true) with check (true);
create policy orq_sync_read_leads on core.leads for select to orq_sync using (true);

-- ############################################################################
-- ENTREGA 3 - pessoas e empresas (dados pessoais: so por views, nunca direto pelo Painel)
-- ############################################################################

create table raw.pd_persons (
  source_id bigint primary key,
  payload jsonb not null,
  payload_hash text not null,
  source_add_time timestamptz,
  source_update_time timestamptz,
  is_deleted boolean not null default false,
  deleted_detected_at timestamptz,
  first_seen_at timestamptz not null default now(),
  synced_at timestamptz not null default now()
);
create table raw.pd_organizations (like raw.pd_persons including all);

create table crm.persons (
  person_id bigint primary key,
  nome text,
  emails jsonb,                                    -- todos, como vieram
  telefones jsonb,
  email_principal_norm text,                       -- mesma normalizacao do orquestrador (minusculas, sem espacos)
  telefone_principal_e164 text,                    -- E.164
  org_id bigint,
  owner_id bigint,
  add_time timestamptz,
  update_time timestamptz,
  is_deleted boolean not null default false,
  deleted_detected_at timestamptz,
  custom_fields jsonb,
  synced_at timestamptz not null default now()
);
create table crm.organizations (
  org_id bigint primary key,
  nome text,
  owner_id bigint,
  add_time timestamptz,
  update_time timestamptz,
  is_deleted boolean not null default false,
  deleted_detected_at timestamptz,
  custom_fields jsonb,
  synced_at timestamptz not null default now()
);
create index persons_email_idx on crm.persons (email_principal_norm);
create index persons_phone_idx on crm.persons (telefone_principal_e164);
create index persons_org_idx on crm.persons (org_id);

alter table raw.pd_persons enable row level security;
alter table raw.pd_organizations enable row level security;
alter table crm.persons enable row level security;
alter table crm.organizations enable row level security;
grant select, insert, update on raw.pd_persons, raw.pd_organizations, crm.persons, crm.organizations to orq_sync;
create policy orq_sync_all on raw.pd_persons for all to orq_sync using (true) with check (true);
create policy orq_sync_all on raw.pd_organizations for all to orq_sync using (true) with check (true);
create policy orq_sync_all on crm.persons for all to orq_sync using (true) with check (true);
create policy orq_sync_all on crm.organizations for all to orq_sync using (true) with check (true);

-- ############################################################################
-- ENTREGA 4 - atividades
-- ############################################################################

create table raw.pd_activities (
  source_id bigint primary key,
  payload jsonb not null,
  payload_hash text not null,
  source_add_time timestamptz,
  source_update_time timestamptz,
  is_deleted boolean not null default false,
  deleted_detected_at timestamptz,
  first_seen_at timestamptz not null default now(),
  synced_at timestamptz not null default now()
);
create table crm.activities (
  activity_id bigint primary key,
  tipo text,
  assunto text,
  concluida boolean,
  due_date date,
  due_time time,
  duracao text,
  deal_id bigint,
  person_id bigint,
  org_id bigint,
  owner_id bigint,
  add_time timestamptz,
  update_time timestamptz,
  concluida_em timestamptz,
  is_deleted boolean not null default false,
  deleted_detected_at timestamptz,
  synced_at timestamptz not null default now()
);
create index activities_deal_idx on crm.activities (deal_id);
create index activities_person_idx on crm.activities (person_id);

alter table raw.pd_activities enable row level security;
alter table crm.activities enable row level security;
grant select, insert, update on raw.pd_activities, crm.activities to orq_sync;
create policy orq_sync_all on raw.pd_activities for all to orq_sync using (true) with check (true);
create policy orq_sync_all on crm.activities for all to orq_sync using (true) with check (true);

-- ############################################################################
-- ENTREGA 5 - historico de etapas (evolui crm.stage_history de forma aditiva; hoje tem 0 linhas)
-- ############################################################################

-- itens de "flow" do Pipedrive (so as mudancas do deal, nao e-mails nem anexos)
create table raw.pd_deal_flow (
  deal_id bigint not null,
  item_key text not null,                          -- identifica o item de forma estavel (idempotente)
  item_type text not null,
  logged_at timestamptz,
  payload jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (deal_id, item_key)
);
create index deal_flow_deal_logged_idx on raw.pd_deal_flow (deal_id, logged_at);

create table crm.deal_field_changes (
  deal_id bigint not null references crm.deals(pipedrive_id),
  item_key text not null,
  field_key text not null,                         -- stage_id, pipeline_id, status, owner_id, value...
  valor_antigo text,
  valor_novo text,
  alterado_em timestamptz,
  user_id bigint,
  primary key (deal_id, item_key)
);
create index deal_changes_field_idx on crm.deal_field_changes (field_key, alterado_em);

-- crm.stage_history ja tem: deal_id, estagio (nome), entrou_em; PK (deal_id, estagio, entrou_em)
alter table crm.stage_history
  add column pipeline_id bigint,
  add column stage_id bigint,
  add column saiu_em timestamptz,
  add column stage_anterior_id bigint,
  add column stage_seguinte_id bigint,
  add column duracao_segundos bigint,
  add column origem_dado text check (origem_dado in ('flow','criacao','observado')),
  add column entrada_estimada boolean not null default false,   -- true quando a entrada nao veio do historico
  add column item_key text;

alter table raw.pd_deal_flow enable row level security;
alter table crm.deal_field_changes enable row level security;
alter table crm.stage_history enable row level security;
grant select, insert, update on raw.pd_deal_flow, crm.deal_field_changes, crm.stage_history to orq_sync;
create policy orq_sync_all on raw.pd_deal_flow for all to orq_sync using (true) with check (true);
create policy orq_sync_all on crm.deal_field_changes for all to orq_sync using (true) with check (true);
create policy orq_sync_all on crm.stage_history for all to orq_sync using (true) with check (true);

-- ############################################################################
-- ENTREGAS 1 a 7 - analytics: SO views (exemplos; as definitivas saem em cada entrega)
-- ############################################################################

create view analytics.sync_saude as
select c.entity,
       c.ultimo_sucesso_em,
       c.backfill_concluido,
       (select j.status from ops.sync_jobs j where j.entity = c.entity order by j.iniciou_em desc limit 1) as ultimo_status,
       (now() - c.ultimo_sucesso_em) > interval '8 hours' as atrasada
from ops.sync_checkpoints c;

create view analytics.pipelines_etapas as
select p.pipeline_id, p.nome as pipeline, p.ordem as pipeline_ordem, cp.produto,
       s.stage_id, s.nome as etapa, s.ordem as etapa_ordem, cs.marco
from crm.pipelines p
left join ops.cfg_pipeline_produto cp on cp.pipeline_id = p.pipeline_id
left join crm.stages s on s.pipeline_id = p.pipeline_id
left join ops.cfg_stage_marco cs on cs.stage_id = s.stage_id;
-- (produto e marco SAO derivados da configuracao na hora da consulta: mudar o mapeamento no Painel
--  vale para todo o historico, sem reprocessar nada.)
