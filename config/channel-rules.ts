/**
 * Configuração da derivação de canal (seção 9 do orquestrador-marketing-quark.md).
 * A lógica fica em src/channel/derive-channel.ts; tudo que é lista de valores fica aqui.
 */

export type ChannelConfig = {
  /** Valores de utm_medium que indicam mídia paga (passo 3). */
  paidMediums: string[];
  /** utm_source => canal pago. A primeira entrada que casar vence. */
  paidSourceMap: Array<{ sources: string[]; canal: string }>;
  /** Canal pago quando o utm_source não está no mapa. */
  paidFallback: string;
  /** utm_medium que define e-mail (passo 4). */
  emailMediums: string[];
  /** Hosts de buscadores (sufixo de domínio, ou regex via `/.../`). */
  searchEngines: RegExp[];
  /** Hosts de redes sociais. */
  socialNetworks: RegExp[];
  /** Domínios próprios: referrer deles conta como navegação interna (ignorado). */
  ownDomains: string[];
  /** Canal quando há UTM mas nenhuma regra reconhece e não há referrer. */
  unknownUtmFallback: string;
};

/** Casa o host inteiro: `google.com`, `www.google.com.br`, mas não `meugoogle.com`. */
const brand = (name: string) => new RegExp(`(^|\\.)${name}\\.[a-z]{2,}(\\.[a-z]{2})?$`);
const exact = (domain: string) => new RegExp(`(^|\\.)${domain.replace(/\./g, '\\.')}$`);

export const channelConfig: ChannelConfig = {
  paidMediums: ['paid_social', 'cpc', 'paid'],
  paidSourceMap: [
    { sources: ['meta', 'facebook', 'fb', 'instagram', 'ig'], canal: 'paid_social_meta' },
    { sources: ['google'], canal: 'paid_search_google' },
  ],
  paidFallback: 'paid_other',
  emailMediums: ['email'],
  searchEngines: [brand('google'), exact('bing.com'), exact('duckduckgo.com'), exact('yahoo.com'), exact('ecosia.org'), exact('yandex.com'), exact('baidu.com')],
  socialNetworks: [
    exact('facebook.com'),
    exact('instagram.com'),
    exact('linkedin.com'),
    exact('lnkd.in'),
    exact('t.co'),
    exact('twitter.com'),
    exact('x.com'),
    exact('youtube.com'),
    exact('tiktok.com'),
    exact('pinterest.com'),
    exact('whatsapp.com'),
    exact('wa.me'),
  ],
  // Domínios próprios: referrer vindo deles é navegação interna, não um canal novo.
  // 'quarkrh.com.br' cobre também www e qualquer subdomínio (site, funcionalidades, LPs de agendamento).
  ownDomains: ['quarkrh.com.br', 'quarkrh-diagnostico.lovable.app'],
  unknownUtmFallback: 'other',
};
