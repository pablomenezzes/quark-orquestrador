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
7. **Toda mudança de banco segue as regras obrigatórias da seção 4** (backup antes, migration aditiva, SQL mostrado e aprovado, testes em transação com rollback). Não há ambiente de testes separado (ver decisão D-01 na seção 17).

## 4. Stack

| Camada | Tecnologia |
|---|---|
| Banco de dados | Supabase (Postgres) |
| Funções do orquestrador | Vercel (serverless functions), região **São Paulo (`gru1`)**, junto do banco. Alternativa: Supabase Edge Functions |
| Tarefas agendadas | Vercel Cron ou pg_cron |
| Rastreamento web | Google Tag Manager (container web único) |
| CRM | Pipedrive (API) |
| Mensageria | Umbler (API) |
| Código | GitHub, desenvolvido com Claude Code |

### Ambiente

- **Um único projeto Supabase**, região **South America (São Paulo)**, nome "Orquestrador CRM Quark". Não existe projeto de testes.
- O schema `public` deste projeto está **vazio**. O dashboard do QuarkRH fica em outra conta do Supabase, sem relação com este banco. Mesmo assim, por organização, **o orquestrador nunca usa o `public`** (regra 1 abaixo).
- Funções na Vercel rodam na região `gru1` (São Paulo), ao lado do banco.
- Como o projeto é único e vai receber dados reais, a segurança vem das regras abaixo, não de um ambiente separado.

### Regras obrigatórias do banco

1. **Nunca criar, alterar ou apagar nada no schema `public`.** Só os schemas `core`, `orq`, `crm`, `mkt` e `analytics`.
2. **Antes de todo `db push`, rodar um dump completo** do banco para a pasta `backups/` (ignorada pelo git). Sem dump, sem push.
3. **Migrations somente aditivas** (`CREATE`, `ADD COLUMN`, `CREATE INDEX`, etc.). Qualquer `DROP`, `RENAME` ou alteração de tipo exige aprovação explícita do Pablo, com justificativa.
4. **Sempre mostrar o SQL e pedir confirmação antes de rodar `db push`.**
5. **Testes de integração rodam dentro de transação com `ROLLBACK`.** Nenhum dado de teste pode permanecer no banco: ao final, a contagem de linhas de cada tabela deve ser idêntica à do início (o banco passará a ter dados reais, então o critério é "nada a mais", não "tudo vazio").
6. **Nunca alterar o banco manualmente** (painel, SQL Editor). Toda mudança é uma migration versionada.

### Atenção ao plano gratuito do Supabase

- Sem backup automático. Fazer dump periódico até migrar para o plano pago (e sempre antes de um `db push`, regra 2).
- Armazenamento limitado. Dados de marketing entram **agregados por dia**, nunca eventos brutos.
- Projetos podem ser pausados por inatividade.
- **Migrar o projeto para o plano pago antes de desligar o Make.**

### Variáveis de ambiente (arquivo `.env.local`, nunca versionado)

