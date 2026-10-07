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
- **Produção (Vercel):** projeto `quark-orquestrador`, conta `pablomenezes-9499`, endpoint `https://quark-orquestrador.vercel.app/api/ingest`, região `gru1`, **modo sombra**. A Deployment Protection está em **Standard Protection** (`all_except_custom_domains`), conferida na API da Vercel em 2026-10-04: o **domínio de produção `quark-orquestrador.vercel.app` é público** (responde sem login), enquanto as URLs únicas de cada deploy e os previews exigem login da Vercel. **Correção:** até 2026-10-04 este documento afirmava que o endpoint estava atrás do login; isso era falso, porque os testes usavam a `vercel curl`, que atravessa a proteção. Plano da conta: **Hobby** (ver pendência P-02).
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
| `INGEST_DB_URL` | Conexão do **endpoint público**: papel `orq_ingest` (privilégio mínimo), pooler, porta 5432. **Secreta.** Gerada e gravada por `node scripts/set-ingest-password.mjs --apply` (nunca o `postgres`; o endpoint recusa outro usuário) |
| `RATE_LIMIT_SALT` | Sal secreto dos contadores de limite (o IP vai ao banco só como hash). Gerado pelo mesmo script |

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
| `raw` | *(proposto, Data Hub, seção 18)* Payload original do Pipedrive, uma tabela por entidade |
| `ops` | *(proposto, Data Hub, seção 18)* Controle da sincronização e configuração editável (pipeline → produto, etapa → marco, nomes de campos) |

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
- **Limite de requisições** (item 4): contador no Postgres (`orq.rate_limits`), por IP (fontes de navegador) e por fonte, contado só **depois** de autenticar; excedeu = `429` com `Retry-After`; falha do contador = falha aberta (o lead entra). Mais uma regra de firewall da Vercel (borda), a aplicar com aprovação
- **Papel de banco mínimo** `orq_ingest` para o endpoint (migration `0003`): privilégios por coluna, sem UPDATE/DELETE em eventos, sem acesso ao `crm`, sem ler o conteúdo dos eventos, `statement_timeout` de 15 s. O endpoint **recusa** conectar com `postgres`
- **CORS por origem**: só origens de `orq.sources.url` recebem permissão; POST de navegador com `Origin` não cadastrada leva `403`. Chamadas servidor a servidor (sem `Origin`) seguem, protegidas por token e limite. A checagem de origem barra o uso do token por *outros sites*, não por scripts fora do navegador
- JSON malformado devolve `400 invalid_json` (antes: `500`); requisição sem token devolve `401` sem consultar o banco
- Honeypot `website_hp` contra bots nos formulários públicos (implementado: responde 200 sem gravar)
- Registro do consentimento LGPD em cada evento (implementado, em `orq.events.dados.consent`)
- Chave de serviço do Supabase apenas no servidor
- RLS ativo; o dashboard usa papel somente leitura e só acessa `analytics`
- **Deployment Protection em Standard Protection**: produção pública, deploys únicos e previews protegidos. O endpoint de produção **está acessível a qualquer pessoa na internet**; a defesa é a da própria aplicação (token, honeypot, validação), a ser reforçada no item 4. Corpo máximo de 100 KB. Trava de alvo do banco (`src/db/guard.ts`) recusa conectar a um projeto que não seja o do `SUPABASE_PROJECT_REF`
- Endpoint em modo sombra: o código não tem caminho de execução real (`SHADOW_MODE` precisa ser `true`)

## 14. Plano de migração

Não há ambiente de testes separado (seção 4). O "modo sombra" faz o papel de ambiente seguro: o orquestrador roda com dados reais, mas **só grava em `orq.decisions` e nunca executa ação** no Pipedrive, na Umbler, na Meta ou no Google.

1. Subir o orquestrador em **modo sombra**: recebe, identifica e decide, mas não executa. O Make continua rodando.
2. Comparar decisões do modo sombra com o que o Make fez por uma a duas semanas (view `saude_orquestrador`).
3. Trocar uma fonte de `sombra` para `real` somente com aprovação explícita do Pablo. Antes de cada troca: dump do banco (seção 4, regra 2).
4. Desligar o Make fonte por fonte, nesta ordem: Vercel, Lovable, Fillout, Elementor, Meta Lead Ads.
5. Só desligar o último cenário depois de migrar o projeto para o plano pago do Supabase.

Como os dados de teste não podem ficar no banco (regra 5), o período em sombra só contém eventos **reais** dos formulários. Os testes manuais usam a **simulação** do Quark Studio, que não grava.

As fontes reais **já conseguem** chegar ao endpoint de produção (o domínio é público). O pré-requisito para abri-las de fato é o reforço de segurança do item 4 (papel de banco mínimo, CORS por origem, limite de requisições), ver seção 15.

## 15. Fases de entrega

Status: `pendente`, `em andamento`, `concluída`. Atualizar a cada entrega.

