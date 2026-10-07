-- 0005: regras de negocio do funil (ajuste da Entrega 1, a pedido do Pablo em 2026-10-07).
--  1) Ganho / perdido / aberto / excluido vem SO do campo Status do negocio, nunca da etapa.
--     => etapa so guarda "ate onde o negocio chegou" (sql, reuniao, proposta).
--  2) MQL nao e etapa: e todo negocio que NAO foi perdido por um motivo marcado em ops.cfg_motivo_perda
--     (inicialmente 398, 185, 184 e 587). Os IDs sao os da opcao do campo "Motivo da perda" (lost_reason).
--  3) Cada status (open, won, lost, deleted) tem uma chave "conta como lead?" editavel no Painel.
-- Somente aditiva (sem DROP): a restricao antiga de cfg_stage_marco continua; esta apenas a estreita.
-- Nada no schema public. Nada em core nem orq.

alter table ops.cfg_stage_marco
  add constraint cfg_stage_marco_chegou_ate check (marco is null or marco in ('sql','reuniao','proposta'));

create table ops.cfg_motivo_perda (
  reason_id bigint primary key,             -- id original da opcao em "Motivo da perda" (lost_reason)
  exclui_mql boolean not null,              -- true = perdido por este motivo NAO conta como MQL
  atualizado_em timestamptz not null default now()
);
create table ops.cfg_status_contagem (
  status text primary key check (status in ('open','won','lost','deleted')),
  conta_como_lead boolean not null,         -- false = fica fora da contagem de leads
  atualizado_em timestamptz not null default now()
);

-- valores iniciais definidos pelo Pablo; "excluido" comeca FORA da contagem (e editavel no Painel)
insert into ops.cfg_motivo_perda (reason_id, exclui_mql) values (398, true), (185, true), (184, true), (587, true);
insert into ops.cfg_status_contagem (status, conta_como_lead) values ('open', true), ('won', true), ('lost', true), ('deleted', false);

alter table ops.cfg_motivo_perda enable row level security;
alter table ops.cfg_status_contagem enable row level security;

grant select on ops.cfg_motivo_perda, ops.cfg_status_contagem to orq_sync;
create policy orq_sync_read on ops.cfg_motivo_perda for select to orq_sync using (true);
create policy orq_sync_read on ops.cfg_status_contagem for select to orq_sync using (true);

grant select, insert, update on ops.cfg_motivo_perda, ops.cfg_status_contagem to orq_panel;
create policy orq_panel_all on ops.cfg_motivo_perda for all to orq_panel using (true) with check (true);
create policy orq_panel_all on ops.cfg_status_contagem for all to orq_panel using (true) with check (true);

-- Todos os motivos de perda que o Pipedrive oferece hoje (ID + nome juntos), com a sua marcacao.
-- Um ID marcado que o Pipedrive removeu depois continua aparecendo (nome nulo), para nada sumir da conta.
create view analytics.motivos_perda as
with opcoes as (
  select (o->>'id')::bigint as reason_id, o->>'label' as motivo
  from crm.field_definitions f
  cross join lateral jsonb_array_elements(case when jsonb_typeof(f.opcoes) = 'array' then f.opcoes else '[]'::jsonb end) o
  where f.entity = 'deal' and f.field_key = 'lost_reason'
)
select coalesce(o.reason_id, c.reason_id) as reason_id,
       o.motivo,
       coalesce(c.exclui_mql, false) as exclui_mql
from opcoes o
full join ops.cfg_motivo_perda c on c.reason_id = o.reason_id;

create view analytics.contagem_status as
select status, conta_como_lead from ops.cfg_status_contagem;

grant select on analytics.motivos_perda, analytics.contagem_status to orq_panel;
