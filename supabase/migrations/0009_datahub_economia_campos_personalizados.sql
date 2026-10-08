-- 0009: economia de espaco (D-40). O banco gratuito tem 500 MB e os negocios ja ocupam ~457 MB: cada negocio guardava os
-- campos personalizados DUAS vezes (em raw.pd_deals.payload e em crm.deals.custom_fields), ~4,3 KB cada, e ~58 dos 84 campos
-- estao sempre vazios (null). A partir daqui:
--   * os campos personalizados ficam SO em raw.pd_deals.payload->'custom_fields' (sem as chaves vazias);
--   * crm.deals.custom_fields deixa de ser preenchida (a coluna continua existindo: esta frente nao faz DROP).
-- Esta migration so TROCA A ORIGEM da view da ficha do negocio (mesmas colunas, na mesma ordem). A limpeza dos dados
-- existentes e feita depois, em lotes, por scripts/datahub-slim.ts (nao cabe numa unica transacao sem estourar o limite).
-- Somente aditiva (CREATE OR REPLACE VIEW com as mesmas colunas). Nada em public, core nem orq.
create or replace view analytics.deal_campos as
select r.source_id as deal_id, c.key as field_key, f.nome_pipedrive, f.rotulo, c.value as valor,
       (select o ->> 'label'
          from crm.field_definitions fd
          cross join lateral jsonb_array_elements(case when jsonb_typeof(fd.opcoes) = 'array' then fd.opcoes else '[]'::jsonb end) o
         where fd.entity = 'deal' and fd.field_key = c.key and (o ->> 'id') = trim(both '"' from c.value::text)
         limit 1) as valor_legivel
from raw.pd_deals r
cross join lateral jsonb_each(case when jsonb_typeof(r.payload -> 'custom_fields') = 'object' then r.payload -> 'custom_fields' else '{}'::jsonb end) c
left join analytics.campos f on f.entity = 'deal' and f.field_key = c.key
where c.value <> 'null'::jsonb;
