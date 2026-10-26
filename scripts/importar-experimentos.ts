// Carga única das planilhas antigas "Growth e Experimentos" para mkt.experimentos (migration 0023 precisa estar aplicada).
//
//   npx tsx scripts/importar-experimentos.ts --form "<respostas.csv>" --lista "<experimentos-2025.csv>"           -> simulação (não grava)
//   npx tsx scripts/importar-experimentos.ts --form "<respostas.csv>" --lista "<experimentos-2025.csv>" --apply   -> grava (papel orq_panel)
//
// Pode rodar de novo: cada linha tem uma chave de origem e o que já foi importado é ignorado.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { validarEntrada } from '../studio/lib/experimentos.js';
import { mapearFormulario, mapearLista2025, type ItemImportado } from './lib/experimentos-planilhas.js';

const argv = process.argv.slice(2);
const arg = (nome: string) => { const i = argv.indexOf(nome); return i >= 0 ? argv[i + 1] : undefined; };
const apply = argv.includes('--apply');
const form = arg('--form'), lista = arg('--lista');
if (!form && !lista) throw new Error('Informe --form "<csv>" e/ou --lista "<csv>".');

const itens: ItemImportado[] = [
  ...(form ? mapearFormulario(readFileSync(form, 'utf8')) : []),
  ...(lista ? mapearLista2025(readFileSync(lista, 'utf8')) : []),
];
for (const it of itens) validarEntrada(it.entrada, 'criar'); // a carga obedece às mesmas regras do cadastro

const por = (campo: 'status' | 'tipo') => Object.entries(itens.reduce<Record<string, number>>((a, i) => { const k = String(i.entrada[campo]); a[k] = (a[k] ?? 0) + 1; return a; }, {})).map(([k, n]) => `${k}: ${n}`).join(' · ');
console.log(`${itens.length} linhas com título nas planilhas.`);
console.log(`Por status: ${por('status')}`);
console.log(`Por tipo: ${por('tipo')}`);
for (const it of itens) console.log(` - [${it.entrada.status}] ${it.entrada.titulo}${it.entrada.inicio ? ` (${it.entrada.inicio})` : ''}`);

if (!apply) {
  console.log('\n(simulação) Nada foi gravado. Rode com --apply depois de conferir a lista.');
  process.exit(0);
}

process.loadEnvFile('.env.local');
const url = process.env.PANEL_DB_URL ?? '';
if (!url) throw new Error('Falta PANEL_DB_URL no .env.local (node scripts/set-role-password.mjs --role orq_panel --apply).');
const pool = new pg.Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
try {
  if (!(await pool.query(`select to_regclass('mkt.experimentos') is not null as ok`)).rows[0].ok) throw new Error('A migration 0023 (mkt.experimentos) ainda não foi aplicada.');
  const COL: Record<string, string> = {
    titulo: 'titulo', tipo: 'tipo', status: 'status', produto: 'produto', responsavel: 'responsavel', areaImpacto: 'area_impacto', hipotese: 'hipotese', inicio: 'inicio', fim: 'fim',
    evidencias: 'evidencias', avaliacao: 'avaliacao', aprendizado: 'aprendizado', iceImpacto: 'ice_impacto', iceConfianca: 'ice_confianca', iceFacilidade: 'ice_facilidade',
  };
  let novos = 0;
  for (const it of itens) {
    const campos = Object.keys(it.entrada).filter((k) => COL[k]);
    const r = await pool.query(
      `insert into mkt.experimentos (${campos.map((k) => COL[k]).join(', ')}, origem) values (${campos.map((_, i) => `$${i + 1}`).join(', ')}, $${campos.length + 1}) on conflict (origem) do nothing`,
      [...campos.map((k) => (it.entrada as unknown as Record<string, unknown>)[k]), it.origem],
    );
    novos += r.rowCount ?? 0;
  }
  console.log(`\nGravados ${novos} novos; ${itens.length - novos} já existiam.`);
} finally { await pool.end(); }
