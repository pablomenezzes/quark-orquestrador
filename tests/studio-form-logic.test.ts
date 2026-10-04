import { describe, it, expect } from 'vitest';
import { validateValues, buildContract, slugify, uniqueKey, buildTestUrl, PRESETS } from '../studio/public/form-logic.js';

const form = {
  id: 'demo',
  title: 'Demo',
  source_slug: 'lp-vercel-rh-teste',
  form_id: 'form-demo',
  lp_id: 'studio-demo',
  event_type: 'form_submit',
  show_consent: true,
  fields: [
    { id: 'f1', key: 'nome', type: 'text', label: 'Nome', required: true, map: 'name', options: [] },
    { id: 'f2', key: 'email', type: 'email', label: 'E-mail', required: true, map: 'email', options: [] },
    { id: 'f3', key: 'fone', type: 'phone', label: 'WhatsApp', required: false, map: 'phone', options: [] },
    { id: 'f4', key: 'empresa', type: 'text', label: 'Empresa', required: false, map: 'company', options: [] },
    { id: 'f5', key: 'func', type: 'number', label: 'Funcionários', required: false, map: 'company_size', options: [] },
    { id: 'f6', key: 'cargo', type: 'text', label: 'Cargo', required: false, map: 'role', options: [] },
    { id: 'f7', key: 'interesse', type: 'select', label: 'Interesse', required: false, map: 'answer', options: ['Demo', 'Preço'] },
    { id: 'f8', key: 'canais', type: 'checkbox', label: 'Canais', required: false, map: 'answer', options: ['A', 'B', 'C'] },
    { id: 'f9', key: 'obs', type: 'textarea', label: 'Obs', required: false, map: 'answer', options: [] },
  ],
};

describe('validateValues', () => {
  it('exige os campos obrigatórios', () => {
    const e = validateValues(form, {});
    expect(Object.keys(e).sort()).toEqual(['f1', 'f2']);
  });

  it('valida formato de e-mail, telefone, número, url e opção', () => {
    const f = {
      ...form,
      fields: [
        ...form.fields,
        { id: 'u', key: 'site', type: 'url', label: 'Site', required: false, map: 'answer', options: [] },
        { id: 'r', key: 'r', type: 'radio', label: 'R', required: false, map: 'answer', options: ['x', 'y'] },
      ],
    };
    const e = validateValues(f, { f1: 'A', f2: 'sem-arroba', f3: '123', f5: 'abc', u: 'não é url', r: 'z' });
    expect(Object.keys(e).sort()).toEqual(['f2', 'f3', 'f5', 'r', 'u']);
  });

  it('aceita valores corretos', () => {
    const e = validateValues(form, { f1: 'Maria', f2: 'm@x.com', f3: '(84) 99999-9999', f5: '15', f7: 'Demo', f8: ['A', 'B'] });
    expect(e).toEqual({});
  });

  it('checkbox obrigatório exige ao menos uma opção', () => {
    const f = { ...form, fields: [{ id: 'c', key: 'c', type: 'checkbox', label: 'C', required: true, map: 'answer', options: ['a', 'b'] }] };
    expect(Object.keys(validateValues(f, { c: [] }))).toEqual(['c']);
    expect(validateValues(f, { c: ['a'] })).toEqual({});
  });
});