| Variável | Onde encontrar no painel do Supabase |
|---|---|
| `SUPABASE_URL` | Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API Keys → `service_role` (secreta, só no servidor) |
| `SUPABASE_PROJECT_REF` | Project Settings → General → Reference ID (também na URL do painel) |
| `SUPABASE_DB_URL` | Connect → Connection string → Session pooler (porta 5432), com a senha do banco. Usada pelos testes de integração e pelo dump |
| `SHADOW_MODE` | Fixo em `true` até a Fase 6 |

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
  },
  "first_touch": null,
  "website_hp": ""
}
```

- `first_touch` (opcional): primeiro toque guardado pelo script no navegador. Mesmo formato dos campos de UTM e click id. Serve para não perder a origem quando a primeira visita não gerou formulário. O primeiro toque oficial continua sendo **calculado** a partir de `orq.touchpoints`.
- `website_hp` (honeypot): campo escondido por CSS. Se vier preenchido, o endpoint descarta o envio e responde 200 sem gravar nada.

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

Organizado em schemas por domínio dentro do mesmo banco. O schema `public` não é usado (seção 4, regra 1).

Acréscimos aprovados ao DDL abaixo (ver seção 17):

- Triggers que **bloqueiam UPDATE e DELETE** em `orq.events` (princípio 5).
- **RLS ativo** em todas as tabelas, sem política para `anon` e `authenticated`: só a service key acessa. O papel de leitura do dashboard nasce com o schema `analytics` (Fase 8).
- Gatilho `updated_at` em `core.leads`.
- Índices nas chaves estrangeiras.
- A API do Supabase só enxerga um schema se ele estiver em *Exposed schemas* (Project Settings → API). Isso é configuração do painel, feita uma vez, e documentada em `supabase/README.md`.

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

A tabela de regras de canal deve ficar em configuração, não espalhada no código (`config/channel-rules.ts`).

Detalhes definidos na implementação:

- **Passo 3, canal pago por `utm_source`:** `meta`, `facebook`, `fb`, `instagram`, `ig` → `paid_social_meta`; `google` → `paid_search_google`; qualquer outro → `paid_other`. A comparação ignora maiúsculas e espaços.
- **Passos 5 e 6:** as listas de buscadores e redes sociais ficam em `config/channel-rules.ts`. O host precisa casar inteiro (`meugoogle.com` não é o Google).
- **Referrer do próprio domínio** (`ownDomains`) é navegação interna e conta como ausente.
- **UTM presente, sem referrer e sem regra que case** → canal `other` (e não `direct`, que é só para quem não traz sinal nenhum).

## 10. Identificação e deduplicação

1. Se o evento traz `lead_id` válido (UUID bem formado, existente no banco), usar. **Exceção: o e-mail pesa mais que o cookie.** Se o lead existe mas o e-mail enviado é diferente do e-mail desse lead, o evento **não** é anexado a ele (outra pessoa usando o mesmo navegador). Segue para o passo 2. Se o lead existe e não tem e-mail, ou o evento não traz e-mail, o `lead_id` vale.
2. Senão, buscar por `email_norm`.
3. Senão, buscar por `phone_e164`.
4. Senão, criar lead novo. Se o `lead_id` do cookie é um UUID válido **e não pertence a nenhum lead**, o lead novo nasce com esse id, para navegador e banco concordarem. Se o UUID do cookie pertence a outro lead (caso da exceção do passo 1), o lead novo recebe um UUID novo.

Depois de achado, o lead é completado só onde falta (nome, telefone, empresa, etc.), sem sobrescrever e sem violar a unicidade de e-mail e telefone.

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
- Guarda primeiro e último toque em cookie (`qk_lid` 400 dias, `qk_ft` 400 dias, `qk_lt` 90 dias). O último toque só muda com sinal novo (UTM, click id ou referrer externo); uma visita direta posterior **não** apaga o último toque pago
- Se o `?lid=` da URL é um UUID válido, ele tem prioridade sobre o cookie (ciclo do diagnóstico)
- Expõe `window.QuarkAttribution` (`get()`, `pushLead()`, `decorateUrl()`); `pushLead()` dispara o `generate_lead` no dataLayer e rotaciona o `event_id`
- Consentimento desconhecido é tratado como **não concedido** (LGPD)
- Detalhes de instalação por plataforma: `tracking/INSTALL.md`
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

Não há ambiente de testes separado (seção 4). O "modo sombra" faz o papel de ambiente seguro: o orquestrador roda com dados reais, mas **só grava em `orq.decisions` e nunca executa ação** no Pipedrive, na Umbler, na Meta ou no Google.

1. Subir o orquestrador em **modo sombra**: recebe, identifica e decide, mas não executa. O Make continua rodando.
2. Comparar decisões do modo sombra com o que o Make fez por uma a duas semanas (view `saude_orquestrador`).
3. Trocar uma fonte de `sombra` para `real` somente com aprovação explícita do Pablo. Antes de cada troca: dump do banco (seção 4, regra 2).
4. Desligar o Make fonte por fonte, nesta ordem: Vercel, Lovable, Fillout, Elementor, Meta Lead Ads.
5. Só desligar o último cenário depois de migrar o projeto para o plano pago do Supabase.

Como os dados de teste não podem ficar no banco (regra 5), o período em sombra só contém eventos **reais** dos formulários.

## 15. Fases de entrega

Status: `pendente`, `em andamento`, `concluída`. Atualizar a cada entrega.

| Fase | Entrega | Status |
|---|---|---|
| 0 | Convenção de UTMs aplicada em todos os anúncios | pendente (fora do código) |
| 1 | Script de atribuição e dataLayer no GTM; GA4 e Pixel configurados | em andamento: script e guia entregues (2026-10-02); falta validar no GTM e configurar GA4 e Pixel |
| 2 | Migrations dos schemas `core`, `orq` e `crm` no projeto Supabase | em andamento: migrations escritas; `db push` aguardando aprovação |
| 3 | Endpoint único, adaptadores de entrada (Vercel e Elementor), identificação e log em modo sombra | pendente |
| 4 | Motor de regras em tabela + adaptadores Pipedrive e Umbler | pendente |
| 5 | Diagnóstico como qualificador (ciclo com `lid`) | pendente |
| 6 | Migração gradual do Make | pendente |
| 7 | CAPI e conversões offline do Google Ads | pendente |
| 8 | Sincronizações de `mkt` e views de `analytics` para o dashboard | pendente |
| 9 | Canvas visual de regras | pendente |

## 16. Convenções de código

- TypeScript em todas as funções
- Um módulo por adaptador (`adapters/in/<fonte>.ts`, `adapters/out/<destino>.ts`)
- Migrations versionadas em `supabase/migrations/`; nunca alterar o banco manualmente
- Migrations somente aditivas; `DROP`, `RENAME` ou mudança de tipo só com aprovação explícita (seção 4, regra 3)
- Nada no schema `public` (seção 4, regra 1)
- Antes de `db push`: dump em `backups/` e SQL mostrado ao Pablo para confirmação (seção 4, regras 2 e 4)
- Testes de integração em transação com `ROLLBACK`, via `SUPABASE_DB_URL`; nenhum dado de teste permanece (seção 4, regra 5)
- Funções da Vercel na região `gru1`
- Toda função do caminho crítico registra a decisão em `orq.decisions`, inclusive em erro
- Retentativa com backoff para chamadas ao Pipedrive e à Umbler
- Testes para o motor de regras e para a derivação de canal antes de qualquer outra coisa

## 17. Decisões e pendências

Registro vivo. Atualizar a cada sessão.

### Decisões tomadas

| ID | Decisão | Data |
|---|---|---|
| D-01 | Um único projeto Supabase (São Paulo), sem projeto de testes; `public` vazio e intocado. Substitui o princípio 7 original | 2026-10-03 |
| D-02 | Regras obrigatórias do banco (seção 4): dump antes do push, migrations aditivas, SQL aprovado, testes com rollback | 2026-10-03 |
| D-03 | `orq.events` é a tabela de eventos (o princípio 5 dizia `orq_events`). Imutável por trigger | 2026-10-02 |
| D-04 | Idempotência no `orq.touchpoints.event_id`. Evento repetido: HTTP 200 `{duplicate:true}`, nada é gravado | 2026-10-02 |
| D-05 | Mapa `utm_source` → canal pago e canal `other` (seção 9) | 2026-10-02 |
| D-06 | `lead_id` do cookie só vale se o e-mail enviado não contradiz o do lead; o e-mail pesa mais que o cookie (seção 10) | 2026-10-03 |
| D-07 | Lead novo reaproveita o UUID do cookie quando ele não pertence a ninguém | 2026-10-02 |
| D-08 | Consentimento desconhecido = não concedido | 2026-10-02 |
| D-09 | RLS sem política para `anon` e `authenticated`; só a service key acessa | 2026-10-02 |
| D-10 | Contrato ganha `first_touch` (opcional) e `website_hp` (honeypot) | 2026-10-02 |
| D-11 | Funções na Vercel em `gru1` | 2026-10-03 |
| D-12 | Arquivo de instruções mantém o nome `orquestrador-marketing-quark.md` | 2026-10-02 |

### Pendências

- [ ] Preencher `ownDomains` em `config/channel-rules.ts` com os domínios do site e das LPs.
- [ ] Validar o script de atribuição num GTM e numa página reais (`tracking/INSTALL.md`, seção 5).
- [ ] Configurar GA4 e Pixel (Fase 1).
- [ ] Expor os schemas `core`, `orq` e `crm` em *Exposed schemas* no painel do Supabase (Entregável 3).
- [ ] Limite de requisições por fonte (seção 13): adiado, sem Redis disponível.
- [ ] IDs do Pipedrive (pipeline, estágios, campos personalizados) em `config/pipedrive.placeholders.ts`, usados só na Fase 4.
- [ ] Adaptadores de entrada de Lovable, Fillout e Meta Lead Ads: sessões futuras.
- [ ] Ferramenta de dump: nem `pg_dump` nem Docker estão instalados nesta máquina (necessário antes do primeiro `db push`).
- [ ] Executar o `db push` das migrations 0001 e 0002 (aguarda aprovação do SQL e dump).
