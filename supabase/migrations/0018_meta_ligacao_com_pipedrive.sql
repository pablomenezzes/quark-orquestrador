-- 0018: Meta Ads M4. Liga cada negócio do Pipedrive ao anúncio, conjunto e campanha da Meta, em 3 métodos (D-52):
--   1) 'ad_id'            : o campo "Meta Ad_id" do negócio é o ID de um anúncio que a Meta conhece (o método principal);
--   2) 'conjunto_id'      : sem Ad_id (ou desconhecido), mas o "Meta Adset_id" é de um conjunto conhecido (liga ao conjunto);
--   3) 'campanha_id+nome' : "Meta Campaign_id" + o NOME (UTM Term, UTM Content ou UTM Medium) igual ao nome de UM anúncio daquela campanha;
--   4) 'nome'             : só por nome: UTM Campaign = nome da campanha E (UTM Term | Content | Medium) = nome do anúncio;
--   5) 'campanha_id' / 'campanha_nome': só a campanha (pelo ID ou, se for única, pelo nome);
--   6) 'ambiguo'          : o nome bate com MAIS DE UM anúncio: não se escolhe um (campanha/conjunto só se todos os candidatos concordam);
--   7) 'sem_ligacao'      : nenhum método achou.
-- Certeza: 'alta' (ad_id, conjunto_id, campanha_id+nome com um só candidato), 'media' (nome, campanha única), 'baixa' (ambíguo e só campanha).
-- Os nomes se comparam por mkt.chave_nome_meta (minúsculas e sem espaços). A ligação é GRAVADA numa tabela (recalculada a cada sincronização,
-- por upsert, sem apagar) para o BI não refazer a busca a cada consulta. Somente aditiva (CREATE). Sem dado pessoal novo (o ID do lead da Meta
-- e do formulário já estão no Pipedrive e não saem do banco para fora dele).

create table mkt.meta_ligacao (
  deal_id bigint primary key,
  conta_id bigint,
  campanha_id bigint,
  conjunto_id bigint,
  anuncio_id bigint,
  metodo text not null check (metodo in ('ad_id', 'conjunto_id', 'campanha_id+nome', 'nome', 'campanha_id', 'campanha_nome', 'ambiguo', 'sem_ligacao')),
  certeza text not null check (certeza in ('alta', 'media', 'baixa')),
  candidatos int not null default 0,              -- quantos anúncios bateram (1 = único; mais de 1 = ambíguo)
  meta_lead_id text,                              -- IDs do Pipedrive, como vieram (úteis para conferir o formulário)
  meta_form_id text,
  calculado_em timestamptz not null default now()
);
create index meta_ligacao_anuncio_idx on mkt.meta_ligacao (anuncio_id);
create index meta_ligacao_campanha_idx on mkt.meta_ligacao (campanha_id);
create index meta_ligacao_conjunto_idx on mkt.meta_ligacao (conjunto_id);
alter table mkt.meta_ligacao enable row level security;
grant select, insert, update on mkt.meta_ligacao to orq_sync;
create policy orq_sync_all on mkt.meta_ligacao for all to orq_sync using (true) with check (true);