describe('buildContract (seção 7)', () => {
  const ctx = {
    lead_id: '11111111-1111-4111-8111-111111111111',
    event_id: 'evt-uuid-0001',
    attribution: { utm_source: 'meta', utm_medium: 'paid_social', referrer: '' },
    first_touch: { utm_source: 'google' },
    consent: { marketing: false, analytics: false },
    consentChecked: true,
    honeypot: '',
    referrerOverride: '',
    now: '2026-10-04T10:00:00.000Z',
  };
  const values = { f1: ' Maria ', f2: 'M@X.com', f3: '(84) 99999-9999', f4: 'Acme', f5: '15', f6: 'RH', f7: 'Demo', f8: ['A', 'C'], f9: 'olá' };

  it('mapeia contato e respostas para o formato do contrato', () => {
    const p = buildContract(form, values, ctx);
    expect(p).toMatchObject({
      source_slug: 'lp-vercel-rh-teste',
      form_id: 'form-demo',
      lp_id: 'studio-demo',
      event_id: 'evt-uuid-0001',
      lead_id: ctx.lead_id,
      event_type: 'form_submit',
      occurred_at: ctx.now,
      contact: { name: 'Maria', email: 'M@X.com', phone: '(84) 99999-9999', company: 'Acme', company_size: 15, role: 'RH' },
      answers: { interesse: 'Demo', canais: ['A', 'C'], obs: 'olá' },
      attribution: { utm_source: 'meta', utm_medium: 'paid_social' },
      first_touch: { utm_source: 'google' },
      website_hp: '',
    });
  });

  it('consentimento marcado vale para marketing e analytics; desmarcado fica falso', () => {
    expect(buildContract(form, values, ctx).consent).toEqual({ marketing: true, analytics: true });
    expect(buildContract(form, values, { ...ctx, consentChecked: false }).consent).toEqual({ marketing: false, analytics: false });
  });

  it('sem checkbox de consentimento no formulário, usa o que o script detectou', () => {
    const f = { ...form, show_consent: false };
    expect(buildContract(f, values, { ...ctx, consent: { marketing: true, analytics: false } }).consent).toEqual({ marketing: true, analytics: false });
  });

  it('referrer simulado sobrescreve o capturado (só para testes de canal)', () => {
    const p = buildContract(form, values, { ...ctx, referrerOverride: 'https://www.google.com/' });
    expect(p.attribution.referrer).toBe('https://www.google.com/');
  });

  it('company_size inválido ou vazio vira null; campos vazios não entram em answers', () => {
    const p = buildContract(form, { f1: 'A', f2: 'a@x.com', f5: 'muitos', f7: '' }, ctx);
    expect(p.contact.company_size).toBeNull();
    expect(p.answers).toEqual({});
  });

  it('honeypot é repassado', () => {
    expect(buildContract(form, values, { ...ctx, honeypot: 'bot' }).website_hp).toBe('bot');
  });
});

describe('slugify / uniqueKey', () => {
  it('gera chaves snake_case sem acento', () => {
    expect(slugify('Qual o tamanho da sua empresa?')).toBe('qual_o_tamanho_da_sua_empresa');
    expect(slugify('Nº de funcionários')).toBe('n_de_funcionarios');
    expect(slugify('123 abc')).toBe('q_123_abc');
    expect(slugify('???')).toBe('campo');
  });
  it('uniqueKey evita repetição', () => {
    expect(uniqueKey('nome', ['nome', 'nome_2'])).toBe('nome_3');
    expect(uniqueKey('email', [])).toBe('email');
  });
});

describe('buildTestUrl', () => {
  it('monta a URL só com os parâmetros preenchidos e o modo', () => {
    const u = new URL(buildTestUrl('http://127.0.0.1:4310', 'demo', { utm_source: 'meta', utm_medium: 'paid_social', utm_term: '', ref: 'https://www.google.com/' }, { mode: 'dry', fresh: true }));
    expect(u.pathname).toBe('/f/demo');
    expect(Object.fromEntries(u.searchParams)).toEqual({ utm_source: 'meta', utm_medium: 'paid_social', ref: 'https://www.google.com/', mode: 'dry', fresh: '1' });
  });
  it('presets cobrem os canais principais', () => {
    expect(Object.keys(PRESETS)).toEqual(expect.arrayContaining(['meta', 'google', 'email', 'organico', 'direto']));
    expect(PRESETS.meta).toMatchObject({ utm_source: 'meta', utm_medium: 'paid_social' });
    expect(PRESETS.google).toMatchObject({ utm_medium: 'cpc' });
    expect(PRESETS.google.gclid).toBeTruthy();
  });
});
