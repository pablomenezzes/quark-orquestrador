import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const ler = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('scripts da Meta: o token nunca aparece na tela nem na URL', () => {
  const guardar = ler('scripts/guardar-token-meta.mjs');
  const teste = ler('scripts/meta-teste.mjs');
  it('guardar-token-meta só imprime nomes e IDs de conta, nunca o valor do token', () => {
    expect(guardar).not.toMatch(/console\.(log|error)\([^)]*\btoken\b[^)]*\)/);
    expect(guardar).toContain('(o token nao e exibido)');
    expect(guardar).toContain('/^[A-Za-z0-9_-]{40,600}$/'); // formato mínimo: recusa arquivo que não parece token
    expect(guardar).toContain('/^\\d{6,20}$/'); // ID de conta: só números
  });
  it('meta-teste manda o token no cabeçalho (nunca na URL) e só lê (GET, sem escrita)', () => {
    expect(teste).toContain('authorization: `Bearer ${token}`');
    expect(teste).not.toMatch(/searchParams\.set\(['"]access_token/);
    expect(teste).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/i);
    expect(teste).not.toMatch(/console\.(log|error)\([^)]*\btoken\b/);
  });
});
