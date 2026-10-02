# Orquestrador de Marketing Quark

Instruções do projeto para desenvolvimento com o Claude Code.

## 1. Contexto

A Quark Tecnologia comercializa dois SaaS: **QuarkRH** (gestão de pessoas, foco principal) e **QuarkClinic** (gestão de clínicas). Hoje a captação de leads é fragmentada:

- Landing pages e site no **Elementor** (WordPress)
- Uma landing page em código na **Vercel**
- Diagnóstico de maturidade de RH no **Lovable** (banco nativo do Lovable Cloud)
- Outro diagnóstico no **Fillout**
- **Formulários nativos da Meta** (Lead Ads)

Cada fonte tem automações próprias no Make que criam deals no **Pipedrive** e disparam mensagens na **Umbler** (WhatsApp).

### Problemas a resolver

1. Regras de negócio espalhadas em várias automações. Uma mudança no Pipedrive exige alterar vários cenários.
2. Atribuição digitada à mão (ex: "mídia paga" fixo na automação), mesmo quando o lead chega por outro canal.
3. Custo variável do Make, que cresce por operação.
4. Todo formulário cria deal. Não existe qualificação automática antes do SDR.
5. Dados de CRM, anúncios, GA4 e Search Console não se cruzam.

## 2. Objetivo

Construir um sistema próprio, centralizado e versionado, que:

- Receba leads de **todas** as fontes por **uma única porta de entrada**
- Rastreie a origem de forma automática e correta
- Decida o que fazer com cada lead a partir de **regras configuráveis em um só lugar**
- Execute ações no Pipedrive e na Umbler por **adaptadores isolados**
- Sirva de base para um **dashboard** que cruza gasto de mídia, tráfego, SEO e receita

## 3. Princípios inegociáveis

1. **Nenhuma fonte fala direto com o Pipedrive ou com a Umbler.** Todas falam só com o orquestrador.
2. **O navegador captura identificadores. O servidor envia conversões.**
3. **Canal é derivado por regra, nunca digitado.**
4. **Regras são dados, não código.** Ficam em tabela, com prioridade e versão.
5. **Eventos são imutáveis.** Nunca editar nem apagar registros de `orq_events`.
6. **O caminho crítico (lead entra, regra decide, ação executa) nunca depende das tabelas de marketing.** Falha em sincronização de anúncios não pode impedir a entrada de leads.
7. **Toda mudança passa primeiro pelo ambiente de testes.**

## 4. Stack

| Camada | Tecnologia |
|---|---|
| Banco de dados | Supabase (Postgres) |
| Funções do orquestrador | Vercel (serverless functions) ou Supabase Edge Functions |
| Tarefas agendadas | Vercel Cron ou pg_cron |
| Rastreamento web | Google Tag Manager (container web único) |
| CRM | Pipedrive (API) |
| Mensageria | Umbler (API) |
| Código | GitHub, desenvolvido com Claude Code |

### Ambientes

- **Projeto Supabase 1: produção.**
- **Projeto Supabase 2: testes**, mesma estrutura, dados falsos. Toda migration e regra nova roda aqui antes.

### Atenção ao plano gratuito do Supabase

- Sem backup automático. Fazer dump periódico até migrar para o plano pago.
- Armazenamento limitado. Dados de marketing entram **agregados por dia**, nunca eventos brutos.
- Projetos podem ser pausados por inatividade.
- **Migrar produção para o plano pago antes de desligar o Make.**

## 5. Arquitetura

```
Fontes (Elementor, Vercel, Lovable, Fillout, Meta Lead Ads)
        |
Script de atribuição (navegador, via GTM)
        |
Adaptadores de entrada (um por tipo de fonte)
        |
Endpoint único -> normaliza para o contrato de dados
        |
Identificação e deduplicação do lead
        |
Motor de regras
        |
Ações: criar deal | marcar evento no deal | convidar ao diagnóstico | validar lead
        |
Adaptadores de saída: Pipedrive | Umbler | Meta CAPI | Google Ads offline
        |
Banco de eventos (fonte da verdade)
```

