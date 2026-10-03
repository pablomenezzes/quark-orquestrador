import { z } from 'zod';

/** Tipos de evento da seção 7. Novos tipos entram primeiro no MD. */
export const EVENT_TYPES = [
  'form_submit',
  'diagnostico_iniciado',
  'diagnostico_concluido',
  'lead_validado',
  'deal_criado',
  'deal_estagio_alterado',
  'deal_ganho',
  'deal_perdido',
] as const;

const text = (max = 2000) =>
  z.preprocess(
    (v) => (v == null ? '' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : typeof v === 'string' ? v.trim() : v),
    z.string().max(max),
  );

const bool = z.preprocess((v) => v === true || v === 'true' || v === 1 || v === '1', z.boolean());

const size = z.preprocess((v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  return /^\d+$/.test(String(v).trim()) ? Number(String(v).trim()) : null;
}, z.number().int().min(0).max(1_000_000).nullable());

const obj = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v == null ? {} : v), schema);

const looseRecord = z.preprocess((v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}), z.record(z.unknown()));

export const contractSchema = z.object({
  source_slug: text(100),
  form_id: text(200),
  lp_id: text(200),
  event_id: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().min(8, 'event_id obrigatório (mín. 8 caracteres)').max(100)),
  lead_id: z.preprocess((v) => (v == null || v === '' ? null : v), z.string().max(100).nullable()),
  event_type: z.preprocess((v) => (v == null || v === '' ? 'form_submit' : v), z.enum(EVENT_TYPES)),
  occurred_at: z.preprocess((v) => (v == null || v === '' ? undefined : v), z.string().max(40).optional()),
  contact: obj(
    z.object({
      name: text(300),
      email: text(320),
      phone: text(40),
      company: text(300),
      company_size: size,
      role: text(200),
    }),
  ),
  answers: looseRecord,
  attribution: obj(
    z.object({
      utm_source: text(200),
      utm_medium: text(200),
      utm_campaign: text(200),
      utm_term: text(200),
      utm_content: text(200),
      gclid: text(500),
      gbraid: text(500),
      wbraid: text(500),
      fbclid: text(500),
      fbp: text(200),
      fbc: text(500),
      ga_client_id: text(100),
      ad_id: text(100),
      landing_url: text(2000),
      referrer: text(2000),
      user_agent: text(1000),
    }),
  ),
  consent: obj(z.object({ marketing: bool, analytics: bool })),
  first_touch: z.preprocess(
    (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null),
    z.record(z.unknown()).nullable(),
  ),
  website_hp: text(2000),
});

export type ContractEvent = z.infer<typeof contractSchema>;
