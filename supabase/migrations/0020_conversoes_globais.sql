-- 0020: Conversoes Globais (pedido do Pablo, 2026-10-13). Somente aditiva (nenhum DROP, nenhum DELETE concedido).
--  1. mkt.conversao_catalogo: o que o Painel classifica em cada conversao, venha de onde vier (site = evento do GA4; rd = evento do RD Station; pipe =
--     "Identificador de Conversao RD" do negocio no Pipedrive, ou uma etapa): tipo de conversao (Tofu/Mofu/Bofu) e pontos de leadscoring.
--  2. crm.deal_atributos ganha pessoa_id e ident_conversao_rd (e a funcao de recalculo passa a preenche-los), para o Painel agregar as conversoes
--     do Pipedrive sem reconstruir o JSON bruto a cada consulta (a causa dos timeouts do D-56).
--  3. analytics.conversoes_pipe_negocios: uma linha por negocio e conversao vinda do Pipedrive (identificador RD na criacao do negocio e a entrada
--     na etapa de Reuniao Agendada). O Painel agrega e cruza com o catalogo.
-- As conversoes do SITE continuam nas visoes analytics.site_* e nas regras de mkt.conversao_regras (o BI usa essas regras).

create table mkt.conversao_catalogo (
  id bigint generated always as identity primary key,
  origem text not null check (origem in ('site', 'rd', 'pipe')),
  evento text not null check (btrim(evento) <> '' and length(evento) <= 300),   -- nome exato do evento / identificador
  tipo_conversao text check (tipo_conversao in ('material', 'levantada_de_mao', 'agendamento_reuniao', 'reuniao_realizada')),
  pontos integer check (pontos between -1000 and 1000),                         -- nota de leadscoring da conversao (em branco = ainda nao definida)
  observacao text,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (origem, evento)
);
alter table mkt.conversao_catalogo enable row level security;
grant select on mkt.conversao_catalogo to orq_sync;
grant select, insert, update on mkt.conversao_catalogo to orq_panel;
create policy orq_sync_read on mkt.conversao_catalogo for select to orq_sync using (true);
create policy orq_panel_all on mkt.conversao_catalogo for all to orq_panel using (true) with check (true);

-- A etapa de Reuniao Agendada e uma conversao de agendamento (Bofu) que o Pipedrive ja registra; o Painel so deixa o Pablo dar os pontos.
insert into mkt.conversao_catalogo (origem, evento, tipo_conversao, observacao)
values ('pipe', '[Etapa] Reunião agendada', 'agendamento_reuniao', 'Vem da entrada do negócio na etapa marcada como Reunião Agendada (histórico de etapas).');

alter table crm.deal_atributos add column pessoa_id bigint;
alter table crm.deal_atributos add column ident_conversao_rd text;
create index deal_atributos_ident_idx on crm.deal_atributos (ident_conversao_rd);

