-- 0016: agrupamento VIRTUAL dos criativos do Meta Ads em DOR > Mensagem (2 níveis) e Módulo de Interesse.
-- Esses campos NÃO existem no Pipedrive: o Pablo conhece os criativos e os mapeia no Painel de Dados (aba "Criativos").
-- Criativo = o campo "UTM Term" do negócio, nos negócios da fonte "Marketing [Meta ADS]" (a chave é o termo em minúsculas e com os
-- espaços normalizados, para "AD1 — Cópia" e "ad1  — cópia" serem o mesmo criativo). Mapear é opcional: o que não tem equivalente fica
-- em BRANCO (DOR, Mensagem e Módulo são independentes entre si, exceto que a Mensagem pertence a uma DOR).
-- "Remover" = desativar (nada é apagado, regra do Data Hub): o item some das listas e dos relatórios (os criativos dele ficam em branco)
-- e pode ser restaurado. Somente aditiva (CREATE). Dados de configuração, sem dado pessoal.

create function mkt.chave_criativo(t text) returns text language sql immutable as $$
  select nullif(lower(btrim(regexp_replace(coalesce(t, ''), '\s+', ' ', 'g'))), '')
$$;

create table mkt.cri_dor (
  id bigint generated always as identity primary key,
  nome text not null check (btrim(nome) <> '' and char_length(nome) <= 120),
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create unique index cri_dor_nome_uq on mkt.cri_dor (lower(btrim(nome)));

create table mkt.cri_mensagem (
  id bigint generated always as identity primary key,
  dor_id bigint not null references mkt.cri_dor (id),
  nome text not null check (btrim(nome) <> '' and char_length(nome) <= 160),
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (id, dor_id)                              -- permite ao mapa garantir que a Mensagem pertence à DOR escolhida
);
create unique index cri_mensagem_nome_uq on mkt.cri_mensagem (dor_id, lower(btrim(nome)));

create table mkt.cri_modulo (
  id bigint generated always as identity primary key,
  nome text not null check (btrim(nome) <> '' and char_length(nome) <= 120),
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create unique index cri_modulo_nome_uq on mkt.cri_modulo (lower(btrim(nome)));

-- Um criativo (chave do termo) -> DOR, Mensagem e Módulo; qualquer um pode ficar em branco (nulo).
create table mkt.cri_mapa (
  termo_chave text primary key,
  dor_id bigint references mkt.cri_dor (id),
  mensagem_id bigint,
  modulo_id bigint references mkt.cri_modulo (id),
  atualizado_em timestamptz not null default now(),
  check (mensagem_id is null or dor_id is not null),                         -- Mensagem só existe dentro de uma DOR
  foreign key (mensagem_id, dor_id) references mkt.cri_mensagem (id, dor_id) -- e tem de ser uma Mensagem DESSA DOR
);
create index cri_mapa_dor_idx on mkt.cri_mapa (dor_id);

alter table mkt.cri_dor enable row level security;
alter table mkt.cri_mensagem enable row level security;
alter table mkt.cri_modulo enable row level security;
alter table mkt.cri_mapa enable row level security;

-- O Painel lê e grava a configuração (sem DELETE: remover é desativar)
grant select, insert, update on mkt.cri_dor, mkt.cri_mensagem, mkt.cri_modulo, mkt.cri_mapa to orq_panel;
create policy orq_panel_all on mkt.cri_dor for all to orq_panel using (true) with check (true);
create policy orq_panel_all on mkt.cri_mensagem for all to orq_panel using (true) with check (true);
create policy orq_panel_all on mkt.cri_modulo for all to orq_panel using (true) with check (true);
create policy orq_panel_all on mkt.cri_mapa for all to orq_panel using (true) with check (true);

-- Uma linha por negócio da fonte Meta ADS com UTM Term preenchido, já com a DOR, a Mensagem e o Módulo (itens ativos; senão, em branco).
create view analytics.negocios_criativo as
with k as (select max(field_key) filter (where nome = 'UTM Term') as term from crm.field_definitions where entity = 'deal'),
b as (
  select d.deal_id, d.criado_em, d.conta_como_lead, d.is_mql, d.status, d.valor, d.produto,
         nullif(btrim(r.payload #>> array['custom_fields', k.term]), '') as termo
  from analytics.negocios_bi d
  join raw.pd_deals r on r.source_id = d.deal_id
  cross join k
  where d.fonte = 'Marketing [Meta ADS]'
)
select b.deal_id, b.criado_em, b.conta_como_lead, b.is_mql, b.status, b.valor, b.produto,
       mkt.chave_criativo(b.termo) as termo_chave, b.termo,
       dor.id as dor_id, dor.nome as dor,
       ms.id as mensagem_id, ms.nome as mensagem,
       md.id as modulo_id, md.nome as modulo
from b
left join mkt.cri_mapa m on m.termo_chave = mkt.chave_criativo(b.termo)
left join mkt.cri_dor dor on dor.id = m.dor_id and dor.ativo
left join mkt.cri_mensagem ms on ms.id = m.mensagem_id and ms.ativo and dor.id is not null
left join mkt.cri_modulo md on md.id = m.modulo_id and md.ativo
where b.termo is not null;

-- Uma linha por criativo, com o volume e o mapeamento (ids salvos, mesmo de itens removidos, para o Painel avisar; nomes só dos ativos).
create view analytics.criativos_meta as
select n.termo_chave,
       (array_agg(n.termo order by n.criado_em desc))[1] as termo,
       count(*) filter (where n.conta_como_lead)::int as leads,
       count(*) filter (where n.is_mql)::int as mql,
       count(*) filter (where n.status = 'won')::int as ganhos,
       coalesce(sum(n.valor) filter (where n.status = 'won'), 0)::float8 as mrr_ganho,
       min(n.criado_em) as primeiro_lead,
       max(n.criado_em) as ultimo_lead,
       m.dor_id as salvo_dor_id, m.mensagem_id as salvo_mensagem_id, m.modulo_id as salvo_modulo_id,
       max(n.dor) as dor, max(n.mensagem) as mensagem, max(n.modulo) as modulo
from analytics.negocios_criativo n
left join mkt.cri_mapa m on m.termo_chave = n.termo_chave
group by n.termo_chave, m.dor_id, m.mensagem_id, m.modulo_id;

grant select on analytics.negocios_criativo, analytics.criativos_meta to orq_panel, orq_chat;
