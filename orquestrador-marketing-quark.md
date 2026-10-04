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
- **Produção (Vercel):** projeto `quark-orquestrador`, conta `pablomenezes-9499`, endpoint `https://quark-orquestrador.vercel.app/api/ingest`, região `gru1`, **modo sombra**. A **Deployment Protection está ligada e assim deve ficar** (decisão D-22): quem não está logado na Vercel recebe o muro de login.
- **Testes:** o ambiente de testes é o **Quark Studio** local (seção "Ambiente de testes" abaixo), que simula o pipeline sem gravar.

### Ambiente de testes: Quark Studio

`npm run studio` sobe `http://127.0.0.1:4310` (só na máquina local, nunca publicado). Constrói formulários (perguntas, tipos, opções, destino de cada resposta no contrato), abre cada um em nova aba com todas as perguntas na mesma tela e com UTMs, presets e referrer simulado, e envia pelo **mesmo `ingest()`** do endpoint, usando o **mesmo `tracking/attribution.js`** do GTM.

| Modo | Efeito |
|---|---|
| **Simular** (padrão) | Roda o pipeline inteiro contra o banco real e **desfaz a transação**. Devolve o que seria gravado (lead, touchpoint, evento, decisão). Não grava nada |
| **Gravar em modo sombra** | Confirma a transação. **Irreversível** (`orq.events` é imutável). Exige `mode:"real"` explícito e dupla confirmação; os dados ficam marcados com `answers._studio_form` e `lp_id` `studio-…` |

O token da fonte fica só no servidor local (`SOURCE_TOKEN_LP_VERCEL`). O servidor confere `Host`, `Origin` e `Content-Type` (anti DNS-rebinding e CSRF). Detalhes em `studio/README.md`. Formulários ficam em `studio/forms/*.json` (versionados).

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
| `SUPABASE_PROJECT_REF` | Project Settings → General → Reference ID (também na URL do painel). Alimenta a trava de alvo (`src/db/guard.ts`) |
| `SUPABASE_DB_URL` | Connect → Connection string → Session pooler (porta 5432), com a senha do banco. **Secreta.** Usada pelo endpoint, pelos testes de integração, pelo dump e pelo `db push` |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API Keys → `service_role`. Não é usada nesta fase (o endpoint fala direto com o Postgres); reservada para clientes REST futuros |
| `SHADOW_MODE` | Fixo em `true` até a Fase 6. Sem `true` exato o endpoint se recusa a operar |
| `SOURCE_TOKEN_LP_VERCEL`, `SOURCE_TOKEN_ELEMENTOR` | Token em texto puro de cada fonte, **só no `.env.local`** (gerado por `scripts/register-source.ts --save-env`). No banco fica apenas o hash |
| `STUDIO_PORT` | Opcional; porta do Studio (padrão 4310) |

**Vercel (produção):** `SUPABASE_DB_URL` (sensível), `SUPABASE_PROJECT_REF` e `SHADOW_MODE`. Para criar ou alterar, use `vercel env add NOME production --value VALOR --force --yes`. **Nunca envie o valor por pipe no PowerShell 5.1**: ele acrescenta `CRLF` e o guarda de segurança do banco passa a recusar a conexão.

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
- *Exposed schemas* do painel do Supabase **não é necessário**: o endpoint fala direto com o Postgres (decisão D-13).

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

- Token próprio por fonte, enviado em header (`x-quark-token`) e comparado com `token_hash` (SHA-256, comparação em tempo constante). Fontes que não conseguem enviar cabeçalho (Elementor, Fillout) usam `?token=` na URL. Fonte desconhecida, inativa ou token errado recebem a mesma resposta `401`
- Validação da assinatura dos webhooks da Meta (adaptador da Meta: sessão futura)
- Limite de requisições por fonte (pendente, ver seção 17)
- Honeypot `website_hp` contra bots nos formulários públicos (implementado: responde 200 sem gravar)
- Registro do consentimento LGPD em cada evento (implementado, em `orq.events.dados.consent`)
- Chave de serviço do Supabase apenas no servidor
- RLS ativo; o dashboard usa papel somente leitura e só acessa `analytics`
- **Deployment Protection da Vercel ligada** em produção (D-22). Corpo máximo de 100 KB. Trava de alvo do banco (`src/db/guard.ts`) recusa conectar a um projeto que não seja o do `SUPABASE_PROJECT_REF`
- Endpoint em modo sombra: o código não tem caminho de execução real (`SHADOW_MODE` precisa ser `true`)

