# Data Hub do Pipedrive: Entrega 0 (auditoria e plano)

Data: 2026-10-05 · Status: **aguardando aprovação do Pablo** · Código escrito: nenhum · Banco alterado: nada

> Este documento responde aos 8 pontos da Entrega 0. O SQL proposto está em [`proposta-schema.sql`](./proposta-schema.sql) (só mostrado, não aplicado). A parte de leitura da documentação do Pipedrive também está registrada na seção 18 do `orquestrador-marketing-quark.md`.

## 0. Resumo para decidir (uma página)

| Pergunta | Resposta curta |
|---|---|
| Dá para trazer tudo do Pipedrive desde 01/01/2025? | **Sim.** Deals, pessoas, empresas, atividades, pipelines, etapas, usuários e campos personalizados vêm pela API atual (v2). |
| O histórico de etapas é possível? | **Sim, mas por um caminho mais caro e antigo.** Só existe na API v1 (`flow`), **um deal por vez**, e cada consulta gasta **40 unidades** da cota diária. Não há versão nova. Ele **não** está na lista de descontinuados. |
| Qual é o gargalo? | A **cota diária de uso da API do Pipedrive**, que o Make também consome. O histórico de etapas gasta ~98% do total. Quanto tempo leva depende do **seu plano e nº de usuários** (tabela na seção 5). |
| Cabe no Supabase gratuito? | **Depende de quantos deals existem.** Até ~5 mil deals cabe com folga; entre 5 e 9 mil fica apertado; **a partir de ~10 mil passa dos 500 MB** e precisaremos do plano pago (seção 4). Preciso das suas contagens. |
| Onde roda a sincronização de 4 em 4 horas? | **GitHub Actions** (recomendado, grátis para este uso). A Vercel gratuita só roda 1 vez por dia. |
| Pipedrive só leitura? | O código será construído **sem nenhuma função de escrita** e com teste que prova isso. Para o próprio Pipedrive também barrar escrita, o ideal é um **usuário dedicado só com permissão de visualização**. |
| O que eu preciso de você? | Seção 9: 5 decisões e 4 dados simples do Pipedrive (nada secreto no chat). |

## 1. O que já existe e esta rodada reaproveita

**No banco (Supabase São Paulo, 11 MB usados de 500 MB):**

| Já existe | Como será usado |
|---|---|
| `crm.deals` (11 colunas, **0 linhas**) | Evolui **só com `ADD COLUMN`**: ganha os IDs (pipeline, etapa, responsável, pessoa, empresa), datas e campos personalizados. Os nomes (`pipeline`, `estagio`, `owner`) continuam como estão. |
| `crm.stage_history` (3 colunas, **0 linhas**) | Evolui da mesma forma: ganha ID da etapa, saída, etapa anterior e seguinte, duração e a origem do dado. |
| `core.leads` | Só **leitura**, para ligar um deal a um lead (por `lead_id`, e-mail ou telefone). Nada em `core` nem `orq` é alterado. |
| Papéis e padrões de segurança (`orq_ingest`, RLS, privilégio por coluna) | Mesmo padrão para dois papéis novos (`orq_sync`, `orq_panel`). |
| Linter de migrations, testes em transação com rollback, `db-push.ps1` com dump | Valem para todas as entregas. |
| Funções de normalização de e-mail e telefone (E.164) | Reaproveitadas para casar pessoa do Pipedrive com lead. |
| Quark Studio (servidor local, checagem de partida, esquema de formulários) | Ganha a área **Painel de Dados** (o congelamento D-28 é suspenso só para isso). |
| Repositório no GitHub | Passa a rodar as sincronizações agendadas (Actions). |

**Não existe e será criado:** schemas `raw`, `ops` e `analytics`; todo o código do Pipedrive (nada existia; o arquivo `config/pipedrive.placeholders.ts` nunca chegou a ser criado); o Painel.

**Conflito com o MD:** nenhum. O MD já previa `crm` como "espelho do Pipedrive" e `analytics` como só views. Eu atualizo a seção 8 para incluir `raw` e `ops`.

