// Lógica pura do Studio (sem DOM), usada no navegador e nos testes.

export const PRESETS = {
  meta: {
    label: 'Meta Ads',
    utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: '120210000000001', utm_term: '120210000000002', utm_content: '120210000000003',
    fbclid: 'IwAR-teste-studio',
  },
  google: {
    label: 'Google Ads',
    utm_source: 'google', utm_medium: 'cpc', utm_campaign: '20000000001', utm_term: 'software rh', utm_content: 'cri-77',
    gclid: 'Cj0KCQ-teste-studio',
  },
  email: { label: 'E-mail', utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'nutricao-outubro' },
  organico: { label: 'Orgânico (Google)', ref: 'https://www.google.com/' },
  social: { label: 'Orgânico (LinkedIn)', ref: 'https://www.linkedin.com/feed/' },
  direto: { label: 'Direto', fresh: true },
};

export const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'lid', 'ref'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function slugify(text) {
  const base = String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!base) return 'campo';
  return /^[a-z]/.test(base) ? base : `q_${base}`.slice(0, 41);
}

export function uniqueKey(base, taken) {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

const isEmpty = (v) => v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');

/** Devolve { [fieldId]: mensagem } para os campos com problema. */
export function validateValues(form, values) {
  const errors = {};
  for (const f of form.fields) {
    const v = values[f.id];
    if (isEmpty(v)) {
      if (f.required) errors[f.id] = 'Resposta obrigatória';
      continue;
    }
    const s = Array.isArray(v) ? '' : String(v).trim();
    if (f.type === 'email' && !EMAIL_RE.test(s)) errors[f.id] = 'E-mail inválido';
    else if (f.type === 'phone' && s.replace(/\D/g, '').length < 10) errors[f.id] = 'Telefone inválido (com DDD)';
    else if (f.type === 'number' && !(s !== '' && Number.isFinite(Number(s)))) errors[f.id] = 'Informe um número';
    else if (f.type === 'url') {
      try {
        new URL(s);
      } catch {
        errors[f.id] = 'URL inválida (https://...)';
      }
    } else if ((f.type === 'select' || f.type === 'radio') && !f.options.includes(s)) errors[f.id] = 'Escolha uma das opções';
    else if (f.type === 'checkbox' && Array.isArray(v) && v.some((x) => !f.options.includes(x))) errors[f.id] = 'Opção inválida';
  }
  return errors;
}

function sizeOf(v) {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

/**
 * Monta o objeto do contrato de dados (seção 7) a partir das respostas.
 * ctx: { lead_id, event_id, attribution, first_touch, consent, consentChecked, honeypot, referrerOverride, now }
 */
export function buildContract(form, values, ctx) {
  const contact = { name: '', email: '', phone: '', company: '', company_size: null, role: '' };
  const answers = {};
  for (const f of form.fields) {
    const v = values[f.id];
    if (isEmpty(v)) continue;
    if (f.map === 'answer') answers[f.key] = Array.isArray(v) ? v : String(v).trim();
    else if (f.map === 'company_size') contact.company_size = sizeOf(v);
    else contact[f.map] = String(v).trim();
  }
  const attribution = { ...(ctx.attribution || {}) };
  if (ctx.referrerOverride) attribution.referrer = ctx.referrerOverride;
  const consent = form.show_consent
    ? { marketing: !!ctx.consentChecked, analytics: !!ctx.consentChecked }
    : { marketing: !!ctx.consent?.marketing, analytics: !!ctx.consent?.analytics };
  return {
    source_slug: form.source_slug,
    form_id: form.form_id || form.id,
    lp_id: form.lp_id || `studio-${form.id}`,
    event_id: ctx.event_id,
    lead_id: ctx.lead_id || null,
    event_type: form.event_type,
    occurred_at: ctx.now,
    contact,
    answers,
    attribution,
    consent,
    first_touch: ctx.first_touch || null,
    website_hp: ctx.honeypot || '',
  };
}

/** URL para abrir o formulário em outra aba, só com os parâmetros preenchidos. */
export function buildTestUrl(origin, formId, params, opts = {}) {
  const u = new URL(`/f/${encodeURIComponent(formId)}`, origin);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && String(v).trim() !== '') u.searchParams.set(k, String(v).trim());
  }
  u.searchParams.set('mode', opts.mode === 'real' ? 'real' : 'dry');
  if (opts.fresh) u.searchParams.set('fresh', '1');
  return u.toString();
}
