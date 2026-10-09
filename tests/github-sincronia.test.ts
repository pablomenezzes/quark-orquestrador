import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const ler = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('.github/workflows/sincronia.yml: sincronia automática segura', () => {
  const w = ler('.github/workflows/sincronia.yml');
  it('roda a cada 4 horas e sob demanda, sem gatilho de pull request ou push (segredos nunca ao alcance de terceiros)', () => {
    expect(w).toContain("cron: '17 */4 * * *'");
    expect(w).toContain('workflow_dispatch');
    expect(w).not.toMatch(/pull_request|pull_request_target|^\s+push:/m);
  });
  it('permissão mínima e uma execução por vez', () => {
    expect(w).toMatch(/permissions:\s*\n\s+contents: read/);
    expect(w).toContain('group: sincronia');
    expect(w).toContain('cancel-in-progress: false');
  });
  it('usa só o papel orq_sync (SYNC_DB_URL), nunca a URL do dono do banco nem outros papéis', () => {
    expect(w).toContain('SYNC_DB_URL');
    expect(w).not.toMatch(/SUPABASE_DB_URL|PANEL_DB_URL|CHAT_DB_URL|INGEST_DB_URL|SERVICE_ROLE/);
  });
  it('só os 7 segredos esperados, e nenhum é impresso', () => {
    const usados = [...w.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
    expect(usados).toEqual(['GA4_PROPERTY_ID', 'GOOGLE_SA_CLIENT_EMAIL', 'GOOGLE_SA_PRIVATE_KEY', 'PIPEDRIVE_API_TOKEN', 'PIPEDRIVE_DOMAIN', 'SUPABASE_PROJECT_REF', 'SYNC_DB_URL']);
    expect(w).not.toMatch(/echo[^\n]*\$\{\{\s*secrets|echo[^\n]*(TOKEN|PRIVATE|DB_URL)/);
  });
  it('as quatro etapas rodam mesmo com falha de outra e o job termina vermelho', () => {
    expect((w.match(/continue-on-error: true/g) ?? []).length).toBe(4);
    expect(w).toContain('exit 1');
  });
  it('só sincroniza com --apply e nada de comando destrutivo', () => {
    for (const l of w.split('\n').filter((x) => /tsx scripts\//.test(x))) expect(l).toContain('--apply');
    expect(w).not.toMatch(/db push|drop|restaurar|set-role-password/i);
  });
});

describe('scripts/github-segredos.ps1: segredos sem aparecer na tela', () => {
  const s = ler('scripts/github-segredos.ps1');
  it('passa o valor pela entrada padrão (nunca na linha de comando) e recusa papel que não seja o orq_sync', () => {
    expect(s).toContain('$env_[$n] | & $gh secret set $n');
    expect(s).not.toMatch(/secret set[^\n]*(--body|-b )/);
    expect(s).toContain('orq_sync');
  });
  it('sem -Apply só mostra os nomes', () => {
    expect(s).toContain("if (-not $Apply) { Write-Host 'Nada guardado");
  });
});