| Fase | Entrega | Status |
|---|---|---|
| 0 | Convenção de UTMs aplicada em todos os anúncios | pendente (fora do código) |
| 1 | Script de atribuição e dataLayer no GTM; GA4 e Pixel configurados | em andamento: script, testes (jsdom) e guia entregues (2026-10-02); já exercitado no Studio; falta validar num GTM real e configurar GA4 e Pixel |
| 2 | Migrations dos schemas `core`, `orq` e `crm` no projeto Supabase | **concluída** (2026-10-03): `0001` e `0002` aplicadas após dump e aprovação do SQL; `public` intacto; testes de integração passando com rollback |
| 3 | Endpoint único, adaptadores de entrada (Vercel e Elementor), identificação e log em modo sombra | em andamento: **no ar** em `https://quark-orquestrador.vercel.app/api/ingest` (`gru1`, modo sombra, Standard Protection: produção pública) desde 2026-10-03; 2 fontes de teste registradas; smoke test em produção ok pelos caminhos sem escrita. Faltam: o reforço de segurança do item 4, o primeiro envio real gravado e as demais pendências da seção 17 |
| 3b | Quark Studio: ambiente de testes local com simulação (extra, fora do plano original) | **concluída e congelada** (2026-10-04): construtor, formulário estilo Typeform com UTMs e modo simulação; validado de ponta a ponta contra o banco real sem gravar. Única correção permitida: rodar sozinho com `npm run studio` (item 1 abaixo). Nenhuma funcionalidade nova |
| 4 | Motor de regras em tabela + adaptadores Pipedrive e Umbler | pendente |
| 5 | Diagnóstico como qualificador (ciclo com `lid`) | pendente |
| 6 | Migração gradual do Make | pendente |
| 7 | CAPI e conversões offline do Google Ads | pendente |
| 8 | Sincronizações de `mkt` e views de `analytics` para o dashboard | pendente |
| 9 | Canvas visual de regras | pendente |

### Ordem de trabalho vigente (ajuste de rota, 2026-10-04)

**Diagnóstico (do Pablo, 2026-10-04):** o projeto está tecnicamente sólido, mas nenhuma fonte real consegue entregar um lead (P-01). *Nota de 2026-10-04, item 3: a premissa do P-01 não se confirmou; o domínio de produção é público e as fontes já alcançam o endpoint. O que falta é torná-lo seguro para o público (item 4).* A prioridade é colocar o **primeiro lead real no banco com segurança**. **Nada novo entra antes disso.** Ao fim de cada item, parar e aguardar a confirmação do Pablo.

| # | Item | Tipo | Status |
|---|---|---|---|
| 1 | **Studio congelado.** Rodar sozinho no PowerShell com `npm run studio`; ao subir, checar `.env.local`, conexão com o banco e porta livre, explicando em português o que falta. Documentar em `studio/README.md`. Nenhuma funcionalidade nova | código mínimo | **feito (2026-10-04), aguardando confirmação do Pablo** |
| 2 | **Backup do código.** Repositório privado no GitHub e `push` (o Pablo faz a autenticação). Antes: confirmar `.env.local` e `backups/` no `.gitignore` | guia | **feito (2026-10-04), aguardando confirmação do Pablo** |
| 3 | **P-01, só análise.** Verificar o nível de Deployment Protection ativo. Comparar as opções (a), (b), (c) e a alternativa **(d)**: proteção padrão (previews protegidos, domínio de produção público) com a defesa da produção na própria aplicação. Segurança, custo, manutenção e recomendação. **Não implementar antes da aprovação.** A opção (a) só é aceitável se o segredo não ficar exposto em páginas públicas | análise | **análise feita (2026-10-04); recomendação: manter (d), que já é o estado atual; aguardando aprovação do Pablo** |
| 4 | **Segurança para abrir ao público**, junto com a solução do item 3: papel de banco com privilégio mínimo (sem `postgres`); CORS restrito às origens de `orq.sources.url`; limite de requisições sem Redis (contador no Postgres, firewall da Vercel ou outro, com o custo de cada um). SQL mostrado e confirmado antes de qualquer `db push` | código + migration | **feito e no ar (2026-10-04)**: migration `0003` aplicada após dump; 10 testes de privilégio mínimo passam dentro do banco; produção usa só `orq_ingest` (o `postgres` foi removido da Vercel); smoke test em produção ok. Pendente só a regra de firewall da Vercel (precisa da aprovação do Pablo) |
| 5 | **LGPD.** Proposta de política de eliminação/anonimização a pedido do titular, compatível com a imutabilidade de `orq.events`. Só proposta | proposta | pendente |
| 6 | **Primeiro lead real.** Depois dos itens 3 e 4 aprovados e aplicados: envio do Pablo, identificável, pela LP da Vercel; confirmar lead, touchpoint, evento e decisão gravados | guia + verificação | pendente |
| 7 | **Fase 1 no mundo real.** Preencher `ownDomains` (domínios abaixo); guiar a validação do script num GTM real (`tracking/INSTALL.md`, seção 5); registrar as fontes reais | código mínimo + guia | pendente |

Domínios do item 7 (`ownDomains`): `quarkrh-diagnostico.lovable.app`, `quarkrh.com.br` (cobre `/quarkrh-sistema-de-rh-completo/`, `/funcionalidades/` e `/lp-agendar-demonstracao/`).

**Só depois dos 7 itens:** adaptadores de entrada do Lovable e da Meta (o Fillout não foi citado nesta lista; confirmar com o Pablo) e a Fase 4.

### Data Hub do Pipedrive (comando do Pablo de 2026-10-05, em paralelo à ordem acima)

Expande o projeto com a camada de dados de CRM para análise: todo o histórico do Pipedrive desde 2025-01-01, atualizado a cada 4 horas, mais um **Painel de Dados** no Studio. Regras e achados da API na **seção 18**; plano completo em `docs/datahub/entrega-0-plano.md`. Cada entrega só termina com a **definição de pronto** (seção 18) e o "conferido" do Pablo. Meta Ads e Google Ads vêm depois, em outros comandos.

