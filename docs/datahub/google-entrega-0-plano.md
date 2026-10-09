# Data Hub Google: GA4 + Google Ads. Entrega 0 (plano, sem código)

> **Status em 2026-10-09:** o plano foi aprovado e o GA4 já foi entregue: G1 e G2 (carga desde 2025-01-01, 218 mil linhas mais 646 dias de totais), a aba "Conversões do site" no Painel e a página "Site e páginas" do BI (migrations `0013` e `0014`), com a sincronia a cada 4 h. **Desvios do plano abaixo:** (1) as tabelas finais são `mkt.ga4_dia`, `ga4_sessoes_dia`, `ga4_eventos_dia`, `ga4_paginas_dia` e `conversao_regras` (ver seção 8.3 do MD); (2) cada entrega ficou menor que o estimado: as 3 semanas viraram 2 dias para o GA4; (3) a ligação com o CRM é por **domínio + caminho** (a "URL de Conversão" mistura domínios); (4) eventos automáticos de alto volume ficam fora de `ga4_eventos_dia`. **Pendente:** G3 a G7 (custo do Google Ads, ligação por campanha, página "Site e Anúncios"), que dependem dos IDs do Google Ads e do developer token. Registro: D-45, D-46 e D-47 do MD.

Pedido do Pablo (2026-10-08): trazer os dados do **Google Analytics** (páginas e sessões/novos usuários, com foco em **conectar pela URL as conversões em site e LPs**) e os dados de **Google Ads** (investimento) para dentro do banco, para cruzar com o Pipedrive no BI e no conector do Claude.

Mesmas regras do Data Hub do Pipedrive: **só leitura** nas APIs do Google, dado real permitido (dado de teste não), **nada descartado**, **ID e nome juntos**, **documentação atual da API antes de cada entidade**, **economia de espaço (D-40)**, definição de pronto de toda entrega (testes, conferência com o Google, tela, roteiro de até 5 passos, MD + commit + push) e **parar e aguardar o "conferido"**.

## 1. O que o Pablo vai poder fazer ao final

1. Ver, por **página/URL** (site e LPs), por **dia**, por **fonte/mídia/campanha**: sessões, usuários novos, usuários ativos, sessões engajadas, visualizações e **conversões (eventos-chave)**.
2. Ver o **investimento do Google Ads** (custo, cliques, impressões, conversões) por **campanha e dia**.
3. **Cruzar com o CRM**: por URL (a "URL de Conversão" do negócio) e por campanha (UTM campaign), chegando a **CPL, custo por MQL, CAC e ROAS por campanha e por página**.
4. Perguntar tudo isso ao Claude no Claude Desktop (o conector `quark-dados` ganha as visões novas) e ver no BI (página nova **"Site e Anúncios"**).

## 2. O que a documentação atual diz (consultada em 2026-10-08)

### GA4 Data API (somente leitura)
- **Cotas por propriedade (oficial):** 200.000 tokens/dia, 40.000/hora e **14.000/hora por projeto**; 10 requisições simultâneas; a maioria das requisições custa 10 tokens ou menos; mais linhas, mais dimensões, intervalos longos e dimensões de alta cardinalidade (como `pagePath`) custam mais. A cota diária zera à meia-noite do Pacífico. Hora/dia sobram para o nosso uso (algumas dezenas de requisições por rodada).
- **Dimensões e métricas** (nomes a **confirmar pelo metadata da própria propriedade**, `getMetadata`, e por `checkCompatibility` antes de cada relatório): `landingPage`, `pagePath`, `hostName`, `sessionSource`, `sessionMedium`, `sessionCampaignName`/`Id`, `sessionGoogleAdsCampaignName`/`Id`, `date`; métricas `sessions`, `newUsers`, `activeUsers`, `engagedSessions`, `screenPageViews`, `keyEvents` (substituiu o antigo `conversions` na interface; **confirmar qual nome a API aceita hoje**). Fontes oficiais incompletas na leitura de hoje: a página do schema veio truncada; confirmar no metadata.
- **Conversão por página só em relatório separado:** eventos (`eventName`, `isKeyEvent`) e métricas de sessão não combinam em qualquer relatório; por isso o desenho usa **relatórios separados** (sessões por página, e eventos-chave por página) e o `checkCompatibility`.
- **Custo do Google Ads pelo GA4** (`advertiserAdCost`, `advertiserAdClicks`, `advertiserAdImpressions`): existe **quando o Google Ads está vinculado ao GA4** e **exige uma dimensão de campanha** (relato de fontes secundárias, a confirmar na propriedade). Serve de **ponte** enquanto o developer token da API do Google Ads não sai.
- Limites úteis: dados agregados do GA4 podem sofrer **limiar (thresholding)** e **modelagem do Consent Mode** (parte dos usuários sem consentimento não aparece); usuários **não são somáveis entre dias** (um usuário ativo em 3 dias conta 3 vezes se somado); usamos usuários novos e sessões, que são aditivos.