create or replace function crm.recalcular_deal_atributos(so_mudados boolean default true) returns integer language plpgsql as $$
declare gravados integer;
begin
  with k as (
    select max(field_key) filter (where nome = 'Fonte do Lead') as fonte, max(field_key) filter (where nome = 'Tipo do Lead') as tipo,
           max(field_key) filter (where nome = 'Faixa de Colaboradores') as fcol, max(field_key) filter (where nome = 'Faixa de profissionais da saúde') as fsau,
           max(field_key) filter (where nome = 'Canal de origem RD') as canal, max(field_key) filter (where nome = 'UTM Source') as us,
           max(field_key) filter (where nome = 'UTM Medium') as um, max(field_key) filter (where lower(nome) = 'utm campaign') as uc,
           max(field_key) filter (where nome = 'UTM Content') as uco, max(field_key) filter (where nome = 'UTM Term') as ut,
           max(field_key) filter (where nome = 'URL de Conversão') as url, max(field_key) filter (where nome = 'Meta Ad_id') as mad,
           max(field_key) filter (where nome = 'Meta Adset_id') as mas, max(field_key) filter (where nome = 'Meta Campaign_id') as mca,
           max(field_key) filter (where nome = 'Meta Lead_id') as mle, max(field_key) filter (where nome = 'Meta Form_id') as mfo,
           max(field_key) filter (where nome = 'Identificador de Conversão RD') as ident
    from crm.field_definitions where entity = 'deal'
  )
  insert into crm.deal_atributos (deal_id, fonte_id, tipo_id, faixa_colab_id, faixa_saude_id, canal_rd, utm_source, utm_medium, utm_campaign, utm_content, utm_term, url_conversao,
                                  meta_ad_id, meta_adset_id, meta_campaign_id, meta_lead_id, meta_form_id, payload_hash, pessoa_id, ident_conversao_rd)
  select r.source_id,
         nullif(r.payload #>> array['custom_fields', k.fonte], ''), nullif(r.payload #>> array['custom_fields', k.tipo], ''), nullif(r.payload #>> array['custom_fields', k.fcol], ''),
         nullif(r.payload #>> array['custom_fields', k.fsau], ''), nullif(r.payload #>> array['custom_fields', k.canal], ''), nullif(r.payload #>> array['custom_fields', k.us], ''),
         nullif(r.payload #>> array['custom_fields', k.um], ''), nullif(r.payload #>> array['custom_fields', k.uc], ''), nullif(r.payload #>> array['custom_fields', k.uco], ''),
         nullif(btrim(r.payload #>> array['custom_fields', k.ut]), ''), nullif(r.payload #>> array['custom_fields', k.url], ''), nullif(btrim(r.payload #>> array['custom_fields', k.mad]), ''),
         nullif(btrim(r.payload #>> array['custom_fields', k.mas]), ''), nullif(btrim(r.payload #>> array['custom_fields', k.mca]), ''), nullif(btrim(r.payload #>> array['custom_fields', k.mle]), ''),
         nullif(btrim(r.payload #>> array['custom_fields', k.mfo]), ''), r.payload_hash,
         case when jsonb_typeof(r.payload -> 'person_id') = 'number' then (r.payload ->> 'person_id')::bigint end,
         nullif(btrim(r.payload #>> array['custom_fields', k.ident]), '')
  from raw.pd_deals r cross join k
  where not so_mudados or not exists (select 1 from crm.deal_atributos a where a.deal_id = r.source_id and a.payload_hash = r.payload_hash and a.ident_conversao_rd is not distinct from nullif(btrim(r.payload #>> array['custom_fields', k.ident]), ''))
  on conflict (deal_id) do update set fonte_id = excluded.fonte_id, tipo_id = excluded.tipo_id, faixa_colab_id = excluded.faixa_colab_id, faixa_saude_id = excluded.faixa_saude_id,
    canal_rd = excluded.canal_rd, utm_source = excluded.utm_source, utm_medium = excluded.utm_medium, utm_campaign = excluded.utm_campaign, utm_content = excluded.utm_content,
    utm_term = excluded.utm_term, url_conversao = excluded.url_conversao, meta_ad_id = excluded.meta_ad_id, meta_adset_id = excluded.meta_adset_id, meta_campaign_id = excluded.meta_campaign_id,
    meta_lead_id = excluded.meta_lead_id, meta_form_id = excluded.meta_form_id, payload_hash = excluded.payload_hash, pessoa_id = excluded.pessoa_id,
    ident_conversao_rd = excluded.ident_conversao_rd, atualizado_em = now();
  get diagnostics gravados = row_count;
  return gravados;
end
$$;

-- Conversoes que o Pipedrive registra, uma linha por negocio e conversao:
--  (a) o "Identificador de Conversao RD" do negocio (a conversao que o criou), datada na criacao do negocio;
--  (b) a entrada do negocio na etapa de Reuniao Agendada (agendamento de reuniao), datada em chegou_em.
-- "Reuniao realizada" ainda nao tem fonte (as atividades do Pipedrive nao sao lidas).
create view analytics.conversoes_pipe_negocios as
select d.deal_id, a.ident_conversao_rd as evento, a.pessoa_id, mkt.caminho_url(a.url_conversao) as caminho_url, d.criado_em as data, d.produto
from crm.deal_atributos a
join analytics.deals d on d.deal_id = a.deal_id
where a.ident_conversao_rd is not null and not d.is_deleted
union all
select d.deal_id, '[Etapa] Reunião agendada', a.pessoa_id, null, m.chegou_em, d.produto
from analytics.negocios_marcos m
join analytics.deals d on d.deal_id = m.deal_id
left join crm.deal_atributos a on a.deal_id = d.deal_id
where m.marco = 'reuniao' and not d.is_deleted;

grant select on analytics.conversoes_pipe_negocios to orq_panel;
