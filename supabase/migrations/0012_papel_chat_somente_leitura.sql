-- 0012: papel orq_chat, usado pelo conector do Claude Desktop (servidor MCP local) para o Pablo conversar com os dados.
-- Principios: SOMENTE LEITURA (o banco recusa qualquer escrita, mesmo que a consulta tente), SO visoes de analytics, e NENHUM dado
-- pessoal: o que sai desse papel vai parar na conversa. Por isso:
--   * nao ve raw, crm, core, orq nem ops;
--   * nao ve analytics.pessoas, organizacoes, vinculos, usuarios, campos, deal_campos (nomes, empresas, campos livres);
--   * nas visoes de negocios, recebe so as COLUNAS que nao sao o titulo do negocio (o titulo costuma ser nome de pessoa).
-- A senha NAO esta aqui: e definida por scripts/set-role-password.mjs --role orq_chat. Somente aditiva. Nada em public, core nem orq.
create role orq_chat login nosuperuser nocreatedb nocreaterole noinherit noreplication connection limit 3;
alter role orq_chat set statement_timeout = '20s';
alter role orq_chat set idle_in_transaction_session_timeout = '20s';
alter role orq_chat set default_transaction_read_only = on;
grant orq_chat to postgres;   -- permite os testes assumirem o papel (SET ROLE), como nos outros papeis

grant usage on schema analytics to orq_chat;

-- visoes sem nenhum dado pessoal
grant select on analytics.deals_resumo, analytics.motivos_perda, analytics.contagem_status, analytics.pipelines_etapas,
                analytics.negocios_marcos, analytics.historico_etapas, analytics.historico_progresso, analytics.sync_saude,
                analytics.campo_opcoes to orq_chat;

-- visoes com o titulo do negocio: so as colunas SEM o titulo
grant select (deal_id, pipeline_id, pipeline, produto, stage_id, etapa, marco, status, valor, moeda, owner_id, responsavel,
              motivo_perda_id, motivo_perda, criado_em, fechado_em, perdido_em, atualizado_em, is_archived, is_deleted,
              conta_como_lead, is_mql) on analytics.deals to orq_chat;
grant select (deal_id, pipeline_id, pipeline, produto, stage_id, etapa, marco, status, valor, moeda, owner_id, responsavel,
              motivo_perda_id, motivo_perda, criado_em, fechado_em, perdido_em, atualizado_em, is_archived, is_deleted,
              conta_como_lead, is_mql, fonte_id, fonte, tipo_id, tipo, faixa_colab_id, faixa_colab, faixa_saude_id, faixa_saude,
              canal_rd, utm_source, sem_pessoa, sem_organizacao) on analytics.negocios_bi to orq_chat;
