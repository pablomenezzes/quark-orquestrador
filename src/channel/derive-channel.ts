import { channelConfig, type ChannelConfig } from '../../config/channel-rules.js';

export type ChannelInput = {
  /** Tipo da fonte em orq.sources.tipo (elementor, vercel, lovable, fillout, meta_form). */
  source_tipo?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  referrer?: string | null;
};

const clean = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

function referrerHost(referrer: string | null | undefined, cfg: ChannelConfig): string | null {
  const r = (referrer ?? '').trim();
  if (!r) return null;
  let host: string;
  try {
    host = new URL(r).hostname.toLowerCase();
  } catch {
    return null;
  }
  const own = cfg.ownDomains.some((d) => host === d || host.endsWith(`.${d}`));
  return own ? null : host;
}

/** Primeira regra que bater define o canal (seção 9). */
export function deriveChannel(input: ChannelInput, cfg: ChannelConfig = channelConfig): string {
  // 1. Meta Lead Ads
  if (input.source_tipo === 'meta_form') return 'paid_social_meta';

  // 2. Click ids do Google
  if (input.gclid || input.gbraid || input.wbraid) return 'paid_search_google';

  const medium = clean(input.utm_medium);
  const source = clean(input.utm_source);

  // 3. Mídia paga por UTM
  if (cfg.paidMediums.includes(medium)) {
    const hit = cfg.paidSourceMap.find((m) => m.sources.includes(source));
    return hit ? hit.canal : cfg.paidFallback;
  }

  // 4. E-mail
  if (cfg.emailMediums.includes(medium)) return 'email';

  // 5-7. Referrer
  const host = referrerHost(input.referrer, cfg);
  if (host) {
    if (cfg.searchEngines.some((re) => re.test(host))) return 'organic_search';
    if (cfg.socialNetworks.some((re) => re.test(host))) return 'organic_social';
    return 'referral';
  }

  // 8. Sem referrer e sem UTM
  if (!medium && !source) return 'direct';
  return cfg.unknownUtmFallback;
}
