import { describe, it, expect } from 'vitest';
import { parseEnv, runPreflight, explainDbError, formatReport, type PreflightDeps } from '../studio/lib/preflight';

const REF = 'avxuerlobmrfsretwuwd';
const SECRET = 'S3nh@Sup3rSecreta!';
const GOOD_URL = `postgresql://postgres.${REF}:abc123@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`;
const GOOD_ENV = `
# comentário
SUPABASE_URL=https://${REF}.supabase.co
SUPABASE_PROJECT_REF=${REF}
SUPABASE_DB_URL=${GOOD_URL}
SOURCE_TOKEN_LP_VERCEL=tok_${'x'.repeat(40)}
SHADOW_MODE=true
`;

const deps = (over: Partial<PreflightDeps> = {}): PreflightDeps => ({
  envPath: 'C:\\proj\\.env.local',
  readEnvFile: () => GOOD_ENV,
  nodeVersion: '24.19.0',
  port: 4310,
  connectDb: async () => {},
  isPortFree: async () => true,
  tokenVar: 'SOURCE_TOKEN_LP_VERCEL',
  sourceSlug: 'lp-vercel-rh-teste',
  ...over,
});

const failIds = (r: { checks: Array<{ id: string; status: string }> }) => r.checks.filter((c) => c.status === 'fail').map((c) => c.id);

