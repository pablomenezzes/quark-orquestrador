import { z } from 'zod';

export const FIELD_TYPES = ['text', 'textarea', 'email', 'phone', 'number', 'select', 'radio', 'checkbox', 'date', 'url'] as const;
export const CHOICE_TYPES = new Set(['select', 'radio', 'checkbox']);
/** Destinos no contrato (seção 7): campos de contato ou "answer" (vai para answers[key]). */
export const FIELD_MAPS = ['answer', 'name', 'email', 'phone', 'company', 'company_size', 'role'] as const;
export const EVENT_TYPES_PUBLIC = ['form_submit', 'diagnostico_iniciado', 'diagnostico_concluido'] as const;

export const FORM_ID_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

const fieldSchema = z.object({
  id: z.string().min(1).max(40),
  key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, 'chave: minúsculas, números e _ (começa com letra)'),
  type: z.enum(FIELD_TYPES),
  label: z.string().trim().min(1, 'a pergunta não pode ficar vazia').max(300),
  help: z.string().max(500).default(''),
  placeholder: z.string().max(200).default(''),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  map: z.enum(FIELD_MAPS).default('answer'),
});

export const formSchema = z
  .object({
    id: z.string().regex(FORM_ID_RE, 'id: minúsculas, números e hífen'),
    title: z.string().trim().min(1, 'dê um título ao formulário').max(200),
    description: z.string().max(1000).default(''),
    submit_label: z.string().trim().min(1).max(60).default('Enviar'),
    thank_you_title: z.string().max(200).default('Obrigado!'),
    thank_you_message: z.string().max(1000).default('Recebemos suas respostas.'),
    source_slug: z.string().min(1).max(100),
    form_id: z.string().max(200).default(''),
    lp_id: z.string().max(200).default(''),
    event_type: z.enum(EVENT_TYPES_PUBLIC).default('form_submit'),
    show_consent: z.boolean().default(true),
    consent_text: z.string().max(500).default('Concordo com o tratamento dos meus dados para contato.'),
    fields: z.array(fieldSchema).max(50),
    updated_at: z.string().optional(),
  })
  .superRefine((f, ctx) => {
    const keys = new Set<string>();
    const maps = new Set<string>();
    f.fields.forEach((fld, i) => {
      if (keys.has(fld.key)) ctx.addIssue({ code: 'custom', path: ['fields', i, 'key'], message: `chave repetida: ${fld.key}` });
      keys.add(fld.key);
      if (fld.map !== 'answer') {
        if (maps.has(fld.map)) ctx.addIssue({ code: 'custom', path: ['fields', i, 'map'], message: `dois campos mapeados para "${fld.map}"` });
        maps.add(fld.map);
      }
      if (CHOICE_TYPES.has(fld.type) && fld.options.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['fields', i, 'options'], message: `"${fld.label}": informe ao menos uma opção` });
      }
    });
  });

export type FormDef = z.infer<typeof formSchema>;
export type FieldDef = FormDef['fields'][number];
