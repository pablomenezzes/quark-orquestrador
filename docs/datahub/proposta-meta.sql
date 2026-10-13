-- docs/datahub/proposta-meta.sql  (PROPOSTA, NADA APLICADO). Entrega 0 do Meta Ads por trimestres e rodadas autorizadas (2026-10-13).
-- Regras: secao 4 do MD (so aditivo, dump antes, SQL aprovado antes do db push, testes com rollback), secao 18 (regras 7 a 12) e principio 6.
-- O que ja existe e ESTA APLICADO (migrations 0017 e 0018): mkt.meta_contas, meta_campanhas, meta_conjuntos, meta_anuncios, meta_ads_dia (anuncio x dia,
-- 21 colunas, ~227 bytes por linha com indices), meta_ligacao e as visoes analytics.meta_desempenho_dia, meta_anuncios, negocios_meta, meta_cobertura.
-- Este arquivo propoe, em 3 partes independentes, o que FALTA para o protocolo de rodadas e para a lentidao do BI. Cada parte pode ser aprovada
-- separadamente. A PARTE 4 (particionar por trimestre, como o pedido original) NAO e recomendada: ver a justificativa no fim.

-- =====================================================================================================================
-- PARTE 1: configuracao em ops (um so lugar, regra 11) e controle das rodadas
-- =====================================================================================================================

-- 1.1 Conta de anuncios -> produto (hoje o produto vem dos nomes das variaveis META_AD_ACCOUNT_RH/CLINIC e e copiado para mkt.meta_contas).
--     Passa a ser configuracao editavel, com lista fechada. Conta fora da lista nao entra: fica em quarentena (nao se adivinha produto).
create table ops.cfg_meta_conta (
  conta_id bigint primary key,
  produto text not null check (produto in ('rh', 'clinic')),
  nome text,
  fuso text not null,                   -- o dia da Meta segue o fuso da CONTA (as duas hoje: America/Sao_Paulo)
  moeda text not null,
  ativa boolean not null default true,
  atualizado_em timestamptz not null default now()
);
insert into ops.cfg_meta_conta (conta_id, produto, nome, fuso, moeda) values
  (287516640670266, 'rh', '[V4] [QUARKRH]', 'America/Sao_Paulo', 'BRL'),
  (1390544329013540, 'clinic', '[V4] [QUARKCLINIC] [NOVA]', 'America/Sao_Paulo', 'BRL');

-- 1.2 Lista fechada de action_types da Meta que viram metricas (NUNCA somar tipos diferentes; tipo novo so entra aqui, por decisao).
create table ops.cfg_meta_acao (
  action_type text primary key,
  coluna text not null check (coluna in ('visitas_pagina', 'leads_meta', 'video_3s')),
  observacao text,
  ativa boolean not null default true
);
insert into ops.cfg_meta_acao (action_type, coluna, observacao) values
  ('landing_page_view', 'visitas_pagina', 'exige o Pixel; base do Connect Rate'),
  ('lead', 'leads_meta', 'total de leads que a Meta atribui; NAO somar onsite_conversion.lead_grouped nem offsite_conversion.fb_pixel_lead (ja estao dentro de "lead")'),
  ('video_view', 'video_3s', 'visualizacao de 3 segundos; base do Hook rate');

-- 1.3 Janelas de releitura (parametros, nao codigo): a Meta ajusta numeros por ate 28 dias (atribuicao).
create table ops.cfg_meta_janela (
  situacao text primary key check (situacao in ('corrente', 'fechando', 'fechado')),
  dias_releitura int not null,          -- corrente: relê os ultimos N dias a cada rodada
  descricao text
);
insert into ops.cfg_meta_janela values
  ('corrente', 28, 'trimestre em curso: releitura dos ultimos 28 dias (a regra proposta de 7 dias nao cobre a atribuicao de 28 dias da Meta)'),
  ('fechando', 0, 'ate 30 dias depois do fim do trimestre: uma releitura completa'),
  ('fechado', 0, 'FECHADO: so reabre com autorizacao explicita e motivo');