describe('parseEnv', () => {
  it('lê chaves, ignora comentários e linhas vazias, remove aspas', () => {
    const e = parseEnv('# c\nA=1\n\nB="dois"\n  C = três \nD=\nINVALIDA\nE=a=b');
    expect(e).toEqual({ A: '1', B: 'dois', C: 'três', D: '', E: 'a=b' });
  });
  it('aceita quebras de linha do Windows', () => {
    expect(parseEnv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('runPreflight: tudo certo', () => {
  it('passa em todas as checagens e devolve o ambiente lido', async () => {
    const r = await runPreflight(deps());
    expect(r.ok).toBe(true);
    expect(failIds(r)).toEqual([]);
    expect(r.checks.map((c) => c.id)).toEqual(['node', 'env_file', 'env_vars', 'db', 'port']);
    expect(r.env.SUPABASE_PROJECT_REF).toBe(REF);
  });
});

describe('runPreflight: .env.local', () => {
  it('arquivo ausente: explica como criar e não tenta banco', async () => {
    let connected = false;
    const r = await runPreflight(deps({ readEnvFile: () => null, connectDb: async () => { connected = true; } }));
    expect(r.ok).toBe(false);
    expect(failIds(r)).toContain('env_file');
    expect(connected).toBe(false);
    const f = r.checks.find((c) => c.id === 'env_file')!;
    expect(f.message).toContain('.env.local');
    expect(f.fix).toMatch(/\.env\.example/);
    // banco fica "pulado", não "falhou", porque depende do arquivo
    expect(r.checks.find((c) => c.id === 'db')!.status).toBe('skip');
  });

  it('variáveis vazias: lista todas de uma vez, com onde achar cada uma', async () => {
    const r = await runPreflight(deps({ readEnvFile: () => 'SHADOW_MODE=true\nSUPABASE_DB_URL=\n' }));
    const v = r.checks.find((c) => c.id === 'env_vars')!;
    expect(v.status).toBe('fail');
    expect(v.message).toContain('SUPABASE_DB_URL');
    expect(v.message).toContain('SUPABASE_PROJECT_REF');
    expect(v.message).toContain('SOURCE_TOKEN_LP_VERCEL');
    expect(v.fix).toMatch(/Connect/);
    expect(r.checks.find((c) => c.id === 'db')!.status).toBe('skip');
  });

  it('URL com o texto [YOUR-PASSWORD] esquecido', async () => {
    const env = GOOD_ENV.replace('abc123', '[YOUR-PASSWORD]');
    const r = await runPreflight(deps({ readEnvFile: () => env }));
    const v = r.checks.find((c) => c.id === 'env_vars')!;
    expect(v.status).toBe('fail');
    expect(v.message).toContain('[YOUR-PASSWORD]');
  });

  it('senha com caracteres especiais (URL inválida): manda rodar o encode-db-url', async () => {
    const env = GOOD_ENV.replace('abc123', 'ab?c,d:e');
    const r = await runPreflight(deps({ readEnvFile: () => env }));
    const v = r.checks.find((c) => c.id === 'env_vars')!;
    expect(v.status).toBe('fail');
    expect(v.fix).toContain('encode-db-url');
  });

  it('URL de outro projeto (não contém o ref): recusa', async () => {
    const env = GOOD_ENV.replace(`postgres.${REF}`, 'postgres.outroprojeto123456789');
    const r = await runPreflight(deps({ readEnvFile: () => env }));
    const v = r.checks.find((c) => c.id === 'env_vars')!;
    expect(v.status).toBe('fail');
    expect(v.message).toMatch(/ref/i);
  });

  it('ref do projeto antigo é recusado', async () => {
    const old = 'igidjtfhqqezmuakprnw';
    const env = GOOD_ENV.split(REF).join(old);
    const r = await runPreflight(deps({ readEnvFile: () => env }));
    expect(failIds(r)).toContain('env_vars');
  });
});

describe('runPreflight: banco', () => {
  it('erro de conexão vira explicação em português e o relatório não vaza a senha', async () => {
    const env = GOOD_ENV.replace('abc123', encodeURIComponent(SECRET));
    const err = Object.assign(new Error(`password authentication failed for user "postgres.${REF}" (${env})`), { code: '28P01' });
    const r = await runPreflight(deps({ readEnvFile: () => env, connectDb: async () => { throw err; } }));
    const db = r.checks.find((c) => c.id === 'db')!;
    expect(db.status).toBe('fail');
    expect(db.message).toMatch(/senha/i);
    const text = formatReport(r);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(encodeURIComponent(SECRET));
    expect(text).not.toContain('postgresql://');
  });

  it('a conexão é testada com a URL do .env.local', async () => {
    let seen = '';
    await runPreflight(deps({ connectDb: async (u) => { seen = u; } }));
    expect(seen).toBe(GOOD_URL);
  });
});

describe('explainDbError', () => {
  const cases: Array<[object, RegExp]> = [
    [{ code: '28P01', message: 'password authentication failed' }, /senha/i],
    [{ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND host' }, /internet|endereço|host/i],
    [{ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }, /tempo|internet|firewall/i],
    [{ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }, /recusou|porta/i],
    [{ message: 'timeout expired' }, /tempo/i],
    [{ message: 'Tenant or user not found' }, /ref|usuário|projeto/i],
    [{ code: 'ERR_INVALID_URL', message: 'Invalid URL' }, /encode-db-url|caracteres/i],
    [{ code: '3D000', message: 'database does not exist' }, /banco/i],
  ];
  it.each(cases)('%j', (err, re) => {
    expect(explainDbError(err as Error).message).toMatch(re);
  });
  it('erro desconhecido: mensagem genérica sem URLs', () => {
    const e = explainDbError(new Error('algo estranho em postgresql://u:p@h/db'));
    expect(e.message).not.toContain('postgresql://');
    expect(e.message).not.toContain(':p@');
  });
});

describe('runPreflight: porta e Node', () => {
  it('porta ocupada: explica como achar o processo ou trocar a porta', async () => {
    const r = await runPreflight(deps({ isPortFree: async () => false }));
    const p = r.checks.find((c) => c.id === 'port')!;
    expect(p.status).toBe('fail');
    expect(p.message).toContain('4310');
    expect(p.fix).toContain('Get-NetTCPConnection');
    expect(p.fix).toContain('STUDIO_PORT');
    expect(r.ok).toBe(false);
  });

  it('Node antigo demais', async () => {
    const r = await runPreflight(deps({ nodeVersion: '18.19.0' }));
    const n = r.checks.find((c) => c.id === 'node')!;
    expect(n.status).toBe('fail');
    expect(n.message).toContain('18.19.0');
  });

  it('várias falhas aparecem juntas no mesmo relatório', async () => {
    const r = await runPreflight(deps({ isPortFree: async () => false, connectDb: async () => { throw Object.assign(new Error('x'), { code: '28P01' }); } }));
    expect(failIds(r).sort()).toEqual(['db', 'port']);
    const text = formatReport(r);
    expect(text).toMatch(/2 problema/);
  });
});

describe('formatReport', () => {
  it('mostra ✔ nas checagens ok e ✖ com a correção nas que falharam', async () => {
    const r = await runPreflight(deps({ readEnvFile: () => null }));
    const t = formatReport(r);
    expect(t).toContain('✖');
    expect(t).toContain('Como resolver');
    expect(t).toContain('.env.example');
  });
  it('relatório de sucesso é curto e não menciona problemas', async () => {
    const t = formatReport(await runPreflight(deps()));
    expect(t).toContain('✔');
    expect(t).not.toContain('✖');
    expect(t).not.toMatch(/problema/);
  });
});