### Google Ads API (somente leitura)
- **Developer token** (obrigatório): níveis **Explorer** (automático, até **2.880 operações/dia** em produção), **Basic** (15.000/dia, por solicitação; relatos de **2 a 5 dias úteis** e fila de análise) e **Standard** (ilimitado). Para nosso uso (uma consulta de relatório por campanha-dia por rodada) **Explorer ou Basic bastam**. O token **só se obtém numa conta de administrador (MCC)** no Centro de API.
- **Versões:** a API lança versão nova com frequência e cada uma vive cerca de um ano (a v20 já foi desligada em junho de 2026 e a v22 está para sair em outubro de 2026; a mais nova achada foi a v25). **Vamos fixar uma versão numa constante e criar um teste/aviso** para trocá-la antes do desligamento.
- **GAQL:** `campaign` com `metrics.cost_micros`, `metrics.clicks`, `metrics.impressions`, `metrics.conversions`, `metrics.conversions_value` e `segments.date`. O custo vem em **micros** (milionésimos da moeda da conta). `click_view` (com **gclid**) só aceita **um dia por consulta** e olha no máximo **90 dias para trás**: serve para ligar um clique a um lead, em consulta separada.
- **Autorização:** OAuth com o usuário que tem acesso à conta (escopo `adwords`; a restrição a "somente leitura" é do **nível de acesso do usuário na conta**: dar acesso **"Somente leitura"** a quem autorizar, ou ao e-mail do projeto).

## 3. Como ligar o Google ao CRM (o ponto central)

O GA4 entrega **números agregados** (não há usuário nem lead individual na API), então a ligação com o CRM é **por chaves**, não por pessoa:

| Chave | Lado Google | Lado CRM (Pipedrive) | Cobertura real hoje (negócios de 2026) |
|---|---|---|---|
| **URL** | `hostName` + `landingPage` (ou `pagePath`) normalizados | campo **"URL de Conversão"** | **14,9%** (1.703 de 11.410): útil, mas parcial |
| **Campanha** | `sessionCampaignName` / `sessionGoogleAdsCampaignId`; Ads: `campaign.id` e `campaign.name` | **UTM CAMPAIGN** (por convenção do Google: `utm_campaign={campaignid}`) | **76,6%** |
| **Fonte e mídia** | `sessionSource` / `sessionMedium` | **UTM Source** (44,3%), **UTM Medium** (78,9%), "Canal de origem RD" (96,1%) | boa |
| **Dia** | `date` | data de criação do negócio | 100% |
| **Conversão do formulário** | evento-chave por página | "Identificador de Conversão RD" (96,3%) | boa, a interpretar na Entrega G5 |

**Fatos que mudam o plano:** (a) **a maior parte dos leads de 2026 vem de formulário nativo do Meta** (as campanhas "[Form Nativo]" dominam os UTMs): **o GA4 não enxerga esses leads**; o cruzamento por URL cobre o **site e as LPs**, e o Meta fica para o outro comando (dados de mídia do Meta); (b) o cruzamento é **por campanha e por URL em grupo**, não por lead; (c) o **orquestrador** (touchpoints com `landing_url`, `gclid` e `ga_client_id`) é o que, no futuro, liga **cada lead** à sua sessão e clique, porque já guarda esses campos; hoje só há leads de teste nele. Para ligação lead a lead no GA4 há ainda a **exportação gratuita do GA4 para o BigQuery**, que a seção 12.3 já prevê ligar "desde já" (**ela só guarda dados a partir de quando é ligada**: ligar logo é barato e vale a pena).

## 4. Tabelas propostas (nada aplicado)

Seguem o padrão do Data Hub: papel `orq_sync` grava (sem apagar), `orq_panel` e `orq_chat` só leem **visões** de `analytics`. Os dados do Google **não têm dados pessoais**, então as visões novas podem ir também para o conector do Claude (migration própria, com a sua confirmação). Segue a seção 8.3 do MD (schema `mkt`), com ajustes.

