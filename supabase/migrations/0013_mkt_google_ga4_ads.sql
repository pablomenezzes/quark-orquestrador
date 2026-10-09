-- 0013: bloco Google (GA4 + Google Ads), D-45. Schema novo `mkt` com os dados agregados por dia e a configuracao das regras de
-- conversao feita no Painel (evento + URL). Os dados do Google sao AGREGADOS (sem pessoa, sem e-mail, sem telefone), entao as visoes
-- novas podem ir tambem para o conector do Claude. Nada se repete: o GA4 e o Ads ja devolvem numeros somados (nao ha JSON original a guardar).
-- Somente aditiva (so CREATE/GRANT). Nada em public, core, orq, crm, raw nem ops. A carga e feita pelo papel orq_sync;
-- o Painel (orq_panel) so LE as visoes e GRAVA somente a tabela de regras (sem DELETE: a regra e desativada, nao apagada).

create schema if not exists mkt;
comment on schema mkt is 'Dados de marketing agregados por dia (GA4 e Google Ads) e regras de conversao do site';

-- ---------- GA4 (propriedade pode cobrir varios sites: property_id + host) ----------
create table mkt.ga4_sessoes_dia (            -- sessoes e usuarios novos por pagina de ENTRADA, fonte, midia e campanha
  property_id bigint not null,
  dia date not null,
  host text not null,
  landing_page text not null,                 -- caminho da pagina de entrada; "(sem pagina)" quando o GA4 nao informa
  fonte text not null,
  midia text not null,
  campanha text not null default '',
  campanha_id text,
  gads_campanha_id text,                      -- sessionGoogleAdsCampaignId (liga ao Google Ads)
  sessoes int not null,
  usuarios_novos int not null,
  sessoes_engajadas int not null,
  visualizacoes int not null,
  atualizado_em timestamptz not null default now(),
  primary key (property_id, dia, host, landing_page, fonte, midia, campanha)
);
create table mkt.ga4_eventos_dia (            -- em que pagina cada evento aconteceu (alimenta "em que URL o evento aparece")
  property_id bigint not null,
  dia date not null,
  host text not null,
  pagina text not null,
  evento text not null,
  eventos int not null,
  usuarios int not null,                      -- nao some entre dias (um usuario ativo em 3 dias conta 3 vezes)
  atualizado_em timestamptz not null default now(),
  primary key (property_id, dia, host, pagina, evento)
);
create table mkt.ga4_paginas_dia (            -- paginas vistas (nao so a de entrada)
  property_id bigint not null,
  dia date not null,
  host text not null,
  pagina text not null,
  visualizacoes int not null,
  usuarios_ativos int not null,
  atualizado_em timestamptz not null default now(),
  primary key (property_id, dia, host, pagina)
);

-- ---------- Google Ads (custo em micros, como a API devolve; a view converte para a moeda da conta) ----------
create table mkt.gads_campanhas (
  customer_id bigint not null,
  campaign_id bigint not null,
  nome text,
  status text,
  atualizado_em timestamptz not null default now(),
  primary key (customer_id, campaign_id)
);
create table mkt.gads_campanha_dia (
  customer_id bigint not null,
  campaign_id bigint not null,
  dia date not null,
  impressoes bigint not null,
  cliques bigint not null,
  custo_micros bigint not null,
  conversoes numeric not null,
  atualizado_em timestamptz not null default now(),
  primary key (customer_id, campaign_id, dia)
);

-- ---------- Configuracao feita no Painel: o que conta como conversao do site ----------
create table mkt.conversao_regras (
  id bigint generated always as identity primary key,
  nome text not null,
  tipo text not null check (tipo in ('lead', 'intermediaria', 'ignorar')),
  evento text not null,                       -- nome exato do evento no GA4
  url_modo text not null default 'qualquer' check (url_modo in ('qualquer', 'igual', 'comeca', 'contem')),
  url_valor text,                             -- caminho ou URL; o dominio e a barra final sao ignorados na comparacao
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  check (url_modo = 'qualquer' or coalesce(trim(url_valor), '') <> '')
);

-- Normaliza URL dos dois lados (GA4 e Pipedrive): minusculas, sem dominio, sem query string, sem fragmento, sem barra final; raiz = "/"
create function mkt.caminho_url(u text) returns text language sql immutable as $$
  select case when p = '' then '/' else p end
  from (select regexp_replace(
                 regexp_replace(
                   regexp_replace(lower(btrim(coalesce(u, ''))), '^(https?://)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(?=/|$|\?|#)', ''),
                   '[?#].*$', ''),
                 '/+$', '') as p) t
$$;

create index ga4_eventos_evento_idx on mkt.ga4_eventos_dia (evento, dia);
create index ga4_sessoes_dia_idx on mkt.ga4_sessoes_dia (dia);
create index gads_dia_idx on mkt.gads_campanha_dia (dia);

alter table mkt.ga4_sessoes_dia enable row level security;
alter table mkt.ga4_eventos_dia enable row level security;
alter table mkt.ga4_paginas_dia enable row level security;
alter table mkt.gads_campanhas enable row level security;
alter table mkt.gads_campanha_dia enable row level security;
alter table mkt.conversao_regras enable row level security;

