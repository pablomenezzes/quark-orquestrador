import { createServer } from 'node:net';
import { assertSafeDbTarget } from '../../src/db/guard.js';

/**
 * Checagens de partida do Studio. Cada falha vira uma explicação em português com o que fazer.
 * Nunca imprime senha, token nem a URL do banco.
 */

export type CheckStatus = 'ok' | 'fail' | 'skip';
export type Check = { id: 'node' | 'env_file' | 'env_vars' | 'db' | 'port'; title: string; status: CheckStatus; message: string; fix?: string };
export type PreflightResult = { ok: boolean; checks: Check[]; env: Record<string, string> };

export type PreflightDeps = {
  envPath: string;
  /** Conteúdo do .env.local, ou null se o arquivo não existe. */
  readEnvFile: () => string | null;
  nodeVersion: string;
  port: number;
  connectDb: (url: string) => Promise<void>;
  isPortFree: (port: number) => Promise<boolean>;
  tokenVar: string;
  sourceSlug: string;
};

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0]!)) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

const scrub = (s: string) =>
  s
    .replace(/postgres(ql)?:\/\/\S+/gi, '<url>')
    .replace(/:[^\s:@/]+@/g, ':***@')
    .slice(0, 200);

export function explainDbError(err: unknown): { message: string; fix: string } {
  const e = (err ?? {}) as { code?: string; message?: string };
  const code = e.code ?? '';
  const msg = e.message ?? String(err);
  if (code === '28P01' || /password authentication failed/i.test(msg)) {
    return {
      message: 'O banco recusou a senha.',
      fix: 'Confira a senha dentro da SUPABASE_DB_URL no .env.local. Se não lembrar: Supabase → Project Settings → Database → "Reset database password", e cole a nova. Se ela tiver caracteres especiais (? , : @ #), rode depois: node scripts/encode-db-url.mjs',
    };
  }
  if (code === 'ERR_INVALID_URL' || /invalid url/i.test(msg)) {
    return {
      message: 'A SUPABASE_DB_URL não é um endereço válido (quase sempre é a senha com caracteres especiais, como ? , : @ #).',
      fix: 'Rode: node scripts/encode-db-url.mjs (ele codifica a senha sem alterá-la) e tente de novo.',
    };
  }
  if (/tenant or user not found/i.test(msg)) {
    return {
      message: 'O Supabase não reconheceu o usuário ou o projeto da URL (o ref está errado).',
      fix: 'No Supabase, clique em "Connect", copie de novo a "Session pooler" (porta 5432) e cole em SUPABASE_DB_URL.',
    };
  }
  if (code === 'ENOTFOUND') {
    return {
      message: 'Não encontrei o endereço do banco (host). Pode ser falta de internet ou endereço errado na URL.',
      fix: 'Verifique a internet. Se estiver ok, copie de novo a "Session pooler" em Connect no Supabase.',
    };
  }
  if (code === 'ETIMEDOUT' || /timeout|timed out/i.test(msg)) {
    return {
      message: 'A conexão com o banco demorou demais (tempo esgotado).',
      fix: 'Verifique a internet, VPN ou firewall e tente de novo. O projeto gratuito do Supabase também pode estar pausado: abra o painel e clique em "Restore" se aparecer.',
    };
  }
  if (code === 'ECONNREFUSED') {
    return { message: 'O servidor recusou a conexão (porta ou endereço errados).', fix: 'Use a "Session pooler" com porta 5432 (Connect → Connection string).' };
  }
  if (code === '3D000') {
    return { message: 'O nome do banco na URL não existe.', fix: 'O final da URL deve ser /postgres.' };
  }
  return { message: `Não consegui conectar ao banco: ${scrub(msg)}`, fix: 'Rode "node scripts/check-db.mjs" para um diagnóstico mais detalhado.' };
}

function versionOk(v: string): boolean {
  const [maj = 0, min = 0] = v.split('.').map(Number);
  return maj > 20 || (maj === 20 && min >= 12);
}

