import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PipedriveReadClient, PipedriveError, normalizeDomain, costOf } from '../src/datahub/pipedrive/client';

type Call = { url: string; init: RequestInit };

/** fetch de mentira que devolve respostas em fila e registra tudo que foi pedido. */
function fakeFetch(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body ?? { success: true, data: [] }), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const mk = (responses: Parameters<typeof fakeFetch>[0], over: object = {}) => {
  const f = fakeFetch(responses);
  const sleeps: number[] = [];
  const client = new PipedriveReadClient({
    domain: 'quark',
    apiToken: 'TOKEN-SECRETO-123',
    fetchImpl: f.fn,
    sleep: async (ms: number) => void sleeps.push(ms),
    minIntervalMs: 0,
    ...over,
  });
  return { client, calls: f.calls, sleeps };
};

describe('somente leitura (regra 7)', () => {
  it('a classe não tem nenhum método de escrita', () => {
    const names = Object.getOwnPropertyNames(PipedriveReadClient.prototype);
    const writers = names.filter((n) => /^(post|put|patch|delete|create|update|add|remove|merge|archive|set|write|send|upsert|insert)/i.test(n));
    expect(writers).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['listPipelines', 'listStages', 'listUsers', 'listFieldDefs']));
  });

  it('o código-fonte do cliente só usa o método GET', () => {
    const src = readFileSync(new URL('../src/datahub/pipedrive/client.ts', import.meta.url), 'utf8');
    const methods = [...src.matchAll(/method:\s*['"]([A-Z]+)['"]/g)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(['GET']));
    expect(src).not.toMatch(/['"](POST|PUT|PATCH|DELETE)['"]/);
  });

  it('todas as requisições feitas são GET, sem corpo', async () => {
    const { client, calls } = mk([{ body: { success: true, data: [{ id: 1 }], additional_data: { next_cursor: 'c2' } } }, { body: { success: true, data: [{ id: 2 }] } }]);
    await client.listPipelines();
    await client.listUsers();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) {
      expect(c.init.method).toBe('GET');
      expect(c.init.body).toBeUndefined();
    }
  });
});

describe('autenticação e destino', () => {
  it('manda o token no cabeçalho x-api-token e nunca na URL', async () => {
    const { client, calls } = mk([{}]);
    await client.listPipelines();
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-token']).toBe('TOKEN-SECRETO-123');
    expect(calls[0]!.url).not.toContain('TOKEN-SECRETO-123');
    expect(calls[0]!.url).not.toContain('api_token');
  });

  it('só fala com *.pipedrive.com (o token nunca vai para outro host)', async () => {
    expect(normalizeDomain('quark')).toBe('quark.pipedrive.com');
    expect(normalizeDomain('Quark.pipedrive.com')).toBe('quark.pipedrive.com');
    expect(normalizeDomain('https://quark.pipedrive.com/')).toBe('quark.pipedrive.com');
    for (const bad of ['evil.com', 'quark.pipedrive.com.evil.com', 'https://evil.com/x', 'quark@evil.com', '', 'a b', 'quark.pipedrive.com:8080', '../x', 'quark/evil']) {
      expect(() => normalizeDomain(bad), bad).toThrow();
    }
  });

  it('usa https e o host normalizado', async () => {
    const { client, calls } = mk([{}]);
    await client.listPipelines();
    expect(calls[0]!.url.startsWith('https://quark.pipedrive.com/')).toBe(true);
  });
});

describe('paginação e rotas (documentação atual, 2026-10-05)', () => {
  it('pipelines e etapas: API v2 com cursor, limite 500, até acabar o next_cursor', async () => {
    const { client, calls } = mk([
      { body: { success: true, data: [{ id: 1 }, { id: 2 }], additional_data: { next_cursor: 'abc' } } },
      { body: { success: true, data: [{ id: 3 }], additional_data: { next_cursor: null } } },
    ]);
    const out = await client.listPipelines();
    expect(out.map((x: any) => x.id)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(2);
    const u1 = new URL(calls[0]!.url);
    expect(u1.pathname).toBe('/api/v2/pipelines');
    expect(u1.searchParams.get('limit')).toBe('500');
    expect(u1.searchParams.get('cursor')).toBeNull();
    expect(new URL(calls[1]!.url).searchParams.get('cursor')).toBe('abc');

    const s = mk([{}]);
    await s.client.listStages();
    expect(new URL(s.calls[0]!.url).pathname).toBe('/api/v2/stages');
  });

  it('usuários: API v1 (não existe na v2)', async () => {
    const { client, calls } = mk([{ body: { success: true, data: [{ id: 7, name: 'Ana' }] } }]);
    const users = await client.listUsers();
    expect(users).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/users');
  });

  it('definição de campos: uma rota v2 por entidade', async () => {
    const paths: Record<string, string> = {
      deal: '/api/v2/dealFields',
      person: '/api/v2/personFields',
      organization: '/api/v2/organizationFields',
      activity: '/api/v2/activityFields',
    };
    for (const [entity, path] of Object.entries(paths)) {
      const { client, calls } = mk([{}]);
      await client.listFieldDefs(entity as 'deal');
      expect(new URL(calls[0]!.url).pathname).toBe(path);
    }
  });

  it('corta paginação infinita (cursor que nunca acaba)', async () => {
    const { client } = mk([{ body: { success: true, data: [{ id: 1 }], additional_data: { next_cursor: 'sempre' } } }], { maxPages: 5 });
    await expect(client.listPipelines()).rejects.toThrow(/p[áa]ginas/i);
  });
});

describe('custo e cota (documentação: pipelines 5, etapas 5, usuários 20, campos 10)', () => {
  it('tabela de custos', () => {
    expect(costOf('/api/v2/pipelines')).toBe(5);
    expect(costOf('/api/v2/stages')).toBe(5);
    expect(costOf('/v1/users')).toBe(20);
    expect(costOf('/api/v2/dealFields')).toBe(10);
    expect(costOf('/api/v2/deals')).toBe(10);
    expect(costOf('/api/v2/deals/archived')).toBe(20);
    expect(costOf('/api/v2/deals/123')).toBe(1);
    expect(costOf('/v1/deals/123/flow')).toBe(40);
    expect(costOf('/api/v2/coisa-desconhecida')).toBe(20); // desconhecido = pessimista
  });

  it('soma as unidades gastas e as requisições', async () => {
    const { client } = mk([{ body: { success: true, data: [{ id: 1 }], additional_data: { next_cursor: 'x' } } }, { body: { success: true, data: [] } }]);
    await client.listPipelines(); // 2 páginas x 5
    await client.listUsers(); // 20
    expect(client.usage).toMatchObject({ tokens: 30, requests: 3, rateLimited: 0 });
  });

  it('para ANTES de estourar o teto de unidades da rodada', async () => {
    const { client, calls } = mk([{}], { maxTokens: 12 });
    await client.listPipelines(); // 5
    await client.listStages(); // 10
    await expect(client.listUsers()).rejects.toThrow(/teto|cota|unidades/i); // 10 + 20 > 12
    expect(calls).toHaveLength(2);
  });
});

describe('limite de requisições (429) e erros', () => {
  it('429: espera o Retry-After e tenta de novo', async () => {
    const { client, calls, sleeps } = mk([{ status: 429, headers: { 'retry-after': '3' } }, { body: { success: true, data: [{ id: 1 }] } }]);
    const out = await client.listPipelines();
    expect(out).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(sleeps).toContain(3000);
    expect(client.usage.rateLimited).toBe(1);
  });

  it('429 sem Retry-After: espera crescente (backoff)', async () => {
    const { client, sleeps } = mk([{ status: 429 }, { status: 429 }, { body: { success: true, data: [] } }]);
    await client.listPipelines();
    const waits = sleeps.filter((s) => s > 0);
    expect(waits.length).toBe(2);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
  });

  it('desiste depois de muitas tentativas, com erro que diz que foi limite', async () => {
    const { client } = mk([{ status: 429 }], { maxRetries: 3 });
    await expect(client.listPipelines()).rejects.toMatchObject({ name: 'PipedriveError', kind: 'rate_limited' });
  });

  it('401/403 viram erro claro de credencial, sem repetir e sem vazar o token', async () => {
    for (const status of [401, 403]) {
      const { client, calls } = mk([{ status, body: { success: false, error: 'unauthorized access' } }]);
      const err = (await client.listPipelines().catch((e: unknown) => e)) as PipedriveError;
      expect(err).toBeInstanceOf(PipedriveError);
      expect(err.kind).toBe('auth');
      expect(String(err.message)).not.toContain('TOKEN-SECRETO-123');
      expect(calls).toHaveLength(1);
    }
  });

  it('5xx: tenta de novo algumas vezes; depois falha', async () => {
    const ok = mk([{ status: 503 }, { body: { success: true, data: [{ id: 1 }] } }]);
    expect(await ok.client.listPipelines()).toHaveLength(1);
    const bad = mk([{ status: 500 }], { maxRetries: 2 });
    await expect(bad.client.listPipelines()).rejects.toMatchObject({ kind: 'server' });
  });

  it('resposta com success:false vira erro', async () => {
    const { client } = mk([{ body: { success: false, error: 'algo' } }]);
    await expect(client.listPipelines()).rejects.toBeInstanceOf(PipedriveError);
  });

  it('o token não aparece em nenhuma mensagem de erro', async () => {
    const { client } = mk([{ status: 400, body: { success: false, error: 'bad request TOKEN-SECRETO-123' } }]);
    const err = (await client.listPipelines().catch((e: unknown) => e)) as Error;
    expect(String(err.message)).not.toContain('TOKEN-SECRETO-123');
  });
});
