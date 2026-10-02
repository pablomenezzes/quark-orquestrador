# Instalação do script de atribuição

Script: [`attribution.js`](./attribution.js) · Seção 12.2 do `orquestrador-marketing-quark.md`.

O script roda **uma vez**, no GTM, e atende Elementor, Vercel, Lovable e Fillout.
Ele só **captura** identificadores. Quem envia conversões é o servidor.

## 1. Criar a tag no GTM (container web único)

1. **Tags → Nova → HTML personalizado**. Nome: `Quark - Atribuicao`.
2. Cole o conteúdo de `attribution.js` **dentro de uma tag `<script>`**:
   ```html
   <script>
     window.QUARK_ATTR_CONFIG = {
       cookieDomain: '',          // ex: '.quark.com.br' se houver subdomínios (ver abaixo)
       decorateHosts: ['fillout.com', 'form.fillout.com'], // + domínio do diagnóstico
       ignoreReferrerHosts: []    // domínios próprios e gateways que não devem virar "toque"
     };
     /* --- cole aqui o conteúdo de attribution.js --- */
   </script>
   ```
3. **Acionador:** `Initialization - All Pages` (para rodar antes dos formulários).
4. **Configurações de consentimento:** exigir `analytics_storage` (e `ad_storage` se quiser marketing).
   Com o Consent Mode v2, a tag só dispara depois do aceite. Se preferir gravar o `lead_id` antes do aceite, informe `getConsent` na configuração.
5. **Visualizar** → validar → **Publicar**.

### Configuração (`QUARK_ATTR_CONFIG`)

| Chave | Padrão | Para quê |
|---|---|---|
| `cookieDomain` | `''` (host atual) | `.dominio.com.br` compartilha o `lead_id` entre site e LPs do mesmo domínio |
| `decorateHosts` | Fillout | Hosts cujos links/iframes recebem `lid` e atribuição |
| `ignoreReferrerHosts` | `[]` | Referrers que não contam como novo toque |
| `metaSources` | meta, facebook, fb, instagram, ig | `utm_source` cujo `utm_content` é o `ad.id` |
| `getConsent` | detecta o Consent Mode | Função `() => ({marketing, analytics})`. Desconhecido = `false` |
| `honeypotName` | `website_hp` | Campo que o script nunca preenche |

## 2. Evento de conversão no dataLayer

Em **todo** formulário, no envio **bem-sucedido**:

```js
window.QuarkAttribution.pushLead({ form_id: 'form-demo', lp_id: 'lp-meta-rh-dp' });
```

Isso empurra `generate_lead` com `lead_id` e `event_id` e gera um novo `event_id` para o próximo envio.
No GTM, crie o acionador **Evento personalizado = `generate_lead`** para disparar GA4 e Pixel (`eventID = event_id`).

## 3. Por plataforma

### Elementor (WordPress)

