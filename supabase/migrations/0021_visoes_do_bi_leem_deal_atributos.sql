-- 0021: as visoes do BI passam a ler crm.deal_atributos (tabela pequena, preenchida e atualizada a cada sincronizacao de negocios) em vez de reconstruir,
-- a CADA consulta, os campos de ~40 mil negocios a partir do JSON bruto (raw.pd_deals, 112 MB). Era a causa dos 5 a 18 s por analise e dos timeouts do D-56
-- (e do "toda vez que mudo a data demora": cada troca de periodo dispara de 4 a 12 analises que liam o JSON).
-- Somente `create or replace view` com as MESMAS colunas, na MESMA ordem e com os MESMOS tipos: nenhuma visao dependente muda, nenhuma permissao muda.
-- Nada e apagado e nenhuma tabela e alterada. As provas (valores iguais linha a linha) estao em tests/integration/visoes-deal-atributos.int.test.ts.

create or replace view analytics.negocios_bi as
with k as (
  select max(field_key) filter (where nome = 'Fonte do Lead') as fonte, max(field_key) filter (where nome = 'Tipo do Lead') as tipo,
         max(field_key) filter (where nome = 'Faixa de Colaboradores') as faixa_colab, max(field_key) filter (where nome = 'Faixa de profissionais da saúde') as faixa_saude
  from crm.field_definitions where entity = 'deal'
)
select d.deal_id, d.titulo, d.pipeline_id, d.pipeline, d.produto, d.stage_id, d.etapa, d.marco, d.status, d.valor, d.moeda, d.owner_id, d.responsavel,
       d.motivo_perda_id, d.motivo_perda, d.criado_em, d.fechado_em, d.perdido_em, d.atualizado_em, d.is_archived, d.is_deleted, d.conta_como_lead, d.is_mql,
       a.fonte_id, fo.opcao as fonte, a.tipo_id, tp.opcao as tipo, a.faixa_colab_id, fc.opcao as faixa_colab, a.faixa_saude_id, fs.opcao as faixa_saude,
       a.canal_rd, a.utm_source, cd.person_id is null as sem_pessoa, cd.org_id is null as sem_organizacao
from analytics.deals d
left join crm.deal_atributos a on a.deal_id = d.deal_id
left join crm.deals cd on cd.pipedrive_id = d.deal_id
left join analytics.campo_opcoes fo on fo.field_key = (select fonte from k) and fo.opcao_id = a.fonte_id
left join analytics.campo_opcoes tp on tp.field_key = (select tipo from k) and tp.opcao_id = a.tipo_id
left join analytics.campo_opcoes fc on fc.field_key = (select faixa_colab from k) and fc.opcao_id = a.faixa_colab_id
left join analytics.campo_opcoes fs on fs.field_key = (select faixa_saude from k) and fs.opcao_id = a.faixa_saude_id;

-- Lado CRM da relacao por URL: so o caminho normalizado e o host (a URL completa, que pode ter dados na query string, NAO sai).
create or replace view analytics.negocios_url as
select d.deal_id, d.produto, d.status, d.criado_em, d.conta_como_lead, d.is_mql, d.valor,
       mkt.caminho_url(a.url_conversao) as caminho_url, a.url_conversao is not null as tem_url, a.utm_campaign as utm_campaign, a.utm_medium as utm_medium,
       mkt.host_url(a.url_conversao) as host_url, mkt.host_url(a.url_conversao) is not null as url_valida
from analytics.deals d
join crm.deal_atributos a on a.deal_id = d.deal_id;

-- Criativos do Meta Ads (UTM Term) com o agrupamento DOR > Mensagem e Modulo (D-50).
create or replace view analytics.negocios_criativo as
with b as (
  select d.deal_id, d.criado_em, d.conta_como_lead, d.is_mql, d.status, d.valor, d.produto, a.utm_term as termo
  from analytics.negocios_bi d
  join crm.deal_atributos a on a.deal_id = d.deal_id
  where d.fonte = 'Marketing [Meta ADS]'
)
select b.deal_id, b.criado_em, b.conta_como_lead, b.is_mql, b.status, b.valor, b.produto, mkt.chave_criativo(b.termo) as termo_chave, b.termo,
       dor.id as dor_id, dor.nome as dor, ms.id as mensagem_id, ms.nome as mensagem, md.id as modulo_id, md.nome as modulo
from b
left join mkt.cri_mapa m on m.termo_chave = mkt.chave_criativo(b.termo)
left join mkt.cri_dor dor on dor.id = m.dor_id and dor.ativo
left join mkt.cri_mensagem ms on ms.id = m.mensagem_id and ms.ativo and dor.id is not null
left join mkt.cri_modulo md on md.id = m.modulo_id and md.ativo
where b.termo is not null;
