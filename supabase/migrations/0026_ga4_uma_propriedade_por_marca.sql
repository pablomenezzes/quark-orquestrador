-- 0026: GA4 e Google Ads separados por marca. Cada marca (QuarkRH, QuarkClinic) tem a sua propriedade do GA4, e o custo do Google Ads
-- chega pela conta de anuncios vinculada a ELA (ponte do GA4, migration 0015). Esta tabela diz qual propriedade e de qual marca,
-- e qual conta do Google Ads esta vinculada, para o BI separar ou somar. A propriedade do QuarkClinic entra numa migration propria
-- quando o ID for conhecido. Somente aditiva (CREATE e CREATE OR REPLACE com a coluna nova no FIM). Nada em public, core, orq, crm, raw nem ops.

create table mkt.ga4_propriedades (
  property_id bigint primary key,
  marca text not null check (marca in ('rh', 'clinic')),
  nome text not null,
  google_ads_customer_id text,                  -- conta do Google Ads vinculada a propriedade (10 digitos, sem tracos); so documentacao ate a API entrar
  criado_em timestamptz not null default now()
);
alter table mkt.ga4_propriedades enable row level security;
grant select on mkt.ga4_propriedades to orq_sync;
create policy orq_sync_read on mkt.ga4_propriedades for select to orq_sync using (true);

insert into mkt.ga4_propriedades (property_id, marca, nome) values (382708044, 'rh', 'QuarkRH');

create view analytics.ga4_propriedades as
select property_id, marca, nome, google_ads_customer_id from mkt.ga4_propriedades;
grant select on analytics.ga4_propriedades to orq_panel, orq_chat;

-- Investimento por campanha e dia agora diz de qual marca e (coluna nova no fim: as visoes e consultas que dependem dela nao mudam).
-- Linhas da API do Google Ads (quando entrar) ficam sem marca ate existir o vinculo conta -> marca.
create or replace view analytics.ads_investimento_dia as
select d.dia, d.campaign_id::text as campanha_id, coalesce(c.nome, '') as campanha, d.custo_micros / 1000000.0 as custo,
       d.cliques::bigint as cliques, d.impressoes::bigint as impressoes, 'google_ads_api'::text as origem, null::text as marca
from mkt.gads_campanha_dia d
left join mkt.gads_campanhas c on c.customer_id = d.customer_id and c.campaign_id = d.campaign_id
union all
select g.dia, g.campanha_id, g.campanha, g.custo, g.cliques::bigint, g.impressoes::bigint, 'ga4'::text, p.marca
from mkt.ga4_ads_dia g
left join mkt.ga4_propriedades p on p.property_id = g.property_id
where not exists (select 1 from mkt.gads_campanha_dia x where x.dia = g.dia);