## 14. Plano de migração

Não há ambiente de testes separado (seção 4). O "modo sombra" faz o papel de ambiente seguro: o orquestrador roda com dados reais, mas **só grava em `orq.decisions` e nunca executa ação** no Pipedrive, na Umbler, na Meta ou no Google.

1. Subir o orquestrador em **modo sombra**: recebe, identifica e decide, mas não executa. O Make continua rodando.
2. Comparar decisões do modo sombra com o que o Make fez por uma a duas semanas (view `saude_orquestrador`).
3. Trocar uma fonte de `sombra` para `real` somente com aprovação explícita do Pablo. Antes de cada troca: dump do banco (seção 4, regra 2).
4. Desligar o Make fonte por fonte, nesta ordem: Vercel, Lovable, Fillout, Elementor, Meta Lead Ads.
5. Só desligar o último cenário depois de migrar o projeto para o plano pago do Supabase.

Como os dados de teste não podem ficar no banco (regra 5), o período em sombra só contém eventos **reais** dos formulários. Os testes manuais usam a **simulação** do Quark Studio, que não grava.

Pré-requisito para as fontes reais chegarem ao endpoint: definir como atravessar a Deployment Protection sem desligá-la (pendência P-01 na seção 17).

## 15. Fases de entrega

Status: `pendente`, `em andamento`, `concluída`. Atualizar a cada entrega.

| Fase | Entrega | Status |
|---|---|---|
| 0 | Convenção de UTMs aplicada em todos os anúncios | pendente (fora do código) |
| 1 | Script de atribuição e dataLayer no GTM; GA4 e Pixel configurados | em andamento: script, testes (jsdom) e guia entregues (2026-10-02); já exercitado no Studio; falta validar num GTM real e configurar GA4 e Pixel |
| 2 | Migrations dos schemas `core`, `orq` e `crm` no projeto Supabase | **concluída** (2026-10-03): `0001` e `0002` aplicadas após dump e aprovação do SQL; `public` intacto; testes de integração passando com rollback |
| 3 | Endpoint único, adaptadores de entrada (Vercel e Elementor), identificação e log em modo sombra | em andamento: **no ar** em `https://quark-orquestrador.vercel.app/api/ingest` (`gru1`, modo sombra, Deployment Protection ligada) desde 2026-10-03; 2 fontes de teste registradas; smoke test em produção ok pelos caminhos sem escrita. Faltam: acesso das fontes reais atravessando a proteção (P-01), primeiro envio real gravado e as pendências de segurança da seção 17 |
| 3b | Quark Studio: ambiente de testes local com simulação (extra, fora do plano original) | **concluída e congelada** (2026-10-04): construtor, formulário estilo Typeform com UTMs e modo simulação; validado de ponta a ponta contra o banco real sem gravar. Única correção permitida: rodar sozinho com `npm run studio` (item 1 abaixo). Nenhuma funcionalidade nova |
| 4 | Motor de regras em tabela + adaptadores Pipedrive e Umbler | pendente |
| 5 | Diagnóstico como qualificador (ciclo com `lid`) | pendente |
| 6 | Migração gradual do Make | pendente |
| 7 | CAPI e conversões offline do Google Ads | pendente |
| 8 | Sincronizações de `mkt` e views de `analytics` para o dashboard | pendente |
| 9 | Canvas visual de regras | pendente |

### Ordem de trabalho vigente (ajuste de rota, 2026-10-04)

**Diagnóstico:** o projeto está tecnicamente sólido, mas nenhuma fonte real consegue entregar um lead (P-01). A prioridade é colocar o **primeiro lead real no banco com segurança**. **Nada novo entra antes disso.** Ao fim de cada item, parar e aguardar a confirmação do Pablo.

