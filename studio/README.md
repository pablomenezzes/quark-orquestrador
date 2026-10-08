# Quark Dados (menu único) e Quark Studio

Um programa local com **um menu só**, igual em todas as telas, nesta ordem:

| Menu | Endereço | Para que serve |
|---|---|---|
| **Início** | `/` | Mostra a **última hora de atualização** dos dados do Pipedrive (e de cada parte), com alerta se passar de 8 horas |
| **BI** | `/bi` | Análises e KPIs, em 4 páginas: Visão geral, Safra, Canais e Qualidade |
| **Painel de Dados** | `/painel` | Saúde da sincronização, configuração das regras, negócios, usuários e campos, conferência |
| **Studio (testes)** | `/studio` | O construtor de formulários de teste do orquestrador (descrito abaixo) |

## Quark Studio (testes)

Ambiente de testes local do orquestrador: você **monta formulários**, abre numa **nova aba** (todas as perguntas na mesma tela, estilo Typeform) com os **UTMs** que quiser e vê **o que o orquestrador faria** com o envio.

## Como rodar (sozinho, num PowerShell)

```powershell
cd C:\Users\Esig\Documents\quark-orquestrador
npm run studio
```

O navegador abre em `http://127.0.0.1:4310` (a tela Início; o construtor de formulários fica em `/studio`). **Deixe a janela do PowerShell aberta**: fechar a janela (ou `Ctrl+C`) para o Studio. Os formulários ficam salvos em `studio/forms/` e não se perdem.

Escuta só em `127.0.0.1`. Não é publicado na Vercel e não altera a Deployment Protection.

### O que ele confere ao subir

Antes de abrir, o Studio faz cinco checagens e mostra o resultado. Se algo falhar, **não sobe**, lista *todos* os problemas de uma vez e diz como resolver. Nunca mostra senha, token nem a URL do banco.

```
 ✔ Node.js: Node 24.19.0
 ✔ Arquivo .env.local: Encontrado.
 ✔ Variáveis do .env.local: Todas preenchidas.
 ✔ Conexão com o banco: Conectado.
 ✔ Porta do Studio: Porta 4310 livre.
```

| Se aparecer | O que significa | O que fazer |
|---|---|---|
| `Arquivo .env.local … não existe` | Falta o arquivo de configuração | `Copy-Item .env.example .env.local` e preencha |
| `Faltam no .env.local: …` | Variável vazia (lista quais) | A mensagem diz onde achar cada uma no Supabase |
| `ainda tem o texto [YOUR-PASSWORD]` | A senha não foi colocada na URL | Troque `[YOUR-PASSWORD]` (com colchetes) pela senha |
| `não está num formato válido` | A senha tem `? , : @ #` | `node scripts/encode-db-url.mjs` |
| `não contém o ref do projeto` | A URL é de outro projeto | Copie de novo a *Session pooler* em *Connect* |
| `O banco recusou a senha` | Senha errada | Confira, ou *Reset database password* no Supabase |
| `A conexão … demorou demais` | Sem internet, VPN/firewall ou projeto pausado | Verifique a rede; no painel do Supabase clique em *Restore* se aparecer |
| `A porta 4310 já está em uso` | O Studio já está aberto em outra janela | Use a janela existente, ou `$env:STUDIO_PORT = 4311; npm run studio` |

### Problemas comuns do Windows

- `npm.ps1 não pode ser carregado porque a execução de scripts foi desabilitada`: use `npm.cmd run studio` (não muda nenhuma configuração do Windows).
- `npm não é reconhecido`: o Node não está no PATH; instale em nodejs.org e abra um PowerShell novo.
- O comando precisa ser rodado **dentro da pasta do projeto** (o `cd` acima).

### Estado do Studio

Está **congelado** (decisão D-28): só recebe correções. Nenhuma funcionalidade nova entra sem aprovação.

## Como usar

