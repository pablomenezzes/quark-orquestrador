import { validateValues, buildContract } from './form-logic.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const qs = new URLSearchParams(location.search);
const MODE = qs.get('mode') === 'real' ? 'real' : 'dry';
const REF_OVERRIDE = qs.get('ref') || '';
const formId = decodeURIComponent(location.pathname.split('/').pop() || '');
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

let form = null;
let values = {};
let consentChecked = false;
let submitting = false;

/* ---------- barra de modo ---------- */
function renderModebar() {
  const el = $('#modebar');
  if (MODE === 'real') {
    el.className = 'modebar real';
    el.innerHTML = '<span>● GRAVANDO EM MODO SOMBRA: o envio grava no banco (irreversível)</span><span class="spacer"></span>';
  } else {
    el.className = 'modebar dry';
    el.innerHTML = '<span>● SIMULAÇÃO: o pipeline roda inteiro, mas nada é gravado</span><span class="spacer"></span>';
  }
  el.insertAdjacentHTML('beforeend', '<span id="count" style="font-weight:500"></span>');
}

/* ---------- render ---------- */
function inputFor(f) {
  const id = `i-${f.id}`;
  const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
  const v = values[f.id] ?? (f.type === 'checkbox' ? [] : '');
  switch (f.type) {
    case 'textarea':
      return `<textarea id="${id}" data-id="${f.id}"${ph} rows="3">${esc(v)}</textarea>`;
    case 'select':
      return `<select id="${id}" data-id="${f.id}"><option value="">Selecione…</option>${f.options.map((o) => `<option ${v === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    case 'radio':
    case 'checkbox': {
      const isCb = f.type === 'checkbox';
      return `<div class="opts" role="${isCb ? 'group' : 'radiogroup'}" aria-labelledby="l-${f.id}">${f.options
        .map((o, i) => {
          const sel = isCb ? v.includes(o) : v === o;
          return `<label class="opt ${sel ? 'sel' : ''}"><input type="${isCb ? 'checkbox' : 'radio'}" name="n-${f.id}" data-id="${f.id}" value="${esc(o)}" ${sel ? 'checked' : ''}><span class="k">${LETTERS[i] ?? i + 1}</span><span>${esc(o)}</span></label>`;
        })
        .join('')}</div>`;
    }
    default: {
      const t = { email: 'email', phone: 'tel', number: 'number', date: 'date', url: 'url' }[f.type] || 'text';
      const extra = f.type === 'phone' ? ' inputmode="tel" autocomplete="tel"' : f.type === 'email' ? ' autocomplete="email"' : '';
      return `<input id="${id}" data-id="${f.id}" type="${t}"${ph}${extra} value="${esc(v)}">`;
    }
  }
}

function render() {
  document.title = form.title;
  $('#app').innerHTML = `
    <header class="fhead"><h1>${esc(form.title)}</h1>${form.description ? `<p>${esc(form.description)}</p>` : ''}</header>
    <form id="f" novalidate autocomplete="on">
      ${form.fields
        .map(
          (f, i) => `
        <section class="q" data-q="${f.id}">
          <div class="q-label" id="l-${f.id}"><span class="n">${i + 1}</span><label for="i-${f.id}">${esc(f.label)}${f.required ? ' <span class="req" title="obrigatória">*</span>' : ''}</label></div>
          ${f.help ? `<p class="q-help">${esc(f.help)}</p>` : ''}
          <div class="q-input">${inputFor(f)}</div>
          <p class="q-err" data-err="${f.id}" role="alert"></p>
        </section>`,
        )
        .join('')}
      <input class="hp" type="text" name="website_hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      ${form.show_consent ? `<label class="consent"><input type="checkbox" id="consent" ${consentChecked ? 'checked' : ''}><span>${esc(form.consent_text)}</span></label>` : ''}
      <div class="submit-row">
        <button class="btn primary" type="submit" id="submit">${esc(form.submit_label)}</button>
        <span class="muted" id="form-err" role="alert"></span>
      </div>
    </form>
    <div id="result"></div>
    <details class="dbg"><summary>Atribuição capturada neste navegador</summary>
      <p class="muted" style="font-size:13px">É o que o script de atribuição (o mesmo do GTM) enviaria com este envio.</p>
      <pre class="json" id="attr"></pre>
      <button class="btn small" id="clear-cookies" type="button">Limpar cookies de atribuição e recarregar</button>
    </details>`;
  updateProgress();
  renderAttr();
}

function renderAttr() {
  const el = $('#attr');
  if (!el) return;
  const q = window.QuarkAttribution?.get();
  el.textContent = q ? JSON.stringify(q, null, 2) : 'O script de atribuição não carregou.';
}

function updateProgress() {
  const total = form.fields.length;
  const done = form.fields.filter((f) => {
    const v = values[f.id];
    return Array.isArray(v) ? v.length > 0 : String(v ?? '').trim() !== '';
  }).length;
  $('#bar').style.width = total ? `${(done / total) * 100}%` : '0';
  const c = $('#count');
  if (c) c.textContent = `${done} de ${total} respondidas`;
}

/* ---------- eventos ---------- */
document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.id === 'consent') {
    consentChecked = t.checked;
    return;
  }
  const id = t.dataset?.id;
  if (!id) return;
  const f = form.fields.find((x) => x.id === id);
  if (f.type === 'checkbox') {
    values[id] = [...document.querySelectorAll(`input[data-id="${id}"]:checked`)].map((i) => i.value);
  } else if (f.type === 'radio') {
    values[id] = t.value;
  } else {
    values[id] = t.value;
  }
  if (f.type === 'radio' || f.type === 'checkbox') {
    document.querySelectorAll(`input[data-id="${id}"]`).forEach((i) => i.closest('.opt').classList.toggle('sel', i.checked));
  }
  const q = document.querySelector(`[data-q="${id}"]`);
  q.classList.remove('err');
  $(`[data-err="${id}"]`).textContent = '';
  updateProgress();
});

