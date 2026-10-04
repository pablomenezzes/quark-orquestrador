import { slugify, uniqueKey, buildTestUrl, PRESETS, UTM_FIELDS } from './form-logic.js';

const TYPE_LABELS = {
  text: 'Texto curto', textarea: 'Texto longo', email: 'E-mail', phone: 'Telefone', number: 'Número',
  select: 'Lista suspensa', radio: 'Escolha única', checkbox: 'Múltipla escolha', date: 'Data', url: 'Link (URL)',
};
const MAP_LABELS = {
  answer: 'Resposta livre (vai em answers)', name: 'Nome', email: 'E-mail', phone: 'Telefone',
  company: 'Empresa', company_size: 'Porte (nº de funcionários)', role: 'Cargo',
};
const CHOICE = new Set(['select', 'radio', 'checkbox']);
const QUICK = [
  { label: 'Nome', type: 'text', map: 'name', text: 'Qual é o seu nome?', required: true },
  { label: 'E-mail', type: 'email', map: 'email', text: 'Qual é o seu e-mail?', required: true },
  { label: 'WhatsApp', type: 'phone', map: 'phone', text: 'Qual é o seu WhatsApp?', placeholder: '(84) 99999-9999' },
  { label: 'Empresa', type: 'text', map: 'company', text: 'Qual é a sua empresa?' },
  { label: 'Porte', type: 'number', map: 'company_size', text: 'Quantos funcionários a empresa tem?' },
  { label: 'Cargo', type: 'text', map: 'role', text: 'Qual é o seu cargo?' },
];
const LABELS_UTM = {
  utm_source: 'utm_source', utm_medium: 'utm_medium', utm_campaign: 'utm_campaign', utm_term: 'utm_term', utm_content: 'utm_content',
  gclid: 'gclid', gbraid: 'gbraid', wbraid: 'wbraid', fbclid: 'fbclid', lid: 'lid (lead_id existente)', ref: 'Referrer simulado',
};

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data, status: res.status });
  return data;
}

function loadTest() {
  try {
    return { params: {}, fresh: false, mode: 'dry', confirmReal: false, ...JSON.parse(localStorage.getItem('qk-studio-test') || '{}'), confirmReal: false };
  } catch {
    return { params: {}, fresh: false, mode: 'dry', confirmReal: false };
  }
}
const saveTest = () => {
  try {
    localStorage.setItem('qk-studio-test', JSON.stringify({ params: S.test.params, fresh: S.test.fresh, mode: S.test.mode }));
  } catch {}
};

const S = { list: [], form: null, original: '', isNew: false, meta: { sources: [], db: {} }, open: null, errors: [], test: loadTest() };

const snap = (f) => JSON.stringify({ ...f, updated_at: undefined }, (k, v) => (k.startsWith('_') ? undefined : v));
const dirty = () => !!S.form && snap(S.form) !== S.original;
const newId = () => Math.random().toString(36).slice(2, 10);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 2600);
}

function blankForm() {
  const taken = S.list.map((f) => f.id);
  const id = uniqueKey('novo-formulario', taken);
  const f = {
    id, title: 'Novo formulário', description: 'Conte um pouco sobre você.', submit_label: 'Enviar',
    thank_you_title: 'Obrigado!', thank_you_message: 'Recebemos suas respostas.',
    source_slug: S.meta.sources[0] || 'lp-vercel-rh-teste', form_id: '', lp_id: '', event_type: 'form_submit',
    show_consent: true, consent_text: 'Concordo com o tratamento dos meus dados para contato.', fields: [],
  };
  for (const q of QUICK.slice(0, 4)) f.fields.push(makeField(f, q));
  return f;
}

function makeField(form, q) {
  const keys = form.fields.map((x) => x.key);
  return {
    id: newId(), key: uniqueKey(slugify(q.text || q.label || 'campo'), keys), type: q.type, label: q.text || 'Nova pergunta',
    help: '', placeholder: q.placeholder || '', required: !!q.required, _new: true, options: CHOICE.has(q.type) ? ['Opção 1', 'Opção 2'] : [], map: q.map || 'answer',
  };
}

function setForm(form, isNew) {
  S.form = form;
  S.isNew = isNew;
  S.original = isNew ? '' : snap(form);
  S.open = null;
  S.errors = [];
  render();
}

async function refreshList() {
  S.list = await api('/api/forms');
  renderList();
}