## 2. Organização proposta

```
Pipedrive ──► raw (payload original)  ──► crm (tabelas limpas)  ──► analytics (views)  ──► Painel
                      ▲                           ▲
                      └────── ops (controle da sincronização + sua configuração) ──────┘
```

| Schema | Papel | Quem grava | Quem lê |
|---|---|---|---|
| `raw` | Uma tabela por entidade com o **JSON original** do Pipedrive, o ID de origem, as datas de origem, `synced_at` e um hash (para ignorar o que não mudou) | `orq_sync` | `orq_sync` |
| `crm` | Tabelas normalizadas, sempre com **ID e nome juntos** | `orq_sync` | `orq_sync` e as views |
| `ops` | Controle (`sync_jobs`, `sync_checkpoints`, `sync_errors`, `sync_settings`, `api_usage_daily`) e **sua configuração** (`cfg_pipeline_produto`, `cfg_stage_marco`, `cfg_field_rotulo`) | `orq_sync` (controle), `orq_panel` (só configuração e frequência) | `orq_panel` |
| `analytics` | **Só views**. É o que o Painel e as análises leem | (ninguém: views) | `orq_panel` |

Decisões de desenho (para você poder discordar):

1. **`produto` e `marco` são calculados na hora da consulta** a partir da sua configuração (`ops.cfg_*`), e não gravados em cada deal. Se você mudar "Pipeline X = RH" no Painel, **todo o histórico muda junto**, sem reprocessar nada.
2. **`crm.deals.status` continua `open`, `won` ou `lost`.** Mudar essa regra exigiria um `DROP` (que só faço com a sua aprovação). Um deal excluído no Pipedrive fica com `is_deleted = true` e o último status conhecido. Nunca é apagado.
3. **Arquivados e excluídos viram marcas** (`is_archived`, `is_deleted`, `deleted_detected_at`), nunca apagam linhas.
4. **Campos personalizados** ficam em `custom_fields` (JSON) com o **ID original** (um código de 40 letras). Os nomes legíveis vêm da tabela `crm.field_definitions` (o que o Pipedrive mostra hoje) e da `ops.cfg_field_rotulo` (o nome que **você** escolher, que nunca muda o ID).
5. **O `raw` guarda a versão mais recente** de cada registro. O histórico de mudanças do deal vem do `flow` (seção 3); para as demais entidades não guardamos cada versão antiga (custaria muito espaço). Se você quiser versões antigas de pessoas e empresas, me diga.
6. **Dois papéis novos**, sem acesso ao que não precisam: `orq_sync` (grava, sem apagar, lê só 3 colunas de `core.leads`) e `orq_panel` (lê `analytics` e `ops`, **grava só a configuração**, e **não vê nenhuma tabela com dados pessoais**: pessoas só aparecem pelas views). Isto cumpre o espírito do seu "só pela service key": como nosso sistema fala direto com o Postgres, o controle é feito por papéis de banco, não pela chave da API REST.
7. **Ligação com o orquestrador** em tabela própria (`crm.deal_lead_links`), sem tocar em `core` ou `orq`.
8. **Entregas e migrations:** uma migration por entrega (0004 a 0009), cada uma com dump antes e a sua confirmação do SQL.

Validação feita: executei o SQL inteiro **dentro de uma transação desfeita** (rollback) e ele roda sem erro (3 schemas, 2 papéis, 30 tabelas e views); depois conferi que o banco voltou idêntico ao que era. Passei também o SQL pelo linter de regras das migrations: aditivo, nada no `public`, RLS em toda tabela. A única reclamação foi esperada: a lista de schemas permitidos precisa incluir `raw` e `ops`, o que a Entrega 1 faz junto com um teste.

## 3. Endpoints atuais do Pipedrive (consultei a documentação oficial hoje)