export async function runPreflight(d: PreflightDeps): Promise<PreflightResult> {
  const checks: Check[] = [];
  let env: Record<string, string> = {};

  // 1. Node
  checks.push(
    versionOk(d.nodeVersion)
      ? { id: 'node', title: 'Node.js', status: 'ok', message: `Node ${d.nodeVersion}` }
      : {
          id: 'node',
          title: 'Node.js',
          status: 'fail',
          message: `Node ${d.nodeVersion} é antigo demais (precisa da versão 20.12 ou mais nova).`,
          fix: 'Instale o Node 22 ou 24 em https://nodejs.org e abra um PowerShell novo.',
        },
  );

  // 2. .env.local
  const text = d.readEnvFile();
  if (text === null) {
    checks.push({
      id: 'env_file',
      title: 'Arquivo .env.local',
      status: 'fail',
      message: `O arquivo .env.local não existe (esperado em ${d.envPath}).`,
      fix: 'Copie o modelo e preencha: Copy-Item .env.example .env.local (os campos estão explicados dentro do arquivo).',
    });
  } else {
    env = parseEnv(text);
    checks.push({ id: 'env_file', title: 'Arquivo .env.local', status: 'ok', message: 'Encontrado.' });
  }

  // 3. Variáveis
  if (text === null) {
    checks.push({ id: 'env_vars', title: 'Variáveis do .env.local', status: 'skip', message: 'Pulado: depende do arquivo .env.local.' });
  } else {
    const missing: string[] = [];
    const problems: string[] = [];
    const fixes: string[] = [];
    const url = env.SUPABASE_DB_URL ?? '';
    const ref = env.SUPABASE_PROJECT_REF ?? '';

    if (!url) missing.push('SUPABASE_DB_URL');
    if (!ref) missing.push('SUPABASE_PROJECT_REF');
    if (!env[d.tokenVar]) missing.push(d.tokenVar);
    if (missing.length) {
      problems.push(`Faltam no .env.local: ${missing.join(', ')}.`);
      if (missing.includes('SUPABASE_DB_URL')) fixes.push('SUPABASE_DB_URL: no Supabase, botão "Connect" → "Session pooler" (porta 5432); troque [YOUR-PASSWORD] pela senha do banco.');
      if (missing.includes('SUPABASE_PROJECT_REF')) fixes.push('SUPABASE_PROJECT_REF: Project Settings → General → Reference ID.');
      if (missing.includes(d.tokenVar)) fixes.push(`${d.tokenVar}: token da fonte "${d.sourceSlug}". Ele só aparece uma vez, no registro da fonte; sem ele, peça ajuda para registrar uma fonte nova.`);
    }
    if (url) {
      if (url.includes('[YOUR-PASSWORD]')) {
        problems.push('A SUPABASE_DB_URL ainda tem o texto [YOUR-PASSWORD].');
        fixes.push('Troque [YOUR-PASSWORD] (com os colchetes) pela senha do banco.');
      } else {
        let parsed: URL | null = null;
        try {
          parsed = new URL(url);
          if (!parsed.hostname || !parsed.password) parsed = null;
        } catch {
          parsed = null;
        }
        if (!parsed) {
          problems.push('A SUPABASE_DB_URL não está num formato válido (quase sempre é a senha com caracteres especiais).');
          fixes.push('Rode: node scripts/encode-db-url.mjs');
        } else if (ref) {
          try {
            assertSafeDbTarget({ target: url, expectedRef: ref });
          } catch (e) {
            const m = e instanceof Error ? e.message : '';
            problems.push(/antigo|bloquead/i.test(m) ? 'A URL ou o ref é de um projeto antigo, que não existe mais.' : 'A SUPABASE_DB_URL não contém o ref do projeto (SUPABASE_PROJECT_REF): parece ser de outro projeto.');
            fixes.push('Copie de novo a "Session pooler" em Connect, no projeto "Orquestrador CRM Quark", e confira o ref em Project Settings → General.');
          }
        }
      }
    }
    checks.push(
      problems.length
        ? { id: 'env_vars', title: 'Variáveis do .env.local', status: 'fail', message: problems.join(' '), fix: fixes.join(' ') }
        : { id: 'env_vars', title: 'Variáveis do .env.local', status: 'ok', message: 'Todas preenchidas.' },
    );
  }

  // 4. Banco
  const varsOk = checks.find((c) => c.id === 'env_vars')!.status === 'ok';
  if (!varsOk) {
    checks.push({ id: 'db', title: 'Conexão com o banco', status: 'skip', message: 'Pulado: depende das variáveis acima.' });
  } else {
    try {
      await d.connectDb(env.SUPABASE_DB_URL!);
      checks.push({ id: 'db', title: 'Conexão com o banco', status: 'ok', message: 'Conectado.' });
    } catch (e) {
      const x = explainDbError(e);
      checks.push({ id: 'db', title: 'Conexão com o banco', status: 'fail', message: x.message, fix: x.fix });
    }
  }

  // 5. Porta
  if (await d.isPortFree(d.port)) {
    checks.push({ id: 'port', title: 'Porta do Studio', status: 'ok', message: `Porta ${d.port} livre.` });
  } else {
    checks.push({
      id: 'port',
      title: 'Porta do Studio',
      status: 'fail',
      message: `A porta ${d.port} já está em uso (provavelmente o Studio aberto em outra janela do PowerShell).`,
      fix: `Feche a outra janela do Studio. Para ver quem usa a porta: Get-NetTCPConnection -LocalPort ${d.port} | Select-Object OwningProcess (depois: Stop-Process -Id <número>). Ou use outra porta: $env:STUDIO_PORT = 4311; npm run studio`,
    });
  }

  return { ok: checks.every((c) => c.status !== 'fail'), checks, env };
}

export function formatReport(r: PreflightResult): string {
  const lines = ['Verificando o ambiente do Quark Studio…', ''];
  for (const c of r.checks) {
    const icon = c.status === 'ok' ? '✔' : c.status === 'fail' ? '✖' : '–';
    lines.push(` ${icon} ${c.title}: ${c.message}`);
    if (c.status === 'fail' && c.fix) lines.push(`     Como resolver: ${c.fix}`);
  }
  const fails = r.checks.filter((c) => c.status === 'fail').length;
  lines.push('');
  lines.push(fails ? `${fails} problema(s) encontrado(s). O Studio não foi iniciado. Corrija e rode de novo: npm run studio` : 'Tudo certo.');
  return lines.join('\n');
}

/** Teste real de porta: tenta escutar em 127.0.0.1 e solta em seguida. */
export function checkPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