| # | Item | Tipo | Status |
|---|---|---|---|
| 1 | **Studio congelado.** Rodar sozinho no PowerShell com `npm run studio`; ao subir, checar `.env.local`, conexão com o banco e porta livre, explicando em português o que falta. Documentar em `studio/README.md`. Nenhuma funcionalidade nova | código mínimo | pendente |
| 2 | **Backup do código.** Repositório privado no GitHub e `push` (o Pablo faz a autenticação). Antes: confirmar `.env.local` e `backups/` no `.gitignore` | guia | pendente |
| 3 | **P-01, só análise.** Verificar o nível de Deployment Protection ativo. Comparar as opções (a), (b), (c) e a alternativa **(d)**: proteção padrão (previews protegidos, domínio de produção público) com a defesa da produção na própria aplicação. Segurança, custo, manutenção e recomendação. **Não implementar antes da aprovação.** A opção (a) só é aceitável se o segredo não ficar exposto em páginas públicas | análise | pendente |
| 4 | **Segurança para abrir ao público**, junto com a solução do item 3: papel de banco com privilégio mínimo (sem `postgres`); CORS restrito às origens de `orq.sources.url`; limite de requisições sem Redis (contador no Postgres, firewall da Vercel ou outro, com o custo de cada um). SQL mostrado e confirmado antes de qualquer `db push` | código + migration | pendente |
| 5 | **LGPD.** Proposta de política de eliminação/anonimização a pedido do titular, compatível com a imutabilidade de `orq.events`. Só proposta | proposta | pendente |
| 6 | **Primeiro lead real.** Depois dos itens 3 e 4 aprovados e aplicados: envio do Pablo, identificável, pela LP da Vercel; confirmar lead, touchpoint, evento e decisão gravados | guia + verificação | pendente |
| 7 | **Fase 1 no mundo real.** Preencher `ownDomains` (domínios abaixo); guiar a validação do script num GTM real (`tracking/INSTALL.md`, seção 5); registrar as fontes reais | código mínimo + guia | pendente |

Domínios do item 7 (`ownDomains`): `quarkrh-diagnostico.lovable.app`, `quarkrh.com.br` (cobre `/quarkrh-sistema-de-rh-completo/`, `/funcionalidades/` e `/lp-agendar-demonstracao/`).

**Só depois dos 7 itens:** adaptadores de entrada do Lovable e da Meta (o Fillout não foi citado nesta lista; confirmar com o Pablo) e a Fase 4.

## 16. Convenções de código

- **Regra de escopo:** nada fora da seção 15 é construído sem aprovação prévia do Pablo. Ao identificar uma ferramenta ou melhoria útil, propor em **até 5 linhas** (problema, solução, custo em tempo, o que atrasa) e **aguardar a resposta** antes de qualquer código.
- TypeScript em todas as funções
- Um módulo por adaptador (`adapters/in/<fonte>.ts`, `adapters/out/<destino>.ts`)
- Migrations versionadas em `supabase/migrations/`; nunca alterar o banco manualmente
- Migrations somente aditivas; `DROP`, `RENAME` ou mudança de tipo só com aprovação explícita (seção 4, regra 3)
- Nada no schema `public` (seção 4, regra 1)
- Antes de `db push`: dump em `backups/` e SQL mostrado ao Pablo para confirmação (seção 4, regras 2 e 4)
- Testes de integração em transação com `ROLLBACK`, via `SUPABASE_DB_URL`; nenhum dado de teste permanece (seção 4, regra 5)
- Funções da Vercel na região `gru1`
- Imports relativos em `src/`, `config/` e `api/` **com extensão `.js`** (Node ESM na Vercel; sem isso a função cai ao carregar). `node scripts/add-js-extensions.mjs` corrige em lote
- Smoke tests em produção só por caminhos que **não gravam** (405, 401, 400, honeypot, OPTIONS): `orq.events` é imutável e dado de teste ali seria permanente
- Segredos nunca são impressos nem passados por pipe; scripts que geram tokens gravam direto no `.env.local` (`--save-env`)
- Toda função do caminho crítico registra a decisão em `orq.decisions`, inclusive em erro
- Retentativa com backoff para chamadas ao Pipedrive e à Umbler
- Testes para o motor de regras e para a derivação de canal antes de qualquer outra coisa

## 17. Decisões e pendências

Registro vivo. Atualizar a cada sessão.

### Estado atual (2026-10-04)