| Dado | Endpoint | Versão | Paginação | Filtro por data | Custo por chamada* |
|---|---|---|---|---|---|
| Deals | `GET /api/v2/deals` | v2 | cursor, até **500** por página | `updated_since`, `updated_until` (RFC 3339), também `status`, `pipeline_id`, `stage_id`, `owner_id` | **10** por página |
| Deals arquivados | `GET /api/v2/deals/archived` | v2 | cursor, até 500 | `updated_since`, `updated_until` | **20** por página |
| Um deal | `GET /api/v2/deals/{id}` | v2 | n/a | n/a | **1** |
| Pessoas | `GET /api/v2/persons` | v2 | cursor, até 500 | `updated_since`, `updated_until` | a confirmar na Entrega 3 |
| Empresas | `GET /api/v2/organizations` | v2 | cursor, até 500 | `updated_since`, `updated_until` | a confirmar na Entrega 3 |
| Atividades | `GET /api/v2/activities` | v2 | cursor, até 500 | `updated_since`, `updated_until`, `done` | **10** por página |
| Pipelines e etapas | `GET /api/v2/pipelines`, `GET /api/v2/stages` | v2 | cursor | lista pequena: lemos tudo a cada ciclo | a confirmar na Entrega 1 |
| Definição de campos | `GET /api/v2/dealFields`, `personFields`, `organizationFields`, `activityFields` | v2 | cursor | sem filtro | a confirmar na Entrega 1 |
| Usuários | `GET /api/v1/users` | **v1** (não existe na v2; **não** está na lista de descontinuados) | n/a | n/a | a confirmar na Entrega 1 |
| **Histórico do deal** | `GET /api/v1/deals/{id}/flow` | **v1** (sem equivalente na v2; **não** descontinuado) | início/limite | por deal | **40** por chamada |

\* "Custo" = unidades da cota diária (seção 5). Onde está "a confirmar", eu leio a documentação da entidade antes de implementar (sua regra 12) e registro no MD.

Outros fatos que afetam o plano:

- **Versão:** a API v2 é a atual para quase tudo. A v1 de deals, pessoas, empresas, atividades, pipelines e etapas foi marcada como descontinuada: anunciada em 14/04/2025, efetiva em 01/01/2026, e depois de 31/12/2025 "a disponibilidade não é garantida". **Usaremos v2** em tudo o que ela cobre. O `flow` e os usuários seguem na v1.
- **Deals arquivados** (desde 15/07/2025) **não aparecem mais** na lista normal. Precisam do endpoint `/deals/archived`. Sem isso, nossa contagem não bateria com a do Pipedrive.
- **Campos personalizados** vêm agrupados em `custom_fields`, com chaves de 40 letras. Os campos `origin` e `channel` do deal existem; se vêm por padrão ou só com `include_fields`, confirmo na Entrega 2.
- **Excluídos:** o Pipedrive marca `is_deleted` e apaga de vez após 30 dias. Nosso ciclo de 4 horas pega isso a tempo e marca.
- **Escopos de OAuth** (importa para somente leitura): `deals:read`, `contacts:read`, `activities:read`, `users:read` e `recents:read` são todos só de leitura e cobrem tudo o que precisamos, inclusive o histórico do deal.

## 4. Volume e espaço

Hoje o banco tem **11,1 MB** de 500 MB (quase tudo é do próprio Supabase). Eu **não consigo contar** os registros do Pipedrive sem acesso, então estimei por cenários, com tamanhos médios típicos (a conferir com dados reais na Entrega 2).

Premissas por deal: o próprio deal ~4 KB; 1,2 pessoa (~2 KB cada); 0,6 empresa (~1,5 KB); 6 atividades (~1 KB cada); 12 mudanças de histórico (~0,6 KB cada). Isso dá ≈ 20 KB de dado original por deal. Com as tabelas limpas e os índices, o banco ocupa cerca de **2,5×**: **~51 KB por deal**.