1. Instale o GTM no WordPress (plugin Site Kit, ou o snippet no cabeçalho do tema filho).
2. No formulário, adicione **campos ocultos** com estes **IDs** (o Elementor monta `name="form_fields[<id>]"`, o script reconhece):
   `lead_id`, `event_id`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`,
   `gclid`, `gbraid`, `wbraid`, `fbclid`, `fbp`, `fbc`, `ga_client_id`, `ad_id`, `landing_url`, `referrer`,
   `consent_marketing`, `consent_analytics`.
3. Adicione a **Ação após o envio → Webhook** apontando para `POST /api/ingest`, com o header de token da fonte
   (ver `samples/elementor.json` para os nomes de campo).
4. Elementor Pro dispara o evento `elementor_pro/forms/form_submitted`. Para o `generate_lead`, adicione na página (HTML ou tag GTM):
   ```js
   jQuery(document).on('submit_success', '.elementor-form', function () {
     window.QuarkAttribution.pushLead({ form_id: 'form-demo', lp_id: 'lp-meta-rh-dp' });
   });
   ```
   O Elementor usa o `event_id` do campo oculto, que já foi enviado no webhook. O `pushLead` vem **depois** do envio, então o par `event_id` do dataLayer e do webhook coincide.
5. Popups do Elementor: o script observa o DOM e preenche campos que aparecem depois.

### Vercel (LP em código)

1. Adicione o snippet do GTM no `<head>`.
2. No envio, leia os dados do script e envie ao endpoint:
   ```ts
   const q = window.QuarkAttribution.get();
   await fetch('https://SEU-ORQUESTRADOR/api/ingest', {
     method: 'POST',
     headers: { 'content-type': 'application/json', 'x-quark-token': TOKEN_DA_FONTE },
     body: JSON.stringify({
       source_slug: 'lp-vercel-teste',
       form_id: 'form-demo',
       lp_id: 'lp-vercel-teste',
       event_id: q.event_id,
       lead_id: q.lead_id,
       event_type: 'form_submit',
       occurred_at: new Date().toISOString(),
       contact: { name, email, phone, company, company_size, role },
       attribution: q.attribution,
       consent: q.consent,
       website_hp: '', // honeypot: campo escondido por CSS; bots o preenchem
     }),
   });
   window.QuarkAttribution.pushLead({ form_id: 'form-demo', lp_id: 'lp-vercel-teste' });
   ```
3. Não precisa de campos ocultos em React: use `get()`.
4. **O token da fonte aparece no código do navegador.** Ele só identifica a fonte; a defesa real é o honeypot, a validação do contrato e o limite de requisições (pendente). Não reutilize este token para nada mais.

### Lovable (diagnóstico)

1. Adicione o GTM ao projeto (campo de código do cabeçalho em `index.html`).
2. Na abertura da página, o `?lid=` da URL é lido pelo script e passa a ser o `lead_id` (ciclo do diagnóstico, seção 5).
3. Ao concluir, envie `event_type: 'diagnostico_concluido'` com `answers` e o score, usando o mesmo `fetch` do exemplo da Vercel.
4. O adaptador do Lovable é de uma sessão futura. Até lá, apenas o script é necessário.

### Fillout

1. O Fillout não executa o script. O script **decora o link ou o iframe** que leva ao Fillout:
   `lid`, UTMs, `gclid`, `fbclid`, `fbp`, `fbc`, `ga_client_id`, `ad_id`, `landing_url`, `referrer`.
   Inclua o domínio do Fillout em `decorateHosts`.
2. No Fillout: **Configurações → Campos ocultos (URL parameters)**: crie um para cada nome acima.
3. **Webhook:** aponte para o endpoint com o header do token. O adaptador do Fillout é de uma sessão futura.
4. Se o Fillout estiver em outro domínio, configure o domínio cruzado no GA4 (item abaixo).

## 4. Fora do script (configuração do GTM/GA4)

- **Domínio cruzado** (Configurações da tag Google → *Configurar seus domínios*), se site, LPs e Fillout tiverem domínios diferentes.
- **Consent Mode v2** com banner de cookies (LGPD).
- **Referências indesejadas** no GA4: incluir o domínio do Fillout.
- **Pixel da Meta:** evento `Lead` com `eventID = {{event_id}}` (variável do dataLayer).

## 5. Como testar

1. GTM → **Visualizar** → abra `https://sua-lp/?utm_source=meta&utm_medium=paid_social&utm_campaign=1&utm_term=2&utm_content=3&fbclid=teste`.
2. No console: `QuarkAttribution.get()` deve mostrar a atribuição e `fbc`.
3. Inspecione os campos ocultos do formulário (aba Elements).
4. Recarregue sem parâmetros: o `utm_source` deve permanecer (último toque pago é mantido).
5. Em `dataLayer`, após o envio, procure `generate_lead` com `event_id`.

## 6. Cookies criados

| Cookie | Conteúdo | Validade |
|---|---|---|
| `qk_lid` | UUID do lead | 400 dias |
| `qk_ft` | Primeiro toque (JSON) | 400 dias |
| `qk_lt` | Último toque (JSON) | 90 dias |

São cookies próprios, sem e-mail nem telefone. Declare-os na política de cookies.