1. **Formulários** (coluna da esquerda): crie, duplique ou exclua. Há um exemplo (`demo-rh`).
2. **Editor** (centro): título, descrição, botão, consentimento LGPD e as perguntas. Em cada pergunta você edita o texto, o tipo, as opções, se é obrigatória e **para onde ela vai no contrato** (nome, e-mail, telefone, empresa, porte, cargo ou resposta livre em `answers`). `Ctrl+S` salva.
3. **Abrir para testar** (direita): escolha um preset (Meta, Google, e-mail, orgânico, direto) ou digite UTMs, `gclid`, `fbclid`, `lid` e um *referrer simulado*, e clique em **Abrir em nova aba**.
4. Preencha e envie. A página mostra o **resultado do orquestrador**: lead (novo ou existente e por qual critério), e-mail e telefone normalizados, canal derivado, touchpoint, consentimento e decisão.

## Dois modos

| Modo | O que faz | Grava? |
|---|---|---|
| **Simular** (padrão) | Roda o pipeline inteiro contra o banco real (token, validação, normalização, canal, dedupe) e **desfaz** a transação no fim | **Não** |
| **Gravar em modo sombra** | Igual, mas confirma a transação | **Sim, e é irreversível**: `orq.events` é imutável |

O modo "gravar" pede confirmação ao abrir e de novo ao enviar. Dados gravados ficam marcados com `answers._studio_form` e `lp_id` começando por `studio-`.

## O que é real e o que é de teste

- O **script de atribuição** da página é o mesmo `tracking/attribution.js` do GTM: cookies `qk_lid`, `qk_ft`, `qk_lt`, `_fbc` a partir do `fbclid`, etc. A seção "Atribuição capturada" mostra o que ele enviaria.
- O envio passa pelo **mesmo `ingest()`** do endpoint de produção. O token da fonte (`SOURCE_TOKEN_LP_VERCEL`, do `.env.local`) fica só no servidor local, nunca vai ao navegador.
- *Visitante novo* limpa os cookies de atribuição. Sem isso, a aba seguinte se comporta como um visitante que volta (útil para testar a regra "o e-mail pesa mais que o cookie").
- O *referrer simulado* só existe no Studio: serve para testar `organic_search`, `organic_social` e `referral`.

## Proteções do servidor local

Confere o `Host` (anti DNS-rebinding), a `Origin` e o `Content-Type: application/json` nas escritas (anti CSRF), limita o corpo a 1 MB e serve arquivos apenas de `studio/public`.

## Arquivos

| Caminho | Função |
|---|---|
| `studio/main.ts` | Sobe o servidor e liga ao pipeline e ao banco |
| `studio/server.ts` | Rotas e proteções |
| `studio/lib/` | Esquema (zod) e armazenamento dos formulários |
| `studio/forms/*.json` | Seus formulários (versionados) |
| `studio/public/` | Construtor (`index.html`, `builder.js`) e formulário (`form.html`, `form.js`, `form-logic.js`) |

## Painel de Dados (Data Hub do Pipedrive)

Em http://127.0.0.1:4310/painel (item **Painel de Dados** do menu). É uma área à parte do construtor de formulários e só aparece funcionando depois que a migration do Data Hub for aplicada e a PANEL_DB_URL existir no .env.local.

| Aba | Para que serve |
|---|---|
| Saúde da sincronização | Quando cada item foi atualizado com sucesso, últimas rodadas, erros e uso da cota do Pipedrive. Aviso vermelho se algo passar de 8 horas sem atualizar. |
| Configuração | Liga cada **pipeline a um produto** (RH ou Clínica) e, se quiser, cada **etapa a "chegou até aqui"** (SQL, reunião, proposta). Define **quais status contam como lead** (aberto, ganho, perdido, excluído) e **quais motivos de perda tiram o negócio do MQL**. Ganho/perdido vêm do Status do negócio, nunca da etapa. Salva sozinho ao escolher. |
| Pipelines e etapas | Lista com busca para conferir nomes e ordem. |
| Negócios | Totais por status e MQL, tabela por pipeline para comparar com o Pipedrive, lista com filtros (pipeline, status, só MQL, mês de criação, ID ou título) e a ficha do negócio com os campos personalizados. Só leitura. |
| Usuários e campos | Usuários (sem e-mail) e definição de campos, com o ID original. |
| Conferência | Totais para você comparar com o Pipedrive. |

