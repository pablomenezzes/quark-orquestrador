/**
 * Configuração do painel Umbler: studio/config/umbler-marketing.json (versionado, SEM segredo: só IDs, nomes, limites e preços).
 * - Regra de pertencimento: uma sessão é do Marketing se o canal está fixado; se há bots fixados e a sessão é de bot,
 *   o bot também precisa estar fixado (sem bots fixados, valem todos os bots dos canais fixados).
 * - Preço do crédito: lista de { desde, preco } em que só se acrescenta; o custo usa o preço vigente no dia da sessão.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Sessao } from './normaliza.js';

export const TIPOS_ITEM = ['canais', 'bots', 'setores', 'etiquetas'] as const;
export type TipoItem = (typeof TIPOS_ITEM)[number];
export type ItemFixado = { id: string; nome: string; fixado: boolean; alteradoEm: string };
export type PrecoCredito = { desde: string; preco: number };
export type ConfigUmbler = {
  versao: 1;
  organizacaoId: string | null;
  atualizadoEm: string | null;
  canais: ItemFixado[];
  bots: ItemFixado[];
  setores: ItemFixado[];
  etiquetas: ItemFixado[];
  precoCredito: PrecoCredito[];
  amostraMinima: number;
};

export class ConfigInvalida extends Error {}

export const AMOSTRA_PADRAO = 100;
export const configVazia = (): ConfigUmbler => ({ versao: 1, organizacaoId: null, atualizadoEm: null, canais: [], bots: [], setores: [], etiquetas: [], precoCredito: [], amostraMinima: AMOSTRA_PADRAO });

const dataOk = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

function itens(x: unknown): ItemFixado[] {
  if (!Array.isArray(x)) return [];
  return x
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object' && typeof (i as { id?: unknown }).id === 'string')
    .map((i) => ({ id: String(i.id), nome: typeof i.nome === 'string' ? i.nome : String(i.id), fixado: i.fixado === true, alteradoEm: typeof i.alteradoEm === 'string' ? i.alteradoEm : '' }));
}

/** Lê o JSON. Arquivo ausente = configuração vazia. Arquivo torto = erro claro (nunca sobrescreve em silêncio). */
export function lerConfig(caminho: string): ConfigUmbler {
  if (!existsSync(caminho)) return configVazia();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(caminho, 'utf8'));
  } catch {
    throw new ConfigInvalida(`O arquivo ${caminho} não é um JSON válido. Corrija ou apague para recomeçar.`);
  }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const precos = (Array.isArray(o.precoCredito) ? o.precoCredito : [])
    .filter((p): p is PrecoCredito => !!p && dataOk((p as PrecoCredito).desde) && typeof (p as PrecoCredito).preco === 'number' && (p as PrecoCredito).preco > 0)
    .map((p) => ({ desde: p.desde, preco: p.preco }))
    .sort((a, b) => a.desde.localeCompare(b.desde));
  const am = o.amostraMinima;
  return {
    versao: 1,
    organizacaoId: typeof o.organizacaoId === 'string' && o.organizacaoId ? o.organizacaoId : null,
    atualizadoEm: typeof o.atualizadoEm === 'string' ? o.atualizadoEm : null,
    canais: itens(o.canais),
    bots: itens(o.bots),
    setores: itens(o.setores),
    etiquetas: itens(o.etiquetas),
    precoCredito: precos,
    amostraMinima: typeof am === 'number' && Number.isInteger(am) && am >= 1 && am <= 1_000_000 ? am : AMOSTRA_PADRAO,
  };
}

