-- 0017: Meta Ads em profundidade (M1 a M3, D-52): contas, estrutura (campanhas, conjuntos, anúncios) e desempenho por anúncio e por dia,
-- lidos da Marketing API (somente leitura). Dados de MÍDIA agregados por dia, sem dado pessoal.
-- IDs da Meta são números de ~18 dígitos: guardados como bigint (nunca como número de ponto flutuante); a ligação com o Pipedrive
-- (campos "Meta Campaign_id / Adset_id / Ad_id", que lá são texto) é feita em uma migration seguinte (M4), por cast para bigint.
-- Espaço: ~45 mil linhas de anúncio por dia desde 2025-01-01 (medido em 2026-10-13), estimado em ~10 MB.
-- Somente aditiva (CREATE). Nada em public, core, orq, crm, raw nem ops. O papel orq_sync grava; Painel e conector do Claude só leem visões.

-- Função: chave de nome para ligar por NOME (minúsculas e sem NENHUM espaço, pois "[Growth][83]" e "[Growth] [83]" são o mesmo nome)
create function mkt.chave_nome_meta(t text) returns text language sql immutable as $$
  select nullif(lower(regexp_replace(coalesce(t, ''), '\s+', '', 'g')), '')
$$;

create table mkt.meta_contas (
  conta_id bigint primary key,                    -- sem o prefixo "act_"
  produto text not null check (produto in ('rh', 'clinic')),
  nome text,
  moeda text,
  fuso text,
  atualizado_em timestamptz not null default now()
);

create table mkt.meta_campanhas (
  campanha_id bigint primary key,
  conta_id bigint not null,
  nome text,
  nome_chave text,
  objetivo text,
  status text,                                    -- effective_status
  orcamento_diario numeric(14, 2),                -- em reais (a Meta devolve em centavos)
  orcamento_total numeric(14, 2),
  criada_em timestamptz,
  atualizada_em timestamptz,
  sincronizado_em timestamptz not null default now()
);
create index meta_campanhas_chave_idx on mkt.meta_campanhas (nome_chave);

create table mkt.meta_conjuntos (
  conjunto_id bigint primary key,
  campanha_id bigint,
  conta_id bigint not null,
  nome text,
  nome_chave text,
  status text,
  otimizacao text,                                -- optimization_goal
  orcamento_diario numeric(14, 2),
  orcamento_total numeric(14, 2),
  criado_em timestamptz,
  atualizado_em timestamptz,
  sincronizado_em timestamptz not null default now()
);
create index meta_conjuntos_chave_idx on mkt.meta_conjuntos (nome_chave);

create table mkt.meta_anuncios (
  anuncio_id bigint primary key,
  conjunto_id bigint,
  campanha_id bigint,
  conta_id bigint not null,
  nome text,
  nome_chave text,
  status text,
  criativo_id bigint,                             -- ID do criativo (a imagem/vídeo e o texto), que pode ser compartilhado entre anúncios
  criativo_nome text,
  url_tags text,                                  -- as UTMs que o anúncio manda (ex.: utm_medium={{adset.name}}&utm_content={{ad.name}})
  criado_em timestamptz,
  atualizado_em timestamptz,
  sincronizado_em timestamptz not null default now()
);
create index meta_anuncios_chave_idx on mkt.meta_anuncios (nome_chave);
create index meta_anuncios_conjunto_idx on mkt.meta_anuncios (conjunto_id);
create index meta_anuncios_campanha_idx on mkt.meta_anuncios (campanha_id);

