-- 0003: papel de privilegio minimo para o endpoint publico (orq_ingest) e contador de limite de requisicoes.
-- Item 4 da secao 15 do orquestrador-marketing-quark.md.
-- Somente aditiva. Nada no schema public.
--
-- A SENHA do papel NAO esta aqui (ficaria versionada). Ela e definida por scripts/set-ingest-password.mjs,
-- que gera um valor aleatorio e grava a URL direto no .env.local e na Vercel.
-- Sem senha, o papel nao consegue autenticar: nasce fechado.

-- ---------------------------------------------------------------------------
-- Papel
-- ---------------------------------------------------------------------------

create role orq_ingest
  login nosuperuser nocreatedb nocreaterole noinherit noreplication
  connection limit 20;

alter role orq_ingest set statement_timeout = '15s';
alter role orq_ingest set idle_in_transaction_session_timeout = '30s';

-- Permite que o dono do banco assuma o papel (SET ROLE) nos testes de integracao.
grant orq_ingest to postgres;

grant usage on schema core, orq to orq_ingest;

-- ---------------------------------------------------------------------------
-- Contador de limite de requisicoes (janela fixa). Mutavel por natureza; nao e evento.
-- ---------------------------------------------------------------------------

create table orq.rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (bucket, window_start)
);

create index rate_limits_window_start_idx on orq.rate_limits (window_start);

alter table orq.rate_limits enable row level security;

-- ---------------------------------------------------------------------------
-- Privilegios (por tabela e, quando possivel, por coluna). Tudo o que o endpoint faz, e nada alem.
-- ---------------------------------------------------------------------------

-- Fontes: ler (token_hash, tipo, url...). Nunca alterar.
grant select on orq.sources to orq_ingest;

-- Leads: dedupe (ler), criar e completar campos vazios (atualizar so estas colunas). Sem delete.
grant select (id, email_norm, phone_e164, nome, empresa, porte, cargo, produto, status) on core.leads to orq_ingest;
grant insert (id, email_norm, phone_e164, nome, empresa, porte, cargo, produto) on core.leads to orq_ingest;
grant update (email_norm, phone_e164, nome, empresa, porte, cargo, produto) on core.leads to orq_ingest;

-- Touchpoints: checar duplicidade (event_id) e inserir. Nao le os campos de atribuicao de volta.
grant select (id, event_id) on orq.touchpoints to orq_ingest;
grant insert (lead_id, source_id, event_id, canal, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
              ad_id, gclid, gbraid, wbraid, fbp, fbc, ga_client_id, landing_url, referrer, occurred_at)
  on orq.touchpoints to orq_ingest;

-- Eventos: so inserir (e ler o id gerado). Imutavel: sem update, delete nem truncate, e nao le o conteudo.
grant select (id) on orq.events to orq_ingest;
grant insert (lead_id, touchpoint_id, tipo, dados, payload_bruto, occurred_at) on orq.events to orq_ingest;

-- Decisoes: so inserir (e ler o id gerado).
grant select (id) on orq.decisions to orq_ingest;
grant insert (event_id, rule_id, rule_versao, acao, modo, status, erro) on orq.decisions to orq_ingest;

-- Contador: contar e limpar janelas antigas.
grant select, insert, update, delete on orq.rate_limits to orq_ingest;

-- ---------------------------------------------------------------------------
-- RLS: as tabelas tem RLS ativo e nenhuma politica para anon/authenticated (0002).
-- O papel nao ignora RLS (nao tem BYPASSRLS), entao recebe politicas proprias, so para ele.
-- ---------------------------------------------------------------------------

create policy orq_ingest_select on orq.sources for select to orq_ingest using (true);

create policy orq_ingest_select on core.leads for select to orq_ingest using (true);
create policy orq_ingest_insert on core.leads for insert to orq_ingest with check (true);
create policy orq_ingest_update on core.leads for update to orq_ingest using (true) with check (true);

create policy orq_ingest_select on orq.touchpoints for select to orq_ingest using (true);
create policy orq_ingest_insert on orq.touchpoints for insert to orq_ingest with check (true);

create policy orq_ingest_select on orq.events for select to orq_ingest using (true);
create policy orq_ingest_insert on orq.events for insert to orq_ingest with check (true);

create policy orq_ingest_select on orq.decisions for select to orq_ingest using (true);
create policy orq_ingest_insert on orq.decisions for insert to orq_ingest with check (true);

create policy orq_ingest_all on orq.rate_limits for all to orq_ingest using (true) with check (true);
