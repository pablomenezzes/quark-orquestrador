import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Garantias do backup local e do roteiro de restauração (lidas no código dos scripts, que são PowerShell):
 * o que protege a produção e o que impede segredo de vazar. A execução real é provada nas rodadas de `npm run backup`.
 */
const ler = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('scripts/restaurar-backup.ps1: só restaura em banco novo e vazio, nunca na produção', () => {
  const s = ler('scripts/restaurar-backup.ps1');
  it('recusa o banco de produção, pelo identificador do projeto e pela URL inteira', () => {
    expect(s).toContain('$Destino.Contains($refProducao)');
    expect(s).toContain('$Destino -eq $env:SUPABASE_DB_URL');
    expect(s.match(/RECUSADO: o destino e o banco de PRODUCAO/g)?.length).toBe(2);
  });
  it('recusa destino com dados e destino sem a estrutura das migrations', () => {
    expect(s).toContain('RECUSADO: o destino ja tem dados');
    expect(s).toContain('ainda nao tem a estrutura do projeto');
  });
  it('só carrega DADOS (a estrutura vem das migrations) e deixa o historico de migrations de fora', () => {
    expect(s).toContain('--data-only');
    expect(s).toContain('--exclude-schema=supabase_migrations');
    expect(s).not.toMatch(/--clean|--create|drop (database|schema|table)/i);
  });
  it('confere o resultado tabela por tabela e falha se o destino não ficou igual ao arquivo', () => {
    expect(s).toContain('so-contar');
    expect(s).toContain('O destino NAO ficou igual ao backup');
  });
  it('confere o índice do arquivo antes de começar', () => {
    expect(s).toMatch(/--list \$Arquivo[\s\S]*indice legivel/);
  });
});

describe('scripts/backup-local.ps1: backup conferido, sem vazar segredo', () => {
  const s = ler('scripts/backup-local.ps1');
  it('só lê da nuvem (pg_dump) e recusa URL que não seja do projeto', () => {
    expect(s).toContain('pg_dump.exe');
    expect(s).toContain('SUPABASE_DB_URL nao contem SUPABASE_PROJECT_REF: recusando');
    expect(s).not.toMatch(/pg_restore\.exe"\s+(--clean|--dbname)/); // o backup diário nunca restaura nada em lugar nenhum
  });
  it('inclui os schemas do projeto e o histórico de migrations, e não os internos do Supabase', () => {
    for (const sc of ['core', 'orq', 'crm', 'raw', 'ops', 'analytics', 'supabase_migrations']) expect(s).toContain(`'${sc}'`);
    expect(s).not.toMatch(/'(auth|storage|realtime|vault)'/);
  });
  it('confere o arquivo (índice e contagem de linhas contra a nuvem) e grava o resultado', () => {
    expect(s).toContain('--list');
    expect(s).toContain('verificar-backup.mjs');
    expect(s).toContain('ULTIMO_BACKUP.json');
    expect(s).toContain('backup.log');
  });
  it('a URL do banco nunca vai para o log nem para a tela (é trocada por <url>)', () => {
    expect(s).toContain("-replace 'postgres(ql)?://\\S+', '<url>'");
    expect(s).not.toMatch(/Log\s*\(?\s*["'][^"']*\$env:SUPABASE_DB_URL/);
  });
  it('a retenção só apaga nuvem-*.dump, protege os 7 mais recentes, os com menos de 30 dias e os do dia 1', () => {
    expect(s).toContain("-Filter 'nuvem-*.dump'");
    expect(s).toContain('Select-Object -Skip 7');
    expect(s).toContain('AddDays(-30)');
    expect(s).toContain('.Day -ne 1');
    expect(s).not.toMatch(/Remove-Item[^\n]*\*\.sql/);
  });
  it('o espelho local foi dispensado: não há mais script nem referência', () => {
    expect(existsSync(new URL('../scripts/espelho.ps1', import.meta.url))).toBe(false);
    expect(s).not.toMatch(/espelho/i);
  });
});

describe('scripts/agendar-backup.ps1: tarefa diária segura', () => {
  const s = ler('scripts/agendar-backup.ps1');
  it('roda todo dia às 3h, recupera execução perdida, só com rede e sem exigir administrador', () => {
    expect(s).toContain('-Daily -At 3am');
    expect(s).toContain('-StartWhenAvailable');
    expect(s).toContain('-RunOnlyIfNetworkAvailable');
    expect(s).not.toMatch(/RunLevel\s+Highest|-User\s+['"]?SYSTEM/i);
  });
  it('executa o backup silencioso com retenção', () => {
    expect(s).toContain('backup-local.ps1');
    expect(s).toContain('-Silencioso -Prune');
  });
});

describe('os backups não vão para o GitHub', () => {
  it('backups/ e o conector gerado estão no .gitignore', () => {
    const g = ler('.gitignore');
    expect(g).toMatch(/^backups\/$/m);
    expect(g).toMatch(/^mcp\/dist\/$/m);
  });
});
