// Guarda no .env.local as credenciais da Meta (Marketing API), sem mostrar nada na tela.
//   node scripts/guardar-token-meta.mjs --conta-rh 287516640670266 --conta-clinic 1390544329013540   -> so os IDs das contas (nao sao secretos)
//   node scripts/guardar-token-meta.mjs "C:\caminho\token.txt" [--apagar]                              -> o token (secreto), lido de um arquivo de texto
// O token e apenas gravado: nunca e impresso, e o arquivo de texto pode ser apagado pelo proprio script (--apagar).
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';

const args = process.argv.slice(2);
const pegar = (nome) => {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
};
const arquivo = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--conta'));
const novos = {};

for (const [flag, chave] of [['--conta-rh', 'META_AD_ACCOUNT_RH'], ['--conta-clinic', 'META_AD_ACCOUNT_CLINIC']]) {
  const v = pegar(flag);
  if (v === undefined) continue;
  const id = v.replace(/^act_/, '');
  if (!/^\d{6,20}$/.test(id)) {
    console.error(`${flag}: o ID da conta de anuncios e so numeros (com ou sem "act_").`);
    process.exit(1);
  }
  novos[chave] = id;
}
if (arquivo) {
  if (!existsSync(arquivo)) {
    console.error('Arquivo do token nao encontrado.');
    process.exit(1);
  }
  const token = readFileSync(arquivo, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{40,600}$/.test(token)) {
    console.error('Esse arquivo nao parece conter um token da Meta (uma unica linha, sem espacos, geralmente comecando com EAA).');
    process.exit(1);
  }
  novos.META_ACCESS_TOKEN = token;
}
if (!Object.keys(novos).length) {
  console.error('Nada para guardar. Use --conta-rh, --conta-clinic e/ou o caminho do arquivo do token.');
  process.exit(1);
}

const destino = new URL('../.env.local', import.meta.url);
const linhas = existsSync(destino) ? readFileSync(destino, 'utf8').split(/\r?\n/) : [];
for (const [k, v] of Object.entries(novos)) {
  const i = linhas.findIndex((l) => l.startsWith(`${k}=`));
  if (i >= 0) linhas[i] = `${k}=${v}`;
  else linhas.push(`${k}=${v}`);
}
writeFileSync(destino, linhas.filter((l, i, a) => l !== '' || i < a.length - 1).join('\n') + '\n');

const nomes = Object.keys(novos);
console.log(`Guardado no .env.local: ${nomes.join(', ')}${nomes.includes('META_ACCESS_TOKEN') ? ' (o token nao e exibido)' : ''}.`);
for (const k of nomes) if (k !== 'META_ACCESS_TOKEN') console.log(`  ${k} = ${novos[k]} (ID de conta, nao e segredo)`);
if (arquivo && args.includes('--apagar')) {
  unlinkSync(arquivo);
  console.log('Arquivo do token apagado.');
} else if (arquivo) {
  console.log('Agora apague o arquivo de texto com o token (ou rode de novo com --apagar).');
}
