-- 0015: painel do Google Ads no BI. Guarda o CUSTO do Google Ads que o GA4 importa (a conta de anúncios já está vinculada à
-- propriedade 382708044), por campanha e por dia, enquanto a leitura direta da API do Google Ads (developer token) não existe.
-- Quando a API do Ads entrar (mkt.gads_campanha_dia), a visão analytics.ads_investimento_dia passa a preferi-la nos dias em que ela
-- tiver dados; o GA4 continua preenchendo os demais dias. Dados agregados, sem dado pessoal; poucas linhas (~2,6 mil desde 2025-01-01).
-- Somente aditiva (CREATE). Nada em public, core, orq, crm, raw nem ops.

create table mkt.ga4_ads_dia (
  property_id bigint not null,
  dia date not null,
  campanha_id text not null default '',          -- sessionGoogleAdsCampaignId ('' quando o GA4 não informa)
  campanha text not null default '',             -- sessionGoogleAdsCampaignName
  custo numeric(14, 2) not null,                 -- advertiserAdCost, na moeda da propriedade (BRL)
  cliques int not null,                          -- advertiserAdClicks
  impressoes int not null,                       -- advertiserAdImpressions
  atualizado_em timestamptz not null default now(),
  primary key (property_id, dia, campanha_id, campanha)
);
create index ga4_ads_dia_idx on mkt.ga4_ads_dia (dia);
alter table mkt.ga4_ads_dia enable row level security;
grant select, insert, update on mkt.ga4_ads_dia to orq_sync;
create policy orq_sync_all on mkt.ga4_ads_dia for all to orq_sync using (true) with check (true);

-- Investimento por campanha e dia, com a origem do número. A API do Google Ads (quando houver) vence o GA4 no mesmo dia.
create view analytics.ads_investimento_dia as
select d.dia, d.campaign_id::text as campanha_id, coalesce(c.nome, '') as campanha, d.custo_micros / 1000000.0 as custo,
       d.cliques::bigint as cliques, d.impressoes::bigint as impressoes, 'google_ads_api'::text as origem
from mkt.gads_campanha_dia d
left join mkt.gads_campanhas c on c.customer_id = d.customer_id and c.campaign_id = d.campaign_id
union all
select g.dia, g.campanha_id, g.campanha, g.custo, g.cliques::bigint, g.impressoes::bigint, 'ga4'::text
from mkt.ga4_ads_dia g
where not exists (select 1 from mkt.gads_campanha_dia x where x.dia = g.dia);

grant select on analytics.ads_investimento_dia to orq_panel, orq_chat;