-- 1.4 Rodadas: uma linha por (trimestre, conta, intervalo, tentativa). Simulacao tambem fica registrada, e a gravacao exige uma simulacao
--     anterior da MESMA rodada (mesma conta e mesmo intervalo) e a autorizacao registrada em `autorizacao`.
create table mkt.meta_rodadas (
  rodada_id bigint generated always as identity primary key,
  trimestre text not null check (trimestre ~ '^20[0-9]{2}-T[1-4]$'),
  conta_id bigint not null,
  de date not null,
  ate date not null,
  modo text not null check (modo in ('simulacao', 'gravacao')),
  status text not null check (status in ('simulada', 'parcial', 'concluida', 'falhou')),
  simulacao_de_origem bigint references mkt.meta_rodadas (rodada_id),   -- a gravacao aponta para a simulacao que a precedeu
  cartao jsonb,                          -- o cartao da rodada (chamadas, linhas, MB, duracao, completude, riscos)
  autorizacao text,                      -- o "pode seguir" do Pablo (texto e data), obrigatorio quando modo = gravacao
  iniciou_em timestamptz not null default now(),
  terminou_em timestamptz,
  chamadas int not null default 0,
  linhas_inseridas int not null default 0,
  linhas_atualizadas int not null default 0,
  linhas_mantidas int not null default 0,
  mb_previsto numeric(8, 2),
  erro text,
  check (de <= ate),
  check (modo = 'simulacao' or (autorizacao is not null and simulacao_de_origem is not null))
);
create index meta_rodadas_trimestre_idx on mkt.meta_rodadas (trimestre, conta_id, iniciou_em desc);

-- 1.5 Situacao de cada (trimestre, conta): ultima data fechada e se o trimestre ja foi FECHADO.
create table mkt.meta_trimestres (
  trimestre text not null check (trimestre ~ '^20[0-9]{2}-T[1-4]$'),
  conta_id bigint not null,
  marca_dagua date,                       -- ultimo dia gravado e conferido
  fechado boolean not null default false,
  fechado_em timestamptz,
  atualizado_em timestamptz not null default now(),
  primary key (trimestre, conta_id)
);

-- 1.6 Colunas de controle no diario (ADD COLUMN, aditivo): hash da linha para so atualizar quando mudou, a rodada que gravou e quantas revisoes houve.
alter table mkt.meta_ads_dia add column row_hash text;
alter table mkt.meta_ads_dia add column rodada_id bigint;
alter table mkt.meta_ads_dia add column revisao int not null default 0;

alter table ops.cfg_meta_conta enable row level security;
alter table ops.cfg_meta_acao enable row level security;
alter table ops.cfg_meta_janela enable row level security;
alter table mkt.meta_rodadas enable row level security;
alter table mkt.meta_trimestres enable row level security;
grant select on ops.cfg_meta_conta, ops.cfg_meta_acao, ops.cfg_meta_janela to orq_sync, orq_panel;
grant select, insert, update on mkt.meta_rodadas, mkt.meta_trimestres to orq_sync;     -- sem DELETE
create policy orq_sync_read on ops.cfg_meta_conta for select to orq_sync using (true);
create policy orq_panel_read on ops.cfg_meta_conta for select to orq_panel using (true);
create policy orq_sync_read on ops.cfg_meta_acao for select to orq_sync using (true);
create policy orq_panel_read on ops.cfg_meta_acao for select to orq_panel using (true);
create policy orq_sync_read on ops.cfg_meta_janela for select to orq_sync using (true);
create policy orq_panel_read on ops.cfg_meta_janela for select to orq_panel using (true);
create policy orq_sync_all on mkt.meta_rodadas for all to orq_sync using (true) with check (true);
create policy orq_sync_all on mkt.meta_trimestres for all to orq_sync using (true) with check (true);
-- o Painel le o controle por uma visao (aviso "dias desde a ultima rodada", por trimestre)
create view analytics.meta_rodadas_resumo as
select t.trimestre, c.produto, t.conta_id, t.marca_dagua, t.fechado,
       (current_date - t.marca_dagua) as dias_desde_a_ultima_data,
       (select max(r.terminou_em) from mkt.meta_rodadas r where r.trimestre = t.trimestre and r.conta_id = t.conta_id and r.modo = 'gravacao' and r.status = 'concluida') as ultima_rodada_concluida