document.addEventListener('click', (ev) => {
  if (ev.target.id === 'clear-cookies') {
    for (const n of ['qk_lid', 'qk_ft', 'qk_lt']) document.cookie = `${n}=; path=/; max-age=0; SameSite=Lax`;
    const u = new URL(location.href);
    u.searchParams.set('fresh', '1');
    location.href = u.toString();
  }
  if (ev.target.id === 'again') {
    values = {};
    consentChecked = false;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

document.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (submitting) return;
  const errors = validateValues(form, values);
  document.querySelectorAll('.q').forEach((q) => q.classList.remove('err'));
  document.querySelectorAll('[data-err]').forEach((p) => (p.textContent = ''));
  $('#form-err').textContent = '';
  const ids = Object.keys(errors);
  if (ids.length) {
    for (const id of ids) {
      document.querySelector(`[data-q="${id}"]`).classList.add('err');
      $(`[data-err="${id}"]`).textContent = errors[id];
    }
    $('#form-err').textContent = `${ids.length} pergunta(s) precisam de atenção.`;
    document.querySelector(`[data-q="${ids[0]}"]`).scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (MODE === 'real' && !confirm('Este envio será GRAVADO no banco (irreversível). Continuar?')) return;

  submitting = true;
  const btn = $('#submit');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const q = window.QuarkAttribution.get();
    const payload = buildContract(form, values, {
      lead_id: q.lead_id,
      event_id: q.event_id,
      attribution: q.attribution,
      first_touch: q.first_touch,
      consent: q.consent,
      consentChecked,
      honeypot: $('[name="website_hp"]').value,
      referrerOverride: REF_OVERRIDE,
      now: new Date().toISOString(),
    });
    const res = await fetch(`/api/submit/${encodeURIComponent(form.id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: MODE, payload }),
    });
    const data = await res.json().catch(() => ({}));
    showResult(res.status, data, payload);
    // Como numa LP real: consome o event_id e dispara generate_lead no dataLayer.
    if (res.ok) window.QuarkAttribution.pushLead({ form_id: payload.form_id, lp_id: payload.lp_id });
  } catch (e) {
    showResult(0, { error: e.message }, null);
  } finally {
    submitting = false;
    const b = $('#submit');
    if (b) {
      b.disabled = false;
      b.textContent = form.submit_label;
    }
  }
});

/* ---------- resultado ---------- */
const kv = (rows) =>
  `<dl class="kv">${rows.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('')}</dl>`;

function showResult(status, data, payload) {
  const el = $('#result');
  let chip;
  if (status === 0 || status >= 500) chip = '<span class="chip danger">Erro</span>';
  else if (status >= 400) chip = '<span class="chip danger">Recusado</span>';
  else if (data.discarded) chip = '<span class="chip warn">Descartado (honeypot)</span>';
  else if (data.duplicate) chip = '<span class="chip warn">Duplicado (event_id já existe)</span>';
  else if (data.dry_run) chip = '<span class="chip ok">Simulado: nada foi gravado</span>';
  else chip = '<span class="chip danger">Gravado no banco (modo sombra)</span>';

  const ok = status === 200 && !data.discarded;
  const p = data.preview;
  let body = '';
  if (p) {
    body = `
      <h3>Lead</h3>${kv([
        ['Situação', p.lead.created ? 'novo lead seria criado' : `lead existente (encontrado por ${p.lead.matched_by})`],
        ['lead_id', p.lead.lead_id], ['E-mail normalizado', p.lead.email_norm], ['Telefone E.164', p.lead.phone_e164],
        ['Nome', p.lead.nome], ['Empresa', p.lead.empresa], ['Porte', p.lead.porte], ['Cargo', p.lead.cargo], ['Produto', p.lead.produto],
      ])}
      <h3>Touchpoint</h3>${kv([
        ['Canal derivado', p.touchpoint.canal], ['utm_source', p.touchpoint.utm_source], ['utm_medium', p.touchpoint.utm_medium],
        ['utm_campaign', p.touchpoint.utm_campaign], ['utm_term', p.touchpoint.utm_term], ['utm_content', p.touchpoint.utm_content],
        ['ad_id', p.touchpoint.ad_id], ['gclid', p.touchpoint.gclid], ['fbp', p.touchpoint.fbp], ['fbc', p.touchpoint.fbc],
        ['landing_url', p.touchpoint.landing_url], ['referrer', p.touchpoint.referrer], ['event_id', p.touchpoint.event_id],
      ])}
      <h3>Evento e decisão</h3>${kv([
        ['Tipo', p.event.tipo], ['Consentimento', p.event.dados.consent], ['Respostas', p.event.dados.answers],
        ['Decisão', `${p.decision.acao} · ${p.decision.modo} · ${p.decision.status}`],
      ])}`;
  } else if (ok) {
    body = kv([['Canal derivado', data.canal], ['lead_id', data.lead_id], ['event_id (orq.events)', data.event_id], ['Duplicado', data.duplicate ? 'sim' : 'não']]);
  } else {
    body = kv([['Status HTTP', status || 'sem resposta'], ['Erro', data.error], ['Detalhe', data.detail], ['Problemas', data.issues ? data.issues.map((i) => `${i.path}: ${i.message}`).join(' | ') : '']]);
  }

  el.innerHTML = `
    <div class="result">
      ${ok ? `<div class="thanks"><h2>${esc(form.thank_you_title)}</h2><p class="muted" style="font-size:18px">${esc(form.thank_you_message)}</p></div>` : ''}
      <section class="card section stack">
        <div class="row"><h2 style="margin:0">Resultado do orquestrador</h2>${chip}</div>
        ${body}
        <details><summary class="muted" style="cursor:pointer">Ver o que foi enviado e a resposta completa</summary>
          <p class="lbl" style="margin-top:12px">Enviado (contrato da seção 7)</p><pre class="json">${esc(JSON.stringify(payload, null, 2))}</pre>
          <p class="lbl" style="margin-top:12px">Resposta (HTTP ${status})</p><pre class="json">${esc(JSON.stringify(data, null, 2))}</pre>
        </details>
        <div class="row"><button class="btn" id="again" type="button">Preencher de novo</button></div>
      </section>
    </div>`;
  renderAttr();
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- início ---------- */
(async function init() {
  renderModebar();
  try {
    const res = await fetch(`/api/forms/${encodeURIComponent(formId)}`);
    if (!res.ok) throw new Error('Formulário não encontrado');
    form = await res.json();
    render();
  } catch (e) {
    $('#app').innerHTML = `<div class="banner danger" style="margin-top:40px">${esc(e.message)}</div>`;
  }
})();
