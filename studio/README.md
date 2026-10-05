# Quark Studio

Ambiente de testes local do orquestrador: você **monta formulários**, abre numa **nova aba** (todas as perguntas na mesma tela, estilo Typeform) com os **UTMs** que quiser e vê **o que o orquestrador faria** com o envio.

## Como rodar (sozinho, num PowerShell)

```powershell
cd C:\Users\Esig\Documents\quark-orquestrador
npm run studio
```

O navegador abre em `http://127.0.0.1:4310`. **Deixe a janela do PowerShell aberta**: fechar a janela (ou `Ctrl+C`) para o Studio. Os formulários ficam salvos em `studio/forms/` e não se perdem.

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

Em http://127.0.0.1:4310/painel (ou pelo link "Painel de Dados" no topo do Studio). É uma área à parte do construtor de formulários e só aparece funcionando depois que a migration do Data Hub for aplicada e a PANEL_DB_URL existir no .env.local.

| Aba | Para que serve |
|---|---|
| Saúde da sincronização | Quando cada item foi atualizado com sucesso, últimas rodadas, erros e uso da cota do Pipedrive. Aviso vermelho se algo passar de 8 horas sem atualizar. |
| Configuração | Liga cada **pipeline a um produto** (RH ou Clínica) e cada **etapa a um marco do funil**. Salva sozinho ao escolher. |
| Pipelines e etapas | Lista com busca para conferir nomes e ordem. |
| Usuários e campos | Usuários (sem e-mail) e definição de campos, com o ID original. |
| Conferência | Totais para você comparar com o Pipedrive. |

O Painel usa um papel de banco próprio (orq_panel): lê só as visões de nalytics e as tabelas de ops, **grava apenas a configuração** e não enxerga nenhuma tabela com dados pessoais. Se a PANEL_DB_URL faltar, o Studio sobe normalmente e o Painel mostra o que falta.