from mkt.meta_trimestres t left join ops.cfg_meta_conta c on c.conta_id = t.conta_id;
grant select on analytics.meta_rodadas_resumo to orq_panel, orq_chat;

-- =====================================================================================================================
-- PARTE 2: resumos por campanha e dia (so se a Parte 3 nao bastar). Atualizados por upsert apenas nas datas tocadas pela rodada.
-- =====================================================================================================================
create table mkt.meta_resumo_campanha_dia (
  campanha_id bigint not null,
  dia date not null,
  conta_id bigint not null,
  produto text not null check (produto in ('rh', 'clinic')),   -- resolvido por JOIN em ops.cfg_meta_conta SO na escrita da rodada
  gasto numeric(14, 2) not null, impressoes int not null, cliques_link int not null, visitas_pagina int not null, leads_meta int not null,
  video_reproducoes int not null, video_3s int not null, video_thruplay int not null,
  rodada_id bigint,
  primary key (campanha_id, dia)
);
create index meta_resumo_campanha_dia_dia_idx on mkt.meta_resumo_campanha_dia (dia);
alter table mkt.meta_resumo_campanha_dia enable row level security;
grant select, insert, update on mkt.meta_resumo_campanha_dia to orq_sync;
create policy orq_sync_all on mkt.meta_resumo_campanha_dia for all to orq_sync using (true) with check (true);

-- =====================================================================================================================
-- PARTE 3: a causa REAL da lentidao do BI (medida em 2026-10-13): analytics.negocios_bi (e as visoes que a usam) reconstroem, a CADA consulta,
-- os campos de ~40 mil negocios a partir do JSON bruto (raw.pd_deals). As consultas lentas do papel orq_panel sao todas dessa familia
-- (max 18,6 s o funil por DOR; 17,5 s por Modulo; 11,8 s o funil por URL; 10,1 s a lista de criativos). Nenhuma lê mkt.meta_ads_dia.
-- Proposta: guardar os atributos ja extraidos numa tabela pequena, atualizada pela sincronizacao SO para os negocios que mudaram.
-- =====================================================================================================================
create table crm.deal_atributos (
  deal_id bigint primary key,
  fonte_id text, tipo_id text, faixa_colab_id text, faixa_saude_id text, canal_rd text,
  utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text, url_conversao text,
  meta_ad_id text, meta_adset_id text, meta_campaign_id text, meta_lead_id text, meta_form_id text,
  payload_hash text,                    -- hash do JSON de origem: so recalcula quando mudou
  atualizado_em timestamptz not null default now()
);
create index deal_atributos_term_idx on crm.deal_atributos (utm_term);
alter table crm.deal_atributos enable row level security;
grant select, insert, update on crm.deal_atributos to orq_sync;
create policy orq_sync_all on crm.deal_atributos for all to orq_sync using (true) with check (true);