O Painel usa um papel de banco próprio (orq_panel): lê só as visões de analytics e as tabelas de ops, **grava apenas a configuração** e não enxerga nenhuma tabela com dados pessoais. Se a PANEL_DB_URL faltar, o Studio sobe normalmente e o Painel mostra o que falta.

## Conversar com os dados no Claude Desktop (conector local)

Um conector (`quark-dados`) que o Claude Desktop inicia no seu computador, **sem abrir porta**, para você perguntar em português ("qual fonte converte melhor?", "compare as safras de março e agosto") e receber números e tabelas dos mesmos dados do BI. **Só leitura**, só visões de `analytics`, **sem e-mail, telefone, nome de pessoa nem título de negócio** (o banco recusa o resto).

| Passo | Comando |
|---|---|
| Gerar o conector | `npm run mcp:build` |
| Registrar no Claude Desktop | `node scripts/instalar-mcp-claude.mjs --apply` (guarda uma cópia da sua configuração antes) e depois **feche o Claude Desktop por completo e abra de novo** |
| Remover | `node scripts/instalar-mcp-claude.mjs --remover --apply` |

Ferramentas: `quark_definicoes` (comece por aqui), `quark_analise` (as análises do BI com filtros por nome), `quark_esquema`, `quark_sql` (um SELECT, até 200 linhas) e `quark_atualizacao` (quando os dados foram atualizados).

## Backup local e sincronia (sempre em dia, sem conflito)

| O que | Comando |
|---|---|
| Backup do banco da nuvem para esta máquina, conferido tabela por tabela | `npm run backup` (roda sozinho todo dia às 03:00 pela tarefa `QuarkDados-BackupLocal`) |
| Ver se nuvem, GitHub e este computador estão iguais (sem conflito) | `npm run sincronia` |
| Ver/criar/remover a tarefa diária | `powershell -File scripts\agendar-backup.ps1` (`-Status`, `-Remover`) |

