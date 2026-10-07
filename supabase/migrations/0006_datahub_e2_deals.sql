-- 0006: Data Hub, ENTREGA 2 (negocios/deals). Derivada de docs/datahub/proposta-schema.sql (bloco ENTREGA 2),
-- ajustada pelas regras do funil (0005, D-36) e pelo que a API devolveu na sondagem de 2026-10-07 (D-37).
-- Somente aditiva (so ADD COLUMN em crm.deals; crm.deals tem 0 linhas). Nada em public, core nem orq.
-- Nao concede nada em core.leads: o vinculo deal -> lead precisa do e-mail/telefone da pessoa e entra na Entrega 3.

create table raw.pd_deals (
  source_id bigint primary key,
  payload jsonb not null,                          -- JSON original do Pipedrive, nada descartado
  payload_hash text not null,                      -- se o hash nao mudou, nao regrava
  source_add_time timestamptz,
  source_update_time timestamptz,
  origem_lista text not null default 'normal' check (origem_lista in ('normal','archived','deleted')),
  first_seen_at timestamptz not null default now(),
  synced_at timestamptz not null default now()
);

-- crm.deals ja tem: pipedrive_id, lead_id, pipeline (nome), estagio (nome), status, valor, motivo_perda (texto),
-- owner (nome), created_at (= add_time), won_at, updated_at (= update_time). Acrescenta IDs e o resto.
alter table crm.deals
  add column pipeline_id bigint,
  add column stage_id bigint,
  add column owner_id bigint,
  add column titulo text,
  add column moeda text,
  add column person_id bigint,
  add column org_id bigint,
  add column status_original text,                 -- o que o Pipedrive disse (open, won, lost ou deleted)
  add column motivo_perda_id bigint,               -- ID da opcao de "Motivo da perda" (a API devolve so o texto)
  add column stage_change_time timestamptz,
  add column close_time timestamptz,
  add column lost_time timestamptz,
  add column expected_close_date date,
  add column origin text,
  add column origin_id text,
  add column channel text,
  add column channel_id text,
  add column is_archived boolean not null default false,
  add column is_deleted boolean not null default false,   -- marcado, nunca apagado
  add column deleted_detected_at timestamptz,
  add column custom_fields jsonb,                  -- campos personalizados com o ID original (hash de 40 caracteres)
  add column synced_at timestamptz;
-- A restricao de status (open|won|lost) continua. Negocio excluido guarda status null e is_deleted = true;
-- o que o Pipedrive disse fica em status_original. Para analise, "deleted" e um quarto status (view abaixo).

create index deals_pipeline_stage_idx on crm.deals (pipeline_id, stage_id);
create index deals_person_idx on crm.deals (person_id);
create index deals_org_idx on crm.deals (org_id);
create index deals_update_idx on crm.deals (updated_at);
create index deals_created_idx on crm.deals (created_at);

alter table raw.pd_deals enable row level security;
grant select, insert, update on raw.pd_deals to orq_sync;
grant select, insert, update on crm.deals to orq_sync;
create policy orq_sync_all on raw.pd_deals for all to orq_sync using (true) with check (true);
create policy orq_sync_all on crm.deals for all to orq_sync using (true) with check (true);

-- ---------- views do Painel (so analytics; o Painel nao enxerga crm nem raw) ----------
-- Uma linha por negocio, com ID e nome juntos, produto/marco/contagem calculados na hora a partir da configuracao.
create view analytics.deals as
select d.pipedrive_id as deal_id,
       d.titulo,
       d.pipeline_id, p.nome as pipeline, cp.produto,
       d.stage_id, s.nome as etapa, cs.marco,
       case when d.is_deleted then 'deleted' else d.status end as status,
       d.valor, d.moeda,
       d.owner_id, u.nome as responsavel,
       d.motivo_perda_id, d.motivo_perda,
       d.created_at as criado_em, d.close_time as fechado_em, d.lost_time as perdido_em, d.updated_at as atualizado_em,
       d.is_archived, d.is_deleted,
       coalesce(sc.conta_como_lead, true) as conta_como_lead,
       -- MQL (D-36): conta como lead e NAO foi perdido por um motivo marcado em "tira do MQL"
       (coalesce(sc.conta_como_lead, true)
         and not (not d.is_deleted and d.status = 'lost' and coalesce(mp.exclui_mql, false))) as is_mql
from crm.deals d
left join crm.pipelines p on p.pipeline_id = d.pipeline_id
left join crm.stages s on s.stage_id = d.stage_id
left join crm.users u on u.user_id = d.owner_id
left join ops.cfg_pipeline_produto cp on cp.pipeline_id = d.pipeline_id
left join ops.cfg_stage_marco cs on cs.stage_id = d.stage_id
left join ops.cfg_motivo_perda mp on mp.reason_id = d.motivo_perda_id
left join ops.cfg_status_contagem sc on sc.status = (case when d.is_deleted then 'deleted' else d.status end);

-- Conferencia com o Pipedrive: quantidade por pipeline, status e mes de criacao.
create view analytics.deals_resumo as
select pipeline_id, pipeline, produto, status, is_archived,
       date_trunc('month', criado_em)::date as mes_criacao,
       count(*)::int as qtd, count(*) filter (where is_mql)::int as qtd_mql,
       coalesce(sum(valor), 0) as valor_total
from analytics.deals
group by pipeline_id, pipeline, produto, status, is_archived, date_trunc('month', criado_em)::date;

-- Ficha do negocio: campos personalizados com ID original, nome do Pipedrive e o seu rotulo.
create view analytics.deal_campos as
select d.pipedrive_id as deal_id, c.key as field_key, f.nome_pipedrive, f.rotulo, c.value as valor
from crm.deals d
cross join lateral jsonb_each(case when jsonb_typeof(d.custom_fields) = 'object' then d.custom_fields else '{}'::jsonb end) c
left join analytics.campos f on f.entity = 'deal' and f.field_key = c.key;

grant select on analytics.deals, analytics.deals_resumo, analytics.deal_campos to orq_panel;
