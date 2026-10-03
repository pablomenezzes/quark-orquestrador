# Payloads de exemplo

Um por fonte, para teste manual do endpoint `POST /api/ingest`. Todos usam dados falsos (`.invalid`).
Em modo sombra, o endpoint **só grava** em `core` e `orq`. Não chama Pipedrive, Umbler, Meta nem Google.

Antes: registre a fonte e guarde o token (aparece uma vez), em simulação primeiro:

```powershell
npx tsx scripts/register-source.ts --slug lp-vercel-rh-teste --tipo vercel --produto rh
npx tsx scripts/register-source.ts --slug elementor-site-rh --tipo elementor --produto rh
# depois de aprovado, com --apply para gravar
```

## Vercel (`samples/vercel.json`)

```powershell
curl.exe -i -X POST "https://SEU-PROJETO.vercel.app/api/ingest" `
  -H "content-type: application/json" `
  -H "x-quark-token: SEU_TOKEN" `
  --data-binary "@samples/vercel.json"
```

## Elementor (`samples/elementor.json`)

O Elementor não envia cabeçalhos: a fonte e o token vão na URL.

```powershell
curl.exe -i -X POST "https://SEU-PROJETO.vercel.app/api/ingest?source=elementor-site-rh&token=SEU_TOKEN" `
  -H "content-type: application/json" `
  --data-binary "@samples/elementor.json"
```

## O que esperar

| Cenário | Resposta |
|---|---|
| Primeira vez | `200 {"ok":true,"duplicate":false,"modo":"sombra","canal":...}` |
| Repetir o mesmo `event_id` | `200 {"ok":true,"duplicate":true}` e nada novo é gravado |
| Token errado ou fonte inexistente/inativa | `401 {"error":"unauthorized"}` |
| Falta `event_id` | `400 invalid_payload` |
| `website_hp` preenchido | `200 {"ok":true,"discarded":true}`, sem gravar |

Para repetir o teste como "novo", troque o `event_id`.
Canal esperado: `vercel.json` → `paid_social_meta`; `elementor.json` → `paid_search_google` (`gclid`).
