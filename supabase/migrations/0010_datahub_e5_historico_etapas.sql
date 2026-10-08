-- 0010: Data Hub, ENTREGA 5 (historico de etapas dos negocios). Derivada de docs/datahub/proposta-schema.sql (bloco ENTREGA 5),
-- enxugada pela economia de espaco (D-40) e pelos achados da sondagem de 2026-10-08 (D-41):
--   * a fonte e GET /v1/deals/{id}/flow?items=dealChange (40 unidades por negocio); so entram as mudancas de ETAPA (stage_id);
--   * negocio SEM mudanca de etapa (stage_change_time vazio) nao e consultado: tem uma unica linha, "entrou na etapa X na criacao";
--   * a etapa inicial de um negocio que mudou e o old_value da primeira mudanca.
-- Somente aditiva (ADD COLUMN em crm.stage_history, que tem 0 linhas; tabela nova em raw; views novas). Nada em public, core nem orq.

-- Mudancas de etapa como o Pipedrive devolveu, so os campos essenciais (uma linha por negocio, compacta).
create table raw.pd_deal_flow (
  deal_id bigint primary key,
  items jsonb not null,                            -- [{id, field_key, old_value, new_value, log_time, user_id, change_source, is_bulk_update_flag}]
  items_hash text not null,
  stage_change_time_vista timestamptz,             -- stage_change_time do negocio quando o historico foi lido (decide se precisa reler)
  lido_em timestamptz not null default now()
);

-- crm.stage_history ja tem: deal_id, estagio (nome), entrou_em; PK (deal_id, estagio, entrou_em)
alter table crm.stage_history
  add column stage_id bigint,
  add column saiu_em timestamptz,                  -- null = ainda esta nesta etapa
  add column user_id bigint,                       -- quem moveu o negocio para esta etapa
  add column origem_dado text check (origem_dado in ('flow', 'criacao')),
  add column entrada_estimada boolean not null default false;
-- idempotencia: reler o historico do mesmo negocio atualiza as mesmas linhas
create unique index stage_history_deal_stage_entry_uidx on crm.stage_history (deal_id, stage_id, entrou_em);
create index stage_history_stage_idx on crm.stage_history (stage_id, entrou_em);

alter table raw.pd_deal_flow enable row level security;
alter table crm.stage_history enable row level security;
grant select, insert, update on raw.pd_deal_flow, crm.stage_history to orq_sync;
create policy orq_sync_all on raw.pd_deal_flow for all to orq_sync using (true) with check (true);
create policy orq_sync_all on crm.stage_history for all to orq_sync using (true) with check (true);

-- ---------- views do Painel ----------
-- Linha do tempo: por onde cada negocio passou, com ID e nome, produto e marco calculados na hora.
create view analytics.historico_etapas as
select h.deal_id, h.stage_id, s.nome as etapa, s.pipeline_id, p.nome as pipeline, cp.produto, cs.marco,
       h.entrou_em, h.saiu_em, (h.saiu_em is null) as etapa_atual,
       -- etapa atual de negocio ABERTO conta ate agora; de ganho/perdido conta ate o fechamento (nao fica crescendo para sempre)
       round((extract(epoch from (coalesce(h.saiu_em, case when d.status = 'open' then now() else coalesce(d.close_time, d.lost_time, d.won_at) end) - h.entrou_em)) / 3600.0)::numeric, 1) as horas_na_etapa,
       h.user_id, u.nome as movido_por, h.origem_dado,
       d.status, d.is_deleted, d.created_at as criado_em
from crm.stage_history h
join crm.deals d on d.pipedrive_id = h.deal_id
left join crm.stages s on s.stage_id = h.stage_id
left join crm.pipelines p on p.pipeline_id = s.pipeline_id
left join crm.users u on u.user_id = h.user_id
left join ops.cfg_pipeline_produto cp on cp.pipeline_id = s.pipeline_id
left join ops.cfg_stage_marco cs on cs.stage_id = h.stage_id;

-- Primeira vez que cada negocio chegou em cada marco ("chegou ate aqui": sql, reuniao, proposta)
create view analytics.negocios_marcos as
select h.deal_id, cs.marco, min(h.entrou_em) as chegou_em
from crm.stage_history h
join ops.cfg_stage_marco cs on cs.stage_id = h.stage_id and cs.marco is not null
group by h.deal_id, cs.marco;

-- Andamento da carga do historico por ano de criacao
create view analytics.historico_progresso as
select extract(year from d.created_at)::int as ano_criacao,
       count(*)::int as negocios,
       count(*) filter (where d.stage_change_time is null)::int as sem_mudanca_de_etapa,
       count(*) filter (where d.stage_change_time is not null and f.deal_id is not null and f.stage_change_time_vista is not distinct from d.stage_change_time)::int as historico_lido,
       count(*) filter (where d.stage_change_time is not null and (f.deal_id is null or f.stage_change_time_vista is distinct from d.stage_change_time))::int as pendentes,
       count(*) filter (where exists (select 1 from crm.stage_history h where h.deal_id = d.pipedrive_id))::int as com_linha_do_tempo
from crm.deals d
left join raw.pd_deal_flow f on f.deal_id = d.pipedrive_id
where not d.is_deleted and d.created_at is not null
group by 1;

grant select on analytics.historico_etapas, analytics.negocios_marcos, analytics.historico_progresso to orq_panel;
