-- 0019: Opcao A do plano D-56 (decidida pelo Pablo em 2026-10-13), partes 1 e 3 de docs/datahub/proposta-meta.sql. Somente aditiva.
--  PARTE 1: configuracao da Meta em ops (conta -> produto, lista fechada de action_types, janelas de releitura) e o controle das rodadas
--           (simulacao e gravacao autorizada, por trimestre e conta; marca d'agua e trimestre fechado) + colunas de controle no diario
--           (row_hash, rodada_id, revisao: a Meta revisa numeros; fica so a versao mais recente, com um contador de revisao: decisao do Pablo).
--  PARTE 3: crm.deal_atributos, a tabela pequena com os campos que o BI hoje reconstroi, a cada consulta, do JSON bruto de ~40 mil negocios
--           (as consultas lentas do orq_panel, D-56), e a funcao que a preenche so para os negocios que mudaram. As VISOES continuam lendo o JSON
--           ate uma migration seguinte trocar a leitura (nada muda para o BI nesta migration).
-- Nada em public, core nem orq. Sem DROP, sem DELETE concedido.

-- ===== PARTE 1 =====
create table ops.cfg_meta_conta (
  conta_id bigint primary key,
  produto text not null check (produto in ('rh', 'clinic')),     -- lista fechada: conta fora dela nao entra (quarentena), nunca se adivinha produto
  nome text,
  fuso text not null,                                            -- o dia da Meta segue o fuso da CONTA
  moeda text not null,
  ativa boolean not null default true,
  atualizado_em timestamptz not null default now()
);
insert into ops.cfg_meta_conta (conta_id, produto, nome, fuso, moeda) values
  (287516640670266, 'rh', '[V4] [QUARKRH]', 'America/Sao_Paulo', 'BRL'),
  (1390544329013540, 'clinic', '[V4] [QUARKCLINIC] [NOVA]', 'America/Sao_Paulo', 'BRL');

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

create table ops.cfg_meta_janela (
  situacao text primary key check (situacao in ('corrente', 'fechando', 'fechado')),
  dias_releitura int not null check (dias_releitura >= 0),
  descricao text
);
insert into ops.cfg_meta_janela (situacao, dias_releitura, descricao) values
  ('corrente', 28, 'trimestre em curso: releitura dos ultimos 28 dias (a atribuicao da Meta muda por ate 28 dias)'),
  ('fechando', 0, 'ate 30 dias depois do fim do trimestre: uma releitura completa'),
  ('fechado', 0, 'FECHADO: so reabre com autorizacao explicita e motivo');

create table mkt.meta_rodadas (
  rodada_id bigint generated always as identity primary key,
  trimestre text not null check (trimestre ~ '^20[0-9]{2}-T[1-4]$'),
  conta_id bigint not null,
  de date not null,
  ate date not null,
  modo text not null check (modo in ('simulacao', 'gravacao')),
  status text not null check (status in ('simulada', 'parcial', 'concluida', 'falhou')),
  simulacao_de_origem bigint references mkt.meta_rodadas (rodada_id),  -- a gravacao aponta para a simulacao da MESMA conta e intervalo que a precedeu
  cartao jsonb,                                                         -- o cartao da rodada (chamadas, linhas, MB, duracao, completude, riscos)
  autorizacao text,                                                     -- o "pode seguir" do Pablo (texto e data); obrigatorio para gravar
  iniciou_em timestamptz not null default now(),
  terminou_em timestamptz,
  chamadas int not null default 0,
  linhas_inseridas int not null default 0,
  linhas_atualizadas int not null default 0,
  linhas_mantidas int not null default 0,
  mb_previsto numeric(8, 2),
  erro text,
  check (de <= ate),
  check (modo = 'simulacao' or (autorizacao is not null and simulacao_de_origem is not null)),
  check (modo = 'gravacao' or status = 'simulada')                       -- simulacao nunca vira "concluida": nada foi gravado
);
create index meta_rodadas_trimestre_idx on mkt.meta_rodadas (trimestre, conta_id, iniciou_em desc);

create table mkt.meta_trimestres (
  trimestre text not null check (trimestre ~ '^20[0-9]{2}-T[1-4]$'),
  conta_id bigint not null,
  marca_dagua date,                                                     -- ultimo dia gravado e conferido
  fechado boolean not null default false,
  fechado_em timestamptz,
  atualizado_em timestamptz not null default now(),
  primary key (trimestre, conta_id)
);

alter table mkt.meta_ads_dia add column row_hash text;                  -- hash da linha: so atualiza quando muda
alter table mkt.meta_ads_dia add column rodada_id bigint;               -- a rodada que gravou a versao atual
alter table mkt.meta_ads_dia add column revisao int not null default 0; -- quantas vezes a Meta mudou o numero (so a versao mais recente fica)

alter table ops.cfg_meta_conta enable row level security;
alter table ops.cfg_meta_acao enable row level security;
alter table ops.cfg_meta_janela enable row level security;
alter table mkt.meta_rodadas enable row level security;
alter table mkt.meta_trimestres enable row level security;
grant usage on schema ops to orq_sync;
grant select on ops.cfg_meta_conta, ops.cfg_meta_acao, ops.cfg_meta_janela to orq_sync;
grant select on ops.cfg_meta_conta, ops.cfg_meta_acao, ops.cfg_meta_janela to orq_panel;
create policy orq_sync_read on ops.cfg_meta_conta for select to orq_sync using (true);
create policy orq_panel_read on ops.cfg_meta_conta for select to orq_panel using (true);
create policy orq_sync_read on ops.cfg_meta_acao for select to orq_sync using (true);
create policy orq_panel_read on ops.cfg_meta_acao for select to orq_panel using (true);
create policy orq_sync_read on ops.cfg_meta_janela for select to orq_sync using (true);
create policy orq_panel_read on ops.cfg_meta_janela for select to orq_panel using (true);
grant select, insert, update on mkt.meta_rodadas, mkt.meta_trimestres to orq_sync;
create policy orq_sync_all on mkt.meta_rodadas for all to orq_sync using (true) with check (true);
create policy orq_sync_all on mkt.meta_trimestres for all to orq_sync using (true) with check (true);

-- Para o Painel e o conector: a situacao de cada trimestre e conta (o aviso "dias desde a ultima rodada") e as rodadas recentes
create view analytics.meta_trimestres_situacao as
select t.trimestre, c.produto, t.conta_id, t.marca_dagua, t.fechado,
       (current_date - t.marca_dagua) as dias_desde_a_ultima_data,
       (select max(r.terminou_em) from mkt.meta_rodadas r where r.trimestre = t.trimestre and r.conta_id = t.conta_id and r.modo = 'gravacao' and r.status = 'concluida') as ultima_rodada_concluida
from mkt.meta_trimestres t
left join ops.cfg_meta_conta c on c.conta_id = t.conta_id;
create view analytics.meta_rodadas_recentes as
select r.rodada_id, r.trimestre, c.produto, r.conta_id, r.de, r.ate, r.modo, r.status, r.chamadas, r.linhas_inseridas, r.linhas_atualizadas, r.linhas_mantidas,
       r.mb_previsto, r.iniciou_em, r.terminou_em, r.erro
from mkt.meta_rodadas r
left join ops.cfg_meta_conta c on c.conta_id = r.conta_id
order by r.iniciou_em desc
limit 200;
grant select on analytics.meta_trimestres_situacao, analytics.meta_rodadas_recentes to orq_panel, orq_chat;

-- ===== PARTE 3 =====
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
