import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { MetaClient, MetaErro, urlPermitida, type FetchLike } from '../src/datahub/meta/meta';

const ler = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, headers: { get: () => null } });

/** Protocolo: o cliente da Meta e SOMENTE LEITURA por construcao. */
describe('Meta: cliente somente leitura (segurança)', () => {
  const fonte = ler('src/datahub/meta/meta.ts');

  it('a classe só tem get e todas (nenhum método de escrita) e nenhum verbo de escrita aparece no código', () => {
    const metodos = Object.getOwnPropertyNames(MetaClient.prototype).filter((n) => n !== 'constructor' && !n.startsWith('lerUso') && !n.startsWith('lerThrottle') && n !== 'usoPct' && n !== 'liberarParada').sort();
    expect(metodos).toEqual(['get', 'todas']);
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codigo).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    expect(codigo).not.toMatch(/method\s*:/i);
    expect(codigo).not.toMatch(/\bbody\s*:/);
  });
  it('o único fetch é a chamada de get(), só com cabeçalhos e sinal de tempo (sem corpo nem método)', () => {
    expect((fonte.match(/doFetch\(/g) ?? []).length).toBe(1);
    expect(fonte).toContain('{ headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(90_000) }');
    expect(fonte).not.toMatch(/access_token/);
  });
  it('nenhum outro arquivo do leitor da Meta faz fetch nem fala com a Meta', () => {
    for (const f of readdirSync(new URL('../src/datahub/meta/', import.meta.url)).filter((x) => x !== 'meta.ts')) {
      const t = ler(`src/datahub/meta/${f}`);
      expect(t, f).not.toMatch(/\bfetch\s*\(|graph\.facebook\.com|https?:\/\//);
    }
  });
  it('só graph.facebook.com por https: URLs de paginação de outro host são recusadas sem chamar a rede', async () => {
    expect(urlPermitida('https://graph.facebook.com/v26.0/x?a=1')).toBe(true);
    for (const u of ['http://graph.facebook.com/x', 'https://evil.example/x', 'https://graph.facebook.com.evil.example/x', 'https://user@graph.facebook.com/x', 'https://graph.facebook.com:8443/x', '//graph.facebook.com/x', 'file:///etc/passwd']) expect(urlPermitida(u), u).toBe(false);
    let chamadas = 0;
    const f: FetchLike = async () => { chamadas++; return ok({ data: [{ id: 1 }], paging: { next: 'https://evil.example/steal?token=x' } }); };
    const c = new MetaClient('TOKEN-FICTICIO', f as never, async () => {});
    const err = await c.todas('act_1/ads', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaErro);
    expect((err as MetaErro).message).not.toContain('evil.example/steal');
    expect(chamadas).toBe(1);
    for (const u of ['http://graph.facebook.com/x', '//evil.example/x', 'ftp://x/y']) await expect(c.get(u)).rejects.toBeInstanceOf(MetaErro);
    expect(chamadas).toBe(1);
  });
  it('o token vai só no cabeçalho Authorization: nunca na URL nem no erro; só GET (o fetch recebe somente headers e signal)', async () => {
    const vistos: Array<{ url: string; init: Record<string, unknown> }> = [];
    const f: FetchLike = async (url, init) => { vistos.push({ url, init: { ...(init as object) } }); return ok({ data: [] }); };
    const c = new MetaClient('TOKEN-FICTICIO-123', f as never, async () => {});
    await c.get('act_1/insights', { level: 'ad' });
    expect(vistos[0]!.url.startsWith('https://graph.facebook.com/v26.0/')).toBe(true);
    expect(vistos[0]!.url).not.toContain('TOKEN-FICTICIO-123');
    expect(Object.keys(vistos[0]!.init).sort()).toEqual(['headers', 'signal']);
    expect((vistos[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer TOKEN-FICTICIO-123');
    const negado: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 200, message: 'Permissions error' } }), headers: { get: () => null } });
    const e = await new MetaClient('TOKEN-FICTICIO-123', negado as never, async () => {}).get('x').catch((x: unknown) => x);
    expect(String((e as Error).message)).not.toContain('TOKEN-FICTICIO-123');
  });
  it('os scripts da Meta não imprimem o token', () => {
    for (const s of ['scripts/meta-sync.ts', 'scripts/meta-rodada.ts']) expect(ler(s), s).not.toMatch(/console\.\w+\([^)]*(cred\.token|META_ACCESS_TOKEN)/);
  });
});
