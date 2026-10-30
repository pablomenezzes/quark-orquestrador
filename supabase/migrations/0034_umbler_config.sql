-- 0034: configuracao do painel Umbler (quais canais e bots sao do Marketing, preco do credito e amostra minima).
-- Uma unica linha com o JSON (so IDs, nomes, limites e precos: nenhum segredo, nenhum dado pessoal). Existe para o painel funcionar na
-- Vercel, que nao tem disco permanente; o Studio local usa a mesma linha, entao os dois enxergam a mesma configuracao.
-- Somente aditiva (CREATE). Nada em public, core, orq, crm, raw nem mkt. Grava apenas o papel do painel.

create table ops.cfg_umbler (
  chave text primary key check (chave = 'marketing'),
  config jsonb not null,
  atualizado_em timestamptz not null default now()
);

alter table ops.cfg_umbler enable row level security;
grant select, insert, update on ops.cfg_umbler to orq_panel;
create policy orq_panel_all on ops.cfg_umbler for all to orq_panel using (true) with check (true);
