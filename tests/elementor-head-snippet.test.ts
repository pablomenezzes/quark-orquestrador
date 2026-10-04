import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { buildHead } from '../tracking/build-elementor-head.mjs';

/**
 * tracking/elementor-head.html é o bloco colado no cabeçalho do WordPress (Elementor > Custom Code).
 * Estes testes usam o ARQUIVO REAL e uma página parecida com a do site.
 */
const ATTR = readFileSync(new URL('../tracking/attribution.js', import.meta.url), 'utf8');
const HEAD_FILE = readFileSync(new URL('../tracking/elementor-head.html', import.meta.url), 'utf8');

const FIELDS = ['lead_id', 'event_id', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'fbp', 'fbc', 'ga_client_id', 'landing_url', 'referrer', 'user_agent', 'consent_marketing', 'consent_analytics'];
const page = (head: string, pre = '') => `<!doctype html><html><head>${pre}${head}</head><body>
<form class="elementor-form">
  ${FIELDS.map((id) => `<input type="hidden" name="form_fields[${id}]" id="form-field-${id}">`).join('\n  ')}
  <input type="hidden" name="form_fields[qk_form_id]" value="form-agendar-demonstracao">
  <input type="hidden" name="form_fields[qk_lp_id]" value="lp-agendar-demonstracao">
  <input type="text" name="form_fields[name]">
</form></body></html>`;

const ready = (w: any) =>
  new Promise<void>((res) => (w.document.readyState === 'loading' ? w.document.addEventListener('DOMContentLoaded', () => res()) : res()));
const open = (url: string, head = HEAD_FILE, pre = '', referrer?: string) =>
  new JSDOM(page(head, pre), { url, referrer, runScripts: 'dangerously', pretendToBeVisual: true });

describe('tracking/elementor-head.html', () => {
  it('está em dia com o attribution.js (se falhar: node tracking/build-elementor-head.mjs)', () => {
    expect(HEAD_FILE).toBe(buildHead(ATTR));
  });

  it('não tem sequências que quebram a incorporação: 3 blocos de script, nenhum fechamento extra', () => {
    expect((HEAD_FILE.match(/<script>/g) ?? []).length).toBe(3);
    expect((HEAD_FILE.match(/<\/script>/g) ?? []).length).toBe(3);
  });

  it('executa sem erro e deixa o script disponível', async () => {
    const errors: string[] = [];
    const dom = open('https://quarkrh.com.br/lp-agendar-demonstracao/?utm_source=google&utm_medium=cpc&gclid=G1');
    dom.window.addEventListener('error', (e: any) => errors.push(String(e.message)));
    await ready(dom.window);
    expect(errors).toEqual([]);
    expect(typeof (dom.window as any).QuarkAttribution.pushLead).toBe('function');
  });

  it('preenche os campos ocultos com atribuição, lead_id e event_id, e respeita os campos fixos', async () => {
    const dom = open('https://quarkrh.com.br/lp-agendar-demonstracao/?utm_source=google&utm_medium=cpc&utm_campaign=c1&gclid=G1', HEAD_FILE, '', 'https://www.google.com/');
    const w = dom.window as any;
    await ready(w);
    const v = (id: string) => (w.document.getElementById(`form-field-${id}`) as HTMLInputElement).value;
    expect(v('utm_source')).toBe('google');
    expect(v('utm_campaign')).toBe('c1');
    expect(v('gclid')).toBe('G1');
    expect(v('referrer')).toBe('https://www.google.com/');
    expect(v('lead_id')).toBe(w.QuarkAttribution.leadId());
    expect(v('event_id')).toBe(w.QuarkAttribution.eventId());
    expect(v('landing_url')).toBe('https://quarkrh.com.br/lp-agendar-demonstracao'); // sem query nem barra final
    expect(v('user_agent')).toContain('jsdom');
    // sem banner de cookies: consentimento desconhecido = falso (LGPD, conservador)
    expect(v('consent_marketing')).toBe('false');
    expect(v('consent_analytics')).toBe('false');
    expect((w.document.querySelector('[name="form_fields[qk_form_id]"]') as HTMLInputElement).value).toBe('form-agendar-demonstracao');
  });

  it('navegação interna (www, outras páginas do site) não vira um novo toque de origem', async () => {
    const dom = open('https://quarkrh.com.br/funcionalidades/', HEAD_FILE, '', 'https://www.quarkrh.com.br/');
    await ready(dom.window);
    expect((dom.window as any).QuarkAttribution.get().attribution.referrer).toBe('');
  });

  it('links para o diagnóstico do Lovable recebem o lid e a atribuição', async () => {
    const html = page(HEAD_FILE).replace('</form>', '</form><a id="d" href="https://quarkrh-diagnostico.lovable.app/">diagnóstico</a>');
    const dom = new JSDOM(html, { url: 'https://quarkrh.com.br/?utm_source=meta&utm_medium=paid_social', runScripts: 'dangerously', pretendToBeVisual: true });
    const w = dom.window as any;
    await ready(w);
    const href = new URL(w.document.getElementById('d').getAttribute('href'));
    expect(href.searchParams.get('lid')).toBe(w.QuarkAttribution.leadId());
    expect(href.searchParams.get('utm_source')).toBe('meta');
  });

  it('o gancho submit_success consome o event_id e entrega outro para o próximo envio', async () => {
    // jQuery de mentira, definido antes do bloco, só para exercitar a lógica do gancho
    const fake = `<script>(function(){var h={};window.jQuery=function(){return{on:function(ev,sel,fn){h[ev]=fn;},find:function(s){return{val:function(){return s.indexOf('qk_form_id')>-1?'form-agendar-demonstracao':'lp-agendar-demonstracao';}};}};};window.__fire=function(ev){h[ev].call({});};})();</script>`;
    const dom = open('https://quarkrh.com.br/lp-agendar-demonstracao/', HEAD_FILE, fake);
    const w = dom.window as any;
    await ready(w);
    const before = w.QuarkAttribution.eventId();
    w.__fire('submit_success');
    expect(w.dataLayer.find((e: any) => e.event === 'generate_lead')).toMatchObject({ form_id: 'form-agendar-demonstracao', lp_id: 'lp-agendar-demonstracao', event_id: before });
    expect(w.QuarkAttribution.eventId()).not.toBe(before);
    expect((w.document.getElementById('form-field-event_id') as HTMLInputElement).value).toBe(w.QuarkAttribution.eventId());
  });

  it('sem jQuery na página o gancho não faz nada e não quebra o site', async () => {
    const errors: string[] = [];
    const dom = open('https://quarkrh.com.br/');
    dom.window.addEventListener('error', (e: any) => errors.push(String(e.message)));
    await ready(dom.window);
    expect(errors).toEqual([]);
  });
});