```sql
-- GA4 (uma propriedade pode ter varios sites; property_id e host separam)
create table mkt.ga4_sessoes_dia (            -- sessoes e usuarios por pagina de entrada, fonte, midia e campanha
  property_id bigint not null, dia date not null,
  host text not null, landing_page text not null,                 -- URL normalizada (ver funcao abaixo)
  fonte text not null, midia text not null,                       -- sessionSource / sessionMedium
  campanha_id text, campanha text,                                -- sessionCampaignId / sessionCampaignName
  gads_campanha_id text,                                          -- sessionGoogleAdsCampaignId
  sessoes int not null, usuarios_novos int not null, sessoes_engajadas int not null, visualizacoes int not null,
  primary key (property_id, dia, host, landing_page, fonte, midia, campanha)
);
create table mkt.ga4_conversoes_dia (         -- eventos-chave por pagina (relatorio separado: eventName nao combina com tudo)
  property_id bigint not null, dia date not null, host text not null, landing_page text not null,
  fonte text not null, midia text not null, campanha text, evento text not null,   -- ex.: generate_lead, diagnostico_concluido
  eventos_chave int not null, primary key (property_id, dia, host, landing_page, fonte, midia, campanha, evento)
);
create table mkt.ga4_paginas_dia (            -- paginas vistas (nao so a de entrada)
  property_id bigint not null, dia date not null, host text not null, pagina text not null,
  visualizacoes int not null, usuarios_ativos int not null, primary key (property_id, dia, host, pagina)
);
-- Google Ads (custo em micros, como a API devolve; a view converte)
create table mkt.gads_campanhas (customer_id bigint not null, campaign_id bigint not null, nome text, tipo text, status text, produto text, primary key (customer_id, campaign_id));
create table mkt.gads_campanha_dia (
  customer_id bigint not null, campaign_id bigint not null, dia date not null,
  impressoes bigint not null, cliques bigint not null, custo_micros bigint not null, conversoes numeric not null, valor_conversoes numeric not null,
  primary key (customer_id, campaign_id, dia)
);
-- controle: reaproveita ops.sync_jobs / sync_checkpoints / sync_errors / api_usage_daily do Data Hub (entidades ga4_sessoes, ga4_conversoes, ga4_paginas, gads_campanhas, gads_campanha_dia)
-- função que normaliza URL dos dois lados: minusculas, sem "www.", sem query string e fragmento, sem barra final
create function mkt.url_normalizada(u text) returns text language sql immutable as $$ ... $$;
```

**Views (analytics)**, todas sem dado pessoal: `site_paginas` (sessões, novos usuários, conversões e taxa por URL e dia), `site_conversoes_url` (evento-chave por URL e fonte), `ads_campanhas` (custo em reais, cliques, CPC, conversões do Ads), **`ads_vs_crm`** (por campanha: custo, leads, MQL, ganhos, valor ganho, **CPL, custo por MQL, CAC e ROAS**, ligando `gads_campanhas.campaign_id` ao UTM campaign dos negócios) e **`url_vs_crm`** (por URL normalizada: sessões e conversões do GA4, leads e ganhos do CRM com aquela "URL de Conversão").

**Economia de espaço (o banco está em 126 MB de 500 MB):** (1) **medir antes**: na Entrega G1 conto quantas linhas por dia a propriedade gera e só então fecho a retenção; (2) **orçamento de até 60 MB** para tudo do Google; (3) nomes de campanha repetidos (os do Meta passam de 60 caracteres) vão para **tabelas de dicionário** em vez de repetir em cada linha; (4) caudas longas (páginas com 1 sessão) podem ser agrupadas em "(outras)" se estourar o orçamento, **com a sua aprovação**; (5) sem JSON duplicado: os próprios números agregados são o "original" (o GA4 e o Ads devolvem dados já agregados).

## 5. Entregas (cada uma só termina com a definição de pronto e o "conferido")

