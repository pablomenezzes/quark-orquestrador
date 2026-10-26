-- 0025: Varias campanhas da Meta no escopo do experimento (pedido do Pablo): os resultados das campanhas escolhidas somam.
-- Somente aditiva: ganha a coluna `campanhas` (jsonb, lista de {id, nome}). As colunas campanha_id e campanha_nome da 0024 ficam onde estao, sem uso novo (nada e apagado,
-- regra do Data Hub; migration nao faz UPDATE): se uma linha so tem a campanha antiga, o Studio a le como lista de uma campanha. O id da campanha e texto dentro do JSON: ids da Meta passam de 2^53.

alter table mkt.experimentos add column campanhas jsonb not null default '[]'::jsonb check (jsonb_typeof(campanhas) = 'array' and jsonb_array_length(campanhas) <= 40);

