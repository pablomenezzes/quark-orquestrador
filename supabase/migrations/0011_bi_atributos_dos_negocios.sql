-- 0011: atributos de marketing dos negocios para o BI (fonte, tipo do lead, faixas, canal, UTM, pessoa e organizacao).
-- O BI precisa filtrar e agrupar por "Fonte do Lead" e "Tipo do Lead" em TODAS as telas. Ler esses campos pela view
-- analytics.deal_campos (que abre os 84 campos de cada negocio) e lento; aqui o valor e lido DIRETO da chave do campo no JSON
-- original (raw.pd_deals), e o nome da opcao vem de crm.field_definitions. Os campos sao achados pelo NOME no Pipedrive, uma
-- vez por consulta, entao nada fica gravado em duplicidade (D-40): so views.
-- Somente aditiva: duas views novas em analytics. Nada em public, core nem orq; nenhuma tabela nova nem coluna nova.

-- Todas as opcoes de todos os campos de lista dos negocios (ID e nome juntos)
create view analytics.campo_opcoes as
select fd.field_key, fd.nome as campo, o ->> 'id' as opcao_id, o ->> 'label' as opcao
from crm.field_definitions fd
cross join lateral jsonb_array_elements(case when jsonb_typeof(fd.opcoes) = 'array' then fd.opcoes else '[]'::jsonb end) o
where fd.entity = 'deal';

-- Uma linha por negocio = analytics.deals + atributos de marketing.
-- *_id e o ID original da opcao (texto); ausente/vazio = null (e o que o BI chama de "em branco").
create view analytics.negocios_bi as
with k as (
  select max(field_key) filter (where nome = 'Fonte do Lead') as fonte,
         max(field_key) filter (where nome = 'Tipo do Lead') as tipo,
         max(field_key) filter (where nome = 'Faixa de Colaboradores') as faixa_colab,
         max(field_key) filter (where nome = 'Faixa de profissionais da saúde') as faixa_saude,
         max(field_key) filter (where nome = 'Canal de origem RD') as canal_rd,
         max(field_key) filter (where nome = 'UTM Source') as utm_source
  from crm.field_definitions where entity = 'deal'
),
a as (
  select r.source_id as deal_id,
         nullif(r.payload #>> array['custom_fields', k.fonte], '') as fonte_id,
         nullif(r.payload #>> array['custom_fields', k.tipo], '') as tipo_id,
         nullif(r.payload #>> array['custom_fields', k.faixa_colab], '') as faixa_colab_id,
         nullif(r.payload #>> array['custom_fields', k.faixa_saude], '') as faixa_saude_id,
         nullif(r.payload #>> array['custom_fields', k.canal_rd], '') as canal_rd,
         nullif(r.payload #>> array['custom_fields', k.utm_source], '') as utm_source
  from raw.pd_deals r cross join k
)
select d.*,
       a.fonte_id, fo.opcao as fonte,
       a.tipo_id, tp.opcao as tipo,
       a.faixa_colab_id, fc.opcao as faixa_colab,
       a.faixa_saude_id, fs.opcao as faixa_saude,
       a.canal_rd, a.utm_source,
       (cd.person_id is null) as sem_pessoa, (cd.org_id is null) as sem_organizacao
from analytics.deals d
left join a on a.deal_id = d.deal_id
left join crm.deals cd on cd.pipedrive_id = d.deal_id
left join analytics.campo_opcoes fo on fo.field_key = (select fonte from k) and fo.opcao_id = a.fonte_id
left join analytics.campo_opcoes tp on tp.field_key = (select tipo from k) and tp.opcao_id = a.tipo_id
left join analytics.campo_opcoes fc on fc.field_key = (select faixa_colab from k) and fc.opcao_id = a.faixa_colab_id
left join analytics.campo_opcoes fs on fs.field_key = (select faixa_saude from k) and fs.opcao_id = a.faixa_saude_id;

grant select on analytics.campo_opcoes, analytics.negocios_bi to orq_panel;
