-- 0028: Como combinar os criterios do escopo do experimento (pagina de destino, campanhas da Meta e identificador de conversao):
--   todos                     = o negocio precisa bater com todos os criterios (E, o comportamento ate aqui);
--   qualquer                  = basta bater com um (OU);
--   campanha_so_investimento  = a pagina e o identificador definem os negocios; a campanha so traz investimento, impressoes e cliques.
-- Somente aditiva (ADD COLUMN com padrao 'todos'): nada existente muda.

alter table mkt.experimentos add column escopo_modo text not null default 'todos' check (escopo_modo in ('todos', 'qualquer', 'campanha_so_investimento'));
