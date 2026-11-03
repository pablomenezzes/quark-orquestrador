/**
 * Importa a Umbler para o banco (ops.umbler_*) de 01/07/2026 em diante. Somente GET na Umbler; grava só no banco pelo papel orq_panel.
 * Imprime apenas contagens. Uso: npx tsx scripts/umbler-importar.ts [ID_DO_CANAL] [--reler]   (sem canal: o canal "Insights"; --reler lê de novo todas as conversas)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { assertRoleUser, assertSafeDbTarget } from '../src/db/guard.js';
import { UmblerCliente } from '../studio/lib/umbler/cliente.js';
import { CacheUmbler } from '../studio/lib/umbler/cache.js';
import { PgBanco } from '../studio/lib/umbler/banco.js';
import { PgConfigStore } from '../studio/lib/umbler/config-store.js';
import { ServicoUmbler } from '../studio/lib/umbler/servico.js';

const env = existsSync('.env.local') ? readFileSync('.env.local', 'utf8') : '';
const lido = (n: string) => process.env[n] || new RegExp(`^${n}=(.*)$`, 'm').exec(env)?.[1]?.trim().replace(/^["']|["']$/g, '') || '';
const token = (lido('UMBLER_TOKEN') || lido('UMBLER_API_TOKEN') || lido('UMBLER')).replace(/^Bearer\s+/i, '');
const url = lido('PANEL_DB_URL');
if (!token || !url) { console.error('Faltam UMBLER (token) e/ou PANEL_DB_URL no .env.local.'); process.exit(2); }
assertSafeDbTarget({ target: url, expectedRef: lido('SUPABASE_PROJECT_REF') });
assertRoleUser(url, 'orq_panel');
const pool = new pg.Pool({ connectionString: url, max: 2, ssl: { rejectUnauthorized: false } });
const svc = new ServicoUmbler({
  leitor: new UmblerCliente({ token }),
  cache: new CacheUmbler(join('.cache', 'umbler'), Date.now, undefined, token),
  store: new PgConfigStore(pool),
  banco: new PgBanco(pool),
  token,
  orcamentoMs: 120_000,
});
try {
  const canal = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? (await svc.canalPadrao())?.id ?? null;
  console.log(`canal da leitura de conversas: ${canal ?? 'nenhum'}`);
  for (let i = 1; i <= 200; i++) {
    const p = await svc.importar(canal, undefined, i === 1 && process.argv.includes('--reler'));
    console.log(`rodada ${i}: fase=${p.fase} sessões ${p.sessoes.atualizadas}/${p.sessoes.total} | conversas: sessões ${p.conversas.sessoesFeitas}/${p.conversas.sessoes}, verificadas ${p.conversas.verificadas}, mensagens ${p.conversas.mensagens} | GETs ${p.chamadas}${p.avisos.length ? ` | avisos: ${p.avisos.length}` : ''}`);
    if (p.concluido) break;
  }
  const r = await svc.relatorio(canal, '2026-07-01', new Date().toISOString().slice(0, 10));
  console.log(`no banco: ${r.cobertura.sessoes} sessões do canal (${r.cobertura.sessoesLidas} com conversas lidas), ${r.cobertura.mensagens} mensagens de template, ${r.canais.length} canais`);
} finally {
  await pool.end();
}