| Entrega | O que | Status |
|---|---|---|
| 0 | Auditoria e plano (sem código): tabelas propostas, endpoints, volume, chamadas, onde rodar, credenciais, limitações | **aprovada pelo Pablo (2026-10-05)** |
| 1 | Pipelines, etapas, usuários e tela de configuração (pipeline → produto, etapa → marco) | **entregue (2026-10-06), aguardando o "conferido" do Pablo**: sincronização real feita (8 pipelines, 43 etapas, 15 usuários, 249 definições de campos; 0 falhas; 2ª rodada ignorou tudo); Painel validado com os dados reais, inclusive gravar a configuração pela tela; migration `0004` aplicada. **Ajuste de regras em 2026-10-07 (D-36):** status do negócio decide ganho/perdido/aberto/excluído, MQL por motivo de perda, "conta como lead" por status; migration `0005` **aplicada em 2026-10-07** (dump `backups/dump-20261007-120614.sql` antes; aprovada pelo Pablo); 416 testes passando (nenhum pulado); tela validada no navegador com dados reais. O Pablo ainda precisa conferir e preencher a aba Configuração |
| 2 | Deals: backfill retomável desde 2025-01-01, campos personalizados, ligação com `core.leads` | **entregue (2026-10-07), aguardando o "conferido" do Pablo**: migration `0006` aplicada (dump `backups/dump-20261007-135723.sql`); **carga inicial real concluída: 39.432 negócios normais + 6 arquivados + 112 excluídos, 0 falhas, 840 unidades da cota (de 1.800.000/dia)**; 2ª rodada trouxe só os ~26 negócios que mudaram (10 unidades); conferência com o Pipedrive negócio a negócio: **bate** (`scripts/datahub-reconcile.ts`); aba **Negócios** no Painel (resumo por pipeline, lista com filtros, ficha com campos personalizados); 457 testes passando. Vínculo com `core.leads` passou para a Entrega 3 (D-37). Migration `0007` (nome da opção nos campos de lista) escrita e validada, **aguardando confirmação do SQL** |
| 3 | Pessoas e empresas, e vínculo negócio → lead do orquestrador | **em andamento (2026-10-07)**: sondagem feita (35.428 pessoas, 23.146 empresas; o Pipedrive não lista excluídas, D-38); migrations `0007` e `0008` escritas e validadas em transação desfeita, **aguardando a confirmação do SQL pelo Pablo** |
| 4 | Atividades | pendente |
| 5 | Histórico de etapas (a mais importante) | pendente |
| 6 | Sincronização automática a cada 4 horas, excluídos/mesclados, alerta de 8 horas | pendente |
| 7 | Primeiras análises (funil, conversão, tempo por etapa, motivos de perda, origem, responsável) | pendente |

## 16. Convenções de código