### Ciclo do diagnóstico

O diagnóstico funciona como **qualificador**, não como porta de entrada. Quando uma regra envia o lead ao diagnóstico, o link carrega o identificador (`?lid=<lead_id>`). As respostas e o score voltam ao endpoint vinculados ao lead existente, sem duplicar. O score atualiza o deal, muda estágio ou libera a criação do deal.

## 6. Adaptadores de entrada

| Fonte | Como entra | Atribuição |
|---|---|---|
| Elementor | Ação de webhook nativa do Elementor Pro | Script no cabeçalho do WordPress preenche campos ocultos |
| Vercel | `fetch` direto para o endpoint | Script embutido na página |
| Lovable | `fetch` no envio, com `lid` e score | Script embutido; `lid` lido da URL |
| Fillout | Webhook do Fillout | Script repassa UTMs, `lid` e IDs como parâmetros de URL (campos ocultos) |
| Meta Lead Ads | Webhook `leadgen` da Meta + busca do lead na Graph API | IDs de campanha, conjunto, anúncio e formulário vêm da própria API |

Observações:

- Meta Lead Ads exige um app na Meta com permissão de leitura de leads. Enquanto não estiver aprovado, um cenário mínimo no Make pode repassar o dado bruto ao endpoint, **sem nenhuma lógica**.
- Cada adaptador tem uma única responsabilidade: traduzir o formato da fonte para o contrato de dados.

## 7. Contrato de dados

Todo adaptador entrega ao endpoint um objeto neste formato:

```json
{
  "source_slug": "lp-meta-rh-dp",
  "form_id": "form-demo",
  "lp_id": "lp-meta-rh-dp",
  "event_id": "uuid-gerado-no-navegador",
  "lead_id": "uuid-do-cookie-ou-null",
  "event_type": "form_submit",
  "occurred_at": "2026-10-02T14:32:00Z",
  "contact": {
    "name": "",
    "email": "",
    "phone": "",
    "company": "",
    "company_size": null,
    "role": ""
  },
  "answers": {},
  "attribution": {
    "utm_source": "",
    "utm_medium": "",
    "utm_campaign": "",
    "utm_term": "",
    "utm_content": "",
    "gclid": "",
    "gbraid": "",
    "wbraid": "",
    "fbclid": "",
    "fbp": "",
    "fbc": "",
    "ga_client_id": "",
    "ad_id": "",
    "landing_url": "",
    "referrer": "",
    "user_agent": "",
    "ip": ""
  },
  "consent": {
    "marketing": true,
    "analytics": true
  }
}
```

### Tipos de evento (`event_type`)

- `form_submit`
- `diagnostico_iniciado`
- `diagnostico_concluido`
- `lead_validado`
- `deal_criado`
- `deal_estagio_alterado`
- `deal_ganho`
- `deal_perdido`

Novos tipos devem ser adicionados a esta lista antes de usados.

### Normalizações obrigatórias

- **E-mail:** minúsculas, sem espaços.
- **Telefone:** formato E.164 (`+5584999999999`).
- **landing_url:** sem query string, sem barra final, sem fragmento.
- **Canal:** derivado pelo orquestrador (seção 9).

## 8. Modelo de dados

Organizado em schemas por domínio dentro do mesmo banco.

| Schema | Conteúdo |
|---|---|
| `core` | Identidade: leads e empresas |
| `orq` | Fontes, touchpoints, eventos, regras, decisões |
| `crm` | Espelho do Pipedrive |
| `mkt` | Dados diários de anúncios, GA4 e Search Console |
| `analytics` | Somente views. O dashboard lê só daqui |

### 8.1 Orquestração