grant usage on schema mkt to orq_sync, orq_panel;
grant select, insert, update on mkt.ga4_sessoes_dia, mkt.ga4_eventos_dia, mkt.ga4_paginas_dia, mkt.gads_campanhas, mkt.gads_campanha_dia to orq_sync;
grant select on mkt.conversao_regras to orq_sync;
create policy orq_sync_all on mkt.ga4_sessoes_dia for all to orq_sync using (true) with check (true);
create policy orq_sync_all on mkt.ga4_eventos_dia for all to orq_sync using (true) with check (true);
create policy orq_sync_all on mkt.ga4_paginas_dia for all to orq_sync using (true) with check (true);
create policy orq_sync_all on mkt.gads_campanhas for all to orq_sync using (true) with check (true);
create policy orq_sync_all on mkt.gads_campanha_dia for all to orq_sync using (true) with check (true);
create policy orq_sync_read on mkt.conversao_regras for select to orq_sync using (true);
-- o Painel grava SO as regras (e nao apaga: desativa)
grant select, insert, update on mkt.conversao_regras to orq_panel;
create policy orq_panel_all on mkt.conversao_regras for all to orq_panel using (true) with check (true);

-- ---------- Visoes (analytics) ----------
create view analytics.site_sessoes_dia as
select property_id, dia, host, landing_page, mkt.caminho_url(landing_page) as caminho, fonte, midia, campanha, campanha_id,
       gads_campanha_id, sessoes, usuarios_novos, sessoes_engajadas, visualizacoes
from mkt.ga4_sessoes_dia;

create view analytics.site_eventos_dia as
select property_id, dia, host, pagina, mkt.caminho_url(pagina) as caminho, evento, eventos, usuarios
from mkt.ga4_eventos_dia;

create view analytics.site_paginas_dia as
select property_id, dia, host, pagina, mkt.caminho_url(pagina) as caminho, visualizacoes, usuarios_ativos
from mkt.ga4_paginas_dia;

create view analytics.ads_campanha_dia as
select d.customer_id, d.campaign_id, c.nome as campanha, c.status, d.dia, d.impressoes, d.cliques,
       d.custo_micros / 1000000.0 as custo, d.conversoes
from mkt.gads_campanha_dia d
left join mkt.gads_campanhas c on c.customer_id = d.customer_id and c.campaign_id = d.campaign_id;

-- Conversoes do site segundo as regras ATIVAS (evento + URL); uma linha por regra, evento, pagina e dia.
-- Se duas regras cobrirem o mesmo evento e pagina, as duas aparecem (o BI filtra por regra/tipo para nao somar em dobro).
create view analytics.site_conversoes_dia as
select r.id as regra_id, r.nome as regra, r.tipo, e.property_id, e.dia, e.host, e.pagina, e.caminho, e.evento, e.eventos, e.usuarios
from analytics.site_eventos_dia e
join mkt.conversao_regras r
  on r.ativo and r.tipo <> 'ignorar' and r.evento = e.evento
 and case r.url_modo
       when 'qualquer' then true
       when 'igual'    then e.caminho = mkt.caminho_url(r.url_valor)
       when 'comeca'   then e.caminho like mkt.caminho_url(r.url_valor) || '%'
       when 'contem'   then e.caminho like '%' || lower(btrim(r.url_valor)) || '%'
     end;

-- Regras (o Painel le por aqui tambem, junto com a contagem do que casa)
create view analytics.conversao_regras as
select id, nome, tipo, evento, url_modo, url_valor, ativo, criado_em, atualizado_em from mkt.conversao_regras;

-- Lado CRM da relacao por URL: o caminho da "URL de Conversao" e a campanha/midia de cada negocio, lidos do JSON original (sem duplicar).
-- A URL completa (que pode ter dados na query string) NAO sai: so o caminho normalizado.
create view analytics.negocios_url as
with k as (
  select max(field_key) filter (where nome = 'URL de Conversão') as url,
         max(field_key) filter (where lower(nome) = 'utm campaign') as campanha,
         max(field_key) filter (where lower(nome) = 'utm medium') as midia
  from crm.field_definitions where entity = 'deal'
)
select d.deal_id, d.produto, d.status, d.criado_em, d.conta_como_lead, d.is_mql, d.valor,
       mkt.caminho_url(nullif(r.payload #>> array['custom_fields', k.url], '')) as caminho_url,
       nullif(r.payload #>> array['custom_fields', k.url], '') is not null as tem_url,
       nullif(r.payload #>> array['custom_fields', k.campanha], '') as utm_campaign,
       nullif(r.payload #>> array['custom_fields', k.midia], '') as utm_medium
from analytics.deals d
join raw.pd_deals r on r.source_id = d.deal_id
cross join k;

grant select on analytics.site_sessoes_dia, analytics.site_eventos_dia, analytics.site_paginas_dia, analytics.ads_campanha_dia,
                analytics.site_conversoes_dia, analytics.conversao_regras, analytics.negocios_url to orq_panel;
-- conector do Claude: so os numeros agregados (sem nenhuma coluna pessoal)
grant select on analytics.site_sessoes_dia, analytics.site_eventos_dia, analytics.site_paginas_dia, analytics.ads_campanha_dia,
                analytics.site_conversoes_dia, analytics.conversao_regras, analytics.negocios_url to orq_chat;