- **Regra de escopo:** nada fora da seção 15 é construído sem aprovação prévia do Pablo. Ao identificar uma ferramenta ou melhoria útil, propor em **até 5 linhas** (problema, solução, custo em tempo, o que atrasa) e **aguardar a resposta** antes de qualquer código.
- **Data Hub:** regras 7 a 12 e a definição de pronto estão na seção 18. Ali valem, além das regras de sempre: Pipedrive só leitura, dado real permitido (de teste não), nada descartado na origem, IDs sempre, `produto` nunca misturado em silêncio e documentação atual da API antes de cada entidade.
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
| Repositório | `C:\Users\Esig\Documents\quark-orquestrador` (git local), branch `main`. **Backup:** GitHub privado `pablomenezzes/quark-orquestrador` (`origin`) |
| Ordem de trabalho | Seção 15, itens 1 a 7. Itens 1 e 2 feitos (2 aguardando confirmação); próximo: item 3 (análise do P-01, sem implementar) |
| Data Hub (Pipedrive) | Autorizado em 2026-10-05. **Entrega 0 aprovada. Entrega 1 entregue** (aguardando "conferido"): conta `quarktec.pipedrive.com`; no banco já estão 8 pipelines, 43 etapas, 15 usuários e 249 definições de campos (original em `raw` e normalizado em `crm`). Cota gasta: 70 unidades por rodada completa. Plano: `docs/datahub/entrega-0-plano.md` |
| Banco | Supabase "Orquestrador CRM Quark" (São Paulo), migrations `0001` a `0005` aplicadas (`0003` papel do endpoint, `0004` Data Hub E1, `0005` regras do funil). Dados: `orq.sources` (2 fontes de teste) e **1 lead de teste do Pablo** gravado pelo Studio em modo "gravar" em 2026-10-04 12:20Z (formulário `demo-rh`, `lp_id` `studio-demo-rh`, canal `direct`, `landing_url` de `127.0.0.1`): 1 lead, 1 touchpoint, 1 evento, 1 decisão. É permanente (eventos imutáveis) e entra na política de LGPD (item 5). Demais tabelas com 0 linhas. `public` com 0 tabelas |
| Fontes registradas | `lp-vercel-rh-teste` (vercel) e `elementor-site-rh` (elementor). Tokens só no `.env.local` |
| Produção | `https://quark-orquestrador.vercel.app/api/ingest`, `gru1`, modo sombra, Standard Protection (**produção pública**), plano **Hobby** (uso não comercial, ver P-02) |
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
| D-22 | ~~A Deployment Protection não é desligada para liberar o endpoint.~~ **Revisada no item 3 (2026-10-04):** a proteção ativa já é a Standard Protection, em que a produção é pública; nada precisa ser desligado. A decisão fica: **não enfraquecer a proteção dos previews e deploys únicos** e reforçar a defesa na aplicação (item 4). Aguardando aprovação formal da recomendação (d) | 2026-10-04 |
| D-23 | Fontes são registradas por `scripts/register-source.ts` (simulação por padrão, `--apply` grava só o hash); com `--save-env` o token vai direto ao `.env.local`, sem aparecer na tela | 2026-10-04 |
| D-24 | Senha do banco com caracteres especiais é codificada na URL (percent-encoding) por `scripts/encode-db-url.mjs`, sem alterar a senha | 2026-10-03 |
| D-25 | A CLI do Supabase exige `sslmode=require` na conexão pelo pooler; `scripts/db-push.ps1` acrescenta sozinho | 2026-10-03 |
| D-26 | **Ajuste de rota:** a prioridade é o primeiro lead real no banco com segurança; nada novo antes disso. Ordem de trabalho na seção 15 (itens 1 a 7), com parada e confirmação do Pablo ao fim de cada item | 2026-10-04 |
| D-27 | **Regra de escopo** (seção 16): nada fora da seção 15 é construído sem aprovação prévia; melhorias são propostas em até 5 linhas e aguardam resposta | 2026-10-04 |
| D-28 | **Studio congelado:** só a correção de execução autônoma (`npm run studio` com checagens e mensagens em português). Nenhuma funcionalidade nova | 2026-10-04 |
| D-29 | **Data Hub autorizado** (2026-10-05): a ordem 1 a 7 da seção 15 continua valendo, mas o Pablo abriu esta frente em paralelo. As regras 7 a 12 (Pipedrive só leitura, dado real permitido, nada descartado, IDs sempre, `produto` nunca em silêncio, documentação atual) valem para ela (seção 18) | 2026-10-05 |
| D-30 | **O congelamento do Studio (D-28) é suspenso só para a área "Painel de Dados"**; nada mais no Studio muda | 2026-10-05 |
| D-31 | **Plano da Entrega 0 aprovado** (2026-10-05): `raw`/`crm`/`ops`/`analytics` com os papéis `orq_sync` e `orq_panel`; sincronização no GitHub Actions; histórico guardando só as mudanças do deal (`dealChange`); token do Pipedrive (usuário dedicado só de visualização, se possível); Painel liberado no Studio | 2026-10-05 |
| D-32 | **Leitor do Pipedrive somente leitura por construção**: a classe não tem nenhum método de escrita, a única chamada de rede usa o método de leitura, só fala com `*.pipedrive.com`, o token vai no cabeçalho (nunca na URL) e testes automáticos provam cada ponto (inclusive lendo o código-fonte) | 2026-10-05 |
| D-33 | **Interpretação tolerante dos registros**: a documentação oficial não enumera os campos de pipelines, etapas, usuários e definições de campos, então os leitores aceitam as variações v1/v2 e deixam `null` quando falta algo. O JSON original **sempre** é guardado em `raw`, então qualquer ajuste pode ser reaplicado sem consultar o Pipedrive de novo | 2026-10-05 |
| D-34 | **Painel só lê `analytics`/`ops` e só grava a configuração**; usuários aparecem sem e-mail; a view de campos junta o nome do Pipedrive com o seu rótulo (`analytics.usuarios` e `analytics.campos` acrescentadas à proposta) | 2026-10-05 |
| D-35 | Testes têm limite de **30 s** (antes 5 s): os de integração falam com o banco pela internet e davam falso alarme em rede lenta. A permissão do `orq_sync` de ler 3 colunas de `core.leads` fica para a Entrega 2 (é onde ela é usada) | 2026-10-05 |
| D-36 | **Regras de negócio do funil (Pablo, 2026-10-07).** (1) **Ganho, perdido, aberto e excluído vêm só do `status` do negócio**, nunca da etapa: um vendedor pode dar ganho em Proposta e todo negócio pode ser perdido em qualquer etapa. (2) **MQL não é etapa**: é todo negócio que **não** foi perdido por um dos motivos de perda **398** (Lead Invalido), **185** (Cliente em Busca de Suporte), **184** (Contato Inexistente) e **587** (Oportunidade Duplicada); abertos, ganhos e perdidos por outro motivo contam como MQL. Os IDs são os da opção do campo `lost_reason` e ficam em `ops.cfg_motivo_perda`, editáveis no Painel. (3) **Cada status (`open`, `won`, `lost`, `deleted`) tem a chave "conta como lead?"** em `ops.cfg_status_contagem`; `deleted` começa **fora** da contagem. (4) Por isso a etapa só guarda **"chegou até aqui"** (`sql`, `reuniao`, `proposta`); `lead`, `mql`, `ganho` e `perdido` deixam de ser marcos de etapa. Migration `0005` (aditiva: acrescenta uma restrição em vez de trocar a antiga). **Confirmado pelo Pablo (2026-10-07):** o MQL vale para **todos** os pipelines (restringe-se depois pelo produto) e a data do MQL é a **data de criação** do negócio |
| D-38 | **Entrega 3 (pessoas e empresas).** (1) O Pipedrive não lista excluídas: **varredura** da lista completa marca `is_deleted` em quem sumiu (excluído ou mesclado), sem apagar. (2) Guardam-se **todos** os e-mails e telefones (arrays normalizados com GIN) além do JSON. (3) O vínculo negócio → lead usa **qualquer** e-mail ou telefone da pessoa e pode dar mais de um lead (`crm.deal_lead_links`, chave `deal_id + lead_id + vinculado_por`). (4) O Painel não vê e-mail nem telefone, só "tem/quantos". (5) `0007` (nome da opção nos campos de lista) vai junto na mesma aprovação | 2026-10-07 |
| D-37 | **Entrega 2 (deals), ajustes ao plano aprovado.** (1) Excluído guarda `status` nulo, `is_deleted = true` e `status_original` (a restrição `open\|won\|lost` não muda); `analytics.deals` mostra `deleted` como quarto status. (2) O motivo de perda vem como texto; grava-se também o **ID** (`motivo_perda_id`), obtido casando o texto com as opções do campo. (3) `is_mql` é calculado na view: conta como lead **e** não foi perdido por motivo marcado. (4) O **vínculo deal → lead** (`crm.deal_lead_links`) e a leitura de 3 colunas de `core.leads` passam para a **Entrega 3**, pois dependem do e-mail/telefone da pessoa; nada é concedido em `core` antes de ser usado. (5) Extração **incremental** (explicada ao Pablo): marca-d'água por `updated_since` com folga, hash para não regravar, arquivados e excluídos em listas próprias, histórico só de deals que mudaram de etapa; cadastros (pipelines, etapas, usuários, campos) 1×/dia | 2026-10-07 | 2026-10-07 |

