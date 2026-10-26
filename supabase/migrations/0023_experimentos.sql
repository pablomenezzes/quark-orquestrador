-- 0023: Experimentos de growth. Cadastro, documentacao e monitoramento num lugar so (substitui as planilhas "Growth e Experimentos"): o Pablo
-- cadastra a ideia ou o teste (hipotese, responsavel, produto, canal, resultado esperado, metrica chave, meta, periodo, investimento e ICE) e o
-- Studio acompanha SOZINHO, lendo as visoes de analytics (a mesma base do Monitor): o resultado, a linha de base (o mesmo numero de dias antes
-- do inicio), o gasto e o ritmo contra o previsto nao sao digitados. Somente aditiva (CREATE). Dados de configuracao, sem dado pessoal.
-- "Remover" = cancelar (nada e apagado, regra do Data Hub): o Painel grava sem DELETE.
-- A metrica e o canal sao validados pelo Studio (catalogo em studio/lib/experimentos.ts), para novas metricas nao exigirem migration.
-- Ideias e melhorias antigas nao tem metrica nem periodo: por isso metrica, meta, inicio e fim sao opcionais (acompanhamento automatico so com os quatro).

create table mkt.experimentos (
  id bigint generated always as identity primary key,
  titulo text not null check (btrim(titulo) <> '' and char_length(titulo) <= 160),
  tipo text not null default 'experimento' check (tipo in ('experimento', 'ideia', 'melhoria', 'documentacao')),
  responsavel text check (responsavel is null or char_length(responsavel) <= 120),
  area_impacto text check (area_impacto is null or char_length(area_impacto) <= 80),
  hipotese text check (hipotese is null or char_length(hipotese) <= 2000),
  resultado_esperado text check (resultado_esperado is null or char_length(resultado_esperado) <= 2000),
  produto text not null default 'rh' check (produto in ('rh', 'clinic')),
  canal text not null default 'total' check (canal in ('total', 'pagos', 'google', 'meta', 'social', 'organico')),
  -- metrica chave e a meta dela: total a atingir no periodo (metricas de contagem) ou valor a atingir (custos e taxas). Nulas = sem acompanhamento automatico
  metrica text check (metrica is null or (btrim(metrica) <> '' and char_length(metrica) <= 40)),
  meta numeric,
  -- linha_base nula = automatica (o Studio calcula com o mesmo numero de dias antes do inicio); preenchida = valor combinado
  linha_base numeric,
  -- investimento previsto (R$); o gasto real vem das visoes de analytics
  investimento numeric check (investimento is null or investimento >= 0),
  inicio date,
  fim date,
  status text not null default 'backlog' check (status in ('backlog', 'planejado', 'rodando', 'bloqueado', 'concluido', 'cancelado')),
  -- avaliacao manual de quem conduziu (a planilha antiga); o desfecho abaixo e o calculado pela meta
  avaliacao text check (avaliacao is null or avaliacao in ('sucesso', 'falha', 'inconclusivo')),
  evidencias text check (evidencias is null or char_length(evidencias) <= 4000),

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

  -- documentacao: HTML do editor do Studio (texto livre + relatorio visual diario, semanal e geral); gravado a parte da lista
  documentacao text check (documentacao is null or char_length(documentacao) <= 400000),

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  check (fim is null or inicio is null or fim >= inicio),
  check ((metrica is null) = (meta is null))
);
create index experimentos_status_idx on mkt.experimentos (status);
create index experimentos_metrica_idx on mkt.experimentos (metrica);

alter table mkt.experimentos enable row level security;
grant select, insert, update on mkt.experimentos to orq_panel;
create policy orq_panel_all on mkt.experimentos for all to orq_panel using (true) with check (true);