| Item | Situação |
|---|---|
| Repositório | `C:\Users\Esig\Documents\quark-orquestrador` (git local, **sem remoto**: backup no GitHub é o item 2), branch `main` |
| Ordem de trabalho | Seção 15, itens 1 a 7. Em andamento: item 1 |
| Banco | Supabase "Orquestrador CRM Quark" (São Paulo), migrations `0001` e `0002` aplicadas. Tabelas com dados reais: só `orq.sources` (2 fontes de teste); demais com 0 linhas. `public` com 0 tabelas |
| Fontes registradas | `lp-vercel-rh-teste` (vercel) e `elementor-site-rh` (elementor). Tokens só no `.env.local` |
| Produção | `https://quark-orquestrador.vercel.app/api/ingest`, `gru1`, modo sombra, Deployment Protection ligada |
| Testes | 184 passando (unitários, integração em transação com rollback, Studio). Os de integração dependem do `.env.local` |
| Backups | `backups/dump-*.sql` (ignorados pelo git). Dump antes de cada `db push` |
| Ferramentas | Node 24, Git 2.55, `pg_dump` 17.11 em `C:\PostgreSQL17\bin`, Vercel CLI (via `npx`) logada |

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
| D-13 | O endpoint fala direto com o Postgres (`pg`), numa transação por evento: lead, touchpoint, evento e decisão são atômicos. Sem `supabase-js` e sem "Exposed schemas" | 2026-10-03 |
| D-14 | Fontes públicas só enviam `form_submit`, `diagnostico_iniciado` e `diagnostico_concluido`. Os `deal_*` e `lead_validado` vêm de dentro (fases futuras) | 2026-10-03 |
| D-15 | Elementor e Fillout não enviam cabeçalho: fonte em `?source=` e token em `?token=`. Só esses tipos aceitam token na URL | 2026-10-03 |
| D-16 | Falha após a validação: 500 para a fonte retentar, nada parcial gravado, e um evento bruto sem lead + decisão `erro` ficam registrados. A retentativa não é tratada como duplicada | 2026-10-03 |
| D-17 | Decisão em modo sombra grava `acao = 'pendente_motor_regras'` até o motor de regras existir (Fase 4) | 2026-10-03 |
| D-18 | IP e user agent: Vercel/Lovable usam os do request (é o visitante); Elementor usa só o `user_agent` do campo oculto e não grava IP (o request é do servidor do Elementor) | 2026-10-03 |
| D-19 | `event_id` exige no mínimo 8 caracteres; corpo máximo de 100 KB; `occurred_at` ausente, inválido ou mais de 10 min no futuro vira o horário de recebimento | 2026-10-03 |
| D-20 | Ambiente de testes = **Quark Studio** (`npm run studio`, só em 127.0.0.1): constrói formulários e envia pelo mesmo `ingest()`. A Deployment Protection da Vercel permanece ligada | 2026-10-04 |
| D-21 | `ingest` ganhou o modo **simulação** (`dryRun`, só ativável por código do servidor): roda tudo na transação e a desfaz, devolvendo o que seria gravado. É o padrão do Studio; gravar exige `mode:"real"` com dupla confirmação | 2026-10-04 |
| D-22 | **A Deployment Protection da Vercel não é desligada** para liberar o endpoint. A defesa continua em camadas (token, honeypot, validação, RLS), mas a abertura ao público exige uma solução que preserve a proteção (P-01) | 2026-10-04 |
| D-23 | Fontes são registradas por `scripts/register-source.ts` (simulação por padrão, `--apply` grava só o hash); com `--save-env` o token vai direto ao `.env.local`, sem aparecer na tela | 2026-10-04 |
| D-24 | Senha do banco com caracteres especiais é codificada na URL (percent-encoding) por `scripts/encode-db-url.mjs`, sem alterar a senha | 2026-10-03 |
| D-25 | A CLI do Supabase exige `sslmode=require` na conexão pelo pooler; `scripts/db-push.ps1` acrescenta sozinho | 2026-10-03 |
| D-26 | **Ajuste de rota:** a prioridade é o primeiro lead real no banco com segurança; nada novo antes disso. Ordem de trabalho na seção 15 (itens 1 a 7), com parada e confirmação do Pablo ao fim de cada item | 2026-10-04 |
| D-27 | **Regra de escopo** (seção 16): nada fora da seção 15 é construído sem aprovação prévia; melhorias são propostas em até 5 linhas e aguardam resposta | 2026-10-04 |
| D-28 | **Studio congelado:** só a correção de execução autônoma (`npm run studio` com checagens e mensagens em português). Nenhuma funcionalidade nova | 2026-10-04 |

