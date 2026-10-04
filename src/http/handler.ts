import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { RateLimitConfig } from '../../config/rate-limits.js';
import { ingest as realIngest } from '../pipeline/ingest.js';
import type { IngestDeps, IngestRequest, IngestResponse, Store } from '../pipeline/types.js';
import { isOriginAllowed } from '../security/origins.js';
import { buildIngestRequest } from './request.js';

export type HandlerDeps = {
  store: Store;
  shadowMode: boolean;
  rateLimit: { salt: string; config: RateLimitConfig };
  /** Origens permitidas (de orq.sources.url, com cache). */
  allowedOrigins: () => Promise<string[]>;
  log: { error: (msg: string, extra?: unknown) => void };
  /** Se definido, o endpoint está mal configurado: tudo (menos OPTIONS) responde 500. */
  configError?: string;
  /** Injetável para teste. */
  ingest?: (req: IngestRequest, deps: IngestDeps) => Promise<IngestResponse>;
};

/**
 * Endpoint público. Camadas, na ordem:
 *  1. CORS só para origens cadastradas (navegador de outros sites é barrado);
 *  2. POST de navegador com Origin não cadastrada -> 403;
 *  3. JSON malformado -> 400 (e não 500);
 *  4. pipeline: token, limite de requisições, validação, gravação.
 */
export function createHandler(deps: HandlerDeps) {
  const run = deps.ingest ?? realIngest;

  return async function handler(req: VercelRequest, res: VercelResponse) {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

    let allowed: string[] = [];
    try {
      allowed = await deps.allowedOrigins();
    } catch (e) {
      deps.log.error('handler: falha ao listar origens permitidas (navegadores ficam bloqueados)', { message: e instanceof Error ? e.message : String(e) });
    }
    const originOk = isOriginAllowed(origin, allowed);

    res.setHeader('Vary', 'Origin');
    if (originOk && origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-quark-token');
      res.setHeader('Access-Control-Max-Age', '86400');
    }

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    if (deps.configError) {
      deps.log.error('handler: configuração inválida', { motivo: deps.configError });
      return res.status(500).json({ error: 'misconfigured' });
    }

    // Navegador de um site que não é fonte cadastrada: nem chega ao pipeline.
    if (origin && !originOk) return res.status(403).json({ error: 'origin_not_allowed' });

    // O corpo é interpretado de forma preguiçosa pela Vercel: JSON inválido lança aqui.
    let body: unknown;
    try {
      body = req.body;
    } catch {
      return res.status(400).json({ error: 'invalid_json' });
    }

    try {
      const out = await run(buildIngestRequest({ headers: req.headers, body, query: req.query }), {
        store: deps.store,
        shadowMode: deps.shadowMode,
        rateLimit: deps.rateLimit,
        log: deps.log,
      });
      for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
      return res.status(out.status).json(out.body);
    } catch (e) {
      deps.log.error('handler: erro inesperado', { message: e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/\S+/gi, '<url>') : 'desconhecido' });
      return res.status(500).json({ error: 'internal_error' });
    }
  };
}