```sql
create table core.leads (
  id uuid primary key default gen_random_uuid(),
  email_norm text unique,
  phone_e164 text unique,
  nome text,
  empresa text,
  porte int,
  cargo text,
  produto text check (produto in ('rh','clinic')),
  status text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table orq.sources (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  tipo text check (tipo in ('elementor','vercel','lovable','fillout','meta_form')),
  produto text,
  url text,
  token_hash text not null,
  ativo boolean default true
);

create table orq.touchpoints (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references core.leads(id),
  source_id uuid references orq.sources(id),
  event_id text unique,
  canal text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  ad_id text,
  gclid text,
  gbraid text,
  wbraid text,
  fbp text,
  fbc text,
  ga_client_id text,
  landing_url text,
  referrer text,
  occurred_at timestamptz not null
);

create table orq.events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references core.leads(id),
  touchpoint_id uuid references orq.touchpoints(id),
  tipo text not null,
  dados jsonb,
  payload_bruto jsonb,
  occurred_at timestamptz not null
);

create table orq.rules (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  prioridade int not null,
  condicoes jsonb not null,
  acao text check (acao in ('criar_deal','marcar_evento','convidar_diagnostico','validar_lead','ignorar')),
  parametros jsonb,
  versao int default 1,
  ativo boolean default true
);

create table orq.decisions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references orq.events(id),
  rule_id uuid references orq.rules(id),
  rule_versao int,
  acao text,
  modo text check (modo in ('sombra','real')),
  status text check (status in ('pendente','ok','erro')),
  erro text,
  created_at timestamptz default now()
);
```

### 8.2 Espelho do CRM

```sql
create table crm.deals (
  pipedrive_id bigint primary key,
  lead_id uuid references core.leads(id),
  pipeline text,
  estagio text,
  status text check (status in ('open','won','lost')),
  valor numeric,
  motivo_perda text,
  owner text,
  created_at timestamptz,
  won_at timestamptz,
  updated_at timestamptz
);

create table crm.stage_history (
  deal_id bigint references crm.deals(pipedrive_id),
  estagio text,
  entrou_em timestamptz,
  primary key (deal_id, estagio, entrou_em)
);
```

### 8.3 Marketing

```sql
create table mkt.ad_entities (
  plataforma text,
  ad_id text,
  adset_id text,
  campaign_id text,
  nome_campanha text,
  nome_conjunto text,
  nome_anuncio text,
  produto text,
  primary key (plataforma, ad_id)
);

create table mkt.ad_daily (
  dia date,
  plataforma text,
  ad_id text,
  impressoes int,
  cliques int,
  gasto numeric,
  leads_plataforma int,
  primary key (dia, plataforma, ad_id)
);

create table mkt.ga4_daily (
  dia date,
  landing_url text,
  source_medium text,
  sessoes int,
  sessoes_engajadas int,
  conversoes int,
  primary key (dia, landing_url, source_medium)
);

create table mkt.gsc_daily (
  dia date,
  pagina text,
  consulta text,
  cliques int,
  impressoes int,
  posicao numeric,
  primary key (dia, pagina, consulta)
);

create table mkt.sync_runs (
  id uuid primary key default gen_random_uuid(),
  tarefa text,
  iniciou_em timestamptz,
  terminou_em timestamptz,
  status text,
  linhas int,
  erro text
);
```

### 8.4 Views de análise (`analytics`)

| View | Responde |
|---|---|
| `funil_por_campanha` | Gasto, leads, qualificados, deals, ganhos, receita, CPL e CAC por campanha, conjunto e anúncio |
| `performance_lp` | Sessões, envios, deals e conversão até o CRM por landing page |
| `seo_para_receita` | Páginas e consultas orgânicas que geraram leads e deals |
| `jornada_lead` | Linha do tempo de cada lead: touchpoints, eventos, decisões e estágios |
| `saude_orquestrador` | Erros por fonte, divergências do modo sombra, sincronizações falhas |

Primeiro e último toque são **calculados** a partir de `orq.touchpoints`, nunca gravados no lead.