| Deals desde 01/01/2025 | Espaço estimado | % dos 500 MB gratuitos | Veredito |
|---|---|---|---|
| 3 mil | ~155 MB | 31% | Cabe com folga |
| 5 mil | ~255 MB | 51% | Cabe, com atenção |
| 7 mil | ~360 MB | 72% | Apertado (sobra pouco para crescer) |
| 10 mil | ~510 MB | 102% | **Não cabe** no gratuito |
| 30 mil | ~1,5 GB | 306% | Precisa do plano pago |

- As **atividades (29%) e o histórico (35%)** são o que mais pesa. As observações das atividades podem ser longas e aumentar isso.
- O plano pago do Supabase (Pro) inclui **8 GB** por projeto (o preço mensal, confirme na página de preços). Pelo MD, já precisamos dele antes de desligar o Make.
- O plano gratuito **não tem backup automático**. Com dados reais do Pipedrive passando a morar aqui, esse risco aumenta; o dump antes de cada mudança continua obrigatório.
- **Para fechar a estimativa eu preciso dos seus números** (seção 9).

## 5. Quantas chamadas, quanto tempo

**Como a API limita:** o Pipedrive dá uma **cota diária de unidades** = 30.000 × multiplicador do plano (Lite 1, Growth 2, Premium 5, Ultimate 7) × número de usuários, zerada à meia-noite. Há também um limite por 2 segundos (token pessoal: Lite 20, Growth 40, Premium 100, Ultimate 120 chamadas). **O Make e qualquer outra integração gastam da mesma cota.**

Exemplo com **10 mil deals**:

| O que | Chamadas | Unidades |
|---|---|---|
| Deals (20 páginas) + arquivados | ~25 | ~300 |
| Pessoas, empresas | ~40 | ~400 |
| Atividades (~60 mil, 120 páginas) | ~120 | ~1.200 |
| Pipelines, etapas, campos, usuários | ~10 | ~100 |
| **Histórico de etapas (1 chamada por deal)** | **~10.000 a 14.000** | **~400.000 a 560.000** |
| **Total** | **~10.200 a 14.200** | **~410 mil a 560 mil** |

O histórico é ~98% de tudo. Para não atrapalhar o Make, o backfill usará no máximo **40% da cota diária** (configurável). Dias necessários para 10 mil deals (~410 mil unidades):

| Seu plano (exemplo) | Cota diária | 40% por dia | Dias para 10 mil deals | Dias para 3 mil deals |
|---|---|---|---|---|
| Lite, 1 usuário | 30 mil | 12 mil | ~34 | ~11 |
| Lite, 3 usuários | 90 mil | 36 mil | ~12 | ~4 |
| Growth, 5 usuários | 300 mil | 120 mil | ~4 | ~2 |
| Premium, 5 usuários | 750 mil | 300 mil | ~2 | 1 |
| Ultimate, 10 usuários | 2,1 milhões | 840 mil | 1 | 1 |

O backfill é **retomável** (ponto de parada salvo): se acabar a cota do dia, continua no outro dia, sem duplicar. A atualização de 4 em 4 horas é barata: só busca o que mudou e só consulta o histórico dos deals cuja etapa, status ou pipeline mudaram, geralmente dezenas por dia (~algumas mil unidades).

Alternativas para reduzir o custo do histórico, se o seu plano for pequeno: (a) guardar só as mudanças do deal (não e-mails, notas ou anexos), que é o que proponho; (b) fazer o backfill do histórico só dos deals que ainda interessam (por exemplo, abertos e ganhos/perdidos a partir de uma data), com a sua autorização.

## 6. Onde rodam o backfill e a atualização de 4 horas

