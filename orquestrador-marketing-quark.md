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
| Código | GitHub, desenvolvido com Claude Code. **O repositório `pablomenezzes/quark-orquestrador` é PÚBLICO (conferido em 2026-10-09)**: código, migrations e este documento são visíveis a qualquer pessoa; segredos nunca ficam no repositório (ver D-46) |
| Sincronização automática | GitHub Actions (`.github/workflows/sincronia.yml`), a cada 4 horas: Pipedrive e GA4, só leitura nas origens |
| Dados de tráfego e mídia | Google Analytics 4 (Data API, conta de serviço) e, a seguir, Google Ads (API) |

### Ambiente

- **Um único projeto Supabase**, região **South America (São Paulo)**, nome "Orquestrador CRM Quark". Não existe projeto de testes.
- O schema `public` deste projeto está **vazio**. O dashboard do QuarkRH fica em outra conta do Supabase, sem relação com este banco. Mesmo assim, por organização, **o orquestrador nunca usa o `public`** (regra 1 abaixo).
- Funções na Vercel rodam na região `gru1` (São Paulo), ao lado do banco.
- Como o projeto é único e vai receber dados reais, a segurança vem das regras abaixo, não de um ambiente separado.
- **Produção (Vercel):** projeto `quark-orquestrador`, conta `pablomenezes-9499`, endpoint `https://quark-orquestrador.vercel.app/api/ingest`, região `gru1`, **modo sombra**. **Desde 2026-10-26 o mesmo domínio também serve o Quark Dados (Monitor, Experimentos, BI, Painel), atrás de login (D-71 e D-72).** A Deployment Protection está em **Standard Protection** (`all_except_custom_domains`), conferida na API da Vercel em 2026-10-04: o **domínio de produção `quark-orquestrador.vercel.app` é público** (responde sem login), enquanto as URLs únicas de cada deploy e os previews exigem login da Vercel. **Correção:** até 2026-10-04 este documento afirmava que o endpoint estava atrás do login; isso era falso, porque os testes usavam a `vercel curl`, que atravessa a proteção. Plano da conta: **Hobby** (ver pendência P-02).
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
7. **Backup local SEMPRE em dia e conferido, e a nuvem é a única fonte da verdade (para nunca haver conflito).** O computador do Pablo mantém uma cópia dos mesmos dados da nuvem (Supabase), do mesmo código (GitHub) e das mesmas migrations:
   - **Backup do banco:** `npm run backup` (`scripts/backup-local.ps1`) gera `backups/nuvem-AAAAMMDD-HHMM.dump` (comprimido, ~12 MB: schemas `core, orq, crm, raw, ops, analytics, public` e o histórico `supabase_migrations`), **confere tabela por tabela** (`scripts/verificar-backup.mjs` conta as linhas dentro do arquivo e compara com a nuvem) e anota em `backups/ULTIMO_BACKUP.json` e `backups/backup.log`. Roda **todo dia às 03:00** pela tarefa do Windows `QuarkDados-BackupLocal` (`scripts/agendar-backup.ps1`; se o computador estava desligado, roda ao ligar). O dump `.sql` completo de antes de cada `db push` (regra 2) continua obrigatório.
   - **Quando rodar além do diário:** antes e depois de toda migration que mexe em dados, depois de toda carga grande (histórico, backfill, enxugamento) e antes de qualquer operação arriscada. O Claude **deve** rodar `npm run backup` nesses momentos e dizer o resultado.
   - **Sem conflito:** (a) a **nuvem manda**: nunca se edita uma cópia local para depois "subir" dados; restaurar um backup sobre a nuvem só com ordem expressa do Pablo; (b) o banco só muda por **migration versionada e aplicada via `db-push.ps1`** (regra 6), então arquivos de migration e nuvem andam juntos; (c) o código só muda por **commit + push** no GitHub, sempre com `git pull --rebase` antes se outra máquina mexeu; (d) segredos (`.env.local`) e `backups/` **nunca** vão para o git; (e) um **único escritor** de cada vez (um computador, uma sessão).
   - **Conferência de sincronia:** `npm run sincronia` (`scripts/sincronia.mjs`) diz em um relatório se **GitHub x computador** (commits adiante ou atrás, arquivos sem commit), **nuvem x migrations** (aplicadas, pendentes, ou na nuvem sem arquivo, que é conflito), **backup** (idade e conferência), **tarefa diária** e **segredos fora do git** estão em ordem. O Claude **deve** rodá-lo no início e no fim de cada sessão de trabalho e antes de qualquer `db push`.
   - **Retenção:** `-Prune` só apaga `nuvem-*.dump`, mantendo sempre os 7 mais recentes, todos com menos de 30 dias e os do dia 1 de cada mês. Nada mais é apagado automaticamente.
   - **Restaurar (só em caso de desastre):** o arquivo mais recente está sempre pronto em `backups/`. O roteiro está em `backups/COMO-RESTAURAR.txt` e em `scripts/restaurar-backup.ps1`: (1) criar um projeto Supabase **novo e vazio**; (2) recriar a estrutura com `npx supabase db push --db-url <novo>` (migrations: tabelas, segurança e papéis); (3) `restaurar-backup.ps1 -Destino <novo>` carrega os **dados** do backup e confere tabela por tabela. O roteiro **recusa** o banco de produção, destino com dados e destino sem estrutura. Não há espelho local nem é preciso instalar nada (decisão do Pablo, 2026-10-08).

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
| `SYNC_DB_URL`, `PANEL_DB_URL`, `CHAT_DB_URL` | Conexões dos papéis `orq_sync` (grava a sincronização), `orq_panel` (Painel e BI) e `orq_chat` (conector do Claude Desktop, só leitura). **Secretas.** Geradas por `node scripts/set-role-password.mjs --role <papel> --apply` |
| `PIPEDRIVE_DOMAIN`, `PIPEDRIVE_API_TOKEN` | Conta `quarktec.pipedrive.com` e token (somente leitura). **Secretos** |
| `GOOGLE_SA_CLIENT_EMAIL`, `GOOGLE_SA_PRIVATE_KEY`, `GA4_PROPERTY_ID` | Conta de serviço do Google (`quark-leitor-ga4@quark-sites-511021.iam.gserviceaccount.com`, papel **Leitor** na propriedade GA4 `382708044`; a chave é secreta, em uma linha com `\n` escapado) e o ID da propriedade. Gravadas por `node scripts/guardar-chave-google.mjs <arquivo.json> --ga4-property <id>` (nada aparece na tela) |

**GitHub Actions (sincronia a cada 4 h):** os 7 segredos `PIPEDRIVE_DOMAIN`, `PIPEDRIVE_API_TOKEN`, `SYNC_DB_URL` (só o papel `orq_sync`), `SUPABASE_PROJECT_REF`, `GOOGLE_SA_CLIENT_EMAIL`, `GOOGLE_SA_PRIVATE_KEY` e `GA4_PROPERTY_ID` ficam no repositório (Settings > Secrets), enviados por `scripts/github-segredos.ps1` (lê o `.env.local`; o valor vai por arquivo temporário sem quebra de linha, apagado em seguida). Para trocar um segredo, rode o script de novo.

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

**Estado real do schema `mkt` (2026-10-09, migrations `0013` e `0014`).** O desenho acima era o plano; o que existe hoje é o do bloco Google (D-45), com RLS em todas as tabelas, o papel `orq_sync` gravando os dados e o `orq_panel` só lendo as visões (e gravando só `mkt.conversao_regras`, sem delete):

| Tabela | O que guarda |
|---|---|
| `mkt.ga4_dia` | Totais do dia (sessões, usuários ativos, novos usuários, engajadas, visualizações); usuários ativos não se somam, por isso a consulta própria |
| `mkt.ga4_sessoes_dia` | Sessões e novos usuários por dia, domínio, página de entrada, fonte, mídia e campanha (inclui `gads_campanha_id`) |
| `mkt.ga4_eventos_dia` | Eventos por dia, domínio e página (sem `page_view`, `session_start`, `first_visit`, `user_engagement`, `scroll`, `click`) |
| `mkt.ga4_paginas_dia` | Visualizações e usuários ativos por página e dia |
| `mkt.gads_campanhas`, `mkt.gads_campanha_dia` | Criadas e vazias: Google Ads API (G4), custo em micros |
| `mkt.ga4_ads_dia` | Custo, cliques e impressões do Google Ads por dia e campanha, como o GA4 importa (migration `0015`; D-50) |
| `mkt.cri_dor`, `mkt.cri_mensagem`, `mkt.cri_modulo`, `mkt.cri_mapa` | Agrupamento virtual dos criativos do Meta Ads em DOR > Mensagem e Módulo de Interesse (migration `0016`; D-51) |
| `mkt.conversao_regras` | Regras criadas no Painel (evento + URL: qualquer, igual, começa com, contém; tipo lead, intermediária ou ignorar; ativa/inativa) |
| Funções | `mkt.caminho_url` (minúsculas, sem domínio, sem query, sem fragmento, sem barra final) e `mkt.host_url` (domínio sem "www."; nulo se o texto não é URL) |

Visões em `analytics` (sem dado pessoal; o `orq_chat` lê todas): `site_dia`, `site_sessoes_dia`, `site_eventos_dia`, `site_paginas_dia`, `site_conversoes_dia` (eventos que casam com as regras ativas), `conversao_regras`, `ads_campanha_dia` e `negocios_url` (caminho e domínio da "URL de Conversão" de cada negócio, nunca a URL inteira). As tabelas `mkt.ad_entities`, `mkt.ad_daily`, `mkt.gsc_daily` e `mkt.sync_runs` do plano ainda **não existem** (Meta Ads e Search Console ficam para depois; o controle de sincronia reaproveita `ops.sync_jobs` e `ops.sync_checkpoints`).

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
- **Estado em 2026-10-09:** a propriedade `382708044` (site `quarkrh.com.br`) já é lida pela Data API (D-45): sessões, novos usuários, páginas e eventos desde 2025-01-01, atualizados a cada 4 horas. Eventos de conversão reais do site: `RD Formulario Embutido`, `RD Landing Pages`, `ads_conversion_Enviar_formul_rio_de_le_1`, `form_submit` (os eventos-chave marcados no GA4 incluem `page_view` e `click`, então a definição de conversão é a das regras do Painel). A métrica `conversions` não existe mais na API (usa-se `keyEvents`). O Google Ads **já está vinculado** à propriedade (o custo por campanha aparece em `advertiserAdCost`). **Pendente:** ligar a exportação para o BigQuery (decisão do Pablo) e filtro de tráfego interno

### 12.4 Meta (Pixel + CAPI)

- Pixel no GTM dispara `Lead` com `eventID = event_id`
- O orquestrador envia o mesmo evento pela CAPI com o mesmo ID, mais e-mail e telefone em hash, `fbp`, `fbc`, IP e user agent
- O orquestrador envia eventos de funil com valor quando o deal vira qualificado ou ganho
- Formulários nativos: usar a otimização por leads de conversão, devolvendo o ID do lead da Meta com os estágios do CRM

### 12.5 Google Ads

- Conversões otimizadas para leads (e-mail em hash no envio)
- O orquestrador sobe conversões offline (lead qualificado, deal ganho) usando `gclid`, `gbraid` ou `wbraid`
- Com volume suficiente, trocar a conversão principal de "formulário enviado" para "lead qualificado"
- **Dados de custo (leitura):** hoje só pela ponte do GA4 (já vinculado). A leitura definitiva (G4) exige o **developer token** (pedido na conta de administrador, Central de API), o ID da conta de anúncios, o da MCC e uma autorização OAuth de um usuário com acesso "Somente leitura"; o mesmo token serve às conversões offline desta seção. Versão da API fixa em constante, com aviso antes do desligamento. Plano: `docs/datahub/google-entrega-0-plano.md`

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
| 3 | Pessoas e empresas, e vínculo negócio → lead do orquestrador | **em andamento (2026-10-07)**: sondagem feita (35.428 pessoas, 23.146 empresas; o Pipedrive não lista excluídas, D-38); migrations `0007` e `0008` **aplicadas** (2026-10-07, dump `backups/dump-20261007-225741.sql`); **o espaço foi resolvido sem o plano Pro (D-40: banco de 470 para 126 MB). Por pedido do Pablo ("foque nos Deals agora"), a carga de pessoas e empresas fica para depois do histórico de etapas (Entrega 5)** |
| 4 | Atividades | pendente |
| 5 | Histórico de etapas (a mais importante). **Prioridade do Pablo (2026-10-08): negócios criados em 2026 primeiro, depois 2025**; pessoas e empresas (Entrega 3) ficam para depois | **2026 entregue (2026-10-08), aguardando o "conferido" do Pablo; 2025 depois dele**: migration `0010` aplicada (dump `backups/dump-20261008-093517.sql`); **11.145 históricos lidos de 2026 (439.520 unidades, 24% de um dia), 0 falhas, 0 avisos**; 149 negócios sem mudança de etapa ganharam a linha da criação sem consulta; conferência `scripts/datahub-reconcile-history.ts`: cobertura 100%, 2 diferenças explicadas (mudaram de etapa depois da leitura), **amostra de 25 negócios relida no Pipedrive: 25 iguais**; aba Negócios com andamento da carga, funil por ano e linha do tempo na ficha; 492 testes passando. Os "chegou em SQL/reunião/proposta" ficam em 0 até o Pablo marcar as etapas na aba Configuração. **2025 COMPLETO (2026-10-09): 11.297 de 11.297 lidos e 0 falhas** (em 2026-10-08 a carga parou sozinha em 5.420 ao atingir os 40% da cota diária; os 5.877 restantes foram lidos em 2026-10-09, 235.080 unidades, 251.412 de 1.800.000 usadas no dia por todos, inclusive o Make). Amostra de 25 negócios de 2025 relidos no Pipedrive em 2026-10-08: 25 iguais; **a amostra dos 5.877 lidos em 2026-10-09 ainda não foi conferida** (rodar `scripts/datahub-reconcile-history.ts`). Daqui em diante o histórico dos negócios novos entra na sincronização de 4 em 4 horas |
| 6 | Sincronização automática a cada 4 horas, excluídos/mesclados, alerta de 8 horas | **no ar desde 2026-10-09 (GitHub Actions `.github/workflows/sincronia.yml`, cron `17 */4 * * *` em UTC)**: cadastros, negócios (abertos, arquivados e excluídos), histórico de etapas 2025/2026 e GA4 (últimos 7 dias); só o que mudou; trava de 40% da cota do Pipedrive; uma execução por vez; sem gatilho de pull request; papel `orq_sync` (sem delete). 7 segredos no GitHub (`scripts/github-segredos.ps1`, sem CRLF; valores nunca na tela). Execução manual de teste: 15 de 15 etapas ok. O alerta de 8 horas continua no Painel (aba Saúde) e uma etapa com falha deixa o job vermelho (e-mail do GitHub). **Atenção: o repositório é PÚBLICO**: logs e arquivos são visíveis; os segredos não. Excluídos/mesclados de pessoas e empresas só entram com a Entrega 3 |
| G+ | **BI "Site e páginas" (2026-10-09, aguardando o "conferido")**: página nova do BI com 6 análises (desempenho do site com comparação ao período anterior, acessos ao longo do tempo, páginas de entrada, fontes do tráfego, conversões pelas regras do Painel e o **funil dos leads por página de conversão**: leads, MQL, SQL, reunião, proposta, ganhos, perdidos e taxas de passo, por domínio + caminho da "URL de Conversão", ao lado das sessões do GA4). Migration `0014` aplicada (`mkt.host_url`, colunas `host_url` e `url_valida` em `analytics.negocios_url`, tabela `mkt.ga4_dia` com os totais diários e visão `analytics.site_dia`); 646 dias carregados. Achados: o campo "URL de Conversão" mistura domínios (quarkrh.com.br, quarkclinic.com.br, lp.quark.tec.br, lp2.quarkrh.com.br, google.com, Lovable...) e traz texto que não é URL (33 dos leads de 2026); só 13,9% dos leads de 2026 têm URL válida. Usuários ativos não se somam: a página usa a média diária. Os testes de integração passaram a rodar um arquivo por vez (`fileParallelism: false`) porque IDs fictícios iguais travavam um ao outro. 687 testes | pronto |
| G | **Bloco Google (GA4 + Google Ads)**, proposto em 2026-10-08 (D-45), plano em `docs/datahub/google-entrega-0-plano.md`: G1 GA4 sessões e páginas, G2 conversões por URL, G3 custo do Ads pela ponte do GA4, G4 Google Ads API, G5 ligação com o CRM, G6 automação e página "Site e Anúncios", G7 primeiras análises | **G0, G1 e G2 entregues em 2026-10-09 (GA4 carregado, aba "Conversões do site" no Painel), aguardando o "conferido"**; G3 a G7 pendentes (IDs do Google Ads e developer token; página "Site e Anúncios" no BI) |
| 7 | Primeiras análises (funil, conversão, tempo por etapa, motivos de perda, origem, responsável) | **em grande parte entregue pelo BI**: 32 análises em 6 páginas (Visão geral, Safra, Canais, **Google Ads** (2026-10-09, D-50), **Site e páginas** (2026-10-09, D-47), Qualidade), com os **KPIs de MRR em todas as telas de negócios (D-48)** e o marco **Reunião Agendada** (D-49), menu único, Início com a última atualização e conector `quark-dados` para o Claude Desktop (D-42, D-43, D-44). Continua aberto: novas análises sob demanda do Pablo |

