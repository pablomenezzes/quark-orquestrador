import { describe, it, expect } from 'vitest';
import { parseVercel } from '../src/adapters/in/vercel';
import { parseElementor } from '../src/adapters/in/elementor';
import { AdapterError } from '../src/adapters/in/errors';

describe('adaptador Vercel', () => {
  const body = {
    source_slug: 'lp-vercel',
    form_id: 'form-demo',
    event_id: 'e-1',
    contact: { email: 'a@x.com' },
    attribution: { utm_source: 'meta' },
    website_hp: '',
  };

  it('entrega o corpo como candidato ao contrato e extrai o honeypot', () => {
    const r = parseVercel(body);
    expect((r.candidate as any).form_id).toBe('form-demo');
    expect((r.candidate as any).contact.email).toBe('a@x.com');
    expect(r.honeypot).toBe('');
  });

  it('honeypot preenchido é devolvido', () => {
    expect(parseVercel({ ...body, website_hp: 'http://spam' }).honeypot).toBe('http://spam');
  });

  it('descarta ip e user_agent enviados pelo navegador (vêm do servidor)', () => {
    const r = parseVercel({ ...body, attribution: { utm_source: 'meta', ip: '1.2.3.4' } });
    expect((r.candidate as any).attribution.ip).toBeUndefined();
  });

  it('rejeita corpo que não é objeto', () => {
    expect(() => parseVercel('texto')).toThrow(AdapterError);
    expect(() => parseVercel(null)).toThrow(AdapterError);
    expect(() => parseVercel([1])).toThrow(AdapterError);
  });
});

describe('adaptador Elementor', () => {
  const flat = {
    form_id: 'a1b2c3d', // id interno do Elementor
    form_name: 'Demo RH',
    name: 'Maria Silva',
    email: 'Maria@Empresa.com',
    phone: '(84) 99999-9999',
    company: 'Acme',
    company_size: '15',
    role: 'Gestora de RH',
    mensagem: 'Quero uma demonstração',
    qk_form_id: 'form-demo',
    qk_lp_id: 'lp-elementor-rh',
    event_id: 'e-100',
    lead_id: '11111111-1111-4111-8111-111111111111',
    utm_source: 'google',
    utm_medium: 'cpc',
    gclid: 'G1',
    landing_url: 'https://quark.com.br/rh/?utm_source=google',
    consent_marketing: 'true',
    consent_analytics: 'false',
    first_touch: '{"utm_source":"meta","ts":1700000000000}',
    website_hp: '',
  };
  const query = { source: 'elementor-site-rh', token: 'abc' };

  it('mapeia campos planos para o contrato', () => {
    const { candidate: c, honeypot } = parseElementor(flat, query) as any;
    expect(honeypot).toBe('');
    expect(c).toMatchObject({
      source_slug: 'elementor-site-rh',
      form_id: 'form-demo',
      lp_id: 'lp-elementor-rh',
      event_id: 'e-100',
      lead_id: '11111111-1111-4111-8111-111111111111',
      event_type: 'form_submit',
      contact: { name: 'Maria Silva', email: 'Maria@Empresa.com', phone: '(84) 99999-9999', company: 'Acme', company_size: '15', role: 'Gestora de RH' },
      attribution: { utm_source: 'google', utm_medium: 'cpc', gclid: 'G1', landing_url: 'https://quark.com.br/rh/?utm_source=google' },
      consent: { marketing: true, analytics: false },
      first_touch: { utm_source: 'meta', ts: 1700000000000 },
    });
  });

  it('campos desconhecidos vão para answers; metadados do Elementor e do orquestrador não', () => {
    const { candidate: c } = parseElementor(flat, query) as any;
    expect(c.answers).toEqual({ mensagem: 'Quero uma demonstração' });
  });

  it('aceita chaves com colchetes (urlencoded do Elementor: fields[email][value])', () => {
    const bracket = {
      form_id: 'x',
      'fields[email][value]': 'a@x.com',
      'fields[name][value]': 'Ana',
      'fields[event_id][value]': 'e-1',
      'fields[utm_source][value]': 'meta',
    };
    const { candidate: c } = parseElementor(bracket, query) as any;
    expect(c.contact).toMatchObject({ email: 'a@x.com', name: 'Ana' });
    expect(c.event_id).toBe('e-1');
    expect(c.attribution.utm_source).toBe('meta');
  });

  it('aceita o formato avançado (fields.<id>.value)', () => {
    const adv = {
      form: { id: 'x', name: 'Demo' },
      fields: {
        email: { id: 'email', type: 'email', title: 'E-mail', value: 'a@x.com', raw_value: 'a@x.com' },
        event_id: { id: 'event_id', value: 'e-2' },
        utm_source: { id: 'utm_source', value: 'meta' },
      },
    };
    const { candidate: c } = parseElementor(adv, query) as any;
    expect(c.contact.email).toBe('a@x.com');
    expect(c.event_id).toBe('e-2');
    expect(c.attribution.utm_source).toBe('meta');
  });

  it('form_id cai para form_name e depois para o id do Elementor; lp_id cai para o slug', () => {
    const { candidate: c } = parseElementor({ form_id: 'a1', form_name: 'Demo RH', email: 'a@x.com' }, query) as any;
    expect(c.form_id).toBe('Demo RH');
    expect(c.lp_id).toBe('elementor-site-rh');
    const { candidate: d } = parseElementor({ form_id: 'a1', email: 'a@x.com' }, query) as any;
    expect(d.form_id).toBe('a1');
  });

  it('honeypot preenchido é devolvido; consentimento ausente vira false; first_touch inválido é ignorado', () => {
    const r = parseElementor({ ...flat, website_hp: 'spam', consent_marketing: undefined, consent_analytics: undefined, first_touch: '{quebrado' }, query) as any;
    expect(r.honeypot).toBe('spam');
    expect(r.candidate.consent).toEqual({ marketing: false, analytics: false });
    expect(r.candidate.first_touch).toBeNull();
  });

  it('event_type opcional vindo do formulário é respeitado', () => {
    const { candidate: c } = parseElementor({ ...flat, event_type: 'diagnostico_iniciado' }, query) as any;
    expect(c.event_type).toBe('diagnostico_iniciado');
  });

  it('o token da URL nunca entra no candidato', () => {
    const { candidate } = parseElementor(flat, query);
    expect(JSON.stringify(candidate)).not.toContain('abc');
  });

  it('rejeita corpo que não é objeto', () => {
    expect(() => parseElementor('x', query)).toThrow(AdapterError);
  });
});
