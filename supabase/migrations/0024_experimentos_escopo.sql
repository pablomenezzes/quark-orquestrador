-- 0024: Escopo do experimento (pedido do Pablo): pagina de destino (GA4), campanha da Meta e identificador de conversao do Pipedrive.
-- Cada um e opcional, vem das contas reais (ou e digitado a mao); com mais de um vale o conjunto (E). Sem escopo, o resultado e o do canal.
-- Somente aditiva (ADD COLUMN, todas nulas): nada existente muda. O id da campanha e bigint, mas o Studio o trata como texto (ids da Meta passam de 2^53).

alter table mkt.experimentos add column pagina_host text check (pagina_host is null or char_length(pagina_host) <= 200);
alter table mkt.experimentos add column pagina_caminho text check (pagina_caminho is null or char_length(pagina_caminho) <= 300);
alter table mkt.experimentos add column campanha_id bigint;
alter table mkt.experimentos add column campanha_nome text check (campanha_nome is null or char_length(campanha_nome) <= 200);
alter table mkt.experimentos add column identificador_conversao text check (identificador_conversao is null or char_length(identificador_conversao) <= 200);
