// Confere um backup (.dump) contra a nuvem SEM precisar de um banco local: le o conteudo do arquivo, conta as linhas de cada tabela
// e compara com a contagem atual do Supabase.
//   node scripts/verificar-backup.mjs backups/nuvem-AAAAMMDD-HHMM.dump
// Aceita pequena diferenca (dados novos que chegaram enquanto o backup rodava): ate 10 linhas ou 0,5% por tabela.
// Sai com codigo 0 se tudo bate, 2 se houver divergencia relevante. So leitura.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const arquivo = process.argv[2];
if (!arquivo || !existsSync(arquivo)) {
  console.error('Uso: node scripts/verificar-backup.mjs <arquivo.dump>');
  process.exit(1);
}
const PG_BINS = ['C:\\PostgreSQL17\\bin\\pg_restore.exe', 'pg_restore'];
const pgRestore = PG_BINS.find((b) => b === 'pg_restore' || existsSync(b)) ?? 'pg_restore';

/** Conta as linhas de cada COPY do backup (formato de dados do pg_dump), em fluxo: nao carrega o arquivo na memoria. */
export async function contarNoBackup(file) {
  const p = spawn(pgRestore, ['--data-only', '-f', '-', file], { stdio: ['ignore', 'pipe', 'inherit'] });
  const rl = createInterface({ input: p.stdout, crlfDelay: Infinity });
  const out = {};
  let atual = null;
  for await (const linha of rl) {
    if (atual === null) {
      const m = /^COPY ([a-z_]+\.[a-z_]+) \(/.exec(linha);
      if (m) {
        atual = m[1];
        out[atual] = 0;
      }
    } else if (linha === '\\.') atual = null;
    else out[atual]++;
  }
  const code = await new Promise((r) => p.on('close', r));
  if (code !== 0) throw new Error(`pg_restore falhou ao ler o backup (codigo ${code}).`);
  return out;
}

// --so-contar: so imprime, em JSON, as linhas de cada tabela dentro do arquivo (usado por restaurar-backup.ps1 para conferir o destino)
if (process.argv.includes('--so-contar')) {
  console.log(JSON.stringify(await contarNoBackup(arquivo)));
  process.exit(0);
}

const r = spawnSync(process.execPath, ['scripts/contagens.mjs', '--nuvem'], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error(r.stderr || 'Nao consegui contar as linhas da nuvem.');
  process.exit(1);
}
const nuvem = JSON.parse(r.stdout);
const backup = await contarNoBackup(arquivo);

let ruins = 0;
let obs = 0;
const linhas = [];
for (const [tabela, n] of Object.entries(nuvem)) {
  if (tabela.startsWith('_') || n === null) continue; // tabela que ainda nao existe na nuvem
  const b = backup[tabela] ?? 0;
  const dif = n - b;
  const tol = Math.max(10, Math.ceil(n * 0.005));
  let marca = 'ok';
  if (dif !== 0) {
    if (dif > 0 && dif <= tol) {
      marca = `ok (+${dif} chegaram durante o backup)`;
      obs++;
    } else {
      marca = `DIVERGE (nuvem ${n}, backup ${b})`;
      ruins++;
    }
  }
  linhas.push(`${tabela.padEnd(28)} backup ${String(b).padStart(8)}  nuvem ${String(n).padStart(8)}  ${marca}`);
}
console.log(linhas.join('\n'));
console.log(`\n${ruins === 0 ? 'BACKUP CONFERIDO' : `ATENCAO: ${ruins} tabela(s) divergem`}: ${linhas.length} tabelas comparadas${obs ? `, ${obs} com dados novos chegando durante o backup` : ''}.`);
process.exit(ruins === 0 ? 0 : 2);