### Cronograma proposto (2026-10-08)

**Andamento em 2026-10-09 (tudo adiantado em relação à tabela abaixo):** histórico de 2025 terminado; **Entrega 6 (sincronização automática a cada 4 h) no ar**, já com o GA4 (a autorização dos segredos no GitHub foi dada pelo Pablo em 2026-10-09); **bloco Google G1 e G2** entregues (GA4 carregado, aba Conversões do site no Painel) e **BI "Site e páginas"** no ar. Continuam pendentes do Pablo: "conferido" das Entregas 1, 2, 5 e do BI, regras de conversão do site, IDs do Google Ads e developer token, P-02 (Vercel) e a decisão sobre o repositório público (D-46). Próximos do Data Hub: Entrega 3 (pessoas e empresas), Entrega 4 (atividades) e G3 a G7 (custo do Google Ads e ligação por campanha).

Estimativas em **dias de trabalho do Claude**, sem contar as esperas por decisão ou confirmação do Pablo, que são o que mais move as datas. Duas frentes em paralelo: **A) fechar o Data Hub** e **B) colocar o orquestrador no ar com leads reais**. Semanas (segunda a sexta): S1 12–16/out, S2 19–23/out, S3 26–30/out, S4 2–6/nov, S5 9–13/nov, S6 16–20/nov, S7 23–27/nov, S8 30/nov–4/dez, S9 7–11/dez, S10 14–18/dez (21/dez em diante: feriados, só folga).

