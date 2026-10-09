-- 0014: BI "Site e páginas" (GA4 + funil dos leads por URL de conversão).
--  1) mkt.host_url: extrai o domínio de uma URL (null quando o texto não é uma URL: o campo "URL de Conversão" do Pipedrive às vezes
--     traz texto livre, como "quarkrh: software de gestão..." ou "ifempty(;https:..."). Domínio + caminho identificam a página: sem o
--     domínio, "/" misturaria quarkrh.com.br, quarkclinic.com.br, lp.quark.tec.br e outros.
--  2) analytics.negocios_url ganha DUAS colunas no fim (host_url e url_valida); as colunas que já existiam não mudam.
--  3) mkt.ga4_dia: totais por dia do GA4 (sessões, usuários ativos, novos usuários...). Usuários ativos NÃO se somam entre páginas nem
--     entre dias, então o total do dia vem de uma consulta própria ao GA4 (poucas linhas: uma por dia).
-- Somente aditiva (CREATE e CREATE OR REPLACE VIEW só acrescentando colunas no fim). Sem dados novos de pessoas.

create function mkt.host_url(u text) returns text language sql immutable as $$
  select lower(substring(btrim(coalesce(u, '')) from '^(?:https?://)?(?:www[.])?([a-zA-Z0-9-]+(?:[.][a-zA-Z0-9-]+)*[.][a-zA-Z]{2,})(?:[/?#:]|$)'))
$$;

create or replace view analytics.negocios_url as
with k as (
  select max(field_key) filter (where nome = 'URL de Conversão') as url,
         max(field_key) filter (where lower(nome) = 'utm campaign') as campanha,
         max(field_key) filter (where lower(nome) = 'utm medium') as midia
  from crm.field_definitions where entity = 'deal'
)
select d.deal_id, d.produto, d.status, d.criado_em, d.conta_como_lead, d.is_mql, d.valor,
       mkt.caminho_url(u.url) as caminho_url,
       u.url is not null as tem_url,
       u.campanha as utm_campaign,
       u.midia as utm_medium,
       mkt.host_url(u.url) as host_url,
       mkt.host_url(u.url) is not null as url_valida
from analytics.deals d
join raw.pd_deals r on r.source_id = d.deal_id
cross join k
cross join lateral (
  select nullif(r.payload #>> array['custom_fields', k.url], '') as url,
         nullif(r.payload #>> array['custom_fields', k.campanha], '') as campanha,
         nullif(r.payload #>> array['custom_fields', k.midia], '') as midia
) u;

create table mkt.ga4_dia (
  property_id bigint not null,
  dia date not null,
  sessoes int not null,
  usuarios_ativos int not null,
  usuarios_novos int not null,
  sessoes_engajadas int not null,
  visualizacoes int not null,
  atualizado_em timestamptz not null default now(),
  primary key (property_id, dia)
);
alter table mkt.ga4_dia enable row level security;
grant select, insert, update on mkt.ga4_dia to orq_sync;
create policy orq_sync_all on mkt.ga4_dia for all to orq_sync using (true) with check (true);

create view analytics.site_dia as
select property_id, dia, sessoes, usuarios_ativos, usuarios_novos, sessoes_engajadas, visualizacoes from mkt.ga4_dia;

grant select on analytics.site_dia to orq_panel, orq_chat;
