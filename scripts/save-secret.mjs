// Guarda um segredo no .env.local pedindo o valor numa tela ESCONDIDA (ele não aparece e não passa pelo chat).
//
//   node scripts/save-secret.mjs PIPEDRIVE_API_TOKEN
//
// Rode num PowerShell seu (precisa de teclado). Cole o valor, aperte Enter. Só o tamanho é mostrado.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const name = process.argv[2] ?? '';
if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(name)) throw new Error('Uso: node scripts/save-secret.mjs NOME_DA_VARIAVEL (maiúsculas e _)');
if (!process.stdin.isTTY) {
  console.error('Este comando precisa de um terminal com teclado. Abra o PowerShell e rode lá.');
  process.exit(1);
}

process.stdout.write(`Cole o valor de ${name} e aperte Enter (nada aparece na tela): `);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

const value = await new Promise((resolve) => {
  let buf = '';
  process.stdin.on('data', (chunk) => {
    for (const ch of chunk) {
      if (ch === '\u0003') {
        process.stdout.write('\nCancelado.\n');
        process.exit(130);
      }
      if (ch === '\r' || ch === '\n') return resolve(buf);
      if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
      else buf += ch;
    }
  });
});
process.stdin.setRawMode(false);
process.stdin.pause();
process.stdout.write('\n');

const v = String(value).trim();
if (!v || /\s/.test(v)) {
  console.error('Valor vazio ou com espaços: nada foi gravado.');
  process.exit(1);
}

const ENV = '.env.local';
let text = existsSync(ENV) ? readFileSync(ENV, 'utf8') : '';
const re = new RegExp(`^${name}=.*$`, 'm');
text = re.test(text) ? text.replace(re, `${name}=${v}`) : `${text.replace(/\s*$/, '\n')}${name}=${v}\n`;
writeFileSync(ENV, text);
console.log(`${name} gravada no .env.local (${v.length} caracteres). O valor não foi exibido.`);
