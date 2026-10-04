/**
 * Limite de requisições do endpoint (item 4 da seção 15). Contadores no Postgres (orq.rate_limits).
 *
 * - `browserPerIp`: fontes que o visitante acessa direto (vercel, lovable). O token dessas fontes fica no
 *   JavaScript da página, ou seja, é público: o limite por IP é o que segura quem o copiar.
 * - `perSource`: teto total por fonte e por janela. Fontes de servidor (Elementor, Fillout, Meta) chegam
 *   com o IP do fornecedor, então só têm o teto por fonte.
 *
 * Valores iniciais conservadores para o volume atual; ajuste aqui (um lugar só).
 */
export type Limit = { limit: number; windowSec: number };

export type RateLimitConfig = {
  browserPerIp: Limit;
  perSource: { browser: Limit; server: Limit };
};

export const rateLimitConfig: RateLimitConfig = {
  // 20 envios em 10 minutos por IP (um escritório inteiro atrás do mesmo IP ainda cabe)
  browserPerIp: { limit: 20, windowSec: 600 },
  perSource: {
    browser: { limit: 300, windowSec: 3600 },
    server: { limit: 1000, windowSec: 3600 },
  },
};
