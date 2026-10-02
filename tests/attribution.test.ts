import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SCRIPT = readFileSync(new URL('../tracking/attribution.js', import.meta.url), 'utf8');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function load(opts: { url: string; html?: string; referrer?: string; cookies?: string[]; config?: object }) {
  const dom = new JSDOM(opts.html ?? '<!doctype html><body></body>', {
    url: opts.url,
    referrer: opts.referrer,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window as any;
  for (const c of opts.cookies ?? []) w.document.cookie = c;
  if (opts.config) w.QUARK_ATTR_CONFIG = opts.config;
  w.eval(SCRIPT);
  return w;
}

const ready = (w: any) =>
  new Promise<void>((res) =>
    w.document.readyState === 'loading' ? w.document.addEventListener('DOMContentLoaded', () => res()) : res(),
  );

const form = `<form id="f">
  <input type="hidden" name="lead_id"><input type="hidden" name="event_id">
  <input type="hidden" name="utm_source"><input type="hidden" name="utm_content">
  <input type="hidden" name="gclid"><input type="hidden" name="fbc"><input type="hidden" name="ga_client_id">
  <input type="hidden" name="form_fields[utm_campaign]"><input type="text" name="website_hp">
  <input type="email" name="email">
</form>`;

describe('attribution.js', () => {
  it('gera lead_id UUID no primeiro acesso e o grava em cookie próprio', () => {
    const w = load({ url: 'https://lp.quark.com.br/rh/' });
    const id = w.QuarkAttribution.leadId();
    expect(id).toMatch(UUID_RE);
    expect(w.document.cookie).toContain('qk_lid=' + id);
  });

  it('reaproveita o lead_id do cookie', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const w = load({ url: 'https://lp.quark.com.br/', cookies: [`qk_lid=${id}`] });
    expect(w.QuarkAttribution.leadId()).toBe(id);
  });

  it('?lid= válido na URL tem prioridade (ciclo do diagnóstico); inválido é ignorado', () => {
    const lid = '22222222-2222-4222-8222-222222222222';
    const w = load({ url: `https://d.quark.com.br/?lid=${lid}` });
    expect(w.QuarkAttribution.leadId()).toBe(lid);
    const w2 = load({ url: 'https://d.quark.com.br/?lid=hack' });
    expect(w2.QuarkAttribution.leadId()).toMatch(UUID_RE);
    expect(w2.QuarkAttribution.leadId()).not.toBe('hack');
  });

  it('captura UTMs e converte fbclid em _fbc; ad_id vem do utm_content quando é Meta', () => {
    const w = load({
      url: 'https://lp.quark.com.br/rh/?utm_source=meta&utm_medium=paid_social&utm_campaign=111&utm_term=222&utm_content=333&fbclid=ABC',
      cookies: ['_fbp=fb.1.1700000000000.999'],
    });
    const { attribution: a } = w.QuarkAttribution.get();
    expect(a).toMatchObject({
      utm_source: 'meta',
      utm_medium: 'paid_social',
      utm_campaign: '111',
      utm_term: '222',
      utm_content: '333',
      ad_id: '333',
      fbp: 'fb.1.1700000000000.999',
      landing_url: 'https://lp.quark.com.br/rh',
    });
    expect(a.fbc).toMatch(/^fb\.1\.\d{13}\.ABC$/);
  });

  it('ad_id fica vazio quando a fonte não é Meta (utm_content do Google é criativo)', () => {
    const w = load({ url: 'https://lp.quark.com.br/?utm_source=google&utm_medium=cpc&utm_content=cri1&gclid=G1' });
    const { attribution: a } = w.QuarkAttribution.get();
    expect(a.ad_id).toBe('');
    expect(a.gclid).toBe('G1');
  });

  it('extrai o client_id do cookie _ga', () => {
    const w = load({ url: 'https://lp.quark.com.br/', cookies: ['_ga=GA1.1.1234567890.1700000000'] });
    expect(w.QuarkAttribution.get().attribution.ga_client_id).toBe('1234567890.1700000000');
  });

  it('visita direta posterior não apaga o último toque pago', () => {
    const first = load({ url: 'https://lp.quark.com.br/?utm_source=google&utm_medium=cpc&gclid=G1' });
    const cookies = (first.document.cookie as string).split('; ');
    const second = load({ url: 'https://lp.quark.com.br/', cookies });
    expect(second.QuarkAttribution.get().attribution.gclid).toBe('G1');
  });

  it('novo sinal (UTM) substitui o último toque mas preserva o primeiro', () => {
    const first = load({ url: 'https://lp.quark.com.br/?utm_source=google&utm_medium=cpc&gclid=G1' });
    const cookies = (first.document.cookie as string).split('; ');
    const second = load({ url: 'https://lp.quark.com.br/?utm_source=meta&utm_medium=paid_social', cookies });
    const g = second.QuarkAttribution.get();
    expect(g.attribution.utm_source).toBe('meta');
    expect(g.first_touch.gclid).toBe('G1');
  });

  it('referrer externo vira toque; referrer do mesmo host é ignorado', () => {
    const ext = load({ url: 'https://lp.quark.com.br/', referrer: 'https://www.google.com/' });
    expect(ext.QuarkAttribution.get().attribution.referrer).toBe('https://www.google.com/');
    const own = load({ url: 'https://lp.quark.com.br/b', referrer: 'https://lp.quark.com.br/a' });
    expect(own.QuarkAttribution.get().attribution.referrer).toBe('');
  });

  it('preenche campos ocultos (inclusive form_fields[...] do Elementor) e não toca no honeypot', async () => {
    const w = load({
      url: 'https://lp.quark.com.br/?utm_source=meta&utm_campaign=c1&utm_content=a1&gclid=G9',
      html: `<!doctype html><body>${form}</body>`,
    });
    await ready(w);
    const q = (n: string) => (w.document.querySelector(`[name="${n}"]`) as HTMLInputElement).value;
    expect(q('lead_id')).toBe(w.QuarkAttribution.leadId());
    expect(q('event_id')).toBe(w.QuarkAttribution.eventId());
    expect(q('utm_source')).toBe('meta');
    expect(q('form_fields[utm_campaign]')).toBe('c1');
    expect(q('gclid')).toBe('G9');
    expect(q('website_hp')).toBe('');
    expect(q('email')).toBe('');
  });

  it('pushLead dispara generate_lead no dataLayer e rotaciona o event_id', () => {
    const w = load({ url: 'https://lp.quark.com.br/' });
    const before = w.QuarkAttribution.eventId();
    const p = w.QuarkAttribution.pushLead({ form_id: 'form-demo', lp_id: 'lp-meta-rh-dp' });
    expect(p).toEqual({
      event: 'generate_lead',
      form_id: 'form-demo',
      lp_id: 'lp-meta-rh-dp',
      lead_id: w.QuarkAttribution.leadId(),
      event_id: before,
    });
    expect(w.dataLayer).toContainEqual(p);
    expect(w.QuarkAttribution.eventId()).not.toBe(before);
  });

  it('decora links do Fillout com lid e atribuição, preservando parâmetros existentes', async () => {
    const w = load({
      url: 'https://lp.quark.com.br/?utm_source=meta&utm_medium=paid_social&utm_campaign=c1',
      html: '<!doctype html><body><a id="a" href="https://form.fillout.com/t/abc?x=1">diag</a><a id="b" href="https://outro.com/">x</a></body>',
    });
    await ready(w);
    const a = new URL(w.document.getElementById('a').getAttribute('href'));
    expect(a.searchParams.get('x')).toBe('1');
    expect(a.searchParams.get('lid')).toBe(w.QuarkAttribution.leadId());
    expect(a.searchParams.get('utm_campaign')).toBe('c1');
    expect(w.document.getElementById('b').getAttribute('href')).toBe('https://outro.com/');
  });

  it('consentimento desconhecido é tratado como não concedido', () => {
    const w = load({ url: 'https://lp.quark.com.br/' });
    expect(w.QuarkAttribution.get().consent).toEqual({ marketing: false, analytics: false });
  });

  it('getConsent da configuração é respeitado', () => {
    const w = load({
      url: 'https://lp.quark.com.br/',
      config: { getConsent: () => ({ marketing: true, analytics: true }) },
    });
    expect(w.QuarkAttribution.get().consent).toEqual({ marketing: true, analytics: true });
  });
});
