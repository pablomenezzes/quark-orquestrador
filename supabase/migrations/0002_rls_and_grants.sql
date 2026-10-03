-- 0002: RLS ativo e privilegios (secoes 8 e 13 do orquestrador-marketing-quark.md, decisao D-09).
-- RLS ligado e NENHUMA politica para anon/authenticated: so a service key acessa.
-- A service_role tem BYPASSRLS no Supabase, entao nao precisa de politica.
-- Somente aditiva. Nada no schema public.

alter table core.leads enable row level security;
alter table orq.sources enable row level security;
alter table orq.touchpoints enable row level security;
alter table orq.events enable row level security;
alter table orq.rules enable row level security;
alter table orq.decisions enable row level security;
alter table crm.deals enable row level security;
alter table crm.stage_history enable row level security;

-- Defesa em profundidade: anon e authenticated sem nenhum acesso aos schemas do orquestrador.
revoke all on schema core, orq, crm from anon, authenticated;
revoke all on all tables in schema core, orq, crm from anon, authenticated;
revoke all on all functions in schema core, orq, crm from anon, authenticated;
alter default privileges in schema core, orq, crm revoke all on tables from anon, authenticated;
alter default privileges in schema core, orq, crm revoke all on functions from anon, authenticated;

-- A service_role (servidor do orquestrador) usa os schemas.
grant usage on schema core, orq, crm to service_role;
grant all on all tables in schema core, orq, crm to service_role;
alter default privileges in schema core, orq, crm grant all on tables to service_role;

-- orq.events e imutavel (principio 5): alem do trigger, a service_role nem recebe o privilegio.
revoke update, delete, truncate on orq.events from service_role;
