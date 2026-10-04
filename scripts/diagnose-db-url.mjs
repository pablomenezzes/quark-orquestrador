// Diagnóstico ESTRUTURAL da SUPABASE_DB_URL. Nunca imprime a senha nem a URL.
try {
  process.loadEnvFile('.env.local');
} catch {
  /* sem .env.local */
}
const url = process.env.SUPABASE_DB_URL ?? '';
const m = /^(postgres(?:ql)?):\/\/(.*)$/.exec(url);
console.log('Começa com postgresql:// ou postgres://:', !!m);
console.log('Espaços/quebras na linha:', /\s/.test(url));
console.log('Aspas na linha:', /["']/.test(url));
console.log('Colchetes na linha:', /[[\]]/.test(url));
if (!m) process.exit(1);
const rest = m[2];
const at = rest.lastIndexOf('@');
console.log('Quantidade de "@":', (rest.match(/@/g) ?? []).length, '(esperado: 1, ou mais se a senha tiver @)');
if (at < 0) process.exit(1);
const cred = rest.slice(0, at);
const host = rest.slice(at + 1);
const colon = cred.indexOf(':');
const user = colon >= 0 ? cred.slice(0, colon) : cred;
const pass = colon >= 0 ? cred.slice(colon + 1) : '';
console.log('Usuário:', user);
console.log('Host/porta/banco:', host);
console.log('Senha: tamanho', pass.length);
const specials = [...new Set(pass.match(/[^A-Za-z0-9\-._~]/g) ?? [])];
console.log('Senha: caracteres que precisam de codificação na URL:', specials.length ? specials.join(' ') : '(nenhum)');
