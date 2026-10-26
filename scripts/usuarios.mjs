// Cria o primeiro admin (e lista usuários) do Quark Dados publicado, direto no Supabase Auth. Depois disso o admin gerencia o time pela página "Usuários".
//
//   node scripts/usuarios.mjs --listar
//   node scripts/usuarios.mjs --criar pessoa@empresa.com --papel admin --nome "Nome"     (a senha é pedida no terminal, sem aparecer na tela)
//
// Usa SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY do .env.local. Nada secreto é impresso.
import { createInterface } from 'node:readline';

process.loadEnvFile('.env.local');
const url = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
const chave = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!url || !chave) throw new Error('Faltam SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env.local.');
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const H = { apikey: chave, authorization: `Bearer ${chave}`, 'content-type': 'application/json' };

function perguntarSenha(texto) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const escrever = rl._writeToOutput;
    rl._writeToOutput = (s) => { if (s.includes(texto)) escrever.call(rl, s); }; // não ecoa o que se digita
    rl.question(texto, (r) => { rl.close(); process.stdout.write('\n'); resolve(r); });
  });
}

if (argv.includes('--listar')) {
  const r = await fetch(`${url}/auth/v1/admin/users?page=1&per_page=200`, { headers: H });
  if (!r.ok) throw new Error(`Supabase Auth respondeu ${r.status}.`);
  for (const u of (await r.json()).users ?? []) console.log(`${u.email}\t${u.app_metadata?.quark_papel ?? '(sem papel)'}\t${u.user_metadata?.nome ?? ''}`);
} else if (arg('--criar')) {
  const papel = arg('--papel') ?? 'admin';
  if (!['admin', 'editor'].includes(papel)) throw new Error('--papel deve ser admin ou editor.');
  const senha = await perguntarSenha('Senha (mín. 10, letras e números): ');
  if (senha.length < 10 || senha.length > 72 || !/[A-Za-z]/.test(senha) || !/\d/.test(senha)) throw new Error('A senha precisa ter 10 a 72 caracteres, com letras e números.');
  const r = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ email: arg('--criar').trim().toLowerCase(), password: senha, email_confirm: true, app_metadata: { quark_papel: papel }, user_metadata: { nome: arg('--nome') ?? null } }),
  });
  if (!r.ok) throw new Error(r.status === 422 ? 'Já existe um usuário com esse e-mail.' : `Supabase Auth respondeu ${r.status}.`);
  console.log(`Usuário ${arg('--criar')} criado como ${papel}.`);
} else {
  console.log('Use --listar ou --criar <e-mail> --papel admin|editor [--nome "Nome"].');
}