export function salvarConfig(caminho: string, c: ConfigUmbler): void {
  mkdirSync(dirname(caminho), { recursive: true });
  const tmp = `${caminho}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, 'utf8');
  renameSync(tmp, caminho);
}

const copia = (c: ConfigUmbler): ConfigUmbler => JSON.parse(JSON.stringify(c)) as ConfigUmbler;

/** Marca/desmarca um item como do Marketing (cria o registro se ainda não existir) e anota a data da alteração. */
export function definirFixado(c: ConfigUmbler, tipo: TipoItem, id: string, nome: string, fixado: boolean, agora: Date = new Date()): ConfigUmbler {
  if (!(TIPOS_ITEM as readonly string[]).includes(tipo)) throw new ConfigInvalida('Tipo de item inválido.');
  if (!id || id.length > 100 || !/^[\w.\-:]+$/.test(id)) throw new ConfigInvalida('ID inválido.');
  const n = copia(c);
  const iso = agora.toISOString();
  const lista = n[tipo];
  const i = lista.find((x) => x.id === id);
  const nomeLimpo = (nome || id).slice(0, 200);
  if (i) {
    if (i.fixado !== fixado) i.alteradoEm = iso;
    i.fixado = fixado;
    i.nome = nomeLimpo;
  } else {
    lista.push({ id, nome: nomeLimpo, fixado, alteradoEm: iso });
  }
  n.atualizadoEm = iso;
  return n;
}

export function definirOrganizacao(c: ConfigUmbler, id: string | null, agora: Date = new Date()): ConfigUmbler {
  if (id !== null && !/^[\w.\-:]{1,100}$/.test(id)) throw new ConfigInvalida('ID de organização inválido.');
  return { ...copia(c), organizacaoId: id, atualizadoEm: agora.toISOString() };
}

export function definirAmostra(c: ConfigUmbler, valor: unknown, agora: Date = new Date()): ConfigUmbler {
  if (typeof valor !== 'number' || !Number.isInteger(valor) || valor < 1 || valor > 1_000_000) throw new ConfigInvalida('A amostra mínima precisa ser um número inteiro entre 1 e 1.000.000.');
  return { ...copia(c), amostraMinima: valor, atualizadoEm: agora.toISOString() };
}

/** Só acrescenta. Recusa data igual ou anterior à última entrada: a história de preços não se edita. */
export function acrescentarPreco(c: ConfigUmbler, desde: unknown, preco: unknown, agora: Date = new Date()): ConfigUmbler {
  if (!dataOk(desde)) throw new ConfigInvalida('Informe a data de início no formato AAAA-MM-DD.');
  if (typeof preco !== 'number' || !Number.isFinite(preco) || preco <= 0 || preco > 1000) throw new ConfigInvalida('O preço do crédito precisa ser um número maior que zero.');
  const ultima = c.precoCredito[c.precoCredito.length - 1];
  if (ultima && desde <= ultima.desde) throw new ConfigInvalida(`A data precisa ser posterior à última entrada (${ultima.desde}). Preços antigos não são editados: acrescente um novo a partir de uma data nova.`);
  const n = copia(c);
  n.precoCredito.push({ desde, preco: Math.round(preco * 1e6) / 1e6 });
  n.atualizadoEm = agora.toISOString();
  return n;
}

/** Preço vigente em um dia (AAAA-MM-DD): a última entrada com `desde` <= dia. Null se não houver. */
export function precoVigente(c: ConfigUmbler, dia: string | null): number | null {
  if (!dia) return null;
  let p: number | null = null;
  for (const e of c.precoCredito) if (e.desde <= dia) p = e.preco;
  return p;
}

const fixados = (l: ItemFixado[]) => l.filter((x) => x.fixado);

/** Regra de pertencimento ao Marketing (ver o cabeçalho do arquivo). */
export function pertenceAoMarketing(c: ConfigUmbler, s: Pick<Sessao, 'canalId' | 'tipo' | 'botId' | 'botNome'>): boolean {
  const canais = fixados(c.canais);
  if (!s.canalId || !canais.some((x) => x.id === s.canalId)) return false;
  const bots = fixados(c.bots);
  if (s.tipo === 'Bot' && bots.length) return bots.some((b) => (s.botId != null && b.id === s.botId) || (s.botNome != null && b.nome === s.botNome));
  return true;
}