### Pendências

Ordem vigente: **seção 15, itens 1 a 7**. As pendências abaixo apontam para o item que as resolve. Parar e aguardar a confirmação do Pablo ao fim de cada item.

**Caminho até o primeiro lead real**

- [x] **Item 1 — Studio rodando sozinho** (2026-10-04): `npm run studio` confere Node, `.env.local`, variáveis, banco e porta, lista todos os problemas de uma vez em português e não sobe se algo falhar. Testado em execução real: caminho feliz, porta ocupada, `.env.local` ausente, senha errada e variáveis vazias. Documentado em `studio/README.md`. Aguardando confirmação do Pablo.
- [x] **Item 2 — Backup no GitHub** (2026-10-04): repositório privado `https://github.com/pablomenezzes/quark-orquestrador`, branch `main` enviada pelo Pablo (autenticação dele, via Git Credential Manager). Conferido: remoto e local no mesmo commit; `.env.local`, `backups/`, `.vercel/` e `node_modules/` fora do repositório; nenhum valor secreto no histórico (varredura sem imprimir valores); `.gitignore` corrigido (a regra `.env*` anulava a exceção do `.env.example`). Aguardando confirmação do Pablo. **Limite:** o `git push` precisa ser feito pelo Pablo num PowerShell dele só na primeira vez; depois o login fica guardado no Windows.
- [x] **Item 3 / P-01 — Análise feita (2026-10-04), aguardando aprovação.** Fatos: a proteção ativa é **Standard Protection** (`all_except_custom_domains`); o domínio de produção `quark-orquestrador.vercel.app` é **público** (confirmado sem login: GET 405, POST com token certo no caminho do honeypot 200, token errado 401), e as URLs únicas de deploy redirecionam ao login da Vercel. A premissa do P-01 ("nenhuma fonte consegue entregar") **não se confirmou**; a causa do erro foi testar só pela `vercel curl`. **Recomendação: (d)** = manter como está (já é o estado atual) e reforçar a defesa na aplicação (item 4). (a) *Protection Bypass* é desnecessária e inaceitável para LPs (segredo em página pública); (b) domínio próprio é opcional (visual/estabilidade), não é segurança; (c) proxy só acrescentaria um ponto de falha. Nada foi implementado.
- [ ] **P-02 — Plano Hobby da Vercel é para uso pessoal e não comercial** (regras de uso justo da Vercel). A Quark é uma empresa e o endpoint vai receber leads reais: o correto é o plano **Pro (US$ 20 por usuário/mês, 1 assento)** antes do item 6. Ganhos relevantes: logs de execução de 1 dia em vez de 1 hora, regras de firewall (40 em vez de 3; limite de requisições 40 em vez de 1), controle de gastos e suporte. Decisão do Pablo.
- [ ] **Achados do item 3 para o item 4:** (1) **JSON malformado devolve 500** em vez de 400 (confirmado em produção; ruído nos logs e falso alarme de erro); (2) **o token da LP da Vercel é público por natureza** (fica no JavaScript da página): qualquer pessoa pode copiá-lo e enviar leads falsos, e como `orq.events` é imutável o lixo seria permanente; mitigar com limite de requisições, checagem de origem e teto por fonte; (3) CORS reflete qualquer origem; (4) o endpoint ainda usa o usuário `postgres`.
- [x] **Item 4 — Segurança para abrir ao público** (2026-10-04): papel `orq_ingest`, CORS por origem, limite de requisições no Postgres, `400` para JSON inválido e `401` sem token sem consultar o banco, tudo aplicado e no ar. Conferido em produção sem login: sem token 401; token certo 200; JSON inválido 400; origem não cadastrada 403. **Sobra:** regra de firewall da Vercel (60 requisições/min por IP em `/api/ingest`; aguarda aprovação) e o cadastro da origem da LP quando houver LP de navegador (`scripts/set-source-url.mjs`).
- [ ] **Item 5 — LGPD x imutabilidade:** `orq.events` é imutável e guarda o `payload_bruto` com dados pessoais. Só proposta de política de eliminação/anonimização a pedido do titular; qualquer solução que mexa na imutabilidade exige aprovação.
- [ ] **Item 6 — Primeiro envio real gravado** pela LP da Vercel (o caminho de escrita está provado por testes de integração, mas não por HTTP em produção). Envio do Pablo, identificável. **Atenção:** já existe um lead de teste com o e-mail do Pablo (gravado pelo Studio em 2026-10-04); um envio com o mesmo e-mail será **deduplicado** para esse lead (`matched_by: email`), o que também testa a regra da seção 10. Para ver um lead novo, usar outro e-mail.
- [ ] **Item 7 — Fase 1 no mundo real:** `ownDomains` em `config/channel-rules.ts`; validar o script num GTM real (`tracking/INSTALL.md`, seção 5); registrar as fontes reais (hoje só as 2 de teste) com `scripts/register-source.ts`; configurar GA4 e Pixel.

