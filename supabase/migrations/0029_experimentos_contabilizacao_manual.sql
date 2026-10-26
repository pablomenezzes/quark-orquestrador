-- 0029: Contabilizacao manual do experimento (pedido do Pablo). No modo 'automatica' o Studio conta pelo escopo (como ate aqui). No modo 'manual' cada metrica
-- pode ter uma regra "metrica = formula" (campos de uma origem do escopo, outras metricas e numeros, com + - * /): ex. Leads = leads do identificador de conversao
-- e CPL = investimento das campanhas / Leads. A lista de regras fica em `regras` (jsonb); o Studio valida a estrutura e os campos (catalogo em
-- studio/lib/experimentos-regras.ts). Somente aditiva (ADD COLUMN com padrao): nada existente muda.

alter table mkt.experimentos add column contabilizacao text not null default 'automatica' check (contabilizacao in ('automatica', 'manual'));
alter table mkt.experimentos add column regras jsonb not null default '[]'::jsonb check (jsonb_typeof(regras) = 'array' and jsonb_array_length(regras) <= 20);
