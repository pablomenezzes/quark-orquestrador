-- 0022: arquivo COMPRIMIDO do historico do Google Analytics (pedido do Pablo, 2026-10-21). Somente aditiva (nenhum DROP, nenhum DELETE nem UPDATE concedido).
-- O historico dos meses FECHADOS (35 dias depois do fim do mes) do GA4 e guardado UMA VEZ, em gzip (uma linha JSON por registro), nesta tabela:
-- se o Google Analytics apagar dados antigos, ou uma tabela de trabalho for perdida, o mes volta com `scripts/ga4-restaurar.ts`. Quem arquiva so INSERE
-- (nunca regrava o que ja foi arquivado) e a sincronizacao do GA4 nunca relê esses meses: ela so revisa os ultimos dias.
create table mkt.ga4_arquivo (
  tabela text not null check (tabela in ('ga4_sessoes_dia', 'ga4_eventos_dia', 'ga4_paginas_dia', 'ga4_dia', 'ga4_ads_dia')),
  mes text not null check (mes ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  linhas integer not null check (linhas >= 0),
  bytes_originais integer not null check (bytes_originais >= 0),   -- tamanho do texto antes de comprimir
  sha256 text not null,                                            -- do texto (NDJSON) antes de comprimir: confere a integridade na restauracao
  dados bytea not null,                                            -- gzip do NDJSON
  criado_em timestamptz not null default now(),
  primary key (tabela, mes)
);
alter table mkt.ga4_arquivo enable row level security;
grant select, insert on mkt.ga4_arquivo to orq_sync;
create policy orq_sync_read on mkt.ga4_arquivo for select to orq_sync using (true);
create policy orq_sync_insert on mkt.ga4_arquivo for insert to orq_sync with check (true);

-- Para o Painel: o que ja esta arquivado, sem os dados comprimidos (so os totais).
create view analytics.ga4_arquivo_resumo as
select tabela, mes, linhas, bytes_originais, octet_length(dados) as bytes_comprimidos, criado_em from mkt.ga4_arquivo;
grant select on analytics.ga4_arquivo_resumo to orq_panel;