**Data Hub do Pipedrive (aguardando o Pablo)**

- [x] **Plano da Entrega 0 aprovado pelo Pablo (2026-10-05)**: (1) organização das tabelas e dos 2 papéis; (2) sincronização no **GitHub Actions**; (3) histórico guardando só as mudanças do deal; (4) token do Pipedrive, de preferência de um usuário dedicado só de visualização; (5) congelamento do Studio suspenso só para o Painel de Dados.
- [ ] **Entrega 1, o que falta de você:** conferir no Painel com o Pipedrive (roteiro de 5 passos entregue em 2026-10-06), preencher na aba Configuração o **produto de cada pipeline** e, se quiser, o **"chegou até aqui"** (SQL, reunião, proposta) de cada etapa, conferir as **regras de MQL e de contagem de leads por status** (D-36; migration `0005` já aplicada) e dizer "conferido". O Pablo já começou: QuarkClinic = Clínica e QuarkRH = RH. Sugestões que o Pablo decide: QuarkRH → RH; QuarkClinic e "Prospecção Outbound [QuarkClinic]" → Clínica; os outros 5 pipelines (Conversão RD, [MKT] Inbound Ativo, Parcerias, CARBONE, Disparos Marketing) dependem do negócio.
- [x] **Entrega 2 conferida pelo Pablo (2026-10-07).** A migration `0007` (nome das opções nos campos de lista) segue aguardando a confirmação do SQL, junto com a `0008` da Entrega 3.
- [x] ~~**Dados do Pipedrive** (nada secreto) para a Entrega 2~~ — obtidos por sondagem somente leitura (cota 1.800.000/dia; 39 mil negócios; ver "Achados da Entrega 2"). Texto original: plano e nº de usuários, contagens desde 2025-01-01 (deals, pessoas, organizações, atividades), nº de pipelines e se usam "arquivar". Com eles a estimativa de espaço e de dias de backfill deixa de ser cenário.
- [ ] Decidir quando migrar o Supabase para o plano pago (a partir de ~10 mil deals o gratuito não comporta; sem backup automático no gratuito).
- [x] Linter das migrations aceita `raw` e `ops` (feito na Entrega 1, com testes que o provam).

**Elementor pelo navegador (em espera)**

- [ ] Proposta de capturar todo formulário do Elementor com um script global (sem campos ocultos nem webhook por formulário) foi apresentada em 2026-10-05 e **aguarda o "aprovo"** do Pablo. Nada foi construído. O bloco `tracking/elementor-head.html` e o caminho do webhook continuam prontos como plano B.

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

## 18. Data Hub (CRM e, depois, mídia)

Camada de dados para análise, ao lado do orquestrador. Primeiro o **Pipedrive**; Meta Ads e Google Ads em comandos próprios. Plano completo: `docs/datahub/entrega-0-plano.md`. SQL proposto (não aplicado): `docs/datahub/proposta-schema.sql`.

### Regras desta frente (além das regras da seção 4)

7. **Pipedrive somente leitura.** Nenhuma chamada que crie, altere ou apague algo. O cliente da API desta frente **não expõe métodos de escrita**, e um teste automatizado prova isso. (O token pessoal do Pipedrive tem as permissões do usuário; por isso o ideal é um usuário dedicado só com visualização.)
8. **Dado real é permitido, dado de teste não.** O que vem do Pipedrive é real e fica no banco. Testes automatizados continuam com dados fictícios e rollback.
9. **Nada é descartado na origem.** Todo registro guarda o payload original além das colunas extraídas. Campos personalizados guardam o ID original e têm tabela à parte de nomes legíveis.
10. **IDs sempre.** Nunca só o nome de pipeline, etapa, usuário ou campo: ID e nome juntos.
11. **Produto nunca misturado em silêncio.** `produto` usa os valores de `core.leads` (`rh`, `clinic`) ou `null`. A relação `pipeline_id → produto` vive num único lugar (`ops.cfg_pipeline_produto`), editável no Painel; `produto` e `marco` são **calculados na consulta** a partir dela.
12. **Documentação atual da API antes de cada entidade.** O que foi achado fica registrado aqui.
13. **Status, MQL e contagem de leads (D-36).** O desfecho do negócio é o `status` (`open`, `won`, `lost`, `deleted`); a etapa nunca decide ganho/perdido. MQL = não perdido pelos motivos marcados em `ops.cfg_motivo_perda` (IDs 398, 185, 184, 587 de início). Quais status entram na contagem de leads é configuração (`ops.cfg_status_contagem`), calculada na consulta, sem reprocessar. **A verificar na Entrega 2:** se o negócio traz o motivo de perda como texto ou como ID (a opção tem os dois: `{"id":398,"label":"Lead Invalido"}`); gravar sempre o ID, casando pelo nome da opção quando vier texto, e registrar aqui o que a API devolver. Também confirmar se `deleted` chega como `status` ou só como `is_deleted`; o banco trata os dois como "excluído".

### Definição de pronto (toda entrega)

1. Testes automatizados passando, incluindo os novos. 2. **Reconciliação** com o Pipedrive (contagens por pipeline, status e período; diferenças explicadas). 3. Tela no Painel onde o Pablo vê o resultado. 4. **Roteiro de verificação** para o Pablo, em até 5 passos, em linguagem simples. 5. MD atualizado (seções 15 e 17), commit e push. Ao fim: parar e esperar o "conferido".