| # | Entrega | O que | Depende de | Esforço |
|---|---|---|---|---|
| G0 | **Este plano** | Sem código | aprovação do Pablo | feito |
| G1 | **GA4: sessões e páginas** | Conexão (service account, só leitura), metadata da propriedade, sessões e novos usuários por página, fonte, mídia e campanha, desde 2025-01-01 (retomável, depois só o que mudou, com janela de revisão dos últimos dias porque o GA4 ajusta números), conferência com o relatório do GA4, aba no Painel | credenciais do GA4 | 2 a 3 dias |
| G2 | **GA4: conversões por URL** | Eventos-chave por página/fonte/campanha (`generate_lead`, `diagnostico_concluido` e os que existirem), taxa de conversão por URL | G1 | 1 a 2 dias |
| G3 | **Custo do Google Ads, ponte pelo GA4** | `advertiserAdCost` etc. por campanha e dia (se o Ads estiver vinculado ao GA4), já cruzado com o CRM; marcado como "pela ponte do GA4" | G1 | 1 dia |
| G4 | **Google Ads API (definitivo)** | Contas, campanhas e `campaign` por dia (custo, cliques, impressões, conversões), versão fixa da API com aviso de desligamento, conferência com o painel do Ads | developer token + OAuth | 2 a 3 dias |
| G5 | **Ligação com o CRM** | Normalização de URL e campanha dos dois lados, views `ads_vs_crm` e `url_vs_crm`, relatório de cobertura (quanto casa e quanto fica sem ligação, e por quê) | G2 e G4 (ou G3) | 2 a 3 dias |
| G6 | **Automação e telas** | Entra no workflow de 4 em 4 horas (GitHub Actions, junto da Entrega 6 do Pipedrive), alerta de atraso, página **"Site e Anúncios"** no BI e as visões no conector do Claude (migration do `orq_chat`) | Entrega 6 do Pipedrive | 2 a 3 dias |
| G7 | **Primeiras análises** | Funil por página, CPL e CAC por campanha, ROAS, conversão por LP, qualidade do tráfego por fonte | G5 | 2 dias |

Total: **cerca de 2,5 a 3,5 semanas de trabalho**, que cabem em paralelo ao restante do cronograma (a frente do Data Hub, depois da sincronização automática do Pipedrive). O gargalo é obter as credenciais, **principalmente o developer token do Google Ads (2 a 5 dias úteis, com fila)**, por isso **pedir o token já** destrava G4 e também a Fase 7 do orquestrador (conversões offline).

## 6. O que preciso do Pablo (nada secreto, e nenhum segredo no chat)

**GA4 (para G1 a G3):**
1. O **ID da propriedade do GA4** (um número; em Admin > Configurações da propriedade) e **quais sites/LPs ela cobre**.
2. Criar uma **conta de serviço** (um "usuário-robô" do Google) e dar a ela **acesso de Leitor** à propriedade. Eu preparo um roteiro de até 5 cliques; o arquivo de chave que o Google baixar **nunca vai para o chat**: um script o guarda no `.env.local` (com campo escondido), como fizemos com a senha do banco.

**Google Ads (para G3 a G5):**
3. O **ID da conta do Google Ads** (10 dígitos) e, se existir, o ID da **conta de administrador (MCC)**.
4. **Pedir o developer token** na conta de administrador (Centro de API). Eu escrevo o texto de descrição de uso (somente leitura, relatórios internos). Enquanto não sai, G3 entrega o custo pela ponte do GA4.
5. **Autorizar o acesso**: um login seu no Google, por um script local, com o escopo do Google Ads; use um usuário com acesso **"Somente leitura"** à conta para garantir que nada possa ser alterado.

## 7. Decisões que peço agora

1. **Aprova o plano** (entregas G1 a G7 e a ligação por URL e por campanha, sabendo que o Meta nativo fica de fora do GA4)?
2. **Período:** desde **2025-01-01**, como no Pipedrive?
3. **Ligar a exportação do GA4 para o BigQuery agora** (grátis, só guarda dali em diante e permitiria, no futuro, ligar lead a lead)? É um clique no GA4; eu só uso depois, se você decidir.
4. **Ordem no cronograma:** sugiro G1 a G3 logo depois da sincronização automática do Pipedrive (S1), e G4 a G7 conforme o token sair.

## 8. Riscos e limites

- **GA4 não vê quem não deu consentimento** (Consent Mode) e pode **ajustar números por até 2 a 3 dias**: por isso a janela de revisão dos últimos dias a cada rodada.
- **Os números do GA4 não vão bater 100% com os do CRM** (atribuição diferente, bloqueadores, formulário nativo): o relatório de cobertura da G5 mostra quanto casa.
- **Custo do Ads pelo GA4** pode diferir do painel do Ads (fuso, moeda, vinculação): a G4 é a fonte definitiva.
- **A API do Google Ads muda de versão e desliga versões antigas:** versão fixa em constante, teste e aviso.
- **Developer token pode demorar ou ser negado:** a ponte da G3 cobre o custo nesse meio-tempo.
- **Espaço:** orçamento de 60 MB e medição antes de fechar a retenção.