/* ---------- lista lateral ---------- */
function renderList() {
  const el = $('#forms-list');
  if (!S.list.length && !S.isNew) {
    el.innerHTML = '<p class="muted" style="font-size:13px">Nenhum formulário ainda.</p>';
    return;
  }
  const items = S.list.map((f) => {
    const active = S.form && S.form.id === f.id && !S.isNew;
    return `<button class="form-item ${active ? 'active' : ''}" data-open="${esc(f.id)}"><strong>${esc(f.title)}</strong><small>${f.fields} pergunta(s) · ${esc(f.id)}</small></button>`;
  });
  if (S.isNew && S.form) items.unshift(`<button class="form-item active"><strong>${esc(S.form.title)}</strong><small>não salvo</small></button>`);
  el.innerHTML = items.join('');
}

/* ---------- editor ---------- */
function fieldCard(f, i) {
  const open = S.open === f.id;
  const usedMaps = new Set(S.form.fields.filter((x) => x.id !== f.id && x.map !== 'answer').map((x) => x.map));
  const mapOpts = Object.entries(MAP_LABELS)
    .map(([v, l]) => `<option value="${v}" ${f.map === v ? 'selected' : ''} ${usedMaps.has(v) ? 'disabled' : ''}>${l}${usedMaps.has(v) ? ' (já usado)' : ''}</option>`)
    .join('');
  const typeOpts = Object.entries(TYPE_LABELS).map(([v, l]) => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${l}</option>`).join('');
  return `
  <div class="q-card ${open ? 'open' : ''}" data-fid="${f.id}">
    <div class="q-head" data-act="toggle">
      <span class="q-num">${i + 1}</span>
      <span class="q-title" data-title>${esc(f.label)}</span>
      <span class="chip">${TYPE_LABELS[f.type]}</span>
      ${f.map !== 'answer' ? `<span class="chip accent">${MAP_LABELS[f.map].split(' (')[0]}</span>` : ''}
      ${f.required ? '<span class="chip warn">obrigatória</span>' : ''}
      <span class="row" style="gap:2px">
        <button class="btn small ghost" data-act="up" title="Subir" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn small ghost" data-act="down" title="Descer" ${i === S.form.fields.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn small ghost" data-act="dup" title="Duplicar">⧉</button>
        <button class="btn small ghost danger" data-act="del" title="Remover">✕</button>
      </span>
    </div>
    ${open ? `
    <div class="q-body">
      <div style="padding-top:12px"><label class="lbl">Pergunta</label><input class="field-input" data-f="label" value="${esc(f.label)}"></div>
      <div><label class="lbl">Texto de apoio (opcional)</label><input class="field-input" data-f="help" value="${esc(f.help)}"></div>
      <div class="grid2">
        <div><label class="lbl">Tipo de resposta</label><select class="field-input" data-f="type">${typeOpts}</select></div>
        <div><label class="lbl">Vai para (no contrato)</label><select class="field-input" data-f="map">${mapOpts}</select></div>
      </div>
      ${CHOICE.has(f.type) ? `<div><label class="lbl">Opções (uma por linha)</label><textarea class="field-input" data-f="options" rows="4">${esc(f.options.join('\n'))}</textarea></div>` : `<div><label class="lbl">Texto de exemplo (placeholder)</label><input class="field-input" data-f="placeholder" value="${esc(f.placeholder)}"></div>`}
      <div class="grid2">
        <div><label class="lbl">Chave da resposta</label><input class="field-input mono" data-f="key" value="${esc(f.key)}"></div>
        <label class="row" style="align-self:end;padding-bottom:8px"><input type="checkbox" data-f="required" ${f.required ? 'checked' : ''}> Resposta obrigatória</label>
      </div>
    </div>` : ''}
  </div>`;
}

function render() {
  renderList();
  renderEditor();
  renderTest();
}

function renderEditor() {
  const el = $('#editor');
  const f = S.form;
  if (!f) {
    el.innerHTML = `<section class="card section"><h2>Bem-vindo ao Studio</h2><p class="muted">Crie um formulário para testar o orquestrador: monte as perguntas, abra numa nova aba com os UTMs que quiser e veja o que seria gravado.</p><button class="btn primary" data-act="new">+ Novo formulário</button></section>`;
    return;
  }
  const sourceOpts = (S.meta.sources.length ? S.meta.sources : [f.source_slug])
    .map((s) => `<option ${s === f.source_slug ? 'selected' : ''}>${esc(s)}</option>`).join('');
  el.innerHTML = `
  ${S.errors.length ? `<div class="banner danger"><strong>Não foi possível salvar:</strong><ul>${S.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
  <section class="card section stack">
    <h2>Formulário</h2>
    <div><label class="lbl">Título</label><input class="field-input" data-form="title" value="${esc(f.title)}"></div>
    <div><label class="lbl">Descrição</label><textarea class="field-input" data-form="description" rows="2">${esc(f.description)}</textarea></div>
    <div class="grid2">
      <div><label class="lbl">Texto do botão</label><input class="field-input" data-form="submit_label" value="${esc(f.submit_label)}"></div>
      <div><label class="lbl">Id (endereço do formulário)</label><input class="field-input mono" data-form="id" value="${esc(f.id)}" ${S.isNew ? '' : 'disabled'}></div>
    </div>
    <div class="grid2">
      <div><label class="lbl">Título da página de obrigado</label><input class="field-input" data-form="thank_you_title" value="${esc(f.thank_you_title)}"></div>
      <div><label class="lbl">Mensagem de obrigado</label><input class="field-input" data-form="thank_you_message" value="${esc(f.thank_you_message)}"></div>
    </div>
    <label class="row"><input type="checkbox" data-form="show_consent" ${f.show_consent ? 'checked' : ''}> Mostrar caixa de consentimento (LGPD)</label>
    ${f.show_consent ? `<div><label class="lbl">Texto do consentimento</label><input class="field-input" data-form="consent_text" value="${esc(f.consent_text)}"></div>` : ''}
    <details>
      <summary class="muted" style="cursor:pointer">Avançado: como o orquestrador enxerga este formulário</summary>
      <div class="grid2" style="margin-top:12px">
        <div><label class="lbl">Fonte (orq.sources)</label><select class="field-input" data-form="source_slug">${sourceOpts}</select></div>
        <div><label class="lbl">Tipo de evento</label><select class="field-input" data-form="event_type">
          ${['form_submit', 'diagnostico_iniciado', 'diagnostico_concluido'].map((t) => `<option ${t === f.event_type ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div><label class="lbl">form_id</label><input class="field-input mono" data-form="form_id" value="${esc(f.form_id)}" placeholder="${esc(f.id)}"></div>
        <div><label class="lbl">lp_id</label><input class="field-input mono" data-form="lp_id" value="${esc(f.lp_id)}" placeholder="studio-${esc(f.id)}"></div>
      </div>
    </details>
  </section>

  <section class="card section stack">
    <h2>Perguntas <span class="muted" style="font-weight:400">(${f.fields.length})</span></h2>
    <div id="cards" class="stack">${f.fields.map(fieldCard).join('') || '<p class="muted">Nenhuma pergunta. Adicione abaixo.</p>'}</div>
    <div>
      <div class="muted" style="font-size:13px;margin-bottom:6px">Adicionar campo de contato (já mapeado no contrato):</div>
      <div class="add-bar">${QUICK.map((q, i) => `<button class="btn small" data-quick="${i}">+ ${q.label}</button>`).join('')}</div>
    </div>
    <div>
      <div class="muted" style="font-size:13px;margin-bottom:6px">Adicionar pergunta livre:</div>
      <div class="add-bar">${Object.entries(TYPE_LABELS).map(([t, l]) => `<button class="btn small" data-addtype="${t}">+ ${l}</button>`).join('')}</div>
    </div>
  </section>

  <div class="card sticky-save">
    <button class="btn primary" data-act="save">Salvar</button>
    <span id="dirty" class="chip ${dirty() ? 'warn' : 'ok'}">${dirty() ? 'alterações não salvas' : 'salvo'}</span>
    <span class="spacer" style="flex:1"></span>
    ${S.isNew ? '' : '<button class="btn" data-act="duplicate">Duplicar</button><button class="btn danger" data-act="delete">Excluir</button>'}
  </div>`;
}

function renderTest() {
  const el = $('#test-panel');
  const f = S.form;
  if (!f) {
    el.innerHTML = '<h2>Testar</h2><p class="muted">Selecione ou crie um formulário.</p>';
    return;
  }
  const p = S.test.params;
  const url = buildTestUrl(location.origin, f.id, p, { mode: S.test.mode, fresh: S.test.fresh });
  const real = S.test.mode === 'real';
  el.innerHTML = `
    <h2>Abrir para testar</h2>
    <div class="presets">${Object.entries(PRESETS).map(([k, v]) => `<button class="btn small" data-preset="${k}">${v.label}</button>`).join('')}<button class="btn small ghost" data-preset="_clear">limpar</button></div>
    <div class="utm-grid">${UTM_FIELDS.map((k) => `<div class="${k === 'ref' || k === 'lid' ? 'full' : ''}"><label>${LABELS_UTM[k]}</label><input class="field-input mono" data-utm="${k}" value="${esc(p[k] || '')}"></div>`).join('')}</div>
    <label class="row"><input type="checkbox" data-test="fresh" ${S.test.fresh ? 'checked' : ''}> Visitante novo (limpar cookies de atribuição)</label>
    <div class="radio-row stack" style="gap:6px">
      <label class="${real ? '' : 'sel'}"><input type="radio" name="mode" value="dry" ${real ? '' : 'checked'}><span><strong>Simular</strong><br><span class="muted" style="font-size:13px">Roda tudo e desfaz. Nada é gravado.</span></span></label>
      <label class="${real ? 'sel real' : ''}"><input type="radio" name="mode" value="real" ${real ? 'checked' : ''}><span><strong>Gravar em modo sombra</strong><br><span class="muted" style="font-size:13px">Grava lead, touchpoint e evento no banco. <strong>Irreversível</strong>: eventos são imutáveis.</span></span></label>
    </div>
    <div class="url-box" id="url-box">${esc(url)}</div>
    <div class="row">
      <button class="btn primary" data-act="open" style="flex:1">Abrir em nova aba ↗</button>
      <button class="btn" data-act="copy">Copiar link</button>
    </div>
    <p class="muted" style="font-size:12px;margin:0">${dirty() ? 'Há alterações não salvas: elas serão salvas antes de abrir.' : 'Cada nova aba reaproveita os cookies, como um visitante que volta.'}</p>`;
}

/* ---------- ações ---------- */
async function save() {
  S.errors = [];
  try {
    const saved = await api(`/api/forms/${encodeURIComponent(S.form.id)}`, { method: 'PUT', body: S.form });
    S.form = saved;
    S.original = snap(saved);
    S.isNew = false;
    await refreshList();
    render();
    toast('Formulário salvo');
    return true;
  } catch (e) {
    S.errors = e.data?.issues?.length ? e.data.issues : [e.message];
    renderEditor();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return false;
  }
}

async function openForm(id) {
  if (dirty() && !confirm('Há alterações não salvas. Descartar e abrir outro formulário?')) return;
  setForm(await api(`/api/forms/${encodeURIComponent(id)}`), false);
}

function moveField(i, d) {
  const a = S.form.fields;
  const j = i + d;
  if (j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]];
  renderEditor();
}

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button, .q-head');
  if (!t) return;
  const card = t.closest('[data-fid]');
  const act = t.dataset.act;

  if (t.id === 'btn-new' || act === 'new') {
    if (dirty() && !confirm('Há alterações não salvas. Descartar?')) return;
    return setForm(blankForm(), true);
  }
  if (t.dataset.open) return openForm(t.dataset.open);
  if (t.dataset.quick != null && S.form) {
    const q = QUICK[Number(t.dataset.quick)];
    if (q.map !== 'answer' && S.form.fields.some((x) => x.map === q.map)) return toast(`Já existe um campo de ${q.label}`);
    const f = makeField(S.form, q);
    S.form.fields.push(f);
    S.open = f.id;
    return renderEditor();
  }
  if (t.dataset.addtype && S.form) {
    const f = makeField(S.form, { type: t.dataset.addtype, text: 'Nova pergunta' });
    S.form.fields.push(f);
    S.open = f.id;
    return renderEditor();
  }
  if (card && S.form) {
    const i = S.form.fields.findIndex((x) => x.id === card.dataset.fid);
    if (act === 'up') return moveField(i, -1);
    if (act === 'down') return moveField(i, 1);
    if (act === 'del') {
      S.form.fields.splice(i, 1);
      return renderEditor();
    }
    if (act === 'dup') {
      const src = S.form.fields[i];
      const copy = { ...src, id: newId(), key: uniqueKey(src.key, S.form.fields.map((x) => x.key)), map: 'answer', options: [...src.options] };
      S.form.fields.splice(i + 1, 0, copy);
      S.open = copy.id;
      return renderEditor();
    }
    if (act === 'toggle') {
      S.open = S.open === card.dataset.fid ? null : card.dataset.fid;
      return renderEditor();
    }
  }
  if (act === 'save') return save();
  if (act === 'duplicate' && S.form) {
    const copy = JSON.parse(JSON.stringify(S.form));
    copy.id = uniqueKey(`${S.form.id}-copia`, S.list.map((x) => x.id));
    copy.title = `${S.form.title} (cópia)`;
    return setForm(copy, true);
  }
  if (act === 'delete' && S.form && confirm(`Excluir "${S.form.title}"? Isto não pode ser desfeito.`)) {
    await api(`/api/forms/${encodeURIComponent(S.form.id)}`, { method: 'DELETE' });
    S.form = null;
    await refreshList();
    render();
    return toast('Formulário excluído');
  }
  if (t.dataset.preset) {
    const key = t.dataset.preset;
    let p = {};
    if (key !== '_clear') {
      const { label, fresh: pf, ...rest } = PRESETS[key];
      p = rest;
      if (pf !== undefined) S.test.fresh = pf;
    }
    S.test.params = p;
    saveTest();
    return renderTest();
  }
  if (act === 'copy' || act === 'open') {
    const url = buildTestUrl(location.origin, S.form.id, S.test.params, { mode: S.test.mode, fresh: S.test.fresh });
    if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copiado');
      } catch {
        toast('Não consegui copiar; selecione o link e copie');
      }
      return;
    }
    if (S.test.mode === 'real' && !confirm('Você vai GRAVAR dados de teste no banco, de forma irreversível (eventos são imutáveis). Continuar?')) return;
    const w = window.open('', '_blank'); // abre já, dentro do clique, para o navegador não bloquear
    if (dirty() && !(await save())) {
      w?.close();
      return;
    }
    if (w) w.location.href = url;
    else toast('O navegador bloqueou a nova aba. Libere pop-ups ou use "Copiar link".');
  }
});

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (!S.form) return;
  if (t.dataset.form) {
    const k = t.dataset.form;
    S.form[k] = t.type === 'checkbox' ? t.checked : t.value;
    if (k === 'title' && S.isNew) {
      S.form.id = uniqueKey(slugify(t.value).replace(/_/g, '-').slice(0, 60) || 'formulario', S.list.map((x) => x.id));
      const idInput = $('[data-form="id"]');
      if (idInput) idInput.value = S.form.id;
    }
    if (k === 'show_consent' || k === 'source_slug') renderEditor();
    return markDirty();
  }
  const card = t.closest('[data-fid]');
  if (card && t.dataset.f) {
    const f = S.form.fields.find((x) => x.id === card.dataset.fid);
    const k = t.dataset.f;
    if (k === 'required') f.required = t.checked;
    else if (k === 'options') f.options = t.value.split('\n').map((s) => s.trim()).filter(Boolean);
    else f[k] = t.value;
    if (k === 'label') {
      card.querySelector('[data-title]').textContent = t.value;
      const auto = f._new && f._autoKey !== false; // só renomeia a chave de campos ainda não salvos
      if (auto) f.key = uniqueKey(slugify(t.value), S.form.fields.filter((x) => x !== f).map((x) => x.key));
      const keyInput = card.querySelector('[data-f="key"]');
      if (keyInput && auto) keyInput.value = f.key;
    }
    if (k === 'key') f._autoKey = false;
    if (k === 'type') {
      if (CHOICE.has(f.type) && f.options.length === 0) f.options = ['Opção 1', 'Opção 2'];
      renderEditor();
    }
    if (k === 'map' || k === 'required') renderEditor();
    return markDirty();
  }
  if (t.dataset.utm) {
    S.test.params[t.dataset.utm] = t.value;
    saveTest();
    $('#url-box').textContent = buildTestUrl(location.origin, S.form.id, S.test.params, { mode: S.test.mode, fresh: S.test.fresh });
    return;
  }
  if (t.dataset.test === 'fresh') {
    S.test.fresh = t.checked;
    saveTest();
    return renderTest();
  }
  if (t.name === 'mode') {
    S.test.mode = t.value;
    saveTest();
    return renderTest();
  }
});

function markDirty() {
  const chip = $('#dirty');
  if (chip) {
    chip.className = `chip ${dirty() ? 'warn' : 'ok'}`;
    chip.textContent = dirty() ? 'alterações não salvas' : 'salvo';
  }
  renderList();
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (S.form) save();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (dirty()) e.preventDefault();
});

/* ---------- início ---------- */
(async function init() {
  try {
    S.meta = await api('/api/meta');
    const chip = $('#db-chip');
    chip.className = `chip ${S.meta.db.connected ? 'ok' : 'danger'}`;
    chip.textContent = S.meta.db.connected ? 'banco conectado' : 'banco indisponível';
    if (S.meta.db.note) chip.title = S.meta.db.note;
    await refreshList();
    if (S.list.length) await openForm(S.list[0].id);
    else render();
  } catch (e) {
    $('#editor').innerHTML = `<div class="banner danger">Falha ao iniciar: ${esc(e.message)}</div>`;
  }
})();
