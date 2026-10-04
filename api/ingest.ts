import pg from 'pg';
import { rateLimitConfig } from '../config/rate-limits.js';
import { assertLeastPrivilegeUser, assertSafeDbTarget } from '../src/db/guard.js';
import { PgStore } from '../src/db/pg-store.js';
import { createHandler } from '../src/http/handler.js';
import { OriginCache, parseSourceOrigins } from '../src/security/origins.js';

/**
 * Endpoint único (seção 5). Região gru1 (vercel.json). Modo sombra: só grava em core/orq;
 * não chama Pipedrive, Umbler, Meta nem Google.
 *
 * Conecta SOMENTE com o papel de privilégio mínimo (INGEST_DB_URL, usuário orq_ingest).
 * Nunca usa o `postgres`: se a variável estiver ausente ou apontar para outro usuário, o endpoint
 * responde 500 "misconfigured" em vez de operar com poder demais.
 */
const url = process.env.INGEST_DB_URL ?? '';
const salt = process.env.RATE_LIMIT_SALT ?? '';

let configError: string | undefined;
try {
  assertSafeDbTarget({ target: url, expectedRef: process.env.SUPABASE_PROJECT_REF ?? '' });
  assertLeastPrivilegeUser(url);
  if (salt.length < 16) throw new Error('RATE_LIMIT_SALT ausente ou curto demais (mínimo 16 caracteres).');
} catch (e) {
  configError = e instanceof Error ? e.message : 'configuração inválida';
}

const log = { error: (msg: string, extra?: unknown) => console.error(msg, extra) };
const pool = configError ? null : new pg.Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
pool?.on('error', (e) => log.error('pool: erro no banco', { message: e.message.replace(/postgres(ql)?:\/\/\S+/gi, '<url>') }));
const store = pool ? PgStore.fromPool(pool) : null;

const origins = new OriginCache(
  async () => {
    if (!store) return [];
    const urls = await store.listSourceUrls();
    return [...new Set(urls.flatMap((u) => parseSourceOrigins(u)))];
  },
  60_000,
  Date.now,
  (e) => log.error('origens: falha ao carregar de orq.sources', { message: e instanceof Error ? e.message : String(e) }),
);

export default createHandler({
  store: store as never,
  shadowMode: process.env.SHADOW_MODE === 'true',
  rateLimit: { salt, config: rateLimitConfig },
  allowedOrigins: () => origins.get(),
  log,
  configError,
});