### Organização proposta (aguardando aprovação)

`raw` (payload original) → `crm` (normalizadas; `crm.deals` e `crm.stage_history` evoluem **só com `ADD COLUMN`**) → `analytics` (**só views**), com `ops` para controle e configuração. Dois papéis novos: `orq_sync` (grava, não apaga) e `orq_panel` (lê `analytics`/`ops`, grava só configuração, não vê tabelas com dados pessoais). Uma migration por entrega. `crm.deals.status` continua `open|won|lost` e o **excluído** é `is_deleted`; na análise, `deleted` é tratado como um quarto status (D-36), com a chave "conta como lead" em `ops.cfg_status_contagem`. O linter das migrations passa a aceitar `raw` e `ops` na Entrega 1.

### O que a documentação atual do Pipedrive diz (consultada em 2026-10-05)

- **API v2** cobre deals, pessoas, empresas, atividades, pipelines, etapas e definição de campos. Paginação por **cursor**, até **500** por página; filtros `updated_since` e `updated_until` (RFC 3339). Os endpoints v1 equivalentes foram descontinuados (efetivo em 2026-01-01; sem garantia depois de 2025-12-31).
- **Histórico do deal (`GET /v1/deals/{id}/flow`) existe só na v1**, por deal, e **não está** na lista de descontinuados. A mudança de etapa vem como `dealChange` com `field_key = stage_id`, valor antigo e novo. **Usuários** também só na v1 (`/v1/users`, não descontinuado).
- **Deals arquivados** (desde 2025-07-15) **não aparecem** nas listas comuns; usar `GET /api/v2/deals/archived`.
- **Excluídos:** `is_deleted`; o Pipedrive apaga de vez após 30 dias. `status` aceita `open`, `won`, `lost`, `deleted`.
- **Cota diária** = 30.000 × multiplicador do plano (Lite 1, Growth 2, Premium 5, Ultimate 7) × usuários, zerada à meia-noite, **compartilhada com o Make**. Limite por 2 segundos: token pessoal 20/40/100/120; OAuth 80/160/400/480. Custos: lista v2 de deals 10; arquivados 20; deal individual 1; atividades 10; **`flow` 40**; resposta de limite: HTTP 429 com `x-ratelimit-*`.
- **Escopos OAuth** só de leitura que cobrem tudo: `deals:read`, `contacts:read`, `activities:read`, `users:read`, `recents:read`.
- **Campos personalizados** na v2 vêm em `custom_fields`, com chave de 40 caracteres.
- **Onde rodar:** Vercel Hobby só aceita cron **1 vez por dia**; GitHub Actions dá **2.000 min/mês grátis** em repositório privado; Supabase gratuito: **500 MB** de banco.

### Achados adicionais da Entrega 1 (2026-10-05)

- **Custos por chamada confirmados na documentação:** pipelines 5, etapas 5, definição de campos 10, usuários 20 (v1). Persons e organizations: a confirmar na Entrega 3.
- **A documentação não lista os campos de cada registro** dessas quatro entidades. Os leitores são tolerantes (D-33) e a primeira sincronização real vai mostrar a forma verdadeira dos dados; qualquer diferença é corrigida relendo o `raw`, sem nova consulta ao Pipedrive.
- **Usuários:** só existem na API v1 (`/v1/users`); não é paginado na documentação, mas o leitor segue `more_items_in_collection` se aparecer.
- **Autenticação:** o token pessoal segue válido; o Pipedrive recomenda OAuth para integrações novas. Mantemos o token com o guarda de somente leitura no código.

### Achados da Entrega 2 (sondagem somente leitura, 2026-10-07)

- **Volume desde 2025-01-01 (contagem mínima: a sondagem parou em 40 páginas de 500):** deals **> 20.000** (na amostra: 61 abertos, 1.171 ganhos, **18.768 perdidos**, ou seja, ~94% perdidos), **112 excluídos** (últimos 30 dias), **6 arquivados**; pessoas, organizações e atividades **> 15.000 cada**. Listar tudo custa pouco (10 unidades por página de 500); o custo grande é o **histórico de etapas**, 40 unidades por deal (≥ 800.000 unidades no total).
- **Cota real da conta** (cabeçalho `x-daily-ratelimit-token-limit`): **1.800.000 unidades/dia**; teto de burst 100 por 2 s. 40% = 720.000/dia ≈ 18.000 históricos de deal por dia.
- **Motivo de perda vem como TEXTO** (`lost_reason` = "Perda de prioridade"; em 261 casos veio como objeto): o ID é obtido casando o texto com as opções de `lost_reason` em `crm.field_definitions`; o que não casar fica com ID nulo e aparece na Conferência (D-37).
- **Excluídos:** a lista normal não os traz; `GET /api/v2/deals?status=deleted` traz os apagados nos últimos 30 dias (testado: 112). Mesclados: a documentação atual não mostra endpoint dedicado.
- Chaves do deal na v2: `id, title, creator_user_id, value, person_id, org_id, stage_id, currency, add_time, update_time, status, probability, lost_reason, close_time, pipeline_id, won_time, lost_time, stage_change_time, local_*_date, expected_close_date, custom_fields (objeto), owner_id, label_ids, is_deleted, origin, origin_id, channel, channel_id, acv, arr, mrr, is_archived, archive_time`.

### Achados da Entrega 3 (sondagem somente leitura, 2026-10-07)

