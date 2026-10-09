// Guarda a chave da conta de servico do Google (GA4) no .env.local, sem mostrar nada na tela.
// Uso: node scripts/guardar-chave-google.mjs "C:\caminho\chave-baixada.json" [--ga4-property 123456789]
// Depois de guardar, apague o arquivo .json baixado (o script avisa; so apaga se voce passar --apagar).
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';

const args = process.argv.slice(2);
const arquivo = args.find((a) => !a.startsWith('--'));
const pegar = (nome) => {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!arquivo || !existsSync(arquivo)) {
  console.error('Informe o caminho do arquivo .json baixado do Google.');
  process.exit(1);
}
const chave = JSON.parse(readFileSync(arquivo, 'utf8'));
if (chave.type !== 'service_account' || !chave.client_email || !chave.private_key) {
  console.error('Esse arquivo nao e uma chave de conta de servico do Google.');
  process.exit(1);
}

const novos = {
  GOOGLE_SA_CLIENT_EMAIL: chave.client_email,
  GOOGLE_SA_PRIVATE_KEY: JSON.stringify(chave.private_key), // \n escapado, uma linha so
};
const prop = pegar('--ga4-property');
if (prop) {
  if (!/^\d{5,15}$/.test(prop)) {
    console.error('O ID da propriedade do GA4 e so numeros.');
    process.exit(1);
  }
  novos.GA4_PROPERTY_ID = prop;
}

const destino = new URL('../.env.local', import.meta.url);
let linhas = existsSync(destino) ? readFileSync(destino, 'utf8').split(/\r?\n/) : [];
for (const [k, v] of Object.entries(novos)) {
  const i = linhas.findIndex((l) => l.startsWith(`${k}=`));
  if (i >= 0) linhas[i] = `${k}=${v}`;
  else linhas.push(`${k}=${v}`);
}
writeFileSync(destino, linhas.filter((l, i, a) => l !== '' || i < a.length - 1).join('\n') + '\n');

console.log(`Guardado no .env.local: ${Object.keys(novos).join(', ')} (valores nao exibidos).`);
console.log(`Conta de servico (e-mail, nao e segredo): ${chave.client_email}`);
if (args.includes('--apagar')) {
  unlinkSync(arquivo);
  console.log('Arquivo .json baixado apagado.');
} else {
  console.log('Agora apague o arquivo .json baixado (ou rode de novo com --apagar).');
}
