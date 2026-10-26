-- 0023: Experimentos de growth. O Pablo cadastra o teste (hipotese, produto, canal, metrica, meta, periodo, orcamento e ICE) e o Studio
-- acompanha SOZINHO, lendo as visoes de analytics (a mesma base do Monitor): o resultado, a linha de base (o mesmo numero de dias antes
-- do inicio), o gasto e o ritmo contra o previsto nao sao digitados. Somente aditiva (CREATE). Dados de configuracao, sem dado pessoal.
-- "Remover" = cancelar (nada e apagado, regra do Data Hub): o Painel grava sem DELETE.
-- A metrica e o canal sao validados pelo Studio (catalogo em studio/lib/experimentos.ts), para novas metricas nao exigirem migration.

create table mkt.experimentos (
  id bigint generated always as identity primary key,
  titulo text not null check (btrim(titulo) <> '' and char_length(titulo) <= 160),
  hipotese text check (hipotese is null or char_length(hipotese) <= 2000),
  produto text not null check (produto in ('rh', 'clinic')),
  canal text not null default 'total' check (canal in ('total', 'pagos', 'google', 'meta', 'social', 'organico')),
  metrica text not null check (btrim(metrica) <> '' and char_length(metrica) <= 40),
  -- meta: total a atingir no periodo (metricas de contagem) ou valor a atingir (custos e taxas)
  meta numeric not null,
  -- linha_base nula = automatica (o Studio calcula com o mesmo numero de dias antes do inicio); preenchida = valor combinado
  linha_base numeric,
  orcamento numeric check (orcamento is null or orcamento >= 0),
  inicio date not null,
  fim date not null,
  status text not null default 'planejado' check (status in ('planejado', 'rodando', 'concluido', 'cancelado')),

  ice_impacto smallint check (ice_impacto between 1 and 10),
  ice_confianca smallint check (ice_confianca between 1 and 10),
  ice_facilidade smallint check (ice_facilidade between 1 and 10),
  ice_score numeric generated always as (
    case when ice_impacto is null or ice_confianca is null or ice_facilidade is null then null
         else round((ice_impacto + ice_confianca + ice_facilidade) / 3.0, 2) end
  ) stored,

  -- fotografia gravada quando o experimento e concluido (o resultado deixa de variar com dados novos)
  valor_final numeric,
  atingimento_final numeric,
  desfecho text check (desfecho in ('atingiu', 'parcial', 'nao_atingiu')),
  aprendizado text check (aprendizado is null or char_length(aprendizado) <= 4000),

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  check (fim >= inicio)
);
create index experimentos_status_idx on mkt.experimentos (status);
create index experimentos_metrica_idx on mkt.experimentos (metrica);

alter table mkt.experimentos enable row level security;
grant select, insert, update on mkt.experimentos to orq_panel;
create policy orq_panel_all on mkt.experimentos for all to orq_panel using (true) with check (true);