- **Volume desde 2025-01-01:** **35.428 pessoas** (34.712 com e-mail, 35.272 com telefone, 31.823 ligadas a uma organização; até **15 e-mails e 20 telefones** numa só pessoa) e **23.146 organizações**. Listar custa ~710 e ~470 unidades (10 por página de 500).
- **Campos da pessoa (v2):** `id, name, first_name, last_name, add_time, update_time, visible_to, custom_fields, owner_id, label_ids, org_id, is_deleted, picture_id, phones, emails, im, postal_address, notes, job_title, birthday`. **Da organização:** `id, name, add_time, update_time, visible_to, custom_fields, owner_id, label_ids, website, linkedin, industry, annual_revenue, employee_count, is_deleted, address`. Telefone e e-mail vêm em listas `{value, primary, label}`.
- **O Pipedrive NÃO lista pessoas ou organizações excluídas:** os parâmetros `status` e `is_deleted` são recusados (HTTP 400) e nenhuma pessoa veio com `is_deleted = true`; excluídas são apagadas em 30 dias. **Solução (D-38):** uma *varredura* periódica relê a lista completa desde 2025-01-01 (só IDs; ~1.200 unidades) e **marca** `is_deleted` em quem sumiu (excluído ou mesclado), nunca apaga; trava de segurança se a lista vier suspeitamente menor.
- **Dados pessoais:** o JSON original (e-mails, telefones, notas, endereço, aniversário) fica em `raw`, acessível só ao `orq_sync`. O Painel enxerga apenas views **sem e-mail nem telefone** (só "tem e-mail", quantidade, nome, organização).
- **Vínculo com `core.leads`:** casa **todos os e-mails** e **todos os telefones** da pessoa (mesma normalização do orquestrador) com `core.leads.email_norm`/`phone_e164`, gravando em `crm.deal_lead_links` (nada muda em `core` nem `orq`). O `orq_sync` ganha leitura de **3 colunas** de `core.leads` (`id`, `email_norm`, `phone_e164`).

### Conferência da Entrega 2 (2026-10-07): negócios

- **Como extrai (já funcionando):** carga inicial retomável (cursor guardado a cada página, janela fixa `updated_since`..`updated_until`, datas **sem milissegundos**: o Pipedrive recusa com HTTP 400, descoberto na 1ª tentativa e coberto por teste); depois, só o que mudou desde a marca-d'água (recuo de 10 min), com hash para não regravar; arquivados (`/deals/archived`) e excluídos (`status=deleted`) em listas e marcas-d'água próprias. O cliente lê o cabeçalho de cota (`x-daily-ratelimit-token-*`) e **para sozinho** antes de a sincronização passar de 40% do dia (a cota é compartilhada com o Make).
- **Números reais (2026-10-07):** 39.432 negócios (QuarkRH 20.824 perdidos / 1.462 ganhos / ~275 abertos; QuarkClinic 15.129 / 850 / ~122; demais pipelines pequenos), 6 arquivados, 112 excluídos. Carga: 79 páginas, 790 unidades. Rodada incremental: 1 página, 10 unidades.
- **Conferência automática:** `npx tsx scripts/datahub-reconcile.ts` compara contagens por pipeline e status e, **negócio a negócio**, explica cada diferença (mudou depois da última sincronização) ou a aponta como sem explicação. Resultado: **0 sem explicação**. Diferenças de 1 a 3 negócios logo após uma rodada são só o time mexendo no Pipedrive.
- **Painel, aba Negócios:** totais por status e MQL, tabela por pipeline (para o Pablo comparar com o Pipedrive), lista com filtros (pipeline, status, só MQL, mês de criação, ID/título) e ficha do negócio (campos personalizados com o ID original). Só leitura.
- **Limitação conhecida:** campos de lista aparecem como número (ID da opção) até a migration `0007` ser aplicada; o nome da opção fica na coluna nova `valor_legivel`.
- **Linha do tempo de etapas** (histórico) é a Entrega 5; aqui só a etapa atual e `stage_change_time`.

### Conferência da Entrega 1 (2026-10-06): o que o banco tem hoje

| Item | Quantidade | Observação |
|---|---|---|
| Pipelines | 8 | todos ativos; QuarkRH (7 etapas), QuarkClinic (7), Conversão RD (1), Prospecção Outbound [QuarkClinic] (4), [MKT] Inbound Ativo (4), Parcerias (7), CARBONE (8), Disparos Marketing (5) |
| Etapas | 43 | todas ativas, todas com ordem e probabilidade |
| Usuários | 15 | todos ativos, nenhum sem nome ou e-mail |
| Campos de negócios | 134 | 84 personalizados (ID de 40 caracteres) |
| Campos de pessoas | 51 | 10 personalizados |
| Campos de organizações | 36 | 2 personalizados |
| Campos de atividades | 28 | nenhum personalizado |
| Sincronização | 7 itens, 0 falhas, 0 erros | 1ª rodada gravou tudo; 2ª ignorou tudo (hash igual). 70 unidades da cota por rodada completa |

- **O formato real bateu** com o que os leitores esperavam (v2: `is_deleted`, `order_nr`, `pipeline_id` etc.); o JSON original está em `raw`. Chaves vistas no usuário (`active_flag`, `is_admin`, `role_id`...) e no campo (`field_code`, `field_name`, `is_custom_field`, `subfields`...) ficam guardadas para quando precisarmos.
- Os nomes das etapas já trazem marcadores do funil (`[SQL]`, `[MCL]`, `[SAL]`, `[Prospect]`), úteis para o Pablo ligar cada etapa a um marco.