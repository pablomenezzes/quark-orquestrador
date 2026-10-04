// Codifica a senha da SUPABASE_DB_URL no .env.local (percent-encoding), sem imprimir segredos.
// Idempotente: se a senha já estiver codificada, não muda nada.
import { readFileSync, writeFileSync } from 'node:fs';

const file = '.env.local';
const text = readFileSync(file, 'utf8');
const re = /^(SUPABASE_DB_URL=)(postgres(?:ql)?:\/\/)(.*)$/m;
const m = re.exec(text);
if (!m) throw new Error('SUPABASE_DB_URL não encontrada ou fora do formato postgresql://');

const [, key, scheme, rest] = m;
const line = rest.replace(/\r$/, '');
const at = line.lastIndexOf('@');
const cred = line.slice(0, at);
const hostPart = line.slice(at + 1);
const colon = cred.indexOf(':');
const user = cred.slice(0, colon);
const pass = cred.slice(colon + 1);

// Se já tem %XX, assume codificada.
if (/%[0-9A-Fa-f]{2}/.test(pass)) {
  console.log('Senha já parece codificada. Nada alterado.');
  process.exit(0);
}
const encoded = encodeURIComponent(pass);
if (encoded === pass) {
  console.log('Senha não tem caracteres especiais. Nada alterado.');
  process.exit(0);
}
writeFileSync(file, text.replace(re, `${key}${scheme}${user}:${encoded}@${hostPart}`));
console.log(`Senha codificada (${pass.length} → ${encoded.length} caracteres). Arquivo atualizado.`);
