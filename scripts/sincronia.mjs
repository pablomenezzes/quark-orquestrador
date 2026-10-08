// Verifica, em um relatorio so, se NUVEM (Supabase), GITHUB e este COMPUTADOR estao em sincronia e sem conflito.
//   npm run sincronia
// So leitura (faz apenas "git fetch" e consultas de leitura). Nada secreto e impresso. Sai com codigo 1 se houver algo a corrigir.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* segue com o ambiente */
}

const itens = [];
const marca = { ok: 'OK ', aviso: 'ATENCAO', erro: 'PROBLEMA' };
const add = (nivel, titulo, detalhe, fazer) => itens.push({ nivel, titulo, detalhe, fazer });
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

// 1) GitHub x computador
try {
  try {
    git('fetch', 'origin', '--quiet');
  } catch {
    add('aviso', 'GitHub', 'Nao consegui falar com o GitHub agora (sem internet?). A comparacao abaixo usa o que o computador ja sabia.', 'Rode de novo com internet.');
  }
  const sujo = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).split('\n').filter(Boolean); // sem trim: a 1a coluna do porcelain pode ser espaco
  const [ahead, behind] = git('rev-list', '--left-right', '--count', 'HEAD...origin/main').split(/\s+/).map(Number);
  if (behind > 0) add('erro', 'Codigo', `O GitHub tem ${behind} commit(s) que este computador nao tem (outra maquina ou alteracao direta).`, 'Rode: git pull --rebase  (antes de mexer em qualquer coisa, para nao haver conflito).');
  else if (ahead > 0) add('aviso', 'Codigo', `Este computador tem ${ahead} commit(s) que ainda nao foram para o GitHub.`, 'Rode: git push origin main');
  else add('ok', 'Codigo', 'Este computador e o GitHub estao iguais (main).');
  if (sujo.length) add('aviso', 'Arquivos', `${sujo.length} arquivo(s) alterado(s) e ainda nao salvo(s) no git (ex.: ${sujo.slice(0, 3).map((s) => s.slice(3)).join(', ')}).`, 'Peca para commitar e subir, ou descarte se for lixo.');
  else add('ok', 'Arquivos', 'Nada pendente de commit.');
} catch (e) {
  add('erro', 'Git', `Nao consegui ler o estado do git: ${e.message.split('\n')[0]}`, 'Confira se esta na pasta do projeto.');
}

// 2) Migrations: arquivos x nuvem
let nuvemOk = false;
const url = process.env.SUPABASE_DB_URL ?? '';
const ref = process.env.SUPABASE_PROJECT_REF ?? '';
try {
  if (!url || !ref || !url.includes(ref)) throw new Error('SUPABASE_DB_URL ausente ou nao bate com SUPABASE_PROJECT_REF no .env.local.');
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const aplicadas = new Set((await c.query('select version from supabase_migrations.schema_migrations')).rows.map((r) => String(r.version)));
    const arquivos = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).map((f) => f.split('_')[0]);
    const pendentes = arquivos.filter((v) => !aplicadas.has(v));
    const semArquivo = [...aplicadas].filter((v) => !arquivos.includes(v));
    nuvemOk = true;
    if (semArquivo.length) add('erro', 'Banco x codigo', `A nuvem tem migration(s) sem arquivo no projeto: ${semArquivo.join(', ')}. Alguem mexeu no banco por fora do codigo.`, 'Nao aplique nada ate entender: peca ao Claude para investigar.');
    else if (pendentes.length) add('aviso', 'Banco x codigo', `Migration(s) escrita(s) e ainda NAO aplicada(s) na nuvem: ${pendentes.join(', ')} (aguardam a sua confirmacao do SQL).`, 'Confirme o SQL para o Claude aplicar (com backup antes).');
    else add('ok', 'Banco x codigo', `Todas as ${arquivos.length} migrations do projeto estao aplicadas na nuvem, e a nuvem nao tem nenhuma a mais.`);
  } finally {
    await c.end();
  }
} catch (e) {
  add('erro', 'Banco x codigo', `Nao consegui consultar a nuvem: ${String(e.message).replace(/postgres(ql)?:\/\/\S+/gi, '<url>')}`, 'Confira a internet e o .env.local.');
}

// 3) Backup local
try {
  if (!existsSync('backups/ULTIMO_BACKUP.json')) throw new Error('semb');
  const b = JSON.parse(readFileSync('backups/ULTIMO_BACKUP.json', 'utf8').replace(/^﻿/, ''));
  const horas = (Date.now() - new Date(b.feito_em).getTime()) / 3600000;
  const idade = horas < 1 ? 'menos de 1 hora' : horas < 48 ? `${Math.floor(horas)} h` : `${Math.floor(horas / 24)} dias`;
  if (!b.conferido_com_a_nuvem) add('erro', 'Backup local', `O ultimo backup (${b.arquivo}) NAO bateu com a nuvem: ${(b.divergencias ?? []).join('; ') || b.resumo}`, 'Rode: npm run backup  e me avise se persistir.');
  else if (horas > 26) add('aviso', 'Backup local', `O ultimo backup conferido tem ${idade} (${b.arquivo}).`, 'Rode: npm run backup  (e confira se a tarefa diaria esta ativa).');
  else add('ok', 'Backup local', `Ultimo backup conferido ha ${idade}: ${b.arquivo} (${b.tamanho_mb} MB). ${b.resumo}`);
} catch {
  add('erro', 'Backup local', 'Ainda nao ha nenhum backup conferido.', 'Rode: npm run backup');
}

// 4) Tarefa diaria
const t = spawnSync('schtasks', ['/query', '/tn', 'QuarkDados-BackupLocal'], { encoding: 'utf8' });
if (t.status === 0) add('ok', 'Backup diario', 'A tarefa do Windows "QuarkDados-BackupLocal" existe (todo dia as 03:00).');
else add('aviso', 'Backup diario', 'A tarefa diaria de backup nao esta criada neste computador.', 'Rode: powershell -File scripts/agendar-backup.ps1');

// 5) Segredos fora do git
try {
  const ign = spawnSync('git', ['check-ignore', '-q', '.env.local']).status === 0;
  const rastreados = git('ls-files').split('\n').filter((f) => /^\.env\.local$|^backups\//.test(f));
  if (ign && !rastreados.length) add('ok', 'Segredos', '.env.local e a pasta backups ficam so neste computador (nao vao para o GitHub).');
  else add('erro', 'Segredos', `Segredo ou backup no git: ${rastreados.join(', ') || '.env.local nao esta ignorado'}.`, 'Pare e me avise: precisa tirar do historico e trocar as senhas.');
} catch {
  /* sem git: ja avisado acima */
}

console.log('\nSINCRONIA: nuvem (Supabase) x GitHub x este computador\n');
for (const i of itens) {
  console.log(`[${marca[i.nivel]}] ${i.titulo}: ${i.detalhe}`);
  if (i.fazer) console.log(`           -> ${i.fazer}`);
}
const ruim = itens.filter((i) => i.nivel !== 'ok').length;
console.log(`\n${ruim === 0 ? 'TUDO EM SINCRONIA: sem conflitos.' : `${ruim} ponto(s) pedem atencao (veja acima).`}`);
void nuvemOk;
process.exit(ruim === 0 ? 0 : 1);