### Pendências

Ordem vigente: **seção 15, itens 1 a 7**. As pendências abaixo apontam para o item que as resolve. Parar e aguardar a confirmação do Pablo ao fim de cada item.

**Caminho até o primeiro lead real**

- [ ] **Item 1 — Studio rodando sozinho** (`npm run studio` com checagem de `.env.local`, banco e porta; mensagens em português; `studio/README.md`).
- [ ] **Item 2 — Backup no GitHub** (repositório privado, `push`; confirmar `.env.local` e `backups/` no `.gitignore`). O repositório hoje não tem remoto: um defeito de disco perde o código.
- [ ] **Item 3 / P-01 — Como as fontes reais atravessam a Deployment Protection?** Com a proteção ligada, o navegador do visitante e o webhook do Elementor recebem o muro de login da Vercel. Análise pendente do nível ativo e das opções (a) *Protection Bypass for Automation* (só aceitável se o segredo não ficar exposto em página pública), (b) domínio próprio com a proteção desligada só nesse projeto, (c) proxy mínimo, (d) proteção padrão (previews protegidos, produção pública) com a defesa na aplicação. **Nada é implementado antes da aprovação.**
- [ ] **Item 4 — Segurança para abrir ao público:** papel de banco com privilégio mínimo (hoje o endpoint usa `postgres` via pooler); CORS restrito às origens de `orq.sources.url` (hoje reflete qualquer origem); limite de requisições por fonte sem Redis (adiado até aqui). SQL mostrado e confirmado antes de qualquer `db push`.
- [ ] **Item 5 — LGPD x imutabilidade:** `orq.events` é imutável e guarda o `payload_bruto` com dados pessoais. Só proposta de política de eliminação/anonimização a pedido do titular; qualquer solução que mexa na imutabilidade exige aprovação.
- [ ] **Item 6 — Primeiro envio real gravado** pela LP da Vercel (o caminho de escrita está provado por testes de integração, mas não por HTTP em produção). Envio do Pablo, identificável.
- [ ] **Item 7 — Fase 1 no mundo real:** `ownDomains` em `config/channel-rules.ts`; validar o script num GTM real (`tracking/INSTALL.md`, seção 5); registrar as fontes reais (hoje só as 2 de teste) com `scripts/register-source.ts`; configurar GA4 e Pixel.

**Depois dos 7 itens (não iniciar antes)**

- [ ] Adaptadores de entrada do Lovable e da Meta Lead Ads (Fillout: confirmar com o Pablo). O Studio só envia pela fonte `lp-vercel-rh-teste`.
- [ ] Fase 4: motor de regras e adaptadores Pipedrive e Umbler. IDs do Pipedrive (pipeline, estágios, campos personalizados) em `config/pipedrive.placeholders.ts`.
- [ ] Fase 0 (fora do código): aplicar a convenção de UTMs em todos os anúncios.

### Concluído

- [x] Ferramenta de dump: `pg_dump` 17.11 instalado em `C:\PostgreSQL17\bin` (2026-10-03); `scripts/dump.ps1` o localiza.
- [x] `db push` das migrations 0001 e 0002 executado em 2026-10-03, com dump prévio (`backups/dump-20261003-222344.sql`) e SQL aprovado.
- [x] Deploy na Vercel (`gru1`) com `SUPABASE_DB_URL`, `SUPABASE_PROJECT_REF` e `SHADOW_MODE` (2026-10-03). Imports ESM corrigidos (`.js`) e variáveis reenviadas sem `CRLF`.
- [x] Duas fontes de teste registradas; smoke test em produção pelos caminhos sem escrita (405, 401, honeypot 200, 400, OPTIONS 204).
- [x] Quark Studio e modo simulação (`dryRun`) entregues (2026-10-04).

### Notas técnicas

- `TRUNCATE` em `orq.events`: hoje o Postgres já barra por causa da FK de `orq.decisions` (erro `0A000`); o trigger é a segunda barreira, e o teste de integração aceita os dois códigos.
- Falha de uma função em produção cai em erro `ERR_MODULE_NOT_FOUND` se um import relativo ficar sem `.js`: o Vitest não acusa, só a execução na Vercel.
