import { AdapterError, isPlainObject, type AdapterResult } from './errors.js';

/**
 * Elementor Pro (ação "Webhook"): traduz o formato do Elementor para o contrato (seção 7).
 * Aceita três formas do mesmo corpo:
 *   1. plano:      { email: "...", utm_source: "..." }
 *   2. colchetes:  { "fields[email][value]": "..." }  (urlencoded)
 *   3. avançado:   { fields: { email: { value: "..." } }, form: { id, name } }
 * O Elementor não envia cabeçalhos customizados: a fonte vem de ?source= e o token de ?token=.
 */

const CONTACT: Record<'name' | 'email' | 'phone' | 'company' | 'company_size' | 'role', string[]> = {
  name: ['name', 'nome', 'your-name'],
  email: ['email', 'e-mail'],
  phone: ['phone', 'telefone', 'whatsapp'],
  company: ['company', 'empresa'],
  company_size: ['company_size', 'porte'],
  role: ['role', 'cargo'],
};

const ATTRIBUTION = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'fbp', 'fbc', 'ga_client_id', 'ad_id',
  'landing_url', 'referrer', 'user_agent',
];

/** Chaves que não são resposta do formulário. */
const RESERVED = new Set([
  'form_id', 'form_name', 'qk_form_id', 'qk_lp_id', 'event_id', 'lead_id', 'event_type', 'occurred_at',
  'first_touch', 'website_hp', 'consent_marketing', 'consent_analytics',
  ...Object.values(CONTACT).flat(),
  ...ATTRIBUTION,
]);

const prim = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;

function flatten(body: Record<string, unknown>): Record<string, string> {
  const flat: Record<string, string> = {};
  const rawValues: Record<string, string> = {};

  for (const [key, value] of Object.entries(body)) {
    if (key === 'fields' && isPlainObject(value)) {
      for (const [id, f] of Object.entries(value)) {
        const v = isPlainObject(f) ? prim(f.value) ?? prim(f.raw_value) : prim(f);
        if (v !== undefined) flat[id] = v;
      }
    } else if (key === 'form' && isPlainObject(value)) {
      const id = prim(value.id);
      const name = prim(value.name);
      if (id && flat.form_id === undefined) flat.form_id = id;
      if (name && flat.form_name === undefined) flat.form_name = name;
    } else if (key === 'meta') {
      continue;
    } else {
      const m = /^fields\[([^\]]+)\](?:\[([a-z_]+)\])?$/.exec(key);
      if (m) {
        const v = prim(value);
        if (v === undefined) continue;
        if (!m[2] || m[2] === 'value') flat[m[1]!] = v;
        else if (m[2] === 'raw_value') rawValues[m[1]!] = v;
      } else {
        const v = prim(value);
        if (v !== undefined) flat[key] = v;
      }
    }
  }
  for (const [k, v] of Object.entries(rawValues)) if (flat[k] === undefined) flat[k] = v;
  return flat;
}

const pick = (flat: Record<string, string>, keys: string[]): string => {
  for (const k of keys) if (flat[k]?.trim()) return flat[k]!.trim();
  return '';
};

const asBool = (v: string | undefined) => v === 'true' || v === '1';

function parseJsonObject(v: string | undefined): Record<string, unknown> | null {
  if (!v) return null;
  try {
    const o = JSON.parse(v);
    return isPlainObject(o) ? o : null;
  } catch {
    return null;
  }
}

export function parseElementor(body: unknown, query: Record<string, string | undefined>): AdapterResult {
  if (!isPlainObject(body)) throw new AdapterError('corpo deve ser um objeto');
  const flat = flatten(body);
  const slug = query.source ?? '';

  const contact: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(CONTACT)) contact[field] = pick(flat, aliases);

  const attribution: Record<string, string> = {};
  for (const k of ATTRIBUTION) attribution[k] = flat[k]?.trim() ?? '';

  const answers: Record<string, string> = {};
  for (const [k, v] of Object.entries(flat)) if (!RESERVED.has(k) && v !== '') answers[k] = v;

  return {
    candidate: {
      source_slug: slug,
      form_id: pick(flat, ['qk_form_id', 'form_name', 'form_id']),
      lp_id: pick(flat, ['qk_lp_id']) || slug,
      event_id: pick(flat, ['event_id']),
      lead_id: pick(flat, ['lead_id']) || null,
      event_type: pick(flat, ['event_type']) || 'form_submit',
      occurred_at: pick(flat, ['occurred_at']) || undefined,
      contact,
      answers,
      attribution,
      consent: { marketing: asBool(flat.consent_marketing), analytics: asBool(flat.consent_analytics) },
      first_touch: parseJsonObject(flat.first_touch),
    },
    honeypot: flat.website_hp?.trim() ?? '',
  };
}
