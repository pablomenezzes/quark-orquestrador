import { createHmac } from 'node:crypto';
import type { RateLimitConfig } from '../../config/rate-limits.js';
import type { SourceRow, SourceTipo, Store } from '../pipeline/types.js';

/** Fontes que o visitante acessa direto: o IP do request é o do visitante. */
export const BROWSER_DIRECT: ReadonlySet<SourceTipo> = new Set<SourceTipo>(['vercel', 'lovable']);

/** Balde por fonte+IP. O IP nunca vai ao banco em claro (HMAC com sal secreto). */
export function ipBucketKey(sourceId: string, ip: string, salt: string): string {
  return `ip:${sourceId}:${createHmac('sha256', salt).update(ip).digest('hex').slice(0, 32)}`;
}

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSec: number; scope: 'ip' | 'source' };

/**
 * Conta a requisição nos baldes aplicáveis. Primeiro o IP: se ele já estourou, não gasta o orçamento da fonte.
 * Quem chama decide o que fazer se o contador falhar (aqui: lança, e o pipeline libera — falha aberta).
 */
export async function checkRateLimits(args: {
  store: Pick<Store, 'hit'>;
  source: Pick<SourceRow, 'id' | 'tipo'>;
  ip: string | null;
  salt: string;
  config: RateLimitConfig;
}): Promise<RateDecision> {
  const { store, source, ip, salt, config } = args;
  const browser = BROWSER_DIRECT.has(source.tipo);

  if (browser && ip) {
    const lim = config.browserPerIp;
    const r = await store.hit(ipBucketKey(source.id, ip, salt), lim.windowSec);
    if (r.hits > lim.limit) return { allowed: false, retryAfterSec: r.resetInSec, scope: 'ip' };
  }

  const lim = browser ? config.perSource.browser : config.perSource.server;
  const r = await store.hit(`src:${source.id}`, lim.windowSec);
  if (r.hits > lim.limit) return { allowed: false, retryAfterSec: r.resetInSec, scope: 'source' };

  return { allowed: true };
}
