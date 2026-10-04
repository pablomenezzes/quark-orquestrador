import type { VercelRequest, VercelResponse } from '@vercel/node';
import pg from 'pg';
import { PgStore } from '../src/db/pg-store.js';
import { assertSafeDbTarget } from '../src/db/guard.js';
import { buildIngestRequest } from '../src/http/request.js';
import { ingest } from '../src/pipeline/ingest.js';

/**
 * Endpoint único (seção 5). Região gru1 (vercel.json).
 * Modo sombra: só grava em core/orq; não chama Pipedrive, Umbler, Meta nem Google.
 */
let pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.SUPABASE_DB_URL ?? '';
    assertSafeDbTarget({ target: url, expectedRef: process.env.SUPABASE_PROJECT_REF ?? '' });
    pool = new pg.Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

function cors(req: VercelRequest, res: VercelResponse) {
  // O token identifica a fonte; o CORS só deixa o navegador da LP enviar. Reflete a origem.
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-quark-token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const result = await ingest(
      buildIngestRequest({ headers: req.headers, body: req.body, query: req.query }),
      {
        store: PgStore.fromPool(getPool()),
        shadowMode: process.env.SHADOW_MODE === 'true',
        log: { error: (msg, extra) => console.error(msg, extra) },
      },
    );
    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error('ingest: erro inesperado', e instanceof Error ? e.message : e);
    return res.status(500).json({ error: 'internal_error' });
  }
}