create function crm.recalcular_deal_atributos(so_mudados boolean default true) returns integer language plpgsql as $$
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
           max(field_key) filter (where nome = 'Meta Lead_id') as mle, max(field_key) filter (where nome = 'Meta Form_id') as mfo
    from crm.field_definitions where entity = 'deal'
  )
  insert into crm.deal_atributos (deal_id, fonte_id, tipo_id, faixa_colab_id, faixa_saude_id, canal_rd, utm_source, utm_medium, utm_campaign, utm_content, utm_term, url_conversao,
                                  meta_ad_id, meta_adset_id, meta_campaign_id, meta_lead_id, meta_form_id, payload_hash)
  select r.source_id,
         nullif(r.payload #>> array['custom_fields', k.fonte], ''), nullif(r.payload #>> array['custom_fields', k.tipo], ''), nullif(r.payload #>> array['custom_fields', k.fcol], ''),
         nullif(r.payload #>> array['custom_fields', k.fsau], ''), nullif(r.payload #>> array['custom_fields', k.canal], ''), nullif(r.payload #>> array['custom_fields', k.us], ''),
         nullif(r.payload #>> array['custom_fields', k.um], ''), nullif(r.payload #>> array['custom_fields', k.uc], ''), nullif(r.payload #>> array['custom_fields', k.uco], ''),
         nullif(btrim(r.payload #>> array['custom_fields', k.ut]), ''), nullif(r.payload #>> array['custom_fields', k.url], ''), nullif(btrim(r.payload #>> array['custom_fields', k.mad]), ''),
         nullif(btrim(r.payload #>> array['custom_fields', k.mas]), ''), nullif(btrim(r.payload #>> array['custom_fields', k.mca]), ''), nullif(btrim(r.payload #>> array['custom_fields', k.mle]), ''),
         nullif(btrim(r.payload #>> array['custom_fields', k.mfo]), ''), r.payload_hash
  from raw.pd_deals r cross join k
  where not so_mudados or not exists (select 1 from crm.deal_atributos a where a.deal_id = r.source_id and a.payload_hash = r.payload_hash)
  on conflict (deal_id) do update set fonte_id = excluded.fonte_id, tipo_id = excluded.tipo_id, faixa_colab_id = excluded.faixa_colab_id, faixa_saude_id = excluded.faixa_saude_id,
    canal_rd = excluded.canal_rd, utm_source = excluded.utm_source, utm_medium = excluded.utm_medium, utm_campaign = excluded.utm_campaign, utm_content = excluded.utm_content,
    utm_term = excluded.utm_term, url_conversao = excluded.url_conversao, meta_ad_id = excluded.meta_ad_id, meta_adset_id = excluded.meta_adset_id, meta_campaign_id = excluded.meta_campaign_id,
    meta_lead_id = excluded.meta_lead_id, meta_form_id = excluded.meta_form_id, payload_hash = excluded.payload_hash, atualizado_em = now();
  get diagnostics gravados = row_count;
  return gravados;
end
$$;
-- Depois dela, em MIGRATION SEPARADA (create or replace view, so lendo desta tabela): analytics.negocios_bi, negocios_url, negocios_criativo e a ligacao
-- mkt.recalcular_ligacao_meta() passam a ler crm.deal_atributos em vez do JSON. Meta de tempo: cada analise do BI de ~0,5 a 7 s para ~0,1 a 1 s.

-- =====================================================================================================================
-- PARTE 4 (NAO RECOMENDADA): mkt.ad_daily particionada por RANGE em dia, uma particao por trimestre.
--   Por que nao: mkt.meta_ads_dia tem 27,7 mil linhas / 6,3 MB hoje e deve chegar a ~50 mil / ~12 MB com 2025 e 2026 inteiros; consulta por
--   periodo ja usa o indice (dia) e leva ~0,5 s. Particionar nao acelera nada nessa escala, exige recriar e copiar a tabela (mudanca estrutural,
--   ADD/COPY, nao aditiva pura), complica a chave primaria (precisa conter o dia, o que ja ocorre) e cada trimestre novo pede uma migration.
--   Se o Pablo ainda quiser, a forma segura e: create table mkt.ad_daily (...) partition by range (dia) + 8 particoes (2025-T1 a 2026-T4),
--   copiar com insert ... select numa rodada autorizada, trocar as visoes e so entao descartar a antiga (DROP: exige aprovacao explicita, secao 4 regra 3).
-- =====================================================================================================================