## 9. Derivação de canal

Ordem de avaliação (a primeira que bater define o canal):

1. Veio de Meta Lead Ads → `paid_social_meta`
2. Tem `gclid`, `gbraid` ou `wbraid` → `paid_search_google`
3. `utm_medium` em (`paid_social`, `cpc`, `paid`) → canal pago conforme `utm_source`
4. `utm_medium = email` → `email`
5. Referrer de buscador sem parâmetro pago → `organic_search`
6. Referrer de rede social sem parâmetro pago → `organic_social`
7. Outro referrer externo → `referral`
8. Sem referrer e sem UTM → `direct`

A tabela de regras de canal deve ficar em configuração, não espalhada no código.

## 10. Identificação e deduplicação

1. Se o evento traz `lead_id` válido, usar.
2. Senão, buscar por `email_norm`.
3. Senão, buscar por `phone_e164`.
4. Senão, criar lead novo.

Antes de criar deal, buscar no Pipedrive pessoa e deal aberto pelo e-mail e telefone. Se existir deal aberto, a ação vira `marcar_evento`.

`event_id` é único em `orq.touchpoints`. Evento repetido é ignorado (idempotência).

## 11. Motor de regras

- Regras avaliadas por `prioridade` crescente. A primeira que bater executa.
- `condicoes` em jsonb, com operadores simples: `eq`, `neq`, `in`, `lt`, `gt`, `exists`, `and`, `or`.
- Campos disponíveis nas condições: produto, porte, cargo, canal, source_slug, event_type, score do diagnóstico, existência de deal aberto, validade de e-mail e telefone.

### Exemplo de condição

```json
{
  "and": [
    { "campo": "produto", "op": "eq", "valor": "rh" },
    { "campo": "porte", "op": "lt", "valor": 20 },
    { "campo": "deal_aberto", "op": "eq", "valor": false }
  ]
}
```

### Ações

| Ação | Comportamento |
|---|---|
| `criar_deal` | Cria pessoa, organização e deal no Pipedrive; dispara mensagem de conexão na Umbler |
| `marcar_evento` | Registra atividade ou nota no deal existente; atualiza campos de conversão |
| `convidar_diagnostico` | Envia link do diagnóstico com `?lid=` via Umbler ou e-mail; não cria deal |
| `validar_lead` | Fluxo de confirmação via WhatsApp ou diagnóstico, sem SDR |
| `ignorar` | Registra a decisão e não executa nada |

### Campos personalizados no Pipedrive

- Última conversão (LP, canal, data)
- Número de conversões
- Score de maturidade
- `lead_id` do orquestrador

### Interface visual (fase futura)

Canvas de nós com React Flow que **apenas edita linhas de `orq.rules`**. Tipos de nó permitidos: origem, condição e ação. Chamadas de API, autenticação e tratamento de erro nunca aparecem no canvas.

## 12. Rastreamento

### 12.1 Convenção de UTMs

**Meta:**
```
utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}
```

**Google Ads:** auto-tagging ligado, mais
```
utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_term={keyword}&utm_content={creative}
```

Nomes de campanha vêm pela API e ficam em `mkt.ad_entities`. Renomear campanha não quebra histórico.

### 12.2 Google Tag Manager

Um único container web em Elementor, Vercel e Lovable.

**Script de atribuição (tag de HTML personalizado):**

- Gera `lead_id` no primeiro acesso e guarda em cookie próprio
- Captura UTMs, `gclid`, `gbraid`, `wbraid`, `fbclid` (convertido em `_fbc`), `_fbp` e `client_id` do GA4
- Guarda primeiro e último toque em cookie
- Preenche campos ocultos dos formulários
- Repassa os parâmetros para URLs do Fillout e do diagnóstico

**Evento padrão do dataLayer**, disparado por todo formulário no envio bem-sucedido:

