-- 0007: ficha do negocio com o NOME da opcao nos campos de lista (regra 10: ID e nome juntos).
-- Hoje um campo de lista (ex.: "[SDR] Qualificador") aparece como o numero da opcao (624). Esta view acrescenta
-- a coluna valor_legivel com o nome da opcao ("Fulano"), quando o valor e o ID de uma opcao conhecida.
-- Somente aditiva: a view existente ganha UMA coluna no fim (as colunas atuais nao mudam); nenhuma tabela e tocada.
create or replace view analytics.deal_campos as
select d.pipedrive_id as deal_id, c.key as field_key, f.nome_pipedrive, f.rotulo, c.value as valor,
       (select o ->> 'label'
          from crm.field_definitions fd
          cross join lateral jsonb_array_elements(case when jsonb_typeof(fd.opcoes) = 'array' then fd.opcoes else '[]'::jsonb end) o
         where fd.entity = 'deal' and fd.field_key = c.key and (o ->> 'id') = trim(both '"' from c.value::text)
         limit 1) as valor_legivel
from crm.deals d
cross join lateral jsonb_each(case when jsonb_typeof(d.custom_fields) = 'object' then d.custom_fields else '{}'::jsonb end) c
left join analytics.campos f on f.entity = 'deal' and f.field_key = c.key;
