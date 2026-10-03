import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ingest } from '../src/pipeline/ingest';
import { MemoryStore } from './helpers/memory-store';

const sample = (name: string) => JSON.parse(readFileSync(new URL(`../samples/${name}`, import.meta.url), 'utf8'));
const deps = (store: MemoryStore) => ({ store, shadowMode: true });

describe('payloads de exemplo (samples/)', () => {
  it('vercel.json é aceito e deriva paid_social_meta', async () => {
    const store = new MemoryStore();
    store.addSource({ slug: 'lp-vercel-rh-teste', tipo: 'vercel', token: 't' });
    const r = await ingest({ body: sample('vercel.json'), query: {}, headers: { 'x-quark-token': 't' }, ip: '1.1.1.1' }, deps(store));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ duplicate: false, canal: 'paid_social_meta' });
    expect(store.state.leads[0]).toMatchObject({ email_norm: 'maria.exemplo@exemplo.invalid', phone_e164: '+5584999990001', porte: 15 });
    expect(store.state.touchpoints[0]!.landing_url).toBe('https://lp.exemplo.invalid/rh');
  });

  it('elementor.json é aceito (token e fonte na URL) e deriva paid_search_google', async () => {
    const store = new MemoryStore();
    store.addSource({ slug: 'elementor-site-rh', tipo: 'elementor', token: 't' });
    const r = await ingest(
      { body: sample('elementor.json'), query: { source: 'elementor-site-rh', token: 't' }, headers: {}, ip: '9.9.9.9' },
      deps(store),
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ duplicate: false, canal: 'paid_search_google' });
    expect(store.state.leads[0]).toMatchObject({ email_norm: 'joao.exemplo@exemplo.invalid', phone_e164: '+5584999990002', porte: 30 });
    const ev = store.state.events[0]!;
    // Elementor: o IP do request é do servidor do Elementor, não do visitante
    expect(ev.dados.ip).toBeNull();
    expect(ev.dados.user_agent).toBe('Mozilla/5.0 (exemplo)');
    expect(ev.dados.answers).toEqual({ mensagem: 'Quero conhecer o QuarkRH' });
    expect(JSON.stringify(ev.payload_bruto)).not.toContain('"token"');
  });
});
