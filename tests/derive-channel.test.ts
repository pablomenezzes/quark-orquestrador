import { describe, it, expect } from 'vitest';
import { deriveChannel } from '../src/channel/derive-channel';
import { channelConfig } from '../config/channel-rules';

const base = {
  source_tipo: 'vercel',
  utm_source: '',
  utm_medium: '',
  gclid: '',
  gbraid: '',
  wbraid: '',
  referrer: '',
};

const d = (over: Partial<typeof base>) => deriveChannel({ ...base, ...over });

describe('deriveChannel (seção 9) — ordem de avaliação', () => {
  it('1. fonte meta_form => paid_social_meta, mesmo com gclid e UTMs conflitantes', () => {
    expect(d({ source_tipo: 'meta_form' })).toBe('paid_social_meta');
    expect(d({ source_tipo: 'meta_form', gclid: 'abc', utm_medium: 'email' })).toBe('paid_social_meta');
  });

  it('2. gclid, gbraid ou wbraid => paid_search_google', () => {
    expect(d({ gclid: 'abc' })).toBe('paid_search_google');
    expect(d({ gbraid: 'abc' })).toBe('paid_search_google');
    expect(d({ wbraid: 'abc' })).toBe('paid_search_google');
  });

  it('2 vence 3: gclid com utm meta/paid_social continua google', () => {
    expect(d({ gclid: 'abc', utm_source: 'meta', utm_medium: 'paid_social' })).toBe('paid_search_google');
  });

  it('3. utm_medium pago mapeia o canal pelo utm_source', () => {
    expect(d({ utm_source: 'meta', utm_medium: 'paid_social' })).toBe('paid_social_meta');
    expect(d({ utm_source: 'facebook', utm_medium: 'paid_social' })).toBe('paid_social_meta');
    expect(d({ utm_source: 'instagram', utm_medium: 'paid' })).toBe('paid_social_meta');
    expect(d({ utm_source: 'google', utm_medium: 'cpc' })).toBe('paid_search_google');
    expect(d({ utm_source: 'linkedin', utm_medium: 'paid_social' })).toBe('paid_other');
    expect(d({ utm_source: '', utm_medium: 'cpc' })).toBe('paid_other');
  });

  it('3. comparação de utm é case-insensitive e ignora espaços', () => {
    expect(d({ utm_source: ' Meta ', utm_medium: 'PAID_SOCIAL' })).toBe('paid_social_meta');
  });

  it('3 vence referrer: utm pago com referrer de buscador continua pago', () => {
    expect(d({ utm_source: 'meta', utm_medium: 'paid_social', referrer: 'https://www.google.com/' })).toBe(
      'paid_social_meta',
    );
  });

  it('4. utm_medium=email => email', () => {
    expect(d({ utm_medium: 'email', utm_source: 'newsletter' })).toBe('email');
    expect(d({ utm_medium: 'email', referrer: 'https://mail.google.com/' })).toBe('email');
  });

  it('5. referrer de buscador sem parâmetro pago => organic_search', () => {
    expect(d({ referrer: 'https://www.google.com/' })).toBe('organic_search');
    expect(d({ referrer: 'https://www.google.com.br/search?q=x' })).toBe('organic_search');
    expect(d({ referrer: 'https://www.bing.com/' })).toBe('organic_search');
    expect(d({ referrer: 'https://duckduckgo.com/' })).toBe('organic_search');
  });

  it('6. referrer de rede social sem parâmetro pago => organic_social', () => {
    expect(d({ referrer: 'https://l.facebook.com/l.php?u=x' })).toBe('organic_social');
    expect(d({ referrer: 'https://www.instagram.com/' })).toBe('organic_social');
    expect(d({ referrer: 'https://www.linkedin.com/feed' })).toBe('organic_social');
    expect(d({ referrer: 'https://lnkd.in/abc' })).toBe('organic_social');
    expect(d({ referrer: 'https://t.co/abc' })).toBe('organic_social');
  });

  it('7. outro referrer externo => referral', () => {
    expect(d({ referrer: 'https://blog-parceiro.com.br/post' })).toBe('referral');
  });

  it('8. sem referrer e sem UTM => direct', () => {
    expect(d({})).toBe('direct');
  });

  it('referrer inválido é tratado como ausente', () => {
    expect(d({ referrer: 'não é url' })).toBe('direct');
  });

  it('host que apenas contém o nome do buscador não é buscador', () => {
    expect(d({ referrer: 'https://meugoogle-fake.com/' })).toBe('referral');
    expect(d({ referrer: 'https://facebook.com.golpe.xyz/' })).toBe('referral');
  });

  it('referrer do próprio domínio é ignorado (navegação interna)', () => {
    const r = deriveChannel(
      { ...base, referrer: 'https://quark.com.br/pagina' },
      { ...channelConfig, ownDomains: ['quark.com.br'] },
    );
    expect(r).toBe('direct');
  });

  it('UTM presente mas desconhecido, sem referrer => other (não direct)', () => {
    expect(d({ utm_source: 'parceiro', utm_medium: 'afiliado' })).toBe('other');
  });

  it('UTM desconhecido com referrer de buscador segue a regra do referrer', () => {
    expect(d({ utm_source: 'x', utm_medium: 'afiliado', referrer: 'https://www.google.com/' })).toBe('organic_search');
  });
});

describe('domínios próprios reais da Quark (item 7)', () => {
  const base2 = { source_tipo: 'elementor', utm_source: '', utm_medium: '', gclid: '', gbraid: '', wbraid: '' };
  it('referrer do site, de subdomínios e do diagnóstico é navegação interna (direct), não referral', () => {
    for (const ref of [
      'https://quarkrh.com.br/funcionalidades/',
      'https://www.quarkrh.com.br/lp-agendar-demonstracao/',
      'https://quarkrh.com.br/quarkrh-sistema-de-rh-completo/',
      'https://quarkrh-diagnostico.lovable.app/',
    ]) expect(deriveChannel({ ...base2, referrer: ref })).toBe('direct');
  });
  it('mas um domínio parecido NÃO é próprio', () => {
    expect(deriveChannel({ ...base2, referrer: 'https://quarkrh.com.br.golpe.xyz/' })).toBe('referral');
    expect(deriveChannel({ ...base2, referrer: 'https://meuquarkrh.com.br/' })).toBe('referral');
  });
  it('e a busca orgânica continua funcionando', () => {
    expect(deriveChannel({ ...base2, referrer: 'https://www.google.com/' })).toBe('organic_search');
  });
});