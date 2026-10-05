-- 0004: Data Hub do Pipedrive, ENTREGA 1 (pipelines, etapas, usuarios, definicao de campos, configuracao e controle).
-- Gerada a partir da proposta aprovada em docs/datahub/proposta-schema.sql (bloco "ENTREGA 1" + views iniciais).
-- Somente aditiva. Nada no schema public. Nada em core nem orq. As SENHAS dos papeis NAO estao aqui:
-- sao definidas por scripts/set-role-password.mjs (sem senha, o papel nao consegue entrar).
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

-- Usuarios do Pipedrive SEM e-mail (dado pessoal fica fora do Painel) e definicao de campos com o seu rotulo.
create view analytics.usuarios as
select user_id, nome, ativo from crm.users;

create view analytics.campos as
select f.entity, f.field_key, f.nome as nome_pipedrive, c.rotulo, f.tipo, f.ordem
from crm.field_definitions f
left join ops.cfg_field_rotulo c on c.entity = f.entity and c.field_key = f.field_key;

-- As views de analytics sao a unica coisa que o Painel le (alem de ops).
grant select on analytics.sync_saude, analytics.pipelines_etapas, analytics.usuarios, analytics.campos to orq_panel;
