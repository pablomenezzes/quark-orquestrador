# Quark Studio

Ambiente de testes local do orquestrador: você **monta formulários**, abre numa **nova aba** (todas as perguntas na mesma tela, estilo Typeform) com os **UTMs** que quiser e vê **o que o orquestrador faria** com o envio.

```powershell
npm run studio        # abre http://127.0.0.1:4310
```

Escuta só em `127.0.0.1`. Não é publicado na Vercel e não altera a Deployment Protection.

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
