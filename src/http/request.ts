import type { IngestRequest } from '../pipeline/types.js';

type Raw = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  query: Record<string, string | string[] | undefined>;
};

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Traduz a requisição HTTP (Vercel) para o formato neutro do pipeline. */
export function buildIngestRequest(raw: Raw): IngestRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw.headers)) headers[k.toLowerCase()] = first(v);

  const query: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw.query)) query[k] = first(v);

  const ip =
    headers['x-vercel-forwarded-for']?.trim() ||
    headers['x-real-ip']?.trim() ||
    headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    null;

  const len = Number(headers['content-length']);
  return {
    body: raw.body,
    query,
    headers,
    ip,
    ...(Number.isFinite(len) && headers['content-length'] ? { bodyBytes: len } : {}),
  };
}