create function mkt.recalcular_ligacao_meta() returns integer language plpgsql as $$
declare gravados integer;
begin
  with k as (
    select max(field_key) filter (where nome = 'Meta Ad_id') as ad, max(field_key) filter (where nome = 'Meta Adset_id') as adset,
           max(field_key) filter (where nome = 'Meta Campaign_id') as camp, max(field_key) filter (where nome = 'Meta Lead_id') as lead,
           max(field_key) filter (where nome = 'Meta Form_id') as form, max(field_key) filter (where lower(nome) = 'utm campaign') as ucamp,
           max(field_key) filter (where nome = 'UTM Content') as ucont, max(field_key) filter (where nome = 'UTM Term') as uterm,
           max(field_key) filter (where nome = 'UTM Medium') as umed, max(field_key) filter (where nome = 'Fonte do Lead') as fonte
    from crm.field_definitions where entity = 'deal'
  ),
  meta_opcao as (   -- IDs das opções da "Fonte do Lead" que se chamam "Marketing [Meta ADS]"
    select o ->> 'id' as id
    from crm.field_definitions fd, k, lateral jsonb_array_elements(case when jsonb_typeof(fd.opcoes) = 'array' then fd.opcoes else '[]'::jsonb end) o
    where fd.entity = 'deal' and fd.field_key = k.fonte and o ->> 'label' = 'Marketing [Meta ADS]'
  ),
  d as (
    select r.source_id as deal_id,
           case when v.ad ~ '^[0-9]{6,20}$' then v.ad::bigint end as ad_pd,
           case when v.adset ~ '^[0-9]{6,20}$' then v.adset::bigint end as adset_pd,
           case when v.camp ~ '^[0-9]{6,20}$' then v.camp::bigint end as camp_pd,
           v.lead as meta_lead_id, v.form as meta_form_id,
           mkt.chave_nome_meta(v.ucamp) as kcamp,
           array_remove(array[mkt.chave_nome_meta(v.uterm), mkt.chave_nome_meta(v.ucont), mkt.chave_nome_meta(v.umed)], null) as knomes,
           (v.fonte in (select id from meta_opcao)) as fonte_meta
    from raw.pd_deals r
    cross join k
    cross join lateral (
      select nullif(btrim(r.payload #>> array['custom_fields', k.ad]), '') as ad, nullif(btrim(r.payload #>> array['custom_fields', k.adset]), '') as adset,
             nullif(btrim(r.payload #>> array['custom_fields', k.camp]), '') as camp, nullif(btrim(r.payload #>> array['custom_fields', k.lead]), '') as lead,
             nullif(btrim(r.payload #>> array['custom_fields', k.form]), '') as form, nullif(btrim(r.payload #>> array['custom_fields', k.ucamp]), '') as ucamp,
             nullif(btrim(r.payload #>> array['custom_fields', k.uterm]), '') as uterm, nullif(btrim(r.payload #>> array['custom_fields', k.ucont]), '') as ucont,
             nullif(btrim(r.payload #>> array['custom_fields', k.umed]), '') as umed, nullif(r.payload #>> array['custom_fields', k.fonte], '') as fonte
    ) v
  ),
  alvo as (   -- só negócios que têm cara de Meta: fonte Meta ADS ou algum ID da Meta preenchido
    select * from d where fonte_meta or ad_pd is not null or adset_pd is not null or camp_pd is not null or meta_lead_id is not null
  ),
  m1 as (select a.deal_id, an.anuncio_id, an.conjunto_id, an.campanha_id, an.conta_id from alvo a join mkt.meta_anuncios an on an.anuncio_id = a.ad_pd),
  m2 as (select a.deal_id, cj.conjunto_id, cj.campanha_id, cj.conta_id from alvo a join mkt.meta_conjuntos cj on cj.conjunto_id = a.adset_pd where a.deal_id not in (select deal_id from m1)),
  m3 as (   -- campanha por ID + nome do anúncio dentro dela
    select a.deal_id, count(distinct an.anuncio_id)::int as n, min(an.anuncio_id) as anuncio_id, min(an.conjunto_id) as conjunto_min, max(an.conjunto_id) as conjunto_max, min(an.conta_id) as conta_id, a.camp_pd as campanha_id
    from alvo a join mkt.meta_anuncios an on an.campanha_id = a.camp_pd and an.nome_chave = any (a.knomes)
    where a.deal_id not in (select deal_id from m1) and a.deal_id not in (select deal_id from m2)
    group by a.deal_id, a.camp_pd
  ),
  m4 as (   -- só por nome: campanha pelo nome da UTM Campaign e anúncio pelo nome nas outras UTMs
    select a.deal_id, count(distinct an.anuncio_id)::int as n, min(an.anuncio_id) as anuncio_id, min(an.conjunto_id) as conjunto_min, max(an.conjunto_id) as conjunto_max,
           min(an.campanha_id) as campanha_min, max(an.campanha_id) as campanha_max, min(an.conta_id) as conta_id
    from alvo a
    join mkt.meta_campanhas c on c.nome_chave = a.kcamp
    join mkt.meta_anuncios an on an.campanha_id = c.campanha_id and an.nome_chave = any (a.knomes)
    where a.kcamp is not null and a.deal_id not in (select deal_id from m1) and a.deal_id not in (select deal_id from m2) and a.deal_id not in (select deal_id from m3)
    group by a.deal_id
  ),
  m5 as (   -- só a campanha: pelo ID, ou pelo nome quando ele é único
    select a.deal_id, c.campanha_id, c.conta_id, 'campanha_id'::text as metodo
    from alvo a join mkt.meta_campanhas c on c.campanha_id = a.camp_pd
    where a.deal_id not in (select deal_id from m1) and a.deal_id not in (select deal_id from m2) and a.deal_id not in (select deal_id from m3) and a.deal_id not in (select deal_id from m4)
    union all
    select a.deal_id, min(c.campanha_id), min(c.conta_id), 'campanha_nome'
    from alvo a join mkt.meta_campanhas c on c.nome_chave = a.kcamp
    where a.camp_pd is null and a.deal_id not in (select deal_id from m1) and a.deal_id not in (select deal_id from m2) and a.deal_id not in (select deal_id from m3) and a.deal_id not in (select deal_id from m4)
    group by a.deal_id having count(*) = 1
  ),
  final as (
    select deal_id, conta_id, campanha_id, conjunto_id, anuncio_id, 'ad_id'::text as metodo, 'alta'::text as certeza, 1 as candidatos from m1
    union all select deal_id, conta_id, campanha_id, conjunto_id, null::bigint, 'conjunto_id', 'alta', 1 from m2
    union all select deal_id, conta_id, campanha_id,
                case when n = 1 then conjunto_min when conjunto_min = conjunto_max then conjunto_min end,
                case when n = 1 then anuncio_id end,
                case when n = 1 then 'campanha_id+nome' else 'ambiguo' end, case when n = 1 then 'alta' else 'baixa' end, n from m3
    union all select deal_id, conta_id, case when campanha_min = campanha_max then campanha_min end,
                case when n = 1 then conjunto_min when conjunto_min = conjunto_max then conjunto_min end,
                case when n = 1 then anuncio_id end,
                case when n = 1 then 'nome' else 'ambiguo' end, case when n = 1 then 'media' else 'baixa' end, n from m4
    union all select deal_id, conta_id, campanha_id, null::bigint, null::bigint, metodo, case when metodo = 'campanha_id' then 'media' else 'baixa' end, 1 from m5
    union all select a.deal_id, null::bigint, null::bigint, null::bigint, null::bigint, 'sem_ligacao', 'baixa', 0 from alvo a
      where a.deal_id not in (select deal_id from m1) and a.deal_id not in (select deal_id from m2) and a.deal_id not in (select deal_id from m3)
        and a.deal_id not in (select deal_id from m4) and a.deal_id not in (select deal_id from m5)
  )
  insert into mkt.meta_ligacao (deal_id, conta_id, campanha_id, conjunto_id, anuncio_id, metodo, certeza, candidatos, meta_lead_id, meta_form_id)
  select f.deal_id, f.conta_id, f.campanha_id, f.conjunto_id, f.anuncio_id, f.metodo, f.certeza, f.candidatos, a.meta_lead_id, a.meta_form_id
  from final f join alvo a on a.deal_id = f.deal_id
  on conflict (deal_id) do update set conta_id = excluded.conta_id, campanha_id = excluded.campanha_id, conjunto_id = excluded.conjunto_id, anuncio_id = excluded.anuncio_id,
    metodo = excluded.metodo, certeza = excluded.certeza, candidatos = excluded.candidatos, meta_lead_id = excluded.meta_lead_id, meta_form_id = excluded.meta_form_id, calculado_em = now();
  get diagnostics gravados = row_count;
  return gravados;
end
$$;

-- Cada negócio ligado à Meta, com os nomes (campanha, conjunto, anúncio) e os dados do funil/MRR para o BI.
create view analytics.negocios_meta as
select l.deal_id, l.metodo, l.certeza, l.candidatos, l.conta_id, c.produto as conta_produto,
       l.campanha_id, ca.nome as campanha, l.conjunto_id, cj.nome as conjunto, l.anuncio_id, an.nome as anuncio, an.criativo_id,
       d.criado_em, d.conta_como_lead, d.is_mql, d.status, d.valor, d.produto as produto_negocio
from mkt.meta_ligacao l
join analytics.negocios_bi d on d.deal_id = l.deal_id
left join mkt.meta_contas c on c.conta_id = l.conta_id
left join mkt.meta_campanhas ca on ca.campanha_id = l.campanha_id
left join mkt.meta_conjuntos cj on cj.conjunto_id = l.conjunto_id
left join mkt.meta_anuncios an on an.anuncio_id = l.anuncio_id;

-- Cobertura da ligação: quantos negócios (e leads) ligaram por cada método, por mês de criação (a tela de cobertura do BI)
create view analytics.meta_cobertura as
select to_char(date_trunc('month', d.criado_em at time zone 'America/Sao_Paulo'), 'YYYY-MM') as mes, l.metodo, l.certeza,
       count(*)::int as negocios, count(*) filter (where d.conta_como_lead)::int as leads
from mkt.meta_ligacao l
join analytics.negocios_bi d on d.deal_id = l.deal_id
group by 1, 2, 3;

grant select on analytics.negocios_meta, analytics.meta_cobertura to orq_panel, orq_chat;