-- Desempenho por anúncio e dia (só dias com impressões ou gasto). As taxas (CPM, CPC, CTR, Connect, Hook, Hold, retenção) NÃO são
-- guardadas: calculam-se a partir destas somas, porque taxa não se soma (média de taxas dá número errado).
create table mkt.meta_ads_dia (
  anuncio_id bigint not null,
  dia date not null,
  conta_id bigint not null,
  conjunto_id bigint,
  campanha_id bigint,
  gasto numeric(14, 2) not null,
  impressoes int not null,
  alcance int not null,                           -- alcance do dia (não se soma entre dias: pessoas únicas)
  cliques int not null,                           -- todos os cliques
  cliques_link int not null,                      -- inline_link_clicks
  visitas_pagina int not null,                    -- landing_page_view (exige o Pixel)
  leads_meta int not null,                        -- action_type "lead"
  video_reproducoes int not null,                 -- video_play_actions
  video_3s int not null,                          -- action_type "video_view" (3 segundos)
  video_p25 int not null,
  video_p50 int not null,
  video_p75 int not null,
  video_p95 int not null,
  video_p100 int not null,
  video_thruplay int not null,
  video_tempo_medio numeric(8, 2),                -- segundos assistidos por reprodução (a média de um dia: pondere por reproduções)
  atualizado_em timestamptz not null default now(),
  primary key (anuncio_id, dia)
);
create index meta_ads_dia_dia_idx on mkt.meta_ads_dia (dia);
create index meta_ads_dia_campanha_idx on mkt.meta_ads_dia (campanha_id, dia);

alter table mkt.meta_contas enable row level security;
alter table mkt.meta_campanhas enable row level security;
alter table mkt.meta_conjuntos enable row level security;
alter table mkt.meta_anuncios enable row level security;
alter table mkt.meta_ads_dia enable row level security;
grant select, insert, update on mkt.meta_contas, mkt.meta_campanhas, mkt.meta_conjuntos, mkt.meta_anuncios, mkt.meta_ads_dia to orq_sync;
create policy orq_sync_all on mkt.meta_contas for all to orq_sync using (true) with check (true);
create policy orq_sync_all on mkt.meta_campanhas for all to orq_sync using (true) with check (true);
create policy orq_sync_all on mkt.meta_conjuntos for all to orq_sync using (true) with check (true);
create policy orq_sync_all on mkt.meta_anuncios for all to orq_sync using (true) with check (true);
create policy orq_sync_all on mkt.meta_ads_dia for all to orq_sync using (true) with check (true);

-- Desempenho por anúncio e dia, com a conta, a campanha, o conjunto e o anúncio (nome e ID juntos). Valores brutos: some e só depois divida.
create view analytics.meta_desempenho_dia as
select d.dia, c.produto, d.conta_id,
       d.campanha_id, ca.nome as campanha, d.conjunto_id, cj.nome as conjunto, d.anuncio_id, a.nome as anuncio, a.criativo_id, a.url_tags,
       d.gasto::float8 as gasto, d.impressoes, d.alcance, d.cliques, d.cliques_link, d.visitas_pagina, d.leads_meta,
       d.video_reproducoes, d.video_3s, d.video_p25, d.video_p50, d.video_p75, d.video_p95, d.video_p100, d.video_thruplay,
       d.video_tempo_medio::float8 as video_tempo_medio
from mkt.meta_ads_dia d
left join mkt.meta_contas c on c.conta_id = d.conta_id
left join mkt.meta_anuncios a on a.anuncio_id = d.anuncio_id
left join mkt.meta_conjuntos cj on cj.conjunto_id = coalesce(d.conjunto_id, a.conjunto_id)
left join mkt.meta_campanhas ca on ca.campanha_id = coalesce(d.campanha_id, a.campanha_id);

-- A estrutura (um anúncio por linha), com os nomes de cima
create view analytics.meta_anuncios as
select a.anuncio_id, a.nome as anuncio, a.nome_chave as anuncio_chave, a.status, a.criativo_id, a.criativo_nome, a.url_tags,
       a.conjunto_id, cj.nome as conjunto, cj.nome_chave as conjunto_chave, a.campanha_id, ca.nome as campanha, ca.nome_chave as campanha_chave,
       ca.objetivo, a.conta_id, c.produto, a.criado_em
from mkt.meta_anuncios a
left join mkt.meta_conjuntos cj on cj.conjunto_id = a.conjunto_id
left join mkt.meta_campanhas ca on ca.campanha_id = a.campanha_id
left join mkt.meta_contas c on c.conta_id = a.conta_id;

grant select on analytics.meta_desempenho_dia, analytics.meta_anuncios to orq_panel, orq_chat;
