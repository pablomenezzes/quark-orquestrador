-- 0035: dados da Umbler guardados no banco (importacao a partir de jul/2026), para o relatorio nao depender de consultar a API a cada abertura.
-- Sem dado pessoal: nada de nome, telefone, e-mail, texto de mensagem nem ID de conversa. Guarda sessoes de envio (totais), o catalogo de templates
-- e UMA LINHA POR MENSAGEM DE TEMPLATE enviada (ID opaco da mensagem, template, dia e tres indicadores de interacao em ate 24 h).
-- Somente aditiva (CREATE). Nada em public, core, orq, crm, raw nem mkt. Grava apenas o papel do painel (orq_panel).

create table ops.umbler_sessao (
  id text primary key,                         -- ID da sessao de envio na Umbler
  organizacao_id text not null,
  criada_em timestamptz not null,
  dia date not null,                           -- dia no horario de Sao Paulo
  titulo text,
  tipo text check (tipo in ('Template', 'Bot')),
  canal_id text,
  canal_nome text,
  bot_id text,
  bot_nome text,
  gatilho text,
  modelo_id text,
  modelo_nome text,
  modelo_categoria text,
  enviadas int,
  lidas int,
  respondidas_formulario int,                  -- so existe para envios com formulario (WhatsApp Flow)
  falhas int,
  creditos bigint,                             -- custo registrado pela Umbler; null = sem registro
  custo_situacao text not null default 'nao_consultado' check (custo_situacao in ('registrado', 'sem_registro', 'falhou', 'nao_consultado')),
  linhas_custo jsonb,                          -- cobrancas (tipo, template, mensagens, creditos)
  paradas jsonb,                               -- motivos de parada dos fluxos
  bruto jsonb,                                 -- detalhe e custo originais, sem dado pessoal (nada e descartado na origem)
  scan_cursor int not null default 0,          -- quantas conversas da sessao ja foram olhadas
  scan_total int,
  scan_completo boolean not null default false,
  scan_em timestamptz,
  atualizado_em timestamptz not null default now()
);
create index umbler_sessao_dia_idx on ops.umbler_sessao (canal_id, dia);

create table ops.umbler_mensagem (
  id text primary key,                         -- ID opaco da mensagem de template na Umbler (evita contar duas vezes)
  sessao_id text not null references ops.umbler_sessao (id),
  canal_id text,
  bot_id text,
  template_id text,
  enviado_em timestamptz not null,
  dia date not null,
  respondeu_24h boolean not null default false,    -- o contato mandou qualquer mensagem em ate 24 h
  clicou_24h boolean not null default false,       -- o contato respondeu por botao/lista em ate 24 h
  humano_24h boolean not null default false,       -- um atendente escreveu em ate 24 h
  atualizado_em timestamptz not null default now()
);
create index umbler_mensagem_dia_idx on ops.umbler_mensagem (canal_id, dia);
create index umbler_mensagem_sessao_idx on ops.umbler_mensagem (sessao_id);

create table ops.umbler_template (
  id text primary key,
  nome text not null,
  categoria text,
  status text,
  atualizado_em timestamptz not null default now()
);

create table ops.umbler_importacao (
  id bigserial primary key,
  iniciada_em timestamptz not null default now(),
  finalizada_em timestamptz,
  desde date not null,
  canal_id text,
  resumo jsonb,
  erro text
);

alter table ops.umbler_sessao enable row level security;
alter table ops.umbler_mensagem enable row level security;
alter table ops.umbler_template enable row level security;
alter table ops.umbler_importacao enable row level security;
grant select, insert, update on ops.umbler_sessao, ops.umbler_mensagem, ops.umbler_template, ops.umbler_importacao to orq_panel;
grant usage, select on sequence ops.umbler_importacao_id_seq to orq_panel;
create policy orq_panel_all on ops.umbler_sessao for all to orq_panel using (true) with check (true);
create policy orq_panel_all on ops.umbler_mensagem for all to orq_panel using (true) with check (true);
create policy orq_panel_all on ops.umbler_template for all to orq_panel using (true) with check (true);
create policy orq_panel_all on ops.umbler_importacao for all to orq_panel using (true) with check (true);