| Quando | Frente A: Data Hub | Frente B: Orquestrador | Depende do Pablo |
|---|---|---|---|
| 9/out | Terminar o histórico de 2025 (5.877 negócios, 1 rodada) e conferir | Item 5: proposta de LGPD (só texto) | "conferido" das Entregas 1, 2 e 5 e do BI; corrigir a etapa "Proposta Enviada" do QuarkClinic (#12) |
| S1 | **Entrega 6: sincronização automática a cada 4 h** (GitHub Actions), cadastros diários, excluídos e mesclados, alerta de 8 h; 1 dia de observação (3 dias de trabalho) | Decisões **P-02** (plano da Vercel antes de leads reais) e regra de **firewall**; **item 6: primeiro lead real** (1 dia) | Aprovar a LGPD; decidir a Vercel; autorizar guardar os segredos no GitHub (Actions); enviar o lead real |
| S2 | **Entrega 3: pessoas e empresas + vínculo negócio → lead do orquestrador** (2 dias) | **Item 7: Fase 1 no mundo real** (GTM real, GA4, Pixel, fontes reais; 2 a 3 dias) e **Elementor pelo navegador** (1 a 2 dias) | Acesso ao GTM, GA4 e Pixel; "aprovo" do Elementor |
| S3 | **Entrega 4: atividades** (1,5 dia) | Adaptadores de entrada **Lovable** e **Meta Lead Ads** (1 a 2 dias cada; Fillout só se confirmado) | Confirmar Fillout, Lovable e Meta |
| S4 a S5 | Estabilização, novas análises do BI sob demanda | **Fase 4: motor de regras + adaptadores Pipedrive e Umbler** (6 a 8 dias) | IDs e regras do Pipedrive; credenciais Umbler |
| S6 | Opcional: histórico de 2019 a 2024 (cota) | **Fase 5: diagnóstico como qualificador** (`lid`, 3 a 4 dias) | Fluxo do diagnóstico |
| S7 a S9 | **Dados de mídia** (Meta Ads e Google Ads: custo por campanha, CPL e CAC no BI; 4 a 6 dias, comando à parte) | **Fase 6: migração gradual do Make**, fluxo a fluxo, em paralelo ao Make e comparando resultados (6 a 10 dias) | Lista de fluxos do Make e ordem de migração; tokens de Meta e Google Ads |
| S9 a S10 | Fase 8: sincronizações de `mkt` e views para o dashboard | **Fase 7: CAPI (Meta) e conversões offline (Google Ads)** (4 a 6 dias) | Developer token do Google Ads; pixel e conta de anúncios |
| depois | | **Fase 9: canvas visual de regras** (opcional, 3+ semanas) e **Fase 0: convenção de UTMs** em todos os anúncios (fora do código) | Decidir se vale a pena |

Marcos: **fim de S1** = dados sempre atualizados sozinhos e primeiro lead real gravado; **fim de S3** = todas as fontes de lead entrando com atribuição; **fim de S6** = Pipedrive e Umbler ligados ao motor de regras; **fim de S10** = Make desligado por etapas e conversões voltando para Meta e Google. **Riscos:** (1) plano Hobby da Vercel para uso comercial (P-02); (2) cota diária do Pipedrive compartilhada com o Make (a sincronização já para sozinha em 40%); (3) a migração do Make é a etapa de maior risco e ficará em paralelo, nunca por substituição direta; (4) tudo depende da velocidade das confirmações.

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
| **Resumo em 2026-10-09** | Migrations `0001` a `0016` aplicadas (schemas `core`, `orq`, `crm`, `raw`, `ops`, `mkt`, `analytics`); banco em ~225 MB de 500 MB (`mkt` ~64 MB); **713 testes passando** (os de integração rodam um arquivo por vez); **motivos que tiram do MQL hoje (configuração do Pablo): #27 Não é SAL, #36 Se inscreveu por engano, #184 Contato Inexistente, #185 Cliente em Busca de Suporte, #398 Lead Invalido, #587 Oportunidade Duplicada e #621 Sem Contato Estabelecido** (os 4 de nascença mais 3 marcados depois); sincronização do Pipedrive e do GA4 **automática a cada 4 h** no GitHub Actions; backup diário local às 03:00; BI com 5 páginas e 25 análises; conector `quark-dados` para o Claude Desktop; Painel com a aba Conversões do site. Os itens abaixo de "Estado atual (2026-10-04)" ficaram como registro histórico; valem este resumo e as seções 15, 17 (decisões e pendências) e 18 |
| Repositório | `C:\Users\Esig\Documents\quark-orquestrador` (git local), branch `main`. **Backup:** GitHub `pablomenezzes/quark-orquestrador` (`origin`), **hoje PÚBLICO** (era privado na decisão de 2026-10-04; ver D-46). GitHub CLI (`gh`) instalado em 2026-10-09 e logado na conta `pablomenezzes` |
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
| D-78 | **Filtros por campo do Pipedrive na mensuração do experimento (2026-10-27, pedido do Pablo; estende D-75 e D-76).** O Pablo escolhe QUAL CAMPO do negócio usar para contar: atalhos para **URL de Conversão**, **UTM Campaign**, **UTM Content** e **UTM Term**, mais qualquer outro campo de negócio do Pipedrive (lista dos campos com valor, ou digitado). Cada filtro é "campo + como comparar + valor": é igual a, contém, começa com, termina com, está preenchido ou está vazio (sem diferenciar maiúsculas de minúsculas); os valores mais comuns do campo aparecem como sugestão (`GET /api/experimentos/valores?campo=`), mas aceita-se digitar. Vários filtros se juntam **todos juntos (E)** ou **qualquer um (OU)**. Leitura por `analytics.deal_campos` (campo por nome, texto = `coalesce(valor_legivel, valor #>> '{}')`: campos de texto livre, como as UTMs, só têm o texto em `valor`), sempre com campo e valor como parâmetros, e só visões de analytics. Os filtros entram: (1) no escopo, combinados com página, campanhas e identificador pelo modo de D-75 (no modo "campanha só para o investimento" definem os negócios junto com página e identificador); (2) na contabilização manual, como nova origem de campos (`filtros.leads`, `filtros.mql`, ...); (3) na documentação (rótulo do escopo e linha "Filtros por campo do Pipedrive, sozinhos" na conferência) e na planilha (coluna nova). Migration **`0031_experimentos_filtros_por_campo`** (aditiva: `filtros jsonb` e `filtros_modo`). **Conferido no banco real (caso Campanha de Diagnóstico, RH, desde 20/09):** URL contém `quarkrh-diagnostico` = **110** leads (o mesmo do identificador); UTM Campaign contém `[Growth][77]` = 23 (contra 9 pela ligação Meta, que exige UTM de anúncio); URL contém E UTM Campaign contém = 23; URL OU UTM = 110; **URL contém E UTM Campaign vazio = 86**, o que confirma que 86 dos 110 chegaram sem UTM de campanha (a causa dos 9 leads de D-75). "Está vazio" usa NOT EXISTS correlacionado (o NOT IN estourava o tempo). Testes: `tests/studio-experimentos-filtros.test.ts`. A 0031 (e a 0030, se pendente) precisa ser aplicada ANTES do deploy desta versão. |
| D-77 | **Integrações: Google Sheets e ClickUp para os experimentos (2026-10-27, pedido do Pablo).** (1) **Google Sheets:** cópia dos experimentos para a planilha EXISTENTE, em duas guias NOVAS que o app cria (nunca toca nas guias que já existem): **"Experimentos Quark Dados"** (uma linha por experimento: tipo, status, responsável, escopo, contabilização, métrica chave, meta, real, atingimento, situação, investimento previsto, gasto real, datas, ICE, avaliação, desfecho e o link do ClickUp) e **"Documentação completa"** (os textos longos: hipótese, resultado esperado, evidências, aprendizados e o texto da documentação em texto simples, com o link do documento no ClickUp; célula cortada em 45 mil caracteres, limite do Sheets). As guias são do app e são REESCRITAS por inteiro a cada sincronização; os valores entram como texto puro (`valueInputOption=RAW`), nada vira fórmula. Sincroniza pelo botão "Sincronizar com Google Sheets", ao enviar ao ClickUp e por **cron diário** da Vercel (`0 11 * * *`, 8h em Brasília, rota `/api/cron/experimentos` protegida pelo segredo `CRON_SECRET` no cabeçalho Authorization, comparado em tempo constante, sem sessão e nunca por parâmetro ou cookie). Reaproveita a conta de serviço do GA4 (`GOOGLE_SA_CLIENT_EMAIL` e `GOOGLE_SA_PRIVATE_KEY`, escopo `spreadsheets`): a planilha precisa ser compartilhada com o e-mail dela como editora e a Google Sheets API precisa estar ativada no projeto do Google Cloud. Variáveis: `SHEETS_PLANILHA_ID` (e, opcionais, `SHEETS_ABA` e `SHEETS_ABA_DOC`). Sentido único (app -> planilha); edição manual nas duas guias é sobrescrita. (2) **ClickUp:** o botão "Enviar para o ClickUp" na documentação cria uma PÁGINA por experimento dentro de um Doc escolhido (`CLICKUP_DOC_ID`, API v3 `POST /api/v3/workspaces/{ws}/docs/{doc}/pages`, conteúdo em Markdown) e, nos envios seguintes, ATUALIZA a mesma página (`PUT`, modo replace); guarda o ID e o link em `mkt.experimentos` (migration **`0030_experimentos_clickup`**: `clickup_pagina_id`, `clickup_url`, `clickup_enviado_em`). O HTML do editor é convertido em Markdown sem DOM (`studio/lib/html-para-md.ts`): títulos, listas, tabelas, negrito, itálico, links e citações passam; os gráficos SVG viram uma linha "[gráfico: título]" (o ClickUp não aceita SVG; as tabelas levam os mesmos números); script e links `javascript:` são descartados. O token é pessoal (`CLICKUP_TOKEN`, enviado no cabeçalho Authorization sem "Bearer") e só existe em variável de ambiente; as mensagens de erro nunca o repetem. Variáveis: `CLICKUP_TOKEN`, `CLICKUP_WORKSPACE_ID`, `CLICKUP_DOC_ID`. (3) Sem as variáveis, as rotas respondem 503 dizendo o que falta. Código: `studio/lib/integracoes.ts`. Testes: `tests/studio-integracoes.test.ts`. A 0030 precisa ser aplicada antes do deploy. |
| D-76 | **Contabilização manual do experimento: regras "métrica = fórmula" (2026-10-26, pedido do Pablo; estende D-75).** O experimento escolhe entre **Automática** (o Studio conta pelo escopo, no modo de combinação de D-75: no caso da Campanha de Diagnóstico, 9 leads com todos os critérios) e **Manual**, onde cada métrica do catálogo pode ter uma regra: uma conta com **campos**, **outras métricas** e **números**, com + − × ÷ (× e ÷ antes de + e −, sem parênteses). **Campo** = uma grandeza diária de uma origem do escopo (identificador de conversão, página de destino, campanhas ou escopo combinado): negócios criados, leads, MQL, reuniões, ganhos, MRR dos ganhos e perdidos (Pipedrive), mais investimento, impressões, cliques e leads informados pela Meta (campanhas) e visualizações da página (GA4). O campo só vale se a origem existe no escopo (validado no cadastro, também ao tirar um item que uma regra usa). A conta é feita sobre os **totais do período** (CPL = total investido ÷ total de leads, nunca média de razões diárias); divisão por zero ou termo sem dado dá "sem resultado" (nulo), não zero. Métrica sem regra segue o automático; uma regra pode citar a métrica de outra regra (sem ciclos, detectados no cadastro). **Caso do Pablo, conferido no banco real:** Leads = leads do identificador = **110**; CPL = investimento das campanhas ÷ Leads = R$ 2.511 ÷ 110 = **R$ 22,83**. As regras alimentam o progresso (atual, linha de base, curva), o relatório (colunas de leads, MQL, reuniões, ganhos, MRR e CPL do diário, semanal e geral) e o card REAL; a documentação lista as regras ativas e avisa que funil, perfil, perdas e safra usam o escopo combinado. Migration **`0029_experimentos_contabilizacao_manual`** (aditiva: `contabilizacao` e `regras jsonb`). Código: `studio/lib/experimentos-regras.ts` (catálogo, validação, avaliação e leitura dos campos, só visões de analytics) e o editor na ficha ("Modelo: leads pelo identificador e CPL = investimento ÷ leads" preenche o caso acima). Testes: `tests/studio-experimentos-regras.test.ts`. A 0029 precisa ser aplicada ANTES do deploy desta versão (junto com a 0025 e a 0028 se ainda pendentes). |
| D-75 | **Conferência das métricas do escopo, modo de combinação e detalhe dos negócios na documentação (2026-10-26, pedido do Pablo).** (1) **Investigação do caso "Campanha de Diagnóstico" (RH):** o relatório marcava 9 leads e o Pipedrive tem 110. Medido no banco: o identificador `diagnostico-quarkrh` traz 110 negócios, a página `quarkrh-diagnostico.lovable.app/` traz 182 (110 no período) e as duas campanhas, pela ligação Meta -> Pipedrive, só 9. O escopo exigia TODOS os critérios (E), então o resultado era a interseção: 9. A causa dos 9 não é bug de soma: dos 110 negócios, 101 estão `sem_ligacao` (86 sem UTM Campaign e 14 com UTM "[Misto, Advantage][Landing Page]", nome diferente do da campanha na Meta; `utm_source` chega como `{{site_source_name}}`), só 9 batem com a campanha 77. O investimento (R$ 2.511) estava certo. (2) **Modo de combinação** (`escopo_modo`, migration **`0028_experimentos_modo_do_escopo`**): `todos` (E, o padrão), `qualquer` (OU) e `campanha_so_investimento` (a página e o identificador definem os negócios; a campanha só traz investimento, impressões e cliques). Conferido no banco real para esse caso: todos = 9 leads, qualquer = 110, campanha_so_investimento = 110 leads, 51 MQL e R$ 2.511 de investimento (CPL real). É o modo recomendado quando a ligação Meta perde negócios por falta de UTM. (3) **Detalhe dos negócios do escopo** (`lerDetalheEscopo`, devolvido em `/api/experimentos/:id/relatorio` como `detalhe`, só com escopo e período): status (aberto, ganho, perdido), etapas por funil, faixa de colaboradores, faixa de profissionais da saúde (some se ninguém preencheu), cargo (campo "Cargo (Negócio)" de `analytics.deal_campos`), motivos de perda, safra por semana de criação com a situação atual, criativos (anúncios) das campanhas com gasto, impressões, cliques, leads da Meta e negócios ligados, e a **conferência**. Janela: negócios criados do início do teste até o último dia completo. (4) **Conferência na documentação:** quantos negócios cada critério traz sozinho, a combinação usada, quantos contam como lead, a distribuição da ligação Meta -> Pipedrive (por método, com `sem_ligacao`), quantos estão sem UTM Campaign e uma amostra de 15 negócios com link para o Pipedrive; avisa quando a campanha liga muito menos negócios que a página ou o identificador. Os blocos novos entram como `data-auto` (funil, safra, perfil, perdas, criativos, conferência) e são recolocados em documentações antigas por "Atualizar dados do relatório". (5) **Lição:** o papel `orq_panel` lê só o schema `analytics` (a primeira versão consultou `crm.deal_atributos` e deu `permission denied for schema crm`); um teste agora proíbe `crm`, `mkt`, `raw` e `orq` no arquivo do escopo. Para validar métricas de um experimento: abrir a documentação, ir à "Conferência dos dados" e comparar com o filtro do Pipedrive por data de criação. A 0025 e a 0028 precisam ser aplicadas ANTES do deploy desta versão. |
| D-74 | **Várias campanhas da Meta no escopo do experimento, somando os resultados (2026-10-26, pedido do Pablo; estende D-73).** O escopo aceita uma ou mais campanhas: na ficha, escolhe-se da lista (ou digita-se nome ou ID) e cada uma vira um chip removível; na planilha a célula aceita várias separadas por ";". O resultado real soma as campanhas: o negócio do Pipedrive entra se estiver ligado a QUALQUER uma delas (`campanha_id = any(...)` e, para as digitadas só pelo nome, `lower(campanha) = any(...)`), e o gasto, as impressões e os cliques são a soma delas; página e identificador continuam valendo em conjunto (E) com as campanhas. Limite de 40 campanhas, sem repetição. Migration **`0025_experimentos_varias_campanhas`** (aditiva: coluna `campanhas jsonb`, lista de {id, nome}, id como texto): as colunas `campanha_id` e `campanha_nome` da 0024 ficam sem uso novo e uma linha antiga que só tem a campanha única é lida como lista de uma (as migrations do projeto não fazem UPDATE, o lint proíbe). A lista vai ao banco como JSON (o driver mandaria um array do Postgres). A 0025 precisa ser aplicada ANTES do deploy desta versão. |
| D-73 | **Escopo do experimento: página de destino, campanha da Meta e identificador de conversão; documentação com o REAL da métrica chave (2026-10-26, pedido do Pablo).** (1) **Três campos opcionais** no cadastro (planilha, ficha e kanban): **página de destino** (uma das páginas do Analytics, `analytics.site_paginas_dia`), **campanha** (Meta Ads, `analytics.meta_desempenho_dia`) e **identificador de conversão** (o "Identificador de Conversão RD" do negócio no Pipedrive, `analytics.conversoes_pipe_negocios`). A lista vem das contas reais (`GET /api/experimentos/opcoes`, últimos 90 dias de páginas e 365 de campanhas) e qualquer um também pode ser **digitado à mão**: página como endereço completo ou só o caminho (normalizado como `mkt.caminho_url`: minúsculas, sem www, sem parâmetros, sem barra final), campanha por nome ou ID, identificador como texto. Colunas novas em `mkt.experimentos` pela migration **`0024_experimentos_escopo`** (aditiva; a 0023 já tinha sido aplicada pelo Pablo antes do escopo existir, e editar uma migration aplicada deixou a página com erro até a 0024 rodar. Lição: depois de aplicada, nunca editar a migration, criar a próxima): `pagina_host`, `pagina_caminho`, `campanha_id` (bigint, tratado como texto no código: ids da Meta passam de 2^53), `campanha_nome`, `identificador_conversao`. (2) **Como mede (`studio/lib/experimentos-escopo.ts`):** com escopo, o resultado REAL deixa de ser o do canal e passa a ser só o da fatia. Com mais de um item vale o conjunto (E: o negócio precisa bater com todos). Negócios (leads, MQL, reuniões, ganhos, MRR) são os do Pipedrive que batem, no produto do experimento: campanha pela ligação Meta -> Pipedrive (`analytics.negocios_meta`), identificador pelo campo do negócio, página pela URL de conversão (`analytics.negocios_url`). Investimento, impressões e cliques só existem com campanha; com página e sem campanha o topo são as visualizações da página no GA4. **Custos (CPL, CAC...) exigem campanha** (validado no cadastro); contagens valem com qualquer escopo. O canal deixa de ser usado quando há escopo. Só leitura das visões (papel `orq_panel`); os dados da fatia usam o mesmo formato do Monitor, então a trajetória, o atingimento e o relatório são os mesmos cálculos. (3) **Documentação:** o resumo abre com um card grande **REAL** da métrica chave (valor real, meta, previsto até aqui, atingimento, estado e projeção) e, abaixo, o escopo; os gráficos diário e semanal da métrica chave aparecem como "real por dia" e "real por semana", e o card consolidado vem do resumo e do comparativo antes e durante. Documentações já salvas ganham o card novo com "Atualizar dados do relatório". Testes: `tests/studio-experimentos.test.ts` (escopo, normalização, SQL parametrizado, leitura da fatia). |
| D-72 | **Estado da publicação do Quark Dados e pendências (2026-10-26, fecha D-70 e D-71).** (1) **Feito e conferido de fora:** o site `https://quark-orquestrador.vercel.app` redireciona toda página para `/login`, a API responde 401 sem sessão, `/studio` não é servido e `/api/ingest` segue como antes. Login real testado: o admin `pablomenezesadiem@gmail.com` (papel `admin`) entra, `/api/me` e `/api/usuarios` respondem 200. (2) **Incidente:** a `SUPABASE_SERVICE_ROLE_KEY` que estava no `.env.local` era recusada pelo Supabase ("Invalid API key"), então o primeiro admin não pôde ser criado e a página Usuários não funcionaria. O Pablo gerou uma chave nova no painel (Project Settings, API Keys), colou no `.env.local`, as variáveis de produção foram reenviadas e o deploy refeito. Lição: testar a chave com uma chamada simples antes de mandá-la à Vercel. (3) **Senha provisória do admin** foi mostrada na conversa e deve ser trocada em "Minha conta" (não fica em nenhum arquivo). (4) **PENDENTE:** a migration `0023_experimentos` (tabela `mkt.experimentos`, só aditiva, sem dado e sem DELETE para o painel) AINDA NÃO FOI APLICADA; sem ela a aba Experimentos responde `internal_error` ("relation mkt.experimentos does not exist"), no local e no publicado. O assistente não conseguiu aplicar porque o ambiente bloqueia `scripts/db-push.ps1 -Apply`; deve ser rodado pelo Pablo no terminal (lint, dump em `backups/`, dry-run que deve listar só a 0023, aplicação). Conferir no dry-run que não há outra migration pendente. (5) **Decisões:** as planilhas antigas de experimentos NÃO foram importadas (só referência de colunas); o repositório é público e nenhum segredo foi para o código; nada foi enviado ao GitHub (o deploy saiu da máquina local pela CLI da Vercel). (6) **Próximos passos:** aplicar a 0023; o admin cria o time em `/usuarios`; avaliar domínio próprio e e-mail de convite/recuperação de senha (hoje a senha provisória é combinada fora do sistema). |
| D-71 | **Quark Dados publicado com login (2026-10-26, pedido do Pablo): `https://quark-orquestrador.vercel.app`.** Função `api/studio.ts` (Vercel, gru1) serve Monitor, Experimentos, BI, Painel de Dados, Usuários e Minha conta; `vercel.json` manda tudo para ela, menos `/api/ingest`. **Login** por e-mail e senha no Supabase Auth, sem cadastro aberto: o papel (`admin` ou `editor`) fica em `app_metadata.quark_papel`, que só a chave de serviço grava, então quem se cadastrar sozinho no Supabase não entra. Cookie assinado (HMAC, HttpOnly, Secure, 8 h); a cada 5 minutos o servidor reconfere se o usuário existe, não está bloqueado e mantém o papel. Freio de 5 erros por e-mail+IP em 15 min; Origin obrigatória nas escritas; CSP e anti-iframe. **Editor** vê tudo e edita experimentos; **admin** também gerencia usuários (`/usuarios`) e grava a configuração do Painel. **O Studio de testes (formulários e envio ao pipeline) NÃO existe publicado** (404): continua só no `npm run studio` local. A função usa só o papel `orq_panel`, nunca o `postgres` nem o de ingestão. Variáveis de produção: `PANEL_DB_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (sensível), `SESSION_SECRET` (sensível). Primeiro admin: `node scripts/usuarios.mjs --criar <e-mail> --papel admin` (a senha é pedida sem aparecer). Testes: `tests/studio-auth.test.ts`. |
| D-70 | **Experimentos vira o lugar único de cadastro, documentação e monitoramento de growth, no lugar das planilhas "Growth e Experimentos" (2026-10-26, pedido do Pablo; estende D-69).** (1) **Mesma lista, duas vistas:** Planilha (células editáveis, salvas ao sair do campo; "+ Nova linha") e Kanban (colunas Backlog, Planejado, Rodando, Bloqueado e Concluído; arrastar o card troca o status; "+ Novo card"). Só o título é obrigatório. (2) **Campos novos** em `mkt.experimentos` (a migration 0023 foi reescrita porque ainda NÃO está aplicada): tipo (experimento, ideia, melhoria, documentação), responsável, área de impacto, **resultado esperado**, **investimento** previsto (era "orçamento"; o gasto real continua vindo do Monitor), avaliação manual (sucesso, falha, inconclusivo), evidências, status Backlog/Planejado/Rodando/Bloqueado/Concluído/Cancelado. **Métrica chave, meta, início e fim viram opcionais** (ideias e melhorias antigas não têm); `check (metrica is null) = (meta is null)`; sem os quatro não há acompanhamento automático (estado "Sem acompanhamento automático"). (3) **Documentação:** o botão abre um editor de texto (HTML salvo em `mkt.experimentos.documentacao`, limite de 400 mil caracteres; a API recusa script, iframe e atributos de evento) com o relatório visual gerado de `/api/experimentos/:id/relatorio`: resumo com KPIs, visão geral antes x durante (médias por dia, porque o período anterior tem o tamanho do experimento inteiro), **visão diária** (gráfico do dia a dia, real contra previsto e tabela) e **visão semanal** (semanas de segunda a domingo, cortadas no início e no último dia completo). Os blocos de dados (`data-auto`) são refeitos por "Atualizar dados do relatório" sem tocar no texto do usuário. **PDF:** botão "Exportar PDF" abre a impressão do navegador (CSS `@media print`, A4, gráficos em SVG com cores fixas da marca); sem biblioteca nova. (4) **Planilhas antigas:** serviram só de referência das colunas e dos dados a estruturar; nada foi importado (decisão do Pablo). Testes: `tests/studio-experimentos.test.ts` e a integração `tests/integration/experimentos.int.test.ts` (pulada até a migration existir). |
| D-69 | **Experimentos de growth: cadastro simples e acompanhamento automático (2026-10-26, pedido do Pablo; página `/experimentos`, menu: Início, Monitor, Experimentos, BI, Painel de Dados, Studio).** Pergunta: o teste está andando no ritmo previsto, dentro do orçamento, e o que aprendemos quando acaba? O Pablo cadastra UMA vez (título, hipótese, produto, canal, métrica foco, meta, período, orçamento opcional e ICE de 1 a 10, média dos três) e nada é digitado depois: o resultado, o gasto e a linha de base vêm das mesmas visões do Monitor (`studio/lib/experimentos.ts` reaproveita `lerDadosMonitor` e `metricasDe`). **Regras:** só dias completos (até ontem, fuso America/Fortaleza); linha de base automática = o mesmo número de dias imediatamente antes do início (ou valor combinado); métricas de CONTAGEM (leads, MQL, reuniões, ganhos, MRR) têm meta = total do período e ritmo linear; métricas de CUSTO e TAXA (CPL, custo por MQL, custo por reunião, CAC de mídia, CPC, CPM, CTR, % MQL, taxa até o lead) têm meta = valor a atingir e a trajetória sai da linha de base até a meta; custo do total usa só os leads dos canais pagos (igual ao Monitor) e Social e Orgânico não aceitam métrica de custo (sem verba). Ritmo: "Em linha" até 5 pontos percentuais atrás do prazo, "Atenção" até 20, "Abaixo do previsto" além; com menos de 3 dias, "Poucos dias de dados"; gasto adiantado = uso do orçamento mais de 15 pontos à frente do prazo. **Retroalimentação:** ao concluir, o resultado é fotografado (valor final, atingimento e desfecho: Atingiu a partir de 100%, Parcial a partir de 70%) e deixa de variar; o histórico dos concluídos com a mesma métrica (quantos bateram a meta e a confiança média que tinham) aparece nos experimentos novos, para calibrar o C do ICE. **Banco:** migration `0023_experimentos.sql` (tabela `mkt.experimentos`, o `orq_panel` lê e grava sem DELETE: remover é cancelar). API `GET/POST /api/experimentos` e `PUT /api/experimentos/:id`, tudo parametrizado e validado no servidor (catálogo de métricas no código, sem migration para métrica nova). Provado em transação desfeita contra o banco real com a migration aplicada na transação (criar, listar com dados reais, concluir, DELETE negado, canal sem verba recusado). **Migration 0023 AINDA NÃO APLICADA** (aguarda o "pode aplicar" do Pablo). Limite: mostra coincidência no tempo, não causa; ganhos e MRR do começo do teste ainda amadurecem (mediana de 17 dias até o ganho no RH). |
| D-68 | **Página "Debriefing semanal" no BI (2026-10-23, pedido do Pablo; é a segunda aba do BI, `studio/lib/debriefing.ts`).** Pergunta: o que mudou, o que foi pausado, o que caiu, e como estão o CPL e as taxas de conversão. A **semana de referência é sempre a última semana COMPLETA** (segunda a domingo, America/Fortaleza), comparada com a anterior; o filtro de período do BI não vale nesta página (o de Produto vale) e cada análise avisa isso. **Seis análises:** (1) **a semana em números**: investimento, leads, CPL de mídia paga, taxa clique → lead, % MQL, reunião ÷ MQL (fluxo), reuniões agendadas, ganhos, MRR novo e CAC de mídia, cada um com a semana anterior e a variação; (2) **o que caiu**: só indicadores que PIORARAM mais de 10% (queda do que é bom subir, alta do que é bom descer, como CPL e CAC), no total e em cada canal, ordenados pela pior piora, sem contagens pequenas (menos de 5 leads ou MQL, 3 reuniões, 2 ganhos ou R$ 500 de MRR na semana anterior); (3) **o que mudou nas campanhas**: Meta Ads e Google Ads ordenados pela maior mudança de investimento (em R$), com leads e CPL da plataforma (Meta) ou CPC (Google); (4) **o que foi pausado e o que entrou**: anúncios do Meta e campanhas do Google que PARARAM de gastar (gastavam até o começo da semana de referência ou depois e não gastam há 2 dias ou mais), com o **status de hoje** na plataforma (Pausado, Conjunto pausado, Campanha pausada, Arquivado, Reprovado...), e os que ENTRARAM (primeiro gasto dentro da semana de referência ou depois); (5) **CPL semana a semana** (mídia paga, Meta e Google, 8 semanas) e (6) **taxas de conversão semana a semana** (clique → lead, % MQL, reunião ÷ MQL). **Correção no Monitor, na mesma entrega:** CPL e CAC de mídia do TOTAL passaram a usar só os leads e ganhos dos canais PAGOS (Google e Meta), como o dicionário de métricas manda; antes dividiam o investimento pelos leads dos 4 canais, o que subestimava o custo. Dados lidos uma vez por 2 minutos e compartilhados pelas análises da página (as 6 carregam juntas em ~4 s). Testes: `tests/studio-debriefing.test.ts` e `tests/studio-monitor.test.ts` | 2026-10-23 |
| D-67 | **Rotina de 2 em 2 horas (2026-10-23, pedido do Pablo).** A sincronização completa (`sincronia.yml`: cadastros, negócios do Pipedrive com `deal_atributos`, histórico de etapas, GA4 e arquivo comprimido, Meta estrutura e ligação) passou de 4 em 4 horas para **de 2 em 2 horas** (`17 */2 * * *`, UTC), e a atualização incremental do desempenho da Meta (`meta-incremental.yml`) de hora em hora para **de 2 em 2 horas** (`23 */2 * * *`): só o dia de HOJE, e às 06 UTC (que continua sendo uma das rodadas, por ser hora par) as últimas 48 h. Ambas continuam só incrementais (nunca carga toda), com 1 execução por vez, e o Monitor lê o que elas gravam. Custo: a sincronização do Pipedrive só traz o que mudou desde a última vez (com 10 min de folga), então dobrar a frequência quase não gasta cota; o histórico de etapas só relê os negócios cuja etapa mudou | 2026-10-23 |
| D-66 | **Monitor em lógica de FUNIL, do investimento ao lead (2026-10-23, pedido do Pablo).** O Monitor passa a seguir o funil de mídia: **Investimento → Impressões (razão: CPM) → Cliques e visitas (razão: CTR; CPC) → Leads (razão: taxa até o lead; CPL no fim)**, e "Depois do lead" (MQL, Reuniões agendadas, Ganhos, MRR novo, % MQL, CAC de mídia). **Painel Monitor diário:** um funil consolidado por período (Hoje contra ontem, Semana, Mês), cada degrau com valor, delta, valor anterior e uma **barra 100% empilhada com a composição por canal** (Google Ads, Meta Ads, Social, Orgânico), e a **matriz "O funil de cada canal"** (total e 4 canais lado a lado, com seletor de período lembrado no navegador). **Painel Canais:** um cartão por canal com o funil em linhas (as razões entre os degraus aparecem com ↳) nos 3 períodos. **Fontes de cada degrau:** Meta Ads = gasto, impressões e cliques no link da conta (`analytics.meta_desempenho_dia`); Google Ads = custo, impressões e cliques do GA4/Ads (`analytics.ads_investimento_dia`); **Social e Orgânico não têm verba e o topo deles são as sessões do site no GA4** (mídia social e busca orgânica, `analytics.site_sessoes_dia`, com 1 dia de atraso, por host: o site do QuarkClinic é `quarkclinic.com.br`). O total soma cliques de mídia paga e sessões, então a taxa do total é leitura de conjunto; o CTR do total é só da mídia paga. A taxa até o lead usa só os leads dos dias em que o GA4 tem sessões (hoje fica em branco para Social e Orgânico). Parte dos leads da Meta vem de formulário nativo (sem passar pelo site), então a taxa clique → lead do Meta é uma razão de plataforma. **No dia**, investimento, impressões e tráfego só existem por dia: hoje (parcial) contra ontem (inteiro) aparece como "parcial", não como queda; as razões (CPM, CTR, CPC, taxa, CPL, CAC) de ontem usam o dia inteiro e as contagens (leads, MQL, reuniões, ganhos, MRR) vão até a mesma hora. Social e Orgânico mostram "não se aplica" em investimento, impressões, CPM, CTR, CPC, CPL e CAC. Testes: `tests/studio-monitor.test.ts` (17) | 2026-10-23 |
| D-65 | **Monitor diário e Canais (BI com a marca do QuarkRH) e correção da tela Saúde (2026-10-21).** (1) **Saúde:** as linhas "Meta Ads: desempenho" (`meta_insights_*`) apareciam atrasadas há 8 dias porque o desempenho deixou de ser agendado (agora é o incremental de hora em hora, D-64, ou rodada manual); sairam da lista, e o incremental passou a gravar o checkpoint `meta_incremental_rh/clinic` ao fim de cada rodada COMPLETA (parada por cota não conta), que é o que a tela mede. (2) **Nova página `/monitor` (menu: Início, Monitor, BI, Painel de Dados, Studio)**, só leitura, API `GET /api/monitor?produto=rh|clinic` (`studio/lib/monitor.ts`, `studio/public/monitor.html` e `monitor.js`). **Painel 1, Monitor diário:** o total dos 4 canais com três cartões lado a lado, **hoje contra ontem**, **a semana contra o mesmo trecho da semana anterior** (segunda a hoje contra o mesmo número de dias da semana anterior) e **o mês contra o mesmo trecho do mês anterior**; cada cartão traz MRR novo, Ganhos, CAC de mídia, Leads, % MQL e CPL (nível 1) e MQL, Reuniões agendadas e Investimento (nível 2), cada número com delta, valor anterior e cor pelo que é BOM (CAC e CPL subindo são ruins); veredito em uma frase (leads, ganhos e MRR do mês e a maior piora acima de 5% em semana ou mês; o dia fica fora do veredito por oscilar demais); gráficos dos últimos 30 dias (leads e MQL, ganhos, investimento). **Painel 2, Canais:** Google Ads, Meta Ads, Social e Orgânico, cada um com a tabela de 8 métricas nos 3 períodos e o gráfico de leads e MQL; canal sem verba mostra "não se aplica" em investimento, CPL e CAC, nunca zero. **Regras:** fluxo por data do evento (lead e MQL pela criação do negócio, Reunião Agendada pela entrada na etapa, ganho e MRR pelo fechamento, gasto pelo dia); dia vira à meia-noite em America/Fortaleza; no comparativo do dia as contagens de ontem vão até a MESMA HORA de agora, e investimento, CPL e CAC de ontem usam o dia inteiro (o gasto só existe por dia); canal = Fonte do Lead; Google Ads vem do GA4 do site (QuarkRH, com ~1 dia de atraso) e não entra no filtro QuarkClinic. Atualiza sozinho a cada 5 minutos. **Marca (Brand Core):** Red Hat Display 400 e 700, laranja `#EA8C0C` só em preenchimento (nunca texto sobre claro), apoio em turquesa, azul e verde, faixa multicolorida fina, tema claro e escuro, logo reservada (arquivo oficial `Logo_quarkrh_v2.svg` ainda não está no projeto; a marca aparece em texto). **Pendências de decisão do Pablo:** cores semânticas de bom e ruim (usei um verde e um vermelho discretos, só nos deltas), peso 900 nos números, logo oficial e identidade do QuarkClinic | 2026-10-21 |
| D-64 | **Atualização incremental, velocidade do BI e arquivo do GA4 (2026-10-21, por ordem do Pablo). Migrations `0021` e `0022` APLICADAS (dump `backups/dump-20261021-172336.sql`).** (1) **Meta de hora em hora, só incremental** (`.github/workflows/meta-incremental.yml`, `scripts/meta-incremental.ts`): de hora em hora lê só HOJE; às 06 UTC lê só as últimas 48 h; nunca mais (a função e o script recusam mais de 2 dias); 7 dias por bloco, para a 75% da cota (espera e relê só o bloco), grava só linhas novas ou alteradas (`revisao`+1), nunca toca trimestre FECHADO, diferença com o total da conta nos dias recentes só vai para o log. Isto **ajusta a regra do protocolo de "nunca agendar"**: existe agendamento do desempenho, só incremental; as rodadas por trimestre (simulação, cartão, "pode seguir") continuam o caminho para reler um período. Carga completa até 21/10 (151 linhas novas e 56 alteradas nos últimos 7 dias). (2) **Pipedrive:** a sincronização de negócios já é incremental (`updated_since` com 10 min de folga, pega qualquer idade; 17 negócios de antes de 2025 foram mexidos em uma semana). Falha achada e corrigida: o histórico de etapas ("Deal Change") só era relido para negócios criados em 2025 e 2026; novo passo `--created-year antigos` relê o histórico dos criados antes de 2025 SÓ se já tinham sido lidos e mudaram de etapa ou foram alterados nos últimos 14 dias (há 4.354 antigos nunca lidos, que NÃO são lidos todos). `crm.deal_atributos` é atualizado dentro do `datahub-sync`. (3) **BI mais rápido (0021):** `negocios_bi`, `negocios_url` e `negocios_criativo` leem `crm.deal_atributos` em vez do JSON bruto de 40 mil negócios (raw.pd_deals tem 112 MB); valores idênticos linha a linha; medido no banco real a soma das análises de Visão geral, Meta, Safra e Canais caiu de 46 s para 13,7 s no ano (6,9 s em 30 dias). Os testes de integração do BI agora chamam `crm.recalcular_deal_atributos(true)` depois de criar os negócios fictícios, como a sincronização real. (4) **Site (GA4) arquivado uma vez e comprimido (0022):** `mkt.ga4_arquivo` guarda cada mês FECHADO (35 dias depois do fim) de cada tabela do GA4 em gzip com hash, só inserindo (o `orq_sync` não apaga nem altera); 100 meses de tabela, 202.359 linhas, 55,4 MB viram 3,2 MB (17,5x); `scripts/ga4-arquivar.ts` (`--apply`, `--verificar`, `--restaurar`); restauração testada (2.698 registros de março/2025 voltaram iguais, sem duplicar). A sincronização do GA4 passou a revisar só os últimos 3 dias (eram 7) e arquiva mês novo a cada rodada. **Espaço:** nenhum corte sem apagar dados é possível (o JSON bruto é a fonte de verdade; os índices grandes são chaves primárias e a regra das migrations proíbe DROP); banco em ~292 MB | 2026-10-21 |
| D-63 | **Meta Ads: carga FINALIZADA (2026-10-18), por ordem do Pablo ("finalize o carregamento" e "grave tudo direto").** Rodadas gravadas: QuarkClinic **97** (T3-2026), **99** (T4-2026 até 18/10), **101** (T4-2025) e **103** (T3-2025), QuarkRH **105** (T4-2026 até 18/10); todas depois de simulação completa da mesma conta e intervalo (simulações 96 a 104). Reconciliação em zero, exceto: T3-2025 da QuarkClinic (R$ 0,01 e 1 impressão na semana de 01 a 07/07/2025, mesma semana da diferença da QuarkRH; o motivo ficou no cartão) e T4-2026 da QuarkRH (R$ 0,07 e 4 impressões nos dias 15 a 18/10, dados do dia ainda em movimento); ambas gravadas **por ordem do Pablo** com o motivo registrado. **Correção:** o leitor passou a limitar o intervalo de um trimestre em curso até HOJE (`intervaloRodada`), porque a Meta recusa datas futuras. **Estado do banco:** diário da Meta contínuo de 2025-06 a 2026-10-18 nas duas contas (a QuarkRH sem nenhum dia faltando desde 01/07/2025; a QuarkClinic com 22 dias sem dados no período, dias sem veiculação); 43.051 linhas de 2025-01-01 em diante; banco em 288 MB; ligação com o Pipedrive recalculada (30.515 negócios). **Em aberto:** T4-2026 está em curso (não fechado: a Meta revisa por até 28 dias, e os trimestres T3-2026 de ambas também podem ser relidos até 28/10); QuarkRH de jan a mar/2026 e 2025 antes de julho vêm de cargas anteriores ao protocolo, sem rodada; `META_ATIVO` foi LIGADO em 2026-10-18 por ordem do Pablo e a execução de teste do fluxo passou (1 min 48 s, sem etapa vermelha); o fluxo de 4 em 4 horas só faz estrutura e ligação, nunca o desempenho | 2026-10-18 |
| D-62 | **Meta Ads QuarkRH: T3-2026 e a lacuna de 2025 gravadas (2026-10-14 e 15).** Rodadas gravadas: **90** (T3-2026: 3.110 linhas, gasto R$ 87.058,37, reconciliação em zero em 14 blocos de 7 dias; não fechado, a Meta ainda pode revisar por até 28 dias), **93** (T3-2025: 2.684 linhas novas e 2.150 mantidas; **diferença aceita pelo Pablo em 2026-10-15**: R$ 0,54 no gasto e 3 impressões na semana de 01 a 07/07/2025, 0,0007%, causa não identificada, provável anúncio excluído ainda somado no total da conta; setembro fecha exato) e **95** (T4-2025: 3.127 linhas, gasto R$ 72.817,66, reconciliação em zero). Uma primeira gravação de T4-2025 foi recusada pelo próprio protocolo por uma diferença que não voltou na resimulação (rodada 94, limpa): nada foi gravado naquela tentativa; a mensagem de recusa agora diz em que bloco de 7 dias está a diferença. Com isso a QuarkRH da Meta tem **2025-06 a 2026-09 contínuo** (jan a mar/2026 são da carga anterior ao protocolo, sem rodada). Ligação com o Pipedrive recalculada (30.438 negócios). **Falta:** QuarkRH de 01/10/2026 em diante (T4-2026, trimestre em curso) e o fim de T3-2026 da QuarkClinic; cada um é uma rodada com simulação, cartão e "pode seguir" | 2026-10-15 |
| D-61 | **Meta Ads: T2-2026 da QuarkRH GRAVADA (rodada 88, 2026-10-14), primeira rodada real do protocolo.** O Pablo autorizou ("Aprove a gravação instantaneamente do T2") depois do cartão da simulação 87. **Causa da diferença de leads achada e corrigida:** o leitor descartava linhas sem gasto, impressão nem clique, mas a Meta atribui leads a dias sem impressão; `temAtividade` agora também guarda linhas com leads ou visitas (a mesma causa explica o 1 lead de diferença da QuarkClinic em julho). Com isso a reconciliação fechou em ZERO em todos os 13 blocos de 7 dias (gasto R$ 83.639,89; impressões 2.684.909; cliques 19.158; leads 3.184). **Leitura de 7 em 7 dias, nunca o mês inteiro (decisão do Pablo):** se a cota passar de 75% no meio de um bloco, descarta só aquele bloco de 7 dias, espera 5 min por vez e mede a cota de insights com uma consulta mínima (volta abaixo de 60%, até 12 pausas) e relê o MESMO bloco (até 6 tentativas); é a mesma rodada continuando, nunca uma nova. A rodada 88 levou 41 min e 76 chamadas (cota chegou a 81%). Gravou 2.332 linhas novas, 0 atualizadas, 1.963 mantidas (+0,5 MB; banco em 54,8%); T2-2026 da QuarkRH ficou FECHADO e a ligação com o Pipedrive foi recalculada (30.395 negócios). **Falta de 2026:** QuarkRH de 01/07 a 14/10 (T3 e começo de T4) e o fim de T3 da QuarkClinic; cada um é uma rodada com simulação, cartão e "pode seguir" | 2026-10-14 |
| D-60 | **Meta Ads no tempo (pedido do Pablo, 2026-10-14): análise `meta-serie` na página Meta Ads do BI.** Gráfico de linhas com seletor de granularidade **Diário, Semanal (segunda a domingo), Mensal e Trimestral (calendário)** e métricas escolhidas por caixas: Investimento, **CPL (Pipedrive)**, CPL (Meta), CPM, CPC (link), CTR (link), Connect Rate, Impressões, Cliques no link, Leads (Meta) e Leads (Pipedrive). Cada métrica tem o seu gráfico, na mesma linha do tempo e com a sua escala (nunca dois eixos em um gráfico). O servidor manda um ponto por dia com os componentes (gasto, impressões, cliques no link, visitas, leads da Meta, leads do Pipedrive) e o navegador soma por balde e calcula as taxas das SOMAS. CPL (Pipedrive) = investimento ÷ negócios Meta ADS criados no dia (mesma definição do KPI "Custo por lead"); CPL (Meta) = ÷ leads atribuídos pela Meta. Período parcial (semana, mês ou trimestre cortado pelo filtro, ou em andamento) vai tracejado com marcador vazado. A escolha de granularidade e métricas fica lembrada no navegador. Tabela e CSV trazem a série diária. **Atenção aos dados:** a QuarkRH da Meta está carregada só até 04/05/2026 (carga pausada, D-56/D-58), então o investimento do gráfico cai a partir de maio por falta de dados, não por queda real | 2026-10-14 |
| D-59 | **Conversões Globais (pedido do Pablo, 2026-10-13; mockups "Leads do Diagnóstico" e "Ficha do lead"): migration `0020` APLICADA (dump `backups/dump-20261013-213642.sql`); `crm.deal_atributos` preenchida (39.732 negócios) e atualizada a cada sincronização (`scripts/atributos-recalcular.ts`, no passo de negócios do fluxo). Verificado no Painel com dados reais (guia Pipedrive com 24 conversões; ficha do negócio com o bloco de conversões).** A aba do Painel "Conversões do site" virou **Conversões Globais**, com guias Todas, Site, RD (evento), Pipedrive e Regras do site (o conteúdo antigo, que o BI continua usando). Uma conversão vem de 3 lugares: **Site** (evento do GA4), **RD** (evento do RD Station) ou **Pipedrive** (campo "Identificador de Conversão RD" do negócio, com 223 identificadores distintos e 36.165 de 39.732 negócios preenchidos, e a entrada na etapa de Reunião Agendada). Colunas: Evento, Ocorrência, Usuários, URLs, Último dia, **Tipo de conversão** (Material = Tofu; Levantada de Mão = Mofu; Agendamento de Reunião = Bofu; Reunião Realizada = Bofu) e **Pontos de leadscoring**; tipo e pontos ficam em `mkt.conversao_catalogo` (origem + evento), editáveis na própria linha. **RD (evento) ainda não tem fonte de dados**: o RD Station não está conectado ao orquestrador, então a guia só deixa cadastrar e classificar eventos, sem contagem; **Reunião Realizada** também não tem fonte (as atividades do Pipedrive não são lidas). `0020`: tabela do catálogo (com a etapa "[Etapa] Reunião agendada" já classificada como Agendamento), `crm.deal_atributos` ganha `pessoa_id` e `ident_conversao_rd` (a função de recálculo preenche; prova em transação desfeita: 39.732 negócios em 4,7 s, segunda chamada 0,5 s) e a visão `analytics.conversoes_pipe_negocios` (consulta de agregação de 30 dias em 0,9 s). **Perfil do lead** = a ficha do negócio no Painel (Negócios): ganhou o bloco "Conversões do lead" (nº de conversões, soma dos pontos, Score Maturidade RH, canal e anúncio, primeira e última conversão, UTMs, histórico com conversões e etapas). Limites honestos: o Pipedrive guarda um só conjunto de UTMs por negócio (sem comparar primeira e última), o site (GA4) é agregado e não liga a lead, e os eventos do RD só entram quando a fonte existir. | 2026-10-13 |
| D-58 | **Meta Ads, Entrega 2 do protocolo (2026-10-13): leitor reforçado, protocolo de rodadas e SIMULAÇÃO de T3-2026. Nenhum dado da Meta foi gravado.** (1) **Cliente somente leitura** (`src/datahub/meta/meta.ts`): só `get`/`todas`, HTTP GET sem corpo, só `https://graph.facebook.com` (a URL de paginação vinda da resposta de outro host é recusada sem chamar a rede), token só no cabeçalho `Authorization`; **para a 75% da cota** (`MetaCotaErro`: não espera, a chamada atual volta e a próxima é recusada; limite de cota da Meta também para) e lê `x-fb-ads-insights-throttle`. Teste `tests/datahub-meta-seguranca.test.ts` lê o código-fonte (sem POST/PUT/PATCH/DELETE/method/body, um único fetch). (2) **Rodadas** (`src/datahub/meta/meta-rodadas.ts`, `scripts/meta-rodada.ts`): simulação por padrão (lê, compara com o banco por valor, reconcilia por mês contra o insights nível conta, monta o CARTÃO e registra em `mkt.meta_rodadas`); `--gravar` exige `--autorizacao`, simulação prévia COMPLETA da mesma conta e intervalo, trimestre não fechado e reconciliação sem diferença (ou `--diferenca-explicada`), e é de UMA conta; grava só linhas novas e alteradas (mudou = `revisao`+1, versão mais recente). O desempenho **não** roda mais em `meta-sync.ts --apply` nem no GitHub Actions (que só faz estrutura e ligação). (3) **Simulação T3-2026 (rodadas 51 a 53):** a cota do app (`development_access`, por tempo de uso) **chega a 75% antes de terminar o trimestre** em cada conta (cada simulação gasta ~18 a 20 chamadas e ~130 s); QuarkClinic ficou com 1.765 linhas já iguais ao banco (nada a inserir) e **1 lead de diferença em julho** (linhas 300 x conta 301; gasto, impressões e cliques batem; sem causa conhecida), então **não está liberada para gravar**; QuarkRH parou com 1.083 linhas lidas (cartão incompleto). **Decisão pendente do Pablo:** como completar a leitura sob a cota (rodada em partes retomáveis por mês, ou subir o nível de acesso do app) e o que fazer com a diferença de 1 lead | 2026-10-13 |
| D-57 | **Meta Ads, Entrega 1 do protocolo (2026-10-13): migration `0019` APLICADA (dump `backups/dump-20261013-163417.sql`).** Pablo aprovou a **Opção A** (tabelas atuais, sem partição, sem resumos por campanha) e a **Decisão 1: ao a Meta revisar um número, fica só a versão mais recente, com o contador `revisao`** (sem histórico). A `0019` é só aditiva: `ops.cfg_meta_conta` (2 contas), `ops.cfg_meta_acao` (lista fechada landing_page_view, lead, video_view), `ops.cfg_meta_janela` (corrente 28 dias), `mkt.meta_rodadas` (simulação nunca vira concluída; gravação exige autorização e simulação de origem), `mkt.meta_trimestres` (marca d'água e fechado), colunas `row_hash`, `rodada_id`, `revisao` em `mkt.meta_ads_dia`, views `analytics.meta_trimestres_situacao` e `meta_rodadas_recentes`, e (Parte 3) `crm.deal_atributos` + `crm.recalcular_deal_atributos(so_mudados)` (39.722 negócios em ~7,5 s; segunda chamada grava 0). O `orq_sync` não apaga rodadas nem trimestres. As visões do BI **ainda leem o JSON**: a troca para `deal_atributos` (com comparação de valores contra `negocios_bi`) é a próxima migration. No BI, **fila de no máximo 3 consultas simultâneas** em `studio/public/bi.js`. Teste `tests/integration/meta-rodadas.int.test.ts` (transação com rollback; contagens voltam ao início). Nenhum dado da Meta foi gravado; `META_ATIVO` segue `false` | 2026-10-13 |
| D-56 | **Meta Ads por trimestres e rodadas autorizadas: Entrega 0 (auditoria e plano), 2026-10-13. Nada aplicado; aguardando a decisão do Pablo.** Proposta em `docs/datahub/proposta-meta.sql` (validada dentro de uma transação desfeita). **Achados:** (1) o BI lê o MESMO banco único (ref `avxuerlobmrfsretwuwd`) pelo papel `orq_panel` (`statement_timeout` de 30 s); o dashboard antigo do QuarkRH em outro Supabase não participa (seção 4, Ambiente). (2) **A tabela do diário da Meta não é o gargalo:** `mkt.meta_ads_dia` tem 27,7 mil linhas, 6,3 MB (227 bytes por linha com índices). As consultas mais lentas do `orq_panel` (`pg_stat_statements`, 2026-10-13) são todas da família `analytics.negocios_bi` e das visões que a usam: funil por DOR (máx. 18,6 s), por Módulo (17,5 s), funil por URL (11,8 s), lista de criativos (10,1 s); a visão reconstrói a cada consulta os campos de ~40 mil negócios a partir do JSON bruto. A página da Meta dispara 12 análises ao mesmo tempo e elas disputam o banco enquanto as cargas gravam. (3) **Contas:** QuarkRH `287516640670266` (32 anúncios ativos, 2.344 no total) e QuarkClinic `1390544329013540` (18 ativos, 750 no total); as duas com fuso America/Sao_Paulo (UTC-3), moeda BRL; o dia da Meta segue o fuso da conta. Hoje o mapeamento conta para produto está em `mkt.meta_contas` (copiado das variáveis de ambiente); a proposta o move para `ops.cfg_meta_conta` (regra 11 da seção 18). (4) **Projeção de espaço:** o diário completo de T1-2025 a T4-2026 tem ~50 mil linhas, ~11 MB; o banco está em 267,8 MB (53,6% dos 500 MB); com o que falta do diário (+3,6 MB) fica em ~54%; com a tabela `crm.deal_atributos` da Parte 3 (+12 MB) em ~57%; **guardar o JSON bruto de cada linha (regra 9) levaria a ~60 a 61%**, no limite que pede parar e decidir (P-02 e o plano pago). (5) **Estado gravado (13/10):** QuarkClinic de 2026 completa (até 12/10) e T1 e T2 de 2025 (sobra); QuarkRH 2026-T1 completo e T2 até 04/05, com sobras de 2025 até 08/08; **a carga da QuarkRH foi PAUSADA em 2026-10-13 ao chegar este protocolo** (as cargas anteriores foram autorizadas em conversa, sem o cartão da rodada). A ligação com o Pipedrive já foi calculada (30.371 negócios). **Divergências entre o pedido e o que já existe, para o Pablo decidir:** (a) relatórios assíncronos da Meta exigem **POST** (cria um `AdReportRun`), o que contradiz "somente GET"; como o volume é pequeno, a proposta é seguir síncrono, em blocos de 31 dias, só com GET; (b) o pedido lista poucas colunas, mas já entregamos hook, hold, retenção e Connect Rate, que precisam das colunas de vídeo e de visitas à página: manter; (c) "o BI lê só os resumos" quebra as análises por anúncio, criativo, vídeo e DOR já entregues: os resumos por campanha servem a parte delas, não todas; (d) a seção 10 do MD trata da identificação de leads ("sem sobrescrever" vale para dados do lead), não de métricas; para a Meta valem o princípio 5 (só `orq.events` é imutável) e a nota da seção 4 de que dados de marketing entram agregados por dia; (e) partição por trimestre não acelera nada com 50 mil linhas e exige recriar a tabela (Parte 4, não recomendada); (f) janela de releitura de 7 dias não cobre a atribuição de 28 dias da Meta: proposta de 28 dias, em tabela de configuração. **Lacunas de segurança a corrigir antes de qualquer rodada nova:** o token tem a permissão extra `business_management` (regenerar só com `ads_read`); o cliente da Meta aceita qualquer URL de paginação vinda da resposta (deve exigir o host `graph.facebook.com`); falta o teste automatizado que prove "sem método de escrita, só GET, só `graph.facebook.com`, token só no cabeçalho" no próprio cliente (existem testes apenas dos scripts); o cliente espera a partir de 90% da cota e o pedido manda parar em 75%; e não lê o cabeçalho `x-fb-ads-insights-throttle`. **Documentação consultada (2026-10-13):** versão vigente v26.0; cota `ads_insights` por conta e por hora = 600 (nível desenvolvimento) ou 190.000 (nível padrão) + 400 por anúncio ativo, e erros de usuário reduzem; limite também por app; cabeçalhos `X-Business-Use-Case-Usage` e `x-fb-ads-insights-throttle`; relatório assíncrono = POST em `/insights`, consulta de `async_status` e leitura de `<report_run_id>/insights`, com `report_run_id` valendo 30 dias | 2026-10-13 |
| D-55 | **Meta Ads, M4 e M5 (2026-10-13): ligação com o Pipedrive e página "Meta Ads" do BI; migrations `0017` e `0018` aplicadas (dumps `backups/dump-20261013-111030.sql` e `dump-20261013-140517.sql`); carga do desempenho EM ANDAMENTO.** (1) **Ligação** (`mkt.meta_ligacao`, recalculada por `mkt.recalcular_ligacao_meta()` ao fim de cada sincronização, por upsert): métodos em ordem `ad_id` (o Meta Ad_id do Pipedrive é um anúncio conhecido; certeza alta), `conjunto_id`, `campanha_id+nome` (campanha pelo ID e o NOME nas UTMs Term/Content/Medium, só entre os anúncios daquela campanha; alta), `nome` (UTM Campaign = nome da campanha e UTM Term/Content/Medium = nome do anúncio; média), `campanha_id`/`campanha_nome` (só a campanha; média/baixa), `ambiguo` (o nome bate com mais de um anúncio: **não escolhe anúncio nem conjunto**, guarda a campanha só se todos concordam) e `sem_ligacao`. Nomes comparados por `mkt.chave_nome_meta` (minúsculas, sem nenhum espaço). Teste a seco com dados reais (antes da carga completa): de ago/2025 em diante o `ad_id` liga 50 a 70% dos negócios do mês (o resto é, em boa parte, QuarkClinic ainda sem estrutura carregada); de jan a jul/2025 quase tudo vem por nome ou campanha, e 130 a 260 negócios por mês ficam ambíguos. Visões `analytics.negocios_meta` e `analytics.meta_cobertura`. (2) **Página "Meta Ads" do BI (12 análises):** visão geral (investimento, impressões, cliques no link, CPM, CPC, CTR, Connect Rate, Hook rate, Hold rate, leads da Meta e do Pipedrive, funil, custo por etapa, CAC, ROAS e os KPIs de MRR), funil e custo de cada etapa, mês a mês (desempenho e custos), mês a mês (leads e funil), **por campanha, por conjunto e por anúncio** (nome e ID juntos, funil e MRR dos negócios ligados, linha "negócios sem ligação"), **vídeos** (hook, hold, retenção 25/50/75/95/100% e tempo médio), **por DOR e Mensagem**, **por Módulo de Interesse** (investimento pelo nome do anúncio e leads pelo UTM Term, via o agrupamento D-51) e **cobertura da ligação**. A página ignora o filtro de Fonte (é sempre "Marketing [Meta ADS]"); período, produto (= a conta), pipeline e tipo valem. Taxas sempre calculadas das somas. (3) **Custos em branco, não R$ 0,00:** sem investimento (mês sem gasto ou linha sem gasto próprio) o custo por etapa e o ROAS ficam em branco (vale também para a página Google Ads). (4) **A cota da Meta é o gargalo da carga inicial:** o app está no nível `development_access` e a cota é por TEMPO de uso da conta (`total_time`): chegou a 102 a 103% nas duas contas, com espera estimada de 17 min (QuarkRH) e 47 min (QuarkClinic). O cliente espera sozinho (o uso da última resposta manda), tem tempo limite de 90 s por chamada e a carga é retomável; **estimativa de várias horas para os ~22 meses das duas contas**. Depois dela, a rodada de 4 em 4 horas relê só os últimos 28 dias. Para acelerar de vez seria preciso o nível de acesso "padrão" (revisão do app na Meta). **Decisão do Pablo (2026-10-13): a Meta só de 2026 em diante** (`--desde 2026-01-01` é o padrão do `meta-sync.ts`; uma marca d'água anterior ao início pedido é ignorada). O que já tinha sido gravado de 2025 (jan a jul/2025, ~16 mil linhas da QuarkRH e da QuarkClinic) **fica** (nada é apagado) e continua aparecendo nas análises que cobrem 2025, mas incompleto: **não confie em 2025 da Meta**. (5) **M6 (2026-10-13): a Meta já está no fluxo de 4 em 4 horas, DESLIGADA.** Os 3 segredos novos (`META_ACCESS_TOKEN`, `META_AD_ACCOUNT_RH`, `META_AD_ACCOUNT_CLINIC`) foram guardados no GitHub por `scripts/github-segredos.ps1` (autorizado pelo Pablo; agora são 10 segredos) e a etapa "Meta Ads" do `sincronia.yml` só roda quando a variável do repositório **`META_ATIVO` = `true`** (hoje `false`): ligar **depois** da carga inicial local, para a sincronia não disputar a cota da Meta com ela (comando: `gh variable set META_ATIVO --body true --repo pablomenezzes/quark-orquestrador`). A etapa tem limite de 25 minutos e roda `meta-sync.ts --apply --max-blocos 1` (estrutura, últimos 28 dias e a ligação). Execução manual de teste do fluxo: tudo verde, etapa da Meta ignorada. **Falta:** conferir os totais com o Gerenciador de Anúncios depois da carga e rodar `scripts/meta-sync.ts --apply` ao final para recalcular a ligação com tudo | 2026-10-13 |
| D-54 | **Meta Ads, M1 a M3 (2026-10-13): conexão testada e leitura pronta; aguardando o "sim" para a migration `0017`.** (1) **Token criado pelo Pablo** no usuário de sistema "Claude" (acesso parcial "Ver desempenho" às duas contas; o token concedeu `ads_read`, `business_management` e `public_profile`: **só `ads_read` é necessário**; regenerar apenas com `ads_read` quando der). Guardado no `.env.local` por `scripts/guardar-token-meta.mjs` (nunca exibido); testado com `scripts/meta-teste.mjs`: QuarkRH `act_287516640670266` (1.931 anúncios, 140 campanhas; R$ 5.705 nos últimos 7 dias) e QuarkClinic `act_1390544329013540` (663 anúncios, 57 campanhas; R$ 1.936), moeda BRL, fuso São Paulo, **nível de acesso "development_access"** (cota menor; uso medido de 1% a 29%). (2) **Volume medido:** ~1.400 linhas de anúncio por mês na QuarkRH e ~500 a 700 na QuarkClinic, **~45 mil linhas desde 2025-01-01, ~10 MB** (abaixo da estimativa de 35 a 60 MB; quebras por posicionamento/idade/gênero continuam fora). (3) **Fatos da API que mudaram o desenho:** (a) `video_view` em `actions` = **visualização de 3 segundos**; (b) as listas não aceitam `DELETED` (erro 100/1815001): anúncios, conjuntos e campanhas apagados que têm desempenho são **buscados pelo ID**; (c) com 500 linhas por página a Meta devolveu erro 500 (código 1) em meses grandes da QuarkClinic: **páginas de 100**; (d) IDs de ~18 dígitos passam como texto (Number() perde dígitos) e ficam `bigint`; (e) a paginação (`paging.next`) devolve URLs com o token: nunca em log nem em erro; (f) **as `url_tags` dos anúncios novos mandam `utm_medium={{adset.name}}`, `utm_campaign={{campaign.name}}`, `utm_content={{ad.name}}`** (já os negócios antigos têm UTM Term = nome do anúncio): por isso as `url_tags` de cada anúncio são guardadas, e a ligação por nome testará cada combinação; (g) nomes de campanha aparecem com e sem espaço entre os colchetes ("[Growth][83]" e "[Growth] [83]"): a chave de nome ignora todos os espaços. (4) **Código pronto e testado** (13 testes unitários + 5 de integração que aguardam a migration): `src/datahub/meta/meta.ts` (cliente com espera por cota e novas tentativas, mapeamento) e `meta-sync.ts` (estrutura por upsert, desempenho em blocos de 31 dias, releitura dos **últimos 28 dias**, busca pelo ID do que foi apagado), `scripts/meta-sync.ts` (simulação por padrão; `--apply` grava). A simulação já leu 3.008 itens de estrutura da QuarkRH e 990 da QuarkClinic e o 1º mês de desempenho (1.441 e 496 linhas). (5) **Migration `0017`** (nada aplicado): `mkt.meta_contas`, `meta_campanhas`, `meta_conjuntos`, `meta_anuncios`, `meta_ads_dia`, função `mkt.chave_nome_meta`, visões `analytics.meta_desempenho_dia` e `meta_anuncios` (as taxas CPM, CPC, CTR, Connect, Hook, Hold e retenção **não são guardadas**: calculam-se das somas) | 2026-10-13 |
| D-53 | **Visão geral do BI: comparações nos KPIs e linhas de referência no gráfico mensal (pedido do Pablo, 2026-10-13).** (1) **Cada card de KPI da Visão geral ganhou uma legenda em fonte bem pequena (10 px)** com duas comparações: **30 dias antes** e **1 ano antes**. Cada linha mostra o valor do período comparado, a **diferença absoluta** e a **variação em %** (ex.: "▲ vs 30 dias antes: 10.625 · +199 (+1,9%)"). (2) **"Mesmo período 30 dias antes"** = as mesmas datas deslocadas 30 dias para trás (pode se sobrepor ao período atual quando ele tem mais de 30 dias); **"1 ano antes"** = o mesmo dia do ano anterior (29/02 vira 28/02). Os mesmos filtros (fonte, tipo, produto, pipeline) valem nas três janelas. (3) **Nas taxas (% MQL, taxa de ganho)** a diferença é em **pontos percentuais** e a variação % é relativa; **sem base** (valor anterior zero ou ticket médio sem ganhos) a diferença ou o % ficam em branco ("—"), nunca inventados. A cor é neutra e o sentido vem da seta e do sinal (subir nem sempre é bom: "perdidos"). (4) **Gráfico "Leads, MQL e ganhos por mês":** duas linhas de referência por série, na cor da série: **linha cheia = mês anterior** e **linha tracejada = mesmo mês do ano anterior** (a consulta recua antes do período para os primeiros meses). **Duas caixas** ligam e desligam cada linha, e um seletor escolhe a série (padrão: Leads; "todas as séries" mostra as 6 linhas); a escolha fica lembrada no navegador. A escala do gráfico considera as linhas mesmo desligadas, para as colunas não pularem. A dica ao passar o mouse mostra também o valor do mês anterior e do ano anterior. O mês em curso é parcial. (5) A tabela da Visão geral ganhou as colunas de comparação. 717 testes | 2026-10-13 |
| D-52 | **Bloco Meta Ads (proposto em 2026-10-09, aguardando aprovação do Pablo; nada construído).** Plano em `docs/datahub/meta-entrega-0-plano.md`. (1) Trazer da Marketing API (só leitura, versão fixa em constante; a mais nova é a v26.0) custo e desempenho **por anúncio e por dia** (gasto, impressões, alcance, cliques, cliques no link, CPM, CPC, CTR, visitas à página, leads da Meta, vídeo: reproduções, 3 s, 25/50/75/95/100%, ThruPlay, tempo médio) e a estrutura (campanhas, conjuntos, anúncios, ID do criativo, `url_tags`); Connect Rate, Hook rate, Hold rate e retenção são **colunas calculadas** com a fórmula escrita na tela (a Meta não as entrega prontas). (2) **O Pipedrive já tem os IDs da Meta** (`Meta Campaign_id`, `Meta Adset_id`, `Meta Ad_id`, `Meta Lead_id`, `Meta Form_id`): 98,3% dos leads Meta de 2026; o Ad_id só é confiável de **ago/2025** em diante (jan a jun/2025 ~0%); o Campaign_id vem em ~40% dos leads de jan a jul/2025. (3) **As UTMs são nomes, não IDs:** UTM Campaign = nome da campanha, UTM Content = nome do conjunto, UTM Term = nome do anúncio, e **os nomes se repetem entre campanhas** (ex.: "AD1 — Cópia", 2.456 leads), então o termo sozinho não identifica o anúncio. (4) **Ligação em 3 métodos, em ordem:** (a) `Meta Ad_id` = ID do anúncio; (b) `Meta Campaign_id` + `UTM Term` (anúncio dentro da campanha); (c) por nome (campanha, conjunto e anúncio, sem diferenciar maiúsculas); cada negócio guarda o **método** e a **certeza**; nome que bate com mais de um anúncio fica **ambíguo** e não é somado; tela de cobertura por mês. (5) Já existe acesso à Meta no projeto antigo (`QuarkRH-Dashboard\.secrets\meta.json`; tarefa diária do Windows rodou com sucesso em 2026-10-09): **não foi aberto nem usado**; reaproveitar exige a autorização do Pablo (copiado por script, sem mostrar). Preferir token de usuário de sistema (não expira como o de usuário comum). (6) Entregas M1 a M6 (~4 dias depois da credencial); espaço estimado de 35 a 60 MB, medir antes (anúncios com mais de 12 meses por semana, se preciso, com aprovação); sem quebras por posicionamento/idade/gênero por padrão. (7) Antes de qualquer SQL ou credencial: aprovação do Pablo | 2026-10-09 |
| D-51 | **Criativos do Meta Ads agrupados em DOR > Mensagem e Módulo de Interesse (pedido do Pablo, 2026-10-09).** (1) **Campos virtuais:** DOR, Mensagem e Módulo de Interesse não existem no Pipedrive; vivem só neste banco (migration `0016`: `mkt.cri_dor`, `mkt.cri_mensagem`, `mkt.cri_modulo`, `mkt.cri_mapa`) e são criados e mapeados pelo Pablo na aba **Criativos (DOR e Mensagem)** do Painel de Dados. (2) **Criativo = o campo "UTM Term"** dos negócios da fonte "Marketing [Meta ADS]" com o campo preenchido (em 2026-10-09: 16.219 leads, 322 criativos; "AD1 — Cópia" sozinho tem 2.456 leads); a chave é o termo em minúsculas e com espaços normalizados (`mkt.chave_criativo`), então grafias diferentes do mesmo termo viram um criativo só. (3) **Dois níveis:** a Mensagem pertence a uma DOR (o banco impede Mensagem sem DOR ou de outra DOR); o Módulo de Interesse é independente. **Tudo é opcional: o que não tem equivalente fica em branco**, inclusive criativo sem nenhum mapeamento. Trocar a DOR de um criativo esvazia a Mensagem dele. (4) **Criar, renomear, remover e restaurar** os três cadastros; **remover = desativar** (nada é apagado, o Painel não tem DELETE): o item some das listas e dos relatórios, o mapa é guardado e restaurar traz tudo de volta; remover uma DOR remove as Mensagens dela (restaurar a DOR não as restaura); criar um nome que estava removido o restaura em vez de duplicar. (5) **Em lote:** marcar vários criativos (ou "todos os filtrados") e aplicar DOR, Mensagem ou Módulo, ou limpar um campo. (6) Visões `analytics.negocios_criativo` (cada negócio herda DOR, Mensagem e Módulo do criativo) e `analytics.criativos_meta`, lidas também pelo conector do Claude, prontas para análises no BI (**ainda não existem análises por DOR, Mensagem e Módulo: proposta feita ao Pablo**). 713 testes | 2026-10-09 |
| D-50 | **Painel do Google Ads no BI e custo via GA4 (pedido do Pablo, 2026-10-09).** (1) Página **Google Ads** do BI com 5 análises: visão geral, funil e custo de cada etapa, mês a mês (investimento, custos, ROAS e MRR), mês a mês (leads e funil) e investimento por campanha. (2) **Investimento = custo do Google Ads que o GA4 importa** da conta vinculada (`advertiserAdCost`, por campanha e dia; migration `0015`: `mkt.ga4_ads_dia` e a visão `analytics.ads_investimento_dia`, 1.666 linhas desde 2025-01-01). Quando a API do Google Ads (developer token) entrar, `mkt.gads_campanha_dia` **vence o GA4 nos dias em que tiver dados** (testado). (3) **Leads e funil = negócios criados no período com Fonte do Lead "Marketing [Google ADS]"**; o filtro de Fonte não vale na página (tipo, produto e pipeline valem, mas o custo é da conta toda: a tela avisa quando se filtra por produto). (4) **Custo por etapa = investimento ÷ negócios que chegaram na etapa**: custo por lead, MQL, SQL, Reunião Agendada, proposta e por ganho (CAC); **ROAS = MRR ganho ÷ investimento** (como o MRR é mensal, o ROAS mede o retorno do primeiro mês, não do LTV). (5) Leads **não ligam a campanhas**: o "UTM Campaign" do Pipedrive traz nomes soltos ("blindagem", "Institucional", "SoftwareDP") que não batem com as campanhas do Google Ads; precisa de uma tabela de correspondência, a definir. (6) Achados em 2026-01-01 a 2026-10-08: investimento R$ 34.310, 103.106 cliques, CPC R$ 0,33, 527 leads, 40 ganhos, custo por lead R$ 65,10, CAC R$ 857,75, ROAS 0,82; **dez/2025 (R$ 826) e jan/2026 (R$ 2.511) parecem lacunas da importação do GA4**: conferir com o painel do Google Ads. (7) Formatos novos no BI: `brl2` (reais com centavos) e `dec` (2 casas) | 2026-10-09 |
| D-49 | **Taxonomia do marco: "Reunião Agendada" (pedido do Pablo, 2026-10-09: "os leads que estão Agendado, o marco é Reunião Agendada").** (1) O marco que a chave interna `reuniao` representa passa a se chamar **Reunião Agendada** em toda a interface (Painel de Dados, BI, conector do Claude): "Chegou em Reunião Agendada", "SQL → Reunião Agendada", "Reunião Agendada → proposta". A **chave interna continua `reuniao`** (restrição do banco, nenhuma migration, nenhum dado mudou). (2) Toda etapa chamada **"Agendado"** tem o marco Reunião Agendada: QuarkRH #3 e QuarkClinic #11 já tinham; **CARBONE #35 foi marcada em 2026-10-09** (pipeline sem produto; reversível na aba Configuração). Outras etapas parecidas **não foram tocadas**: "Reunião Agendada" (Parcerias #26), "Visita Agendada" (Prospecção Outbound [QuarkClinic] #19) e "Agendar Visita" (#18); o Pablo decide se também levam o marco. (3) Continua aberto: QuarkClinic #12 "Proposta Enviada [SAL]" está marcada como Reunião Agendada (parece ser proposta) | 2026-10-09 |
| D-48 | **KPIs de MRR sempre presentes (pedido do Pablo, 2026-10-09), principalmente em Safra e Canais.** (1) **MRR = o `valor` do negócio no Pipedrive.** Conferido: o campo MRR nativo do Pipedrive (`mrr`, `arr`) está zerado em 100% dos negócios de 2026 e o time guarda a mensalidade em "Valor" (99,9, 199,9, 285...); moeda BRL. **Hipótese a confirmar com o Pablo.** (2) Definições: **MRR criado** = soma do valor dos negócios criados no período que contam como lead (qualquer status); **MRR ganho** = status ganho; **MRR perdido** = status perdido; **MRR em aberto** = status aberto (pelo Status do negócio, D-36); **Ticket médio ganho** = MRR ganho ÷ ganhos. Com a configuração atual, criado = ganho + perdido + aberto (conferido com os dados reais de 2026: 2.051.465 = 434.233 + 1.402.086 + 215.145). (3) Onde aparecem: tiles novos "MRR e ticket médio das safras no período" (primeira análise de **Safra**) e "MRR e ticket médio das fontes selecionadas" (primeira de **Canais**); tiles na **Visão geral**; colunas MRR criado, ganho, perdido, em aberto e ticket médio nas tabelas de mês (Visão geral), responsável, **Safras**, **Canais por fonte** e **funil por página de conversão**. (4) Regra para as próximas análises: **toda análise nova que agrupe negócios (por mês, safra, fonte, página, responsável...) deve trazer essas 5 colunas** (helpers `MRR_SQL`, `colunasMrr`, `celulasMrr` em `studio/lib/bi.ts`). (5) O conector `quark-dados` conhece as definições (`DEFINICOES`). 689 testes | 2026-10-09 |
| D-47 | **BI "Site e páginas" e ligação por URL (2026-10-09).** (1) Página nova do BI com 6 análises (desempenho do site, acessos ao longo do tempo, páginas de entrada, fontes do tráfego, conversões pelas regras e funil dos leads por página de conversão). (2) **A ligação entre o GA4 e o CRM é por domínio + caminho** (`mkt.host_url` + `mkt.caminho_url`), nunca só pelo caminho, porque o campo "URL de Conversão" mistura domínios (quarkrh.com.br, quarkclinic.com.br, lp.quark.tec.br, lp2.quarkrh.com.br, google.com, Lovable...); texto que não é URL fica fora e a tela diz quantos. (3) O tráfego do site responde só ao período (não a fonte, tipo nem produto, que são do Pipedrive); o funil por URL obedece a todos os filtros. (4) **Usuários ativos não se somam** entre dias nem entre páginas: a tela usa a média diária e os totais do dia vêm de consulta própria (`mkt.ga4_dia`). (5) "Lead ÷ sessões" é aproximação (a URL de conversão é onde a pessoa converteu, não onde entrou). (6) Migration `0014` (colunas novas no fim de `analytics.negocios_url`, tabela `mkt.ga4_dia`). (7) Os testes de integração passaram a rodar **um arquivo por vez** (`fileParallelism: false`): IDs fictícios iguais travavam um ao outro e, numa corrida assim, uma linha fictícia (`crm.users` 960001) chegou a ficar gravada; foi conferida (sem referências) e apagada, e nenhum outro resíduo foi achado | 2026-10-09 |
| D-46 | **Sincronia automática a cada 4 h no GitHub Actions (Entrega 6) e o repositório público.** (1) Fluxo `.github/workflows/sincronia.yml`: cron `17 */4 * * *` (UTC) e manual; etapas independentes (cadastros, negócios, histórico de etapas, GA4), cada uma com `continue-on-error` e um passo final que deixa o job vermelho se alguma falhou (o GitHub avisa por e-mail); permissão só de leitura do conteúdo; uma execução por vez; **sem gatilho de pull request ou push**; só o papel `orq_sync`; trava de 40% da cota diária do Pipedrive. (2) 7 segredos no GitHub enviados por `scripts/github-segredos.ps1` (o script recusa `SYNC_DB_URL` que não seja do `orq_sync`); autorizado pelo Pablo em 2026-10-09 ("guarde os segredos no github"); GitHub CLI instalado por `winget` a pedido do Pablo. (3) **Erro encontrado e corrigido:** enviar o valor pelo pipe do PowerShell 5.1 acrescenta CRLF, e a trava de alvo do banco recusou o `SUPABASE_PROJECT_REF` na primeira execução; o script passou a usar um arquivo temporário sem quebra de linha. (4) **O repositório é PÚBLICO** (a nota de 2026-10-04 dizia privado): código, migrations, este documento e o histórico das execuções são visíveis a qualquer pessoa; segredos não. Regra daqui em diante: **nada sensível neste documento, em commits ou em logs**. O Pablo decide se volta a privado (a sincronia funciona nos dois casos; em repositório privado os minutos do Actions entram na cota gratuita) | 2026-10-09 |
| D-45 | **Bloco Google: GA4 + Google Ads. ATUALIZAÇÃO 2026-10-09: GA4 (G1, G2 e a tela de regras) ENTREGUE, aguardando o "conferido" do Pablo; Google Ads (G3/G4/G5/G6) pendente de IDs e do developer token.** Migration `0013` aplicada (dump `backups/dump-20261008-213243.sql`): schema `mkt` (5 tabelas de dados + `mkt.conversao_regras`), função `mkt.caminho_url` e 7 views em `analytics`. Conta de serviço `quark-leitor-ga4@quark-sites-511021.iam.gserviceaccount.com` (Leitor, só leitura) e chave só no `.env.local` (`scripts/guardar-chave-google.mjs`). Carga `npm run ga4:sync -- --apply` (`src/datahub/google/ga4*.ts`): desde 2025-01-01 até 2026-10-08, 218.487 linhas (sessões 120.987, eventos 16.851, páginas 80.649), 63 requisições, retomável por blocos de 31 dias e revisão dos últimos 7 dias nas próximas rodadas. **Conferência com o próprio GA4: usuários novos (726.723) e visualizações (1.342.999) idênticos no período todo; sessões 1.224.151 contra 1.212.122 do total (+1%, sessões que atravessam a meia-noite contam nos dois dias quando somadas por página).** Espaço: `mkt` ocupa 63 MB (orçamento 60; banco em 223 MB de 500). Eventos automáticos (`page_view`, `session_start`, `first_visit`, `user_engagement`, `scroll`, `click`) não entram em `ga4_eventos_dia` (já estão nas sessões e páginas). `conversions` não existe mais na API: usa-se `keyEvents`. O custo do Ads aparece no GA4 (`advertiserAdCost`), ponte para a G3. Painel de Dados ganhou a aba **Conversões do site** (eventos, em quais URLs cada um aparece, regras evento + URL, contagem no GA4 e negócios do Pipedrive com aquela URL). Plano original: **(proposto em 2026-10-08)** Plano completo em `docs/datahub/google-entrega-0-plano.md`. (1) Só leitura nas duas APIs; GA4 por conta de serviço com acesso de Leitor; Google Ads por OAuth de usuário "Somente leitura" + developer token (Explorer/Basic bastam; pedir já, também serve à Fase 7). (2) O GA4 devolve dados **agregados**: a ligação com o CRM é por **chaves** (URL normalizada, campanha, fonte/mídia, dia), não por lead; cobertura no Pipedrive: URL de Conversão 14,9%, UTM Campaign 76,6%, UTM Medium 78,9%, Canal RD 96,1%. (3) Leads de formulário nativo do Meta não aparecem no GA4; lead a lead só pelo orquestrador (gclid, client_id) ou pela exportação do GA4 para o BigQuery (grátis, só guarda dali em diante). (4) Tabelas no schema `mkt` (`ga4_sessoes_dia`, `ga4_conversoes_dia`, `ga4_paginas_dia`, `gads_campanhas`, `gads_campanha_dia`), custo em micros, orçamento de até 60 MB (banco em 126 de 500 MB), medir antes de fechar a retenção; views `site_paginas`, `ads_vs_crm`, `url_vs_crm`. (5) Entregas G1 a G7 (~3 semanas); custo do Ads pela ponte do GA4 enquanto o token não sai; versão da API do Ads fixa em constante com aviso de desligamento. (6) Antes de qualquer SQL ou credencial: aprovação do Pablo | 2026-10-08 |
| D-44 | **Conversar com os dados no Claude Desktop + backup local sempre em dia (pedido do Pablo, 2026-10-08: "Faça a A" e "mantenha sempre um backup na minha máquina com o mesmo banco/dados que está na nuvem, para não haver conflitos").** (1) **Conector local (opção A)**: servidor MCP `quark-dados` (`mcp/quark-dados/`, gerado em `mcp/dist/quark-dados.mjs` por `npm run mcp:build`, registrado no Claude Desktop por `scripts/instalar-mcp-claude.mjs`) que roda **no computador do Pablo**, sem abrir porta, e dá 5 ferramentas só de leitura: `quark_definicoes` (conceitos e filtros), `quark_analise` (as 19 análises do BI, com os mesmos números do painel e filtros por nome: "google", "meta"…), `quark_esquema`, `quark_sql` (um SELECT/WITH, até 200 linhas, 20 s) e `quark_atualizacao`. (2) **Segurança em 3 camadas**: papel de banco `orq_chat` (migration `0012`) só com SELECT nas visões de `analytics` **sem dados pessoais** (sem `pessoas`, `organizacoes`, `vinculos`, `usuarios`, `campos`, `deal_campos`; nas visões de negócios só as colunas **sem o título do negócio**, que costuma ser nome de pessoa); `begin read only` + `rollback` em toda consulta; trava de SQL (`guardaSql`: uma instrução, sem comentários, sem palavras de escrita, com limite de linhas). A senha (`CHAT_DB_URL`) é gerada por `scripts/set-role-password.mjs --role orq_chat --apply` e só vive no `.env.local`. (3) **O que sai do computador**: o que o Claude consultar entra na conversa (passa pela Anthropic) e **não tem e-mail, telefone, nome de pessoa nem título de negócio**. A opção B (conector remoto para o time, na Vercel) **não foi feita**: abre o banco para a internet e exige OAuth e revisão de segurança. (4) **Backup local** (regra 7 da seção 4): `npm run backup` (dump comprimido de ~12 MB, conferido tabela por tabela contra a nuvem), tarefa diária `QuarkDados-BackupLocal` às 03:00, retenção conservadora, `npm run sincronia` (GitHub x computador, migrations x nuvem, backup, tarefa e segredos). **Sem espelho local (decisão do Pablo, 2026-10-08: "não precisa instalar, só preciso ter o arquivo pronto caso precise restaurar")**: o arquivo `.dump` mais recente fica sempre pronto em `backups/`, com `backups/COMO-RESTAURAR.txt` e `scripts/restaurar-backup.ps1` (restaura só em projeto novo e vazio, nunca na produção; confere tabela por tabela) | 2026-10-08 |
| D-43 | **Menu único, BI em 4 páginas e filtros globais (pedido do Pablo, 2026-10-08).** (1) **Menu único** (`studio/public/nav.js`, igual em todas as telas), nesta ordem: **Início** (`/`, última hora de atualização dos dados, por parte, com alerta acima de 8 h e o aviso de que a atualização automática de 4 em 4 h ainda não está ligada), **BI** (`/bi`), **Painel de Dados** (`/painel`) e, por último, **Studio (testes)**, que passou de `/` para `/studio`. (2) **BI com 4 páginas** (abas): Visão geral, **Safra** (resumo por mês de criação, funil por safra em mapa de calor e curva de ganhos acumulados com células vazias para safra sem idade), **Canais** (comparativo por Fonte do Lead, leads por fonte mês a mês com cor fixa por fonte e detalhe por "Canal de origem RD") e **Qualidade** (indicadores, por fonte, ao longo do tempo, motivos de invalidação, dados em branco). (3) **Filtros em todas as análises**: Data de criação; **Fonte do Lead** com seleção fixa Google ADS (#366), Meta ADS (#365), Orgânico (#367) e Social (#673) e possibilidade de marcar outras (e "em branco"); **Tipo do Lead** fixo em Marketing (#112) com possibilidade de marcar outros; mais Produto e Pipeline. A seleção fixa de fábrica está em `PADRAO_FONTES`/`PADRAO_TIPOS` (`studio/lib/bi.ts`); o usuário pode "Fixar seleção atual" como padrão do navegador. (4) **Definições**: *inválido* = lead perdido por motivo que a regra do Painel tira do MQL; *em branco* = campo do Pipedrive não preenchido; a faixa em branco depende do produto (RH: "Faixa de Colaboradores"; Clínica: "Faixa de profissionais da saúde"). (5) **Migration `0011`** (só duas views novas, sem tabela nem coluna): `analytics.campo_opcoes` e `analytics.negocios_bi` (= `analytics.deals` + fonte, tipo, faixas, canal RD, UTM, sem pessoa e sem organização, lidos direto da chave do campo no JSON original, achada pelo NOME do campo); medida em 0,4 a 0,8 s por consulta. (6) Paleta de até 4 séries validada nos dois modos (`validate_palette.js`). **Dados "desconhecidos" reais achados e medidos na Qualidade (2026-10-08):** Canal de origem RD = "Desconhecido"/"Unknown" (~79 leads) e UTM Source com modelo de link não preenchido (`{{}}` 74, `undefined` 68, `{{GoogleAds}}` 51, `unknown`), sinal de campanha com link mal configurado. **Funis lado a lado (pedido do Pablo, 2026-10-08):** na página Canais, `canais-funis` (uma coluna por fonte, as 6 com mais leads, mais o total; etapas Leads, MQL, SQL, reunião, proposta e ganhos alinhadas; barra = % dos leads da própria fonte; "passo" = conversão condicional da etapa anterior, nunca acima de 100%) e `canais-conversoes` (mapa dos passos e do resultado final por fonte). **Definição "chegou em X ou além"** em TODAS as análises de marcos: SQL = passou por SQL, reunião ou proposta; reunião = reunião ou proposta; porque muitos negócios pulam etapas (a primeira versão mostrava mais "chegou em reunião" que "chegou em SQL"); ganho continua vindo do Status. Medido em 2026 com a seleção padrão: Lead→ganho **Orgânico 13,4%**, Google ADS 7,4%, Social 8,0%, **Meta ADS 3,5%**; o gargalo da Meta é MQL→SQL (39,1% contra 69,9% do Orgânico). **Pendência de configuração para o Pablo confirmar:** no QuarkClinic a etapa "Proposta Enviada [SAL]" (#12) está marcada como **reunião**, e no QuarkRH a mesma etapa (#4) como **proposta**; se for engano, corrigir na aba Configuração. **Migration `0011` aplicada em 2026-10-08** (dump `backups/dump-20261008-135858.sql`; 550 testes passando). 17 análises; números provados com negócios fictícios (`tests/integration/bi.int.test.ts`, 18 testes, rodam depois da `0011`) | 2026-10-08 |
| D-42 | **Painel BI (pedido do Pablo, 2026-10-08).** O Pablo escolheu a opção A: um painel novo, **BI**, dentro do Studio local (`/bi`), onde ele vai construindo as análises e KPIs que quer acompanhar; a opção de ligar uma ferramenta externa (Looker Studio, Metabase) fica para depois, quando os dados estiverem completos. (1) Cada análise é um **bloco independente** em `studio/lib/bi.ts` (`BI_ANALISES`); acrescentar um bloco dá filtro, gráfico, tabela e CSV de graça. (2) **Só leitura e só `analytics`**: usa o papel `orq_panel` (sem migration nova); o navegador escolhe a análise e os filtros e **nunca manda SQL**; filtros validados no servidor e passados como parâmetros (testes provam). (3) O período filtra a **data de criação** do negócio (fuso de São Paulo); ganho/perdido/aberto vêm do Status e MQL/lead das regras do Painel (D-36). (4) **Gráficos** seguem a skill `dataviz`: paleta categórica validada (`validate_palette.js`: passa nos dois modos; aqua abaixo de 3:1 no claro exige tabela e tooltip, que existem), barras de no máximo 24 px com ponta de 4 px, hairlines, legenda, tooltip e Gráfico/Tabela/CSV em toda análise, modo escuro. (5) Primeiras 7 análises: visão geral, por mês, funil, motivos de perda, origem, tempo em cada etapa, desempenho por responsável; números provados com negócios fictícios (526 testes passando) | 2026-10-08 |
| D-41 | **Histórico de etapas (Entrega 5).** (1) Fonte: `GET /v1/deals/{id}/flow?items=dealChange`, **40 unidades por negócio**, uma chamada na quase totalidade dos casos (o `changelog` custa 20 mas devolve até 500 itens com todos os campos e estoura a paginação: descartado). (2) **Negócio que nunca mudou de etapa tem `stage_change_time` vazio** (confirmado em 7 negócios) e **não é consultado**: ganha uma linha "entrou na etapa X na criação". Isso tira da fila só uma minoria (149 dos 11.294 de 2026; ver a correção nos achados: `stage_change_time` a poucos segundos da criação NÃO é "sem mudança"). (3) A etapa inicial de quem mudou é o `old_value` da primeira mudança; cada mudança fecha a linha anterior. (4) **Só as mudanças de etapa** (`stage_id`) são guardadas, em `raw.pd_deal_flow` (1 linha por negócio, só os campos essenciais, sem user agent) e em `crm.stage_history`; status, valor e responsável não entram (economia de espaço, D-40); ganho/perdido vêm do `status` do negócio (D-36). (5) Depois da carga, só volta à fila o negócio cujo `stage_change_time` mudou desde a última leitura. (6) Ordem da fila: abertos, ganhos, perdidos, mais recentes primeiro. (7) Escopo por ano de criação: **2026 primeiro, depois 2025** (pedido do Pablo); anos anteriores só se ele pedir. (8) A etapa atual de negócio ganho/perdido conta o tempo até o fechamento, não até hoje. (9) **O Pipedrive às vezes registra a mesma mudança duas vezes no mesmo segundo** (visto em integrações via API: dois itens 1→3 com o mesmo `log_time`; negócio #101636); itens idênticos em origem, destino e momento viram um só, e há uma trava final por (negócio, etapa, momento); o JSON de `raw.pd_deal_flow` guarda o que veio. (11) **Colisão de nome (2025):** uma automação move o negócio, no mesmo segundo, por duas etapas de pipelines diferentes com o MESMO NOME (ex.: QuarkRH #2 e QuarkClinic #8, ambas "Conexão [Prospect]"; negócios #80252 e #79546), e a chave antiga de `crm.stage_history` (negócio, nome, momento) colidia. Agora `estagio` guarda **"nome #ID"** (ex.: "Conexão [Prospect] #2"; ID e nome juntos, regra 10), e as 41.851 linhas já gravadas foram atualizadas. (10) **Desempenho:** a carga sequencial fazia ~0,5 negócio/s (6 horas para 2026); com 6 consultas em paralelo (`--concurrency`, padrão 6) faz ~8/s (~22 min). A linha do tempo é gravada **antes** do marcador "já li" (`raw.pd_deal_flow`), então uma interrupção nunca dá um negócio como lido sem linhas | 2026-10-08 |
| D-40 | **Economia de espaço, SEM o plano Pro (decisão do Pablo, 2026-10-08: "não vamos contratar o PRO, precisamos enxugar e ser econômicos").** (1) Os campos personalizados ficam **só** em `raw.pd_deals.payload->'custom_fields'`; `crm.deals.custom_fields` deixou de ser preenchida (coluna mantida, sem DROP) e a view `analytics.deal_campos` passou a ler de `raw` (migration `0009`). (2) O JSON de `raw` perde **só as chaves nulas** de `custom_fields` (de ~84 campos só ~26 têm valor; "ausente" = vazio; a lista completa fica em `crm.field_definitions`); zero, texto vazio e lista vazia permanecem. (3) `payload_hash` é calculado sobre o JSON **original**, então a sincronização não acha que tudo mudou. (4) A limpeza dos dados existentes foi feita em lotes por `scripts/datahub-slim.ts` (VACUUM entre os lotes, teto de 497 MB, VACUUM FULL no fim). **Resultado: banco de 470 MB para 126 MB** (`raw.pd_deals` 233→99 MB, `crm.deals` 224→14 MB); 460 testes passando; conferência com o Pipedrive continua batendo. (5) **Regra para as próximas entregas:** guardar o campo personalizado uma vez só (em `raw`, sem nulos), nunca duplicar em `crm`. A cópia completa de antes do enxugamento está em `backups/dump-20261008-082839.sql` (só no computador do Pablo) | 2026-10-08 |
| D-39 | **ALERTA DE ESPAÇO (2026-10-07), RESOLVIDO em 2026-10-08 pela D-40 (470 → 126 MB).** Depois da carga de 39,5 mil negócios o banco está com **470 MB de 500 MB** (plano gratuito do Supabase; ao passar, o projeto vira somente leitura e o endpoint do orquestrador para de gravar leads). Cada negócio ocupa ~10 KB: ~5,3 KB do JSON original em `raw.pd_deals` + ~4,3 KB de `custom_fields` repetidos em `crm.deals`. Pessoas (35 mil), empresas (23 mil), atividades e histórico não cabem. **Carga de pessoas e empresas suspensa até o Pablo decidir:** (A) **plano Pro do Supabase (recomendado)**: 8 GB e backups diários, que o gratuito não tem; ou (B) enxugar sem custo: tirar de `crm` a cópia dos `custom_fields` (a ficha leria de `raw`), libera ~170 MB, mas só adia o problema | 2026-10-07 |
| D-38 | **Entrega 3 (pessoas e empresas).** (1) O Pipedrive não lista excluídas: **varredura** da lista completa marca `is_deleted` em quem sumiu (excluído ou mesclado), sem apagar. (2) Guardam-se **todos** os e-mails e telefones (arrays normalizados com GIN) além do JSON. (3) O vínculo negócio → lead usa **qualquer** e-mail ou telefone da pessoa e pode dar mais de um lead (`crm.deal_lead_links`, chave `deal_id + lead_id + vinculado_por`). (4) O Painel não vê e-mail nem telefone, só "tem/quantos". (5) `0007` (nome da opção nos campos de lista) vai junto na mesma aprovação | 2026-10-07 |
| D-37 | **Entrega 2 (deals), ajustes ao plano aprovado.** (1) Excluído guarda `status` nulo, `is_deleted = true` e `status_original` (a restrição `open\|won\|lost` não muda); `analytics.deals` mostra `deleted` como quarto status. (2) O motivo de perda vem como texto; grava-se também o **ID** (`motivo_perda_id`), obtido casando o texto com as opções do campo. (3) `is_mql` é calculado na view: conta como lead **e** não foi perdido por motivo marcado. (4) O **vínculo deal → lead** (`crm.deal_lead_links`) e a leitura de 3 colunas de `core.leads` passam para a **Entrega 3**, pois dependem do e-mail/telefone da pessoa; nada é concedido em `core` antes de ser usado. (5) Extração **incremental** (explicada ao Pablo): marca-d'água por `updated_since` com folga, hash para não regravar, arquivados e excluídos em listas próprias, histórico só de deals que mudaram de etapa; cadastros (pipelines, etapas, usuários, campos) 1×/dia | 2026-10-07 | 2026-10-07 |

### Pendências

Ordem vigente: **seção 15, itens 1 a 7**. As pendências abaixo apontam para o item que as resolve. Parar e aguardar a confirmação do Pablo ao fim de cada item.

**Caminho até o primeiro lead real**

- [x] **Item 1 — Studio rodando sozinho** (2026-10-04): `npm run studio` confere Node, `.env.local`, variáveis, banco e porta, lista todos os problemas de uma vez em português e não sobe se algo falhar. Testado em execução real: caminho feliz, porta ocupada, `.env.local` ausente, senha errada e variáveis vazias. Documentado em `studio/README.md`. Aguardando confirmação do Pablo.
- [x] **Item 2 — Backup no GitHub** (2026-10-04; **em 2026-10-09 o repositório aparece como PÚBLICO**, ver D-46): repositório `https://github.com/pablomenezzes/quark-orquestrador`, branch `main` enviada pelo Pablo (autenticação dele, via Git Credential Manager). Conferido: remoto e local no mesmo commit; `.env.local`, `backups/`, `.vercel/` e `node_modules/` fora do repositório; nenhum valor secreto no histórico (varredura sem imprimir valores); `.gitignore` corrigido (a regra `.env*` anulava a exceção do `.env.example`). Aguardando confirmação do Pablo. **Limite:** o `git push` precisa ser feito pelo Pablo num PowerShell dele só na primeira vez; depois o login fica guardado no Windows.
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
- [ ] **Entrega 5 (2026), o que falta de você:** conferir a aba **Negócios** (roteiro entregue em 2026-10-08), **marcar na aba Configuração as etapas SQL, reunião e proposta** (sem isso o funil mostra 0 em "chegou em…") e dizer "conferido". **2025 já foi carregado (2026-10-09)**; falta rodar a conferência por amostra dos 5.877 negócios lidos nesse dia.
- [ ] **Conector do Claude Desktop (D-44), o que falta de você:** **fechar o Claude Desktop por completo e abrir de novo**, e testar uma pergunta (ex.: "Use o quark-dados: qual fonte converte melhor em ganho este ano?"). Já feito em 2026-10-08: migration `0012` aplicada (backup `nuvem-20261008-1557.dump` e dump `dump-20261008-155821.sql` antes), senha de `orq_chat` gerada (`CHAT_DB_URL` no `.env.local`), teste de ponta a ponta (14 testes contra o banco real) e conector registrado nas duas configurações do Claude Desktop (cópias `.bak-20261008190106`). **Backup local:** já rodando e conferido (último: `nuvem-20261008-1522.dump`); tarefa diária criada.
- [ ] **Menu único e BI em 4 páginas (2026-10-08), o que falta de você:** (migration `0011` já aplicada) abrir o Início e as 4 páginas do BI e conferir. Achados de Qualidade a olhar: em 2026, ~97% dos negócios de Clínica estão sem "Faixa de profissionais da saúde" e ~28% dos de RH sem "Faixa de Colaboradores".
- [ ] **BI (2026-10-08), o que falta de você:** abrir `/bi`, conferir os números da Visão geral com o Pipedrive, e dizer **quais análises e KPIs quer acompanhar a seguir** (cada pedido vira um bloco em `studio/lib/bi.ts`). Os "chegou em SQL/reunião/proposta" do funil dependem de marcar as etapas na Configuração do Painel de Dados; "Tempo em cada etapa" e o funil de 2025 ficam completos quando o histórico de 2025 terminar (amanhã, pela cota).
- [x] **Entrega 2 conferida pelo Pablo (2026-10-07).** A migration `0007` (nome das opções nos campos de lista) segue aguardando a confirmação do SQL, junto com a `0008` da Entrega 3.
- [x] ~~**Dados do Pipedrive** (nada secreto) para a Entrega 2~~ — obtidos por sondagem somente leitura (cota 1.800.000/dia; 39 mil negócios; ver "Achados da Entrega 2"). Texto original: plano e nº de usuários, contagens desde 2025-01-01 (deals, pessoas, organizações, atividades), nº de pipelines e se usam "arquivar". Com eles a estimativa de espaço e de dias de backfill deixa de ser cenário.
- [ ] Decidir quando migrar o Supabase para o plano pago (a partir de ~10 mil deals o gratuito não comporta; sem backup automático no gratuito).
- [x] Linter das migrations aceita `raw` e `ops` (feito na Entrega 1, com testes que o provam).

**Google (GA4 + Google Ads), sincronia automática e BI Site e páginas (2026-10-09, aguardando o Pablo)**

- [ ] **Conferir e criar as regras de conversão do site:** Painel de Dados > **Conversões do site** (ver em quais URLs cada evento aparece e criar as regras evento + URL). Sugestão a confirmar: Lead = `RD Formulario Embutido`, `RD Landing Pages`, `ads_conversion_Enviar_formul_rio_de_le_1`, `form_submit`; Intermediária = `form_start`. Sem regras, a análise "Conversões do site" do BI fica vazia.
- [ ] **Conferir a página "Site e páginas" do BI** (`npm run studio`, BI): números do GA4 batem com o relatório do próprio GA4 (conferido por mim em 2026-10-09: usuários novos e visualizações idênticos; sessões +1% por sessões que atravessam a meia-noite). Só 13,9% dos leads de 2026 têm URL de conversão válida; 33 têm texto que não é URL; 152 trazem `google.com` (origem, não página). **Ação sugerida ao Pablo/marketing:** preencher o campo "URL de Conversão" nos leads dos formulários nativos do Meta, ou usar outro critério de página.
- [ ] **Google Ads (G3 a G5):** o Pablo precisa enviar o **ID da conta de anúncios** (10 dígitos) e o da **MCC**, **pedir o developer token** (Central de API na conta de administrador) e autorizar o acesso OAuth com um usuário "Somente leitura". Até lá o custo vem pela ponte do GA4 (já vinculado). Depois: custo por campanha, CPL, custo por MQL, CAC e ROAS por campanha (visão `ads_vs_crm`), página "Site e Anúncios".
- [ ] **Exportação do GA4 para o BigQuery** (seção 12.3): ligar já (grátis, só guarda dali em diante) para permitir, no futuro, ligar cada lead à sua sessão. Decisão do Pablo.
- [ ] **Repositório público (D-46):** decidir se volta a ser privado (Settings do repositório). A sincronia continua funcionando nos dois casos.
- [ ] **Chave do Google baixada:** o arquivo `.json` original ainda está na pasta Downloads do Pablo (`quark-sites-511021-*.json`); a chave já está no `.env.local` e no GitHub, então o arquivo pode ser apagado (aguarda o "apague").
- [ ] **Conector `quark-dados`:** reconstruir (`npm run mcp:build`) e reiniciar o Claude Desktop para o conector enxergar as visões novas (`site_*`, `ads_campanha_dia`, `negocios_url`).
- [x] **Segredos no GitHub e sincronia a cada 4 h** (2026-10-09), com o GitHub CLI instalado e logado; execução manual de teste: 15 de 15 etapas ok.
- [x] **Carga do GA4 desde 2025-01-01** e **BI Site e páginas** (migrations `0013` e `0014`; dumps `backups/dump-20261008-213243.sql` e o gerado antes da `0014`).

**Criativos e Google Ads (2026-10-09, aguardando o Pablo)**

- [ ] **Mapear os criativos do Meta Ads (D-51):** Painel de Dados > **Criativos (DOR e Mensagem)**: criar as DORes, as Mensagens (dentro de cada DOR) e os Módulos de Interesse e mapear os 322 criativos (use o lote: marcar vários e aplicar; o que não tiver equivalente fica em branco). Dica: comece pelos de mais leads ("AD1 — Cópia", "[Growth] [47] [Vídeo]…", "[AD16] [02/09/2025]").
- [ ] **Decidir se levo DOR, Mensagem e Módulo para o BI** (leads, funil, MRR e custo por DOR, Mensagem e Módulo). Hoje só existem as visões `analytics.negocios_criativo` e `criativos_meta`.
- [ ] **Conferir a página Google Ads do BI (D-50):** em especial dez/2025 (R$ 826) e jan/2026 (R$ 2.511) contra o painel do Google Ads, e dizer como ligar as campanhas aos leads (tabela UTM Campaign → campanha).
- [x] **Migrations `0015` e `0016` aplicadas (2026-10-09)**, dump `backups/dump-20261009-124828.sql`; custo do Google Ads carregado desde 2025-01-01.

**Meta Ads em profundidade (D-52, 2026-10-09, aguardando o Pablo)**

- [ ] **Aprovar o plano** `docs/datahub/meta-entrega-0-plano.md` (entregas M1 a M6) e responder: (3) período desde 2025-01-01; (4) definições das taxas (Connect, Hook, Hold, retenção); (5) se quer quebras por posicionamento, idade ou gênero (por padrão não). **Respondidos em 2026-10-10:** (1) o Pablo quer **criar um token novo** (usuário de sistema; o do projeto antigo NÃO será reaproveitado); (2) **duas contas de anúncios**: QuarkRH `287516640670266` e QuarkClinic `1390544329013540` (IDs guardados no `.env.local` como `META_AD_ACCOUNT_RH` e `META_AD_ACCOUNT_CLINIC`; não são segredo).
- [ ] **Criar o token da Meta e guardá-lo** (roteiro de 5 passos entregue em 2026-10-10): `node scripts/guardar-token-meta.mjs "<arquivo.txt>" --apagar` e testar com `node scripts/meta-teste.mjs` (somente leitura).

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

### Achados da Entrega 5 (sondagem somente leitura, 2026-10-08)

- **`flow` com `items=dealChange`** devolve só as mudanças do negócio (1 a 29 itens; `field_key` = `stage_id`, `status`, `value`, `user_id`, `expected_close_date`, `add_time`), com `old_value`, `new_value`, `log_time` (UTC, `AAAA-MM-DD HH:MM:SS`), `user_id`, `change_source`, `is_bulk_update_flag` e `id`; paginação `start`/`limit` (`more_items_in_collection`). Sem o filtro, vêm também atividades e e-mails (30 itens no mesmo negócio).
- **`changelog`** (20 unidades): mesmas mudanças de etapa, mas devolve todos os campos (91 a 500 itens por negócio, com paginação não exposta em `additional_data`); num negócio movimentado truncou em 500 e perdeu 3 mudanças de etapa. Descartado.
- **`stage_change_time` vazio = nunca mudou de etapa** (4 negócios sem mudança tinham o campo vazio; 3 com mudança tinham data).
- **CORREÇÃO (piloto de 2026-10-08): `stage_change_time` a poucos segundos da criação NÃO significa "sem mudança".** A primeira estimativa tratava "vazio ou até 5 s depois da criação" como sem mudança (~7.250 a consultar em 2026). Uma amostra aleatória de 10 negócios nessa situação mostrou que **todos os 10 tinham 1 mudança de etapa real** (a automação cria o negócio e o move de etapa 2 a 4 s depois). A regra correta é só **campo vazio** = sem mudança.
- **Quantos precisam de consulta (negócios não excluídos), regra correta:** criados em **2026**: **11.145** de 11.294 (149 com o campo vazio): ~446 mil unidades, 25% de um dia. Criados em **2025**: estimado igual (~440 mil). Os dois anos juntos (~890 mil) passam da fatia de 40% de um dia (720 mil): a carga continua sozinha no dia seguinte.
- **Espaço:** ~140 B por linha de histórico e ~1,2 KB por negócio em `raw.pd_deal_flow`: cerca de 15 MB por ano de criação.

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
