-- 0031: Filtros por campo do Pipedrive no escopo do experimento (pedido do Pablo): o experimento pode contar so os negocios cujo campo escolhido
-- (URL de Conversao, UTM Campaign, UTM Content, UTM Term, Identificador de Conversao RD ou qualquer outro campo do negocio) bate com um valor, por igualdade,
-- trecho, inicio, fim, preenchido ou vazio. `filtros` e a lista [{campo, operador, valor}] (jsonb); `filtros_modo` diz se os filtros se juntam em E (todos) ou OU (qualquer).
-- Somente aditiva (ADD COLUMN com padrao): nada existente muda.

alter table mkt.experimentos add column filtros jsonb not null default '[]'::jsonb check (jsonb_typeof(filtros) = 'array' and jsonb_array_length(filtros) <= 10);
alter table mkt.experimentos add column filtros_modo text not null default 'todos' check (filtros_modo in ('todos', 'qualquer'));