| Opção | Prós | Contras (limites atuais) |
|---|---|---|
| Script no seu computador | Zero configuração | Só roda com o PC ligado; o backfill dura dias. Descartada. |
| **Vercel Cron** | Já usamos a Vercel | **Plano Hobby: no máximo 1 vez por dia**, com atraso de até 59 min. 4 em 4 horas exige o plano Pro (~US$ 20/mês, o mesmo que o P-02 já recomenda). Cada execução é uma função com limite de duração. |
| Agendador do Supabase (`pg_cron`) | Dentro do banco | A extensão está disponível, mas ela só agenda SQL; para chamar o Pipedrive precisaria de funções do Supabase (outro ambiente, em Deno). Mais complexidade. |
| **GitHub Actions** | **2.000 minutos/mês grátis em repositório privado**; agendamento a cada hora ou 4 horas; botão "Rodar agora"; senhas guardadas em cofre; o código já está lá | Pode atrasar alguns minutos em horário de pico; o horário é em UTC. |

**Recomendação: GitHub Actions.** Consumo estimado: 24 verificações por dia, cobradas no mínimo 1 minuto cada (≈ 720 min/mês), mais ~2 a 4 minutos extras nas 6 que realmente sincronizam (≈ 360 a 720 min/mês) ≈ **1.100 a 1.450 min/mês** (55 a 72% da cota grátis de 2.000). A "frequência configurável sem reescrever código" funciona assim: o agendador acorda a cada hora e consulta `ops.sync_settings`; **você muda o intervalo (por exemplo, 240 minutos) no Painel**. Se a cota apertar, reduzimos para acordar a cada 2 horas. A conexão usa o papel `orq_sync`, nunca o `postgres`.

## 7. Credenciais que eu preciso que você providencie

Nada disso passa pelo chat. Cada passo termina com um comando que **pede o segredo numa tela escondida** e o grava só no seu `.env.local` (eu rodo e te aviso).

1. **Token do Pipedrive.** No Pipedrive: foto do perfil → *Preferências pessoais* → aba *API* → copiar o token. **Recomendado:** criar antes um usuário "Quark Data Hub" com um conjunto de permissões **só de visualização** (se o seu plano permitir) e pegar o token dele, porque o token tem as mesmas permissões do usuário. Se isso não for possível, usamos o seu token e a garantia de somente leitura fica no código (sem funções de escrita, com teste).
2. **Endereço da conta Pipedrive** (ex.: `suaempresa.pipedrive.com`). Não é secreto.
3. **Cofre do GitHub** (para a sincronização agendada): no repositório → *Settings* → *Secrets and variables* → *Actions* → *New repository secret*. Eu te dou um comando que copia cada valor para a área de transferência; você só cola. São 2 segredos (token do Pipedrive e conexão do banco `orq_sync`).
4. **Conexão dos dois papéis novos do banco:** eu gero as senhas por script e as gravo no `.env.local`; você só confirma o SQL.
5. **Nota sobre "API token":** ferramentas como o Make abandonaram a conexão por token em favor do OAuth, mas o token pessoal **continua funcionando**. A alternativa mais segura, um aplicativo privado com escopos só de leitura, é mais trabalhosa (renovação de acesso) e fica como melhoria.

## 8. Limitações da API que afetam o que você pediu

1. **Histórico de etapas só por deal, na API antiga (v1), a 40 unidades por consulta.** Não há consulta em lote. Se o Pipedrive um dia descontinuar o `flow`, o histórico dos deals novos teria de vir só de "fotos" nossas. Por segurança, **a cada sincronização guardamos a etapa observada** de cada deal (histórico "observado", com precisão de 4 horas), marcado como tal.
2. **Saída de etapa não é informada diretamente.** Ela é deduzida da entrada na etapa seguinte. Quando a primeira etapa não aparece no histórico, a entrada fica **estimada pela data de criação e marcada como estimada**. Nada é inventado: o que não dá para reconstruir fica "desconhecido" (`historico_status`).
3. **Arquivados:** têm endpoint à parte (20 unidades por página). Se o `flow` funciona para deal arquivado, confirmo na Entrega 5.
4. **Excluídos e mesclados:** o Pipedrive apaga o excluído de vez após 30 dias. **Uma mesclagem de deals não aparece de forma explícita** na API que consultei: o deal mesclado some (como excluído) e **não dá para saber para qual deal foi**. Ficará marcado como excluído, e a limitação documentada.
5. **A cota diária é compartilhada** com o Make e qualquer outra integração.
6. **Campos personalizados** têm código de 40 letras; se você renomear um campo no Pipedrive, o ID não muda, só o nome (por isso guardamos os dois).
7. **O token pessoal tem as permissões do usuário** (não dá para limitá-lo só a leitura no Pipedrive). Daí a recomendação do usuário dedicado.
8. **Dados pessoais:** pessoas e empresas passam a morar no nosso banco. Isso entra na política de LGPD do item 5 do MD (eliminação a pedido do titular). Hoje essas tabelas ficam sem acesso para o Painel, só por views.

