/**
 * Conferência real do painel Umbler (somente GET): imprime SÓ números agregados, nenhum nome ou dado pessoal.
 * Usa configuração e cache temporários (não mexe em studio/config nem em .cache). Uso: npx tsx scripts/umbler-conferencia.ts [AAAA-MM-DD AAAA-MM-DD]
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UmblerCliente } from '../studio/lib/umbler/cliente.js';
import { CacheUmbler } from '../studio/lib/umbler/cache.js';
import { ServicoUmbler } from '../studio/lib/umbler/servico.js';

const env = existsSync('.env.local') ? readFileSync('.env.local', 'utf8') : '';
const lido = (n: string) => process.env[n] || new RegExp(`^${n}=(.*)$`, 'm').exec(env)?.[1]?.trim().replace(/^["']|["']$/g, '') || '';
const token = (lido('UMBLER_TOKEN') || lido('UMBLER_API_TOKEN') || lido('UMBLER')).replace(/^Bearer\s+/i, '');
if (!token) { console.error('Falta o token.'); process.exit(2); }
const hoje = new Date();
const de = process.argv[2] ?? `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-01`;
const ate = process.argv[3] ?? hoje.toISOString().slice(0, 10);
const dir = mkdtempSync(join(tmpdir(), 'umb-conf-'));
try {
  const cli = new UmblerCliente({ token });
  const svc = new ServicoUmbler({ leitor: cli, cache: new CacheUmbler(join(dir, 'c'), Date.now, undefined, token), configPath: join(dir, 'cfg.json'), token });
  const cat = await svc.catalogo(true);
  console.log(`catálogo: ${cat.canais.itens.length} canais, ${cat.bots.itens.length} bots, ${cat.setores.itens.length} setores, ${cat.etiquetas.itens.length} etiquetas`);
  const p = await svc.painel({ de, ate, escopo: 'tudo' }, true);
  const c = p.completude;
  console.log(`período ${de} a ${ate}: ${p.sessoes.length} sessões (${p.sessoes.filter((s) => s.tipo === 'Template').length} template, ${p.sessoes.filter((s) => s.tipo === 'Bot').length} bot)`);
  console.log(`envios=${p.cartoes.enviadas.v} lidas=${p.cartoes.lidas.v} respondidas=${p.cartoes.respondidas.v} falhas=${p.cartoes.falhas.v} créditos=${p.cartoes.custoCreditos.v}`);
  console.log(`completude: custo ${c.custo.x}/${c.custo.y}, enviadas ${c.enviadas.x}/${c.enviadas.y}, lidas ${c.lidas.x}/${c.lidas.y}, respondidas ${c.respondidas.x}/${c.respondidas.y}, falhas ${c.falhas.x}/${c.falhas.y}`);
  console.log(`paradas de fluxo: ${p.paradas ? `${p.paradas.sessoesComDado}/${p.paradas.sessoesDeBot} sessões com dado` : 'sem sessão de bot'}`);
  console.log(`avisos: ${p.avisos.length ? p.avisos.join(' | ') : 'nenhum'}`);
  console.log(`GETs: ${cli.total}`);
  const again = await svc.painel({ de, ate, escopo: 'tudo' });
  console.log(`segunda leitura (cache): ${again.chamadas} GETs`);
} finally { rmSync(dir, { recursive: true, force: true }); }
