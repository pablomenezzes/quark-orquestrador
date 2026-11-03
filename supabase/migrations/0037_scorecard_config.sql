-- 0037: metricas que o Pablo acrescenta ao Scorecard do BI (uma linha com o JSON). So nomes de visoes/colunas de analytics e formulas: nenhum dado,
-- nenhum segredo. Somente aditiva (CREATE). Nada em public, core, orq, crm, raw nem mkt. Grava apenas o papel do painel (orq_panel).

create table ops.cfg_scorecard (
  chave text primary key check (chave = 'principal'),
  config jsonb not null,
  atualizado_em timestamptz not null default now()
);

alter table ops.cfg_scorecard enable row level security;
grant select, insert, update on ops.cfg_scorecard to orq_panel;
create policy orq_panel_all on ops.cfg_scorecard for all to orq_panel using (true) with check (true);