## 9. O que eu preciso de você para seguir

**Aprovações (responda "aprovo" ou diga o que mudar):**

1. A **organização das tabelas** da seção 2 (inclui `produto`/`marco` calculados pela sua configuração e os dois papéis novos).
2. **Rodar no GitHub Actions** (seção 6).
3. **Guardar só as mudanças do deal** no histórico (sem e-mails, notas e anexos do `flow`).
4. **Usar o token do Pipedrive**, de preferência de um usuário dedicado só de visualização (seção 7).
5. **Suspender o congelamento do Studio só para a área "Painel de Dados"** (nada mais no Studio muda).

**Dados simples do Pipedrive (nada secreto):**

1. O **endereço da conta** (o começo do endereço quando você abre o Pipedrive, antes de `.pipedrive.com`).
2. O **plano** (Lite, Growth, Premium ou Ultimate) e o **número de usuários**: Pipedrive → *Configurações da empresa* → *Assinatura*.
3. As **contagens** desde 01/01/2025: abra *Negócios* → lista; filtre pela data de criação ≥ 01/01/2025 e anote o total de **deals**; faça o mesmo para *Pessoas*, *Organizações* e *Atividades*.
4. Quantos **pipelines** vocês têm, e se usam **arquivar** negócios.

## 10. Estimativa de esforço (minha parte, sem contar a espera da cota do Pipedrive)

| Entrega | O que | Estimativa |
|---|---|---|
| 1 | Pipelines, etapas, usuários, configuração e as telas iniciais do Painel | ~1 dia |
| 2 | Deals, backfill retomável, ligação com leads | ~1 a 1,5 dia |
| 3 | Pessoas e empresas | ~0,5 dia |
| 4 | Atividades | ~0,5 dia |
| 5 | Histórico de etapas | ~1 a 1,5 dia (+ dias de cota no backfill) |
| 6 | Sincronização automática de 4 em 4 horas, alertas, excluídos | ~1 dia |
| 7 | Primeiras análises | ~1 dia |

São estimativas, e cada entrega termina com a sua conferência antes da próxima.

## Fontes consultadas (documentação oficial, 2026-10-05)

- [Pipedrive: limites e custo por chamada](https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting)
- [Pipedrive: paginação v1 e v2](https://pipedrive.readme.io/docs/core-api-concepts-pagination)
- [Pipedrive: guia de migração para a API v2](https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide)
- [Pipedrive: descontinuação de endpoints v1 (lista oficial)](https://developers.pipedrive.com/changelog/post/deprecation-of-selected-api-v1-endpoints)
- [Pipedrive: negócios arquivados](https://developers.pipedrive.com/changelog/post/breaking-change-archived-deals-and-leads-will-not-be-returned-in-existing-endpoints-and-will-not-be-editable)
- [Pipedrive: referência de Deals (v2, `flow`)](https://developers.pipedrive.com/docs/api/v1/Deals)
- [Pipedrive: referência de Atividades](https://developers.pipedrive.com/docs/api/v1/Activities)
- [Pipedrive: escopos de OAuth](https://pipedrive.readme.io/docs/marketplace-scopes-and-permissions-explanations)
- [Vercel: Cron Jobs (limites por plano)](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [GitHub Actions: minutos gratuitos](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions)
- [Supabase: limites do plano gratuito](https://supabase.com/docs/guides/platform/billing-on-supabase)
