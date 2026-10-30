/**
 * Descoberta da API da Umbler: no máximo 60 GETs, sem imprimir dados pessoais.
 * Grava amostras SANITIZADAS em docs/umbler/amostras/ (sem nome, telefone, e-mail ou token).
 * Uso: npx tsx scripts/umbler-descoberta.ts
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { UmblerCliente } from '../studio/lib/umbler/cliente.js';
import { sanitizar } from '../studio/lib/umbler/sanitiza.js';
import { itensDe, normalizaOrganizacoes, pick } from '../studio/lib/umbler/normaliza.js';

const LIMITE = 60;
const env = existsSync('.env.local') ? readFileSync('.env.local', 'utf8') : '';
const lido = (nome: string) => process.env[nome] || /* @__PURE__ */ new RegExp(`^${nome}=(.*)$`, 'm').exec(env)?.[1]?.trim().replace(/^["']|["']$/g, '') || '';
const token = (lido('UMBLER_TOKEN') || lido('UMBLER_API_TOKEN') || lido('UMBLER')).replace(/^Bearer\s+/i, '');
if (!token) {
  console.error('Falta UMBLER_TOKEN (ou UMBLER) no .env.local. Nada foi consultado.');
  process.exit(2);
}
const cli = new UmblerCliente({ token });
const dir = join('docs', 'umbler', 'amostras');
mkdirSync(dir, { recursive: true });
const ids = new Map<string, string>();
const resumo: string[] = [];

async function amostra(nome: string, rota: string, q: Record<string, string | number> = {}): Promise<unknown | null> {
  if (cli.total >= LIMITE) { resumo.push(`${nome}: pulado (limite de ${LIMITE} GETs)`); return null; }
  try {
    const r = await cli.get(rota, q);
    writeFileSync(join(dir, `${nome}.json`), `${JSON.stringify(sanitizar(r, ids), null, 2)}\n`, 'utf8');
    resumo.push(`${nome}: ok (${itensDe(r).length} itens)`);
    return r;
  } catch (e) {
    resumo.push(`${nome}: FALHOU (${e instanceof Error ? e.message : 'erro'})`);
    return null;
  }
}

const me = await amostra('members-me', '/v1/members/me/');
const orgs = normalizaOrganizacoes(me);
const org = orgs[0]?.id;
if (!org) { console.error('Nenhuma organização retornada.'); process.exit(3); }
const q = { organizationId: org };
await amostra('canais', '/v1/channels/', q);
await amostra('bots', '/v1/bots/', { ...q, Take: 3 });
await amostra('setores', '/v1/sectors/', q);
await amostra('etiquetas', '/v1/tags/', { ...q, Take: 3 });
await amostra('templates', '/v1/templates/', { ...q, Take: 3 });
const lista = await amostra('sessoes-lista', '/v1/bulk-send-session/', { ...q, Take: 5, Skip: 0, OrderBy: 'CreatedAtUTC', Order: 'Desc', Behavior: 'CountAllAndGetSlice' });
for (const [i, s] of itensDe(lista).slice(0, 2).entries()) {
  const id = String(pick(s, 'id') ?? '');
  if (!id) continue;
  await amostra(`sessao-detalhe-${i + 1}`, `/v1/bulk-send-session/${id}/`, q);
  await amostra(`sessao-custo-${i + 1}`, `/v1/bulk-send-session/${id}/costs/`, q);
}
const bot = itensDe(lista).map((s) => pick(pick(s, 'bot'), 'id')).find((x) => typeof x === 'string');
if (typeof bot === 'string') await amostra('botinstances', '/v1/bots/flowchart/botinstances/', { ...q, botId: bot, Take: 2 });

console.log(resumo.join('\n'));
console.log(`GETs feitos: ${cli.total} de ${LIMITE}. Amostras sanitizadas em ${dir}.`);
