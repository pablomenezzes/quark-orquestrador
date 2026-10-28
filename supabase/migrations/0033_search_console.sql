-- 0033: Google Search Console. Guarda, por marca, dia e pagina (e por consulta), cliques, impressoes e a posicao ponderada (pos_x_imp = posicao
-- media x impressoes, para somar varios dias e dividir depois). Alimenta a pagina SEO e os experimentos de SEO. Dados agregados, sem dado pessoal.
-- host + pagina sao a mesma chave do GA4 (hostName + pagePath), o que permite casar GSC, GA4 e Pipedrive por pagina.
-- Somente aditiva (CREATE). Nada em public, core, orq, crm, raw nem ops.

create table mkt.gsc_pagina_dia (
  marca text not null check (marca in ('rh', 'clinic')),
  dia date not null,
  host text not null,
  pagina text not null,                          -- so o caminho (sem parametros)
  cliques int not null,
  impressoes int not null,
  pos_x_imp numeric(16, 2) not null,             -- posicao media do dia x impressoes
  atualizado_em timestamptz not null default now(),
  primary key (marca, dia, host, pagina)
);
create index gsc_pagina_dia_idx on mkt.gsc_pagina_dia (dia);

-- ATENCAO: apesar do nome, `dia` aqui e o PRIMEIRO DIA DO MES (consultas agregadas por mes; por dia eram 1,9 milhao de linhas e 700 MB).
create table mkt.gsc_consulta_dia (
  marca text not null check (marca in ('rh', 'clinic')),
  dia date not null,
  host text not null,
  pagina text not null,
  consulta text not null,
  cliques int not null,
  impressoes int not null,
  pos_x_imp numeric(16, 2) not null,
  atualizado_em timestamptz not null default now(),
  primary key (marca, dia, host, pagina, consulta)
);
create index gsc_consulta_dia_idx on mkt.gsc_consulta_dia (dia);

alter table mkt.gsc_pagina_dia enable row level security;
alter table mkt.gsc_consulta_dia enable row level security;
grant select, insert, update on mkt.gsc_pagina_dia, mkt.gsc_consulta_dia to orq_sync;
create policy orq_sync_all on mkt.gsc_pagina_dia for all to orq_sync using (true) with check (true);
create policy orq_sync_all on mkt.gsc_consulta_dia for all to orq_sync using (true) with check (true);

create view analytics.gsc_pagina_dia as
select marca, dia, host, pagina, cliques, impressoes, pos_x_imp / nullif(impressoes, 0) as posicao from mkt.gsc_pagina_dia;
create view analytics.gsc_consulta_dia as
select marca, dia, host, pagina, consulta, cliques, impressoes, pos_x_imp / nullif(impressoes, 0) as posicao from mkt.gsc_consulta_dia;
grant select on analytics.gsc_pagina_dia, analytics.gsc_consulta_dia to orq_panel, orq_chat;