Os backups ficam em `backups\` (fora do git): `nuvem-AAAAMMDD-HHMM.dump`, `ULTIMO_BACKUP.json` e `backup.log`. A nuvem é sempre a fonte da verdade: nunca se edita uma cópia local para subir. Detalhes na regra 7 da seção 4 do `orquestrador-marketing-quark.md`.

## BI (análises e KPIs)

Em http://127.0.0.1:4310/bi (item **BI** do menu). Gráficos, tabelas e KPIs sobre os negócios do Pipedrive, **só leitura**, em **4 páginas** (abas): Visão geral, Safra, Canais e Qualidade.

**Filtros (valem para todas as páginas, ficam à vista no topo e são lembrados):**
- **Data de criação** do negócio: este ano, ano passado, 90 ou 30 dias, tudo, ou datas à escolha.
- **Fonte do Lead**: começa com a seleção **fixa** Google ADS, Meta ADS, Orgânico e Social, e você pode marcar **outras** fontes (ou "em branco"). Botões: **Padrão** (volta à seleção fixa), **Todas** e **Fixar seleção atual** (passa a ser o seu padrão neste navegador). A seleção fixa de fábrica está em `PADRAO_FONTES` (`studio/lib/bi.ts`).
- **Tipo do Lead**: começa fixo em **Marketing**, com a possibilidade de marcar outros (Indicação, Prospecção, Parceria, CX…). `PADRAO_TIPOS`.
- **Produto** (RH ou Clínica) e **Pipeline**.

Cada análise tem **Gráfico** (ou **Mapa**), **Tabela**, **CSV** (planilha para o Excel, com vírgula decimal) e um "Como ler" que diz o que ela mede.

| Página | Análise | Responde |
|---|---|---|
| Visão geral | Visão geral | Leads, MQL, % MQL, ganhos, taxa de ganho, valor ganho, abertos e perdidos |
| | Leads, MQL e ganhos por mês | Como a entrada de leads evolui e quanto vira ganho |
| | Funil | Quantos chegaram em SQL, reunião e proposta (pelo histórico de etapas) e quantos ganharam |
| | Principais motivos de perda | Por que perdemos (nome e ID; marca os que tiram do MQL) |
| | Tempo em cada etapa | Onde os negócios ficam parados (mediana em dias) |
| | Desempenho por responsável | Quem fecha mais |
| **Safra** | Resultado de cada safra | Por mês de criação: % MQL, % que chegou em SQL, reunião e proposta, ganhos, taxa, valor e ciclo mediano |
| | Funil por safra | Mapa de calor do % de cada safra em cada marco |
| | Curva de safra | % dos leads de cada safra ganhos até 1, 2… 13 meses depois (células sem a idade ficam vazias) |
| **Canais** | **Funis lado a lado** | Uma coluna por fonte (as 6 com mais leads) e o total, com as mesmas etapas alinhadas (Leads, MQL, SQL, reunião, proposta, ganhos): barra = % dos leads da própria fonte, número = quantidade e o "passo" (conversão da etapa anterior) em cada etapa |
| | **Taxas de conversão por fonte** | Mapa: Lead→MQL, MQL→SQL, SQL→reunião, reunião→proposta, proposta→ganho e Lead→ganho, uma coluna por fonte, com a cor comparando as fontes dentro de cada linha |
| | Comparativo por fonte | Volume, % MQL, % inválidos, funil, ganhos, taxa, valor, ticket e ciclo por fonte |
| | Leads por fonte, mês a mês | Evolução de cada fonte (cor fixa por fonte; as demais em "Outras fontes") |
| | Canal de origem RD | De onde exatamente vêm os leads dentro das fontes escolhidas |
| **Qualidade** | Indicadores | % MQL, % inválidos, % perdidos, % sem fonte, sem tipo, sem faixa (RH e Clínica), sem pessoa e sem organização |
| | Qualidade por fonte | Quais fontes trazem leads melhores e mais bem preenchidos |
| | Qualidade ao longo do tempo | % MQL, % inválidos e % com dado em branco, mês a mês |
| | Por que os leads são inválidos | Motivos (nome e ID) que tiram do MQL |
| | Dados em branco | % em branco por campo (Faixa de Colaboradores só em RH; Faixa de profissionais da saúde só em Clínica) |

**Definições:** *chegou em SQL / reunião / proposta* = passou pela etapa marcada com esse nome **ou por uma posterior** (muitos negócios pulam etapas; assim o funil só diminui e os passos nunca passam de 100%); *ganho* vem sempre do Status do negócio. *inválido* = lead perdido por um motivo que a regra do Painel tira do MQL (hoje: Lead Invalido, Cliente em Busca de Suporte, Contato Inexistente, Oportunidade Duplicada). *Em branco* = campo do Pipedrive não preenchido.

**Como acrescentar uma análise (peça para o Claude):** cada análise é um bloco independente em `studio/lib/bi.ts` (lista `BI_ANALISES`: id, título, pergunta, "como ler", largura e uma função que consulta **só visões de `analytics`**). Ao acrescentar um bloco, a análise ganha sozinha o filtro, o gráfico (KPIs, colunas, barras ou tabela), a tabela e o CSV. O navegador nunca manda SQL: escolhe a análise e os filtros, validados no servidor e passados ao banco sempre como parâmetros. Testes provam os números com negócios fictícios (`tests/integration/bi.int.test.ts`) e a segurança (`tests/studio-bi.test.ts`).
