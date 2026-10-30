# Achados da API da Umbler (descoberta de 2026-10-30)

Somente leitura (GET). 11 GETs na descoberta (limite de 60) mais 192 na conferência de 4 meses. Amostras sanitizadas (sem nome, telefone, e-mail, token, link ou texto livre; IDs trocados por rótulos) em `docs/umbler/amostras/`. Reaplicar: `npx tsx scripts/umbler-descoberta.ts`. Conferir números: `npx tsx scripts/umbler-conferencia.ts [de] [ate]`.

## Origem do esquema
O swagger foi lido do arquivo `swagger_umbler.json` (baixado pelo Pablo de `https://app-utalk.umbler.com/api/`, OpenAPI 3.0.4, 2,2 MB). O arquivo não está no repositório. O protótipo `scripts/prototipos/umbler_marketing_report.py` citado no comando não existe no repositório; nada foi reaproveitado dele.

## Acesso
- Base `https://app-utalk.umbler.com/api`, cabeçalho `Authorization: Bearer <token>`.
- No `.env.local` a variável chama-se **`UMBLER`** (o comando dizia `UMBLER_TOKEN`). O Studio aceita `UMBLER_TOKEN`, `UMBLER_API_TOKEN` e `UMBLER`.
- Limite: **100 requisições por janela de 5 s** (texto do swagger em cada rota). O cliente usa 90 por 5 s, uma por vez, e recua no 429.
- Quase toda rota exige `organizationId` na query. `GET /v1/members/me/` lista as organizações da conta: aqui são **2, uma inativa** (a inativa responde 403 em tudo). O painel usa só as ativas.

## Rotas usadas
| Rota | Para quê | Observação real |
|---|---|---|
| `/v1/members/me/` | organizações | traz nome, e-mail e telefone do usuário: **só a lista de organizações é guardada** |
| `/v1/channels/` | canais (números) | lista pura; 27 canais; traz `phoneNumber` em alguns tipos, que **não** é guardado |
| `/v1/bots/` | bots/fluxos | paginado; 47 bots |
| `/v1/sectors/`, `/v1/tags/` | setores e etiquetas | 6 setores, 178 etiquetas |
| `/v1/bulk-send-session/` | sessões de envio em massa (a unidade do painel) | paginado (máximo 250 por página); 163 sessões no total; **a lista não traz totais nem template/bot** |
| `/v1/bulk-send-session/{id}/` | detalhe: totais, template, bot, estados | 1 GET por sessão |
| `/v1/bulk-send-session/{id}/costs/` | custo em créditos | o swagger avisa que **não é estável** |
| `/v1/bots/flowchart/botinstances/` | caminho de cada contato no fluxo | usado só sob demanda, guarda só contagens |

## Campos que valem
- Sessão: `id`, `createdAtUTC`, `title`, `type` (`Template` ou `Bot`), `channel.id`, `messagesSent`, `totalScheduled`; no detalhe: `totalSent`, `totalRead`, `totalFailed`, `totalProcessing`, `totalAnswered`, `answersFlowId`, `messageStates`, `scheduleStates`, `botStatuses`, `botStopReasons`, `bot {id, botName, triggerName}`, `template {id, label, category...}`.
- Custo: `totalCredits` e `lines [{creditType (Template|AI|Message), templateId, templateName, count, credits}]`.
- O `bot.id` da sessão **bate com o `id` do catálogo de bots** (19 de 19 sessões de bot em outubro).

## Pegadinhas conferidas na API real (já tratadas no código)
1. **Sessão de Bot: `messagesSent` vem 0**; o enviado está em `totalSent` (igual a `scheduleStates` Sent). O painel usa `totalSent`.
2. **Sessão de Bot: `messageStates` vem vazio e `totalRead`/`totalFailed` = 0.** Esse 0 é "não rastreado", não "ninguém leu". Leitura aparece como indisponível, com motivo. Falha usa os erros de agendamento.
3. **Custo zerado sem linhas = sem registro.** Em jul a set/2026 todas as sessões devolveram `totalCredits` 0 com `lines` vazio; só 4 das 19 sessões de outubro têm custo. Isso aparece como "indisponível" ("sem registro de custo"), nunca como R$ 0.
4. **`totalAnswered` só existe para envios com formulário (WhatsApp Flow)**; nas 91 sessões de jul a out veio `null`. Não há resposta de conversa comum em nenhuma rota agregada.
5. **Unidade do crédito:** um template custou 3.900 créditos por mensagem (`count 21`, `credits 81900`). Pelos preços da Meta (~R$ 0,39 por template de marketing) isso sugere **1 crédito = R$ 0,0001**, mas é inferência, não documentado. O preço do crédito fica em Configuração e deve ser conferido contra a tela da Umbler antes de confiar no R$.
6. Duas listagens são `oneOf` (Basic ou completo); o serviço pede o detalhe sempre que a listagem não traz totais.

## O que a API NÃO expõe (e o painel diz isso na tela)
- **Respostas por envio de template comum**: só contagem de formulário (Flow). Sem isso, "custo por resposta" fica indisponível na maioria dos casos.
- **Leitura e falha das mensagens de fluxos**: não rastreadas.
- **Custo de sessões antigas**: sem registro.
- **Pós-resposta (o que o contato fez depois)**: só existe nas conversas individuais (`/v1/chats/`, mensagens), que têm nome, telefone e texto. O painel não lê nem guarda isso.
- **Passos de fluxo com nome**: `botinstances` traz o caminho (`navigationPath`) só com o ID do passo. A tela mostra o último passo (ID) de cada contato; teste real: 200 de 390 instâncias lidas (limite de 2 páginas no teste), 2 passos finais distintos.
- Setor e etiqueta **não vêm na sessão de envio**: ficam só como registro na Configuração, fora da regra de pertencimento.

## Privacidade do que fica em disco
- `studio/config/umbler-marketing.json` (versionado, repositório público): só IDs, nomes de canais/bots escolhidos, limites e preços. Sem telefone e sem token.
- `.cache/umbler/` (ignorado pelo git): JSON original das respostas, **sem** chaves de telefone, e-mail, foto, token ou nome de usuário.
- O JSON bruto de `botinstances` (traz `data` e conversa) **nunca** vai para o cache; só a contagem.