```js
dataLayer.push({
  event: 'generate_lead',
  form_id: 'form-demo',
  lp_id: 'lp-meta-rh-dp',
  lead_id: '<uuid>',
  event_id: '<uuid-unico>'
});
```

**Configurações adicionais:**

- Domínio cruzado entre site, LPs e Fillout, se os domínios forem diferentes
- Consent Mode v2 com banner de cookies (LGPD)

### 12.3 GA4

- Eventos-chave: `generate_lead`, `diagnostico_concluido`
- Dimensões personalizadas: `lp_id`, `form_id`
- `user_id` = `lead_id`, enviado só após a conversão. Nunca enviar e-mail ou telefone
- Vincular ao Google Ads e ao Search Console
- Filtro de tráfego interno
- Domínio do Fillout em referências indesejadas
- Exportação gratuita para o BigQuery ativada desde já

### 12.4 Meta (Pixel + CAPI)

- Pixel no GTM dispara `Lead` com `eventID = event_id`
- O orquestrador envia o mesmo evento pela CAPI com o mesmo ID, mais e-mail e telefone em hash, `fbp`, `fbc`, IP e user agent
- O orquestrador envia eventos de funil com valor quando o deal vira qualificado ou ganho
- Formulários nativos: usar a otimização por leads de conversão, devolvendo o ID do lead da Meta com os estágios do CRM

### 12.5 Google Ads

- Conversões otimizadas para leads (e-mail em hash no envio)
- O orquestrador sobe conversões offline (lead qualificado, deal ganho) usando `gclid`, `gbraid` ou `wbraid`
- Com volume suficiente, trocar a conversão principal de "formulário enviado" para "lead qualificado"

### 12.6 Fora de escopo agora

GTM server-side. O orquestrador já cumpre o papel de servidor.

## 13. Segurança

- Token próprio por fonte, enviado em header e comparado com `token_hash`
- Validação da assinatura dos webhooks da Meta
- Limite de requisições por fonte
- Honeypot contra bots nos formulários públicos
- Registro do consentimento LGPD em cada evento
- Chave de serviço do Supabase apenas no servidor
- RLS ativo; o dashboard usa papel somente leitura e só acessa `analytics`

## 14. Plano de migração

1. Subir o orquestrador em **modo sombra**: recebe, identifica e decide, mas não executa. O Make continua rodando.
2. Comparar decisões do modo sombra com o que o Make fez por uma a duas semanas (view `saude_orquestrador`).
3. Desligar o Make fonte por fonte, nesta ordem: Vercel, Lovable, Fillout, Elementor, Meta Lead Ads.
4. Só desligar o último cenário depois de migrar produção para o plano pago do Supabase.

## 15. Fases de entrega

| Fase | Entrega |
|---|---|
| 0 | Convenção de UTMs aplicada em todos os anúncios |
| 1 | Script de atribuição e dataLayer no GTM; GA4 e Pixel configurados |
| 2 | Migrations dos schemas `core`, `orq` e `crm` no ambiente de testes |
| 3 | Endpoint único, adaptadores de entrada, identificação e log em modo sombra |
| 4 | Motor de regras em tabela + adaptadores Pipedrive e Umbler |
| 5 | Diagnóstico como qualificador (ciclo com `lid`) |
| 6 | Migração gradual do Make |
| 7 | CAPI e conversões offline do Google Ads |
| 8 | Sincronizações de `mkt` e views de `analytics` para o dashboard |
| 9 | Canvas visual de regras |

## 16. Convenções de código

- TypeScript em todas as funções
- Um módulo por adaptador (`adapters/in/<fonte>.ts`, `adapters/out/<destino>.ts`)
- Migrations versionadas no repositório; nunca alterar o banco manualmente
- Toda função do caminho crítico registra a decisão em `orq.decisions`, inclusive em erro
- Retentativa com backoff para chamadas ao Pipedrive e à Umbler
- Testes para o motor de regras e para a derivação de canal antes de qualquer outra coisa
