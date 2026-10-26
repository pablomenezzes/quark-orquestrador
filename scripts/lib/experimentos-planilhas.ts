/**
 * Carga única das planilhas antigas "Growth e Experimentos" (formulário de respostas e lista de 2025) para mkt.experimentos.
 * Tudo aqui é puro (texto CSV -> entradas do cadastro); quem grava é scripts/importar-experimentos.ts.
 * Cada linha vira uma entrada do mesmo cadastro da página (validarEntrada) mais uma `origem` estável, para a carga poder rodar de novo sem duplicar.
 */
import type { ExperimentoEntrada } from '../../studio/lib/experimentos.js';

export interface ItemImportado { origem: string; entrada: ExperimentoEntrada & { titulo: string } }

/** CSV com aspas, aspas duplas escapadas e quebras de linha dentro de campo (o formulário do Google tem as três). */
export function lerCsv(texto: string): string[][] {
  const linhas: string[][] = [];
  let campo = '', linha: string[] = [], aspas = false;
  const t = texto.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (aspas) {
      if (c === '"') { if (t[i + 1] === '"') { campo += '"'; i++; } else aspas = false; } else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ',') { linha.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      linha.push(campo); campo = '';
      linhas.push(linha); linha = [];
    } else campo += c;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

const sem = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const limpo = (s: string | undefined) => (s ?? '').trim();
const corta = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const ou = (s: string, max: number): string | null => (s ? corta(s, max) : null);

/** dd/mm/aaaa (ou dd/mm, com o ano dado) -> AAAA-MM-DD; qualquer outra forma vira nulo. */
export function dataBr(v: string | undefined, anoPadrao?: number): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:\s.*)?$/.exec(limpo(v));
  if (!m) return null;
  const ano = m[3] ? Number(m[3]) : anoPadrao;
  if (!ano) return null;
  const iso = `${ano}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}
const iceDe = (v: string | undefined): number | null => { const n = Number(limpo(v)); return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null; };
const avaliacaoDe = (v: string | undefined): string | null => { const s = sem(limpo(v)); return ['sucesso', 'falha', 'inconclusivo'].includes(s) ? s : null; };
const statusDe = (v: string | undefined, vazio: string): string => {
  const s = sem(limpo(v));
  if (s === 'em execucao' || s === 'execucao') return 'rodando';
  if (s === 'bloqueado') return 'bloqueado';
  if (s === 'concluido') return 'concluido';
  if (s === 'backlog' || s === 'ideia') return 'backlog';
  return vazio;
};
const tipoDe = (v: string | undefined): string => {
  const s = sem(limpo(v));
  if (s === 'ideia') return 'ideia';
  if (s.startsWith('melhoria')) return 'melhoria';
  if (s.startsWith('documentacao')) return 'documentacao';
  return 'experimento';
};
const slug = (s: string) => sem(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
const produtoDe = (titulo: string): string => (/clinic|clínica/i.test(titulo) ? 'clinic' : 'rh');

/** Chaves únicas: dois títulos iguais ganham sufixo, para a carga não perder nenhum. */
function chaves(prefixo: string) {
  const usadas = new Map<string, number>();
  return (titulo: string, extra = '') => {
    const base = `${prefixo}:${slug(titulo) || 'sem-titulo'}${extra ? `:${extra}` : ''}`;
    const n = (usadas.get(base) ?? 0) + 1;
    usadas.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
}
const semVazios = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as T;

/**
 * Formulário "Respostas ao formulário 1": título, datas, responsável, tipo, área, hipótese, ICE (1 a 5), evidências, Controle (status), Avaliação e Aprendizados.
 * Linhas sem título são descartadas (a planilha tem dezenas de linhas de Backlog em branco).
 */
export function mapearFormulario(csv: string): ItemImportado[] {
  const [, ...linhas] = lerCsv(csv);
  const chave = chaves('form');
  const out: ItemImportado[] = [];
  for (const l of linhas) {
    const titulo = limpo(l[1]);
    if (!titulo) continue;
    const tipo = tipoDe(l[5]);
    const inicio = dataBr(l[2]), fimBruto = dataBr(l[3]);
    const fim = inicio && fimBruto && fimBruto < inicio ? null : fimBruto;
    const evid = [limpo(l[11]), limpo(l[12])].filter(Boolean).join('\n');
    const entrada = semVazios({
      titulo: corta(titulo, 160), tipo, status: statusDe(l[15], tipo === 'melhoria' || tipo === 'documentacao' ? 'concluido' : 'backlog'), produto: produtoDe(titulo),
      responsavel: ou(limpo(l[4]), 120), areaImpacto: ou(limpo(l[6]), 80), hipotese: ou(limpo(l[7]), 2000),
      inicio, fim: inicio ? fim : fimBruto, evidencias: ou(evid, 4000), avaliacao: avaliacaoDe(l[16]), aprendizado: ou(limpo(l[17]), 4000),
      iceImpacto: iceDe(l[8]), iceConfianca: iceDe(l[9]), iceFacilidade: iceDe(l[10]),
    }) as ItemImportado['entrada'];
    out.push({ origem: chave(titulo, limpo(l[0]).slice(0, 10).split('/').reverse().join('-')), entrada });
  }
  return out;
}

/**
 * Lista "Experimentos 2025": COD, Categoria, Responsável, Status, Hipótese, I, C, E, SUM, PON, Data Início (sem ano: 2025), Resultado, Aprendizados, Documentação.
 * O título é o início da hipótese (ou a categoria, quando ela já é o título). Linhas sem hipótese nem título são descartadas.
 */
export function mapearLista2025(csv: string): ItemImportado[] {
  const linhas = lerCsv(csv).filter((l) => /^\d+$/.test(limpo(l[0])));
  const chave = chaves('lista2025');
  const out: ItemImportado[] = [];
  for (const l of linhas) {
    const categoria = limpo(l[1]), hipotese = limpo(l[4]);
    const categoriaEhTitulo = categoria.length > 25;
    if (!hipotese && !categoriaEhTitulo) continue;
    const primeira = hipotese.split(/(?<=[.!?])\s|\n/)[0] ?? '';
    const titulo = categoriaEhTitulo ? categoria : corta(primeira, 110) || categoria;
    if (!titulo) continue;
    const status = sem(limpo(l[3]));
    const doc = limpo(l[13]);
    const entrada = semVazios({
      titulo: corta(titulo, 160), tipo: status === 'ideia' ? 'ideia' : 'experimento', status: statusDe(l[3], 'backlog'), produto: produtoDe(titulo),
      responsavel: ou(limpo(l[2]), 120), areaImpacto: categoriaEhTitulo ? null : ou(categoria, 80), hipotese: ou(hipotese, 2000),
      inicio: dataBr(l[10], 2025), avaliacao: avaliacaoDe(l[11]), aprendizado: ou(limpo(l[12]), 4000), evidencias: ou(doc ? `Documentação: ${doc}` : '', 4000),
      iceImpacto: iceDe(l[5]), iceConfianca: iceDe(l[6]), iceFacilidade: iceDe(l[7]),
    }) as ItemImportado['entrada'];
    out.push({ origem: chave(`${limpo(l[0])}-${titulo}`), entrada });
  }
  return out;
}
