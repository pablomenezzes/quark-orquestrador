import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Teste de ponta a ponta do conector do Claude Desktop: sobe o arquivo gerado (mcp/dist/quark-dados.mjs) como o Claude Desktop faria,
 * conversa com ele pelo protocolo MCP e confere respostas e recusas, contra o banco de verdade com o papel orq_chat.
 * Pulado se o papel ainda não existe (CHAT_DB_URL ausente no .env.local).
 */
try {
  process.loadEnvFile('.env.local');
} catch {
  /* sem .env.local */
}
const pronto = Boolean(process.env.CHAT_DB_URL);
const run = describe.skipIf(!pronto);

run('conector quark-dados (ponta a ponta)', () => {
  let client: Client;
  const texto = async (nome: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name: nome, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    return { erro: Boolean(r.isError), texto: r.content.map((c) => c.text).join('\n') };
  };

  beforeAll(async () => {
    const b = spawnSync(process.execPath, ['scripts/build-mcp.mjs'], { encoding: 'utf8' });
    expect(b.status, b.stderr).toBe(0);
    expect(existsSync(resolve('mcp/dist/quark-dados.mjs'))).toBe(true);
    client = new Client({ name: 'teste', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('mcp/dist/quark-dados.mjs')], stderr: 'pipe' }));
  }, 60_000);
  afterAll(async () => {
    await client?.close();
  });

  it('expõe exatamente as 5 ferramentas, todas marcadas como somente leitura', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['quark_analise', 'quark_atualizacao', 'quark_definicoes', 'quark_esquema', 'quark_sql']);
    for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
  });

  it('definições: explica os conceitos e lista análises, fontes e tipos', async () => {
    const r = await texto('quark_definicoes');
    expect(r.erro).toBe(false);
    expect(r.texto).toContain('MQL');
    expect(r.texto).toContain('canais-funis');
    expect(r.texto).toContain('Marketing [Meta ADS]');
    expect(r.texto).not.toMatch(/@|\+55|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/); // nada que pareça e-mail, telefone ou CPF
  });

  it('análise pronta: devolve a tabela com os filtros aplicados à vista', async () => {
    const r = await texto('quark_analise', { id: 'visao-geral', de: '2026-01-01', ate: '2026-10-08' });
    expect(r.erro).toBe(false);
    expect(r.texto).toContain('## Visão geral');
    expect(r.texto).toContain('Filtros aplicados');
    expect(r.texto).toContain('seleção fixa do BI');
    expect(r.texto).toMatch(/\| Leads \| [\d.]+ \|/);
  });

  it('análise com nomes de fonte em linguagem natural', async () => {
    const r = await texto('quark_analise', { id: 'canais-funis', fontes: ['google', 'meta'], de: '2026-01-01', ate: '2026-10-08' });
    expect(r.erro).toBe(false);
    expect(r.texto).toContain('Marketing [Google ADS], Marketing [Meta ADS]');
  });

  it('fonte que não existe: erro claro que lista as opções', async () => {
    const r = await texto('quark_analise', { id: 'visao-geral', fontes: ['tiktok'] });
    expect(r.erro).toBe(true);
    expect(r.texto).toMatch(/não encontrei "tiktok"/);
  });

  it('SQL de leitura nas visões liberadas funciona', async () => {
    const r = await texto('quark_sql', { consulta: 'select status, count(*) as n from analytics.deals group by 1 order by 2 desc', limite: 10 });
    expect(r.erro).toBe(false);
    expect(r.texto).toMatch(/\| status \| n \|/);
  });

  it('o título do negócio (nome de pessoa), pessoas, empresas e tabelas internas são recusados pelo BANCO', async () => {
    for (const sql of [
      'select titulo from analytics.negocios_bi', 'select * from analytics.deals', 'select * from analytics.pessoas', 'select * from analytics.deal_campos',
      'select * from crm.deals', 'select * from raw.pd_deals', 'select * from core.leads', 'select * from ops.cfg_status_contagem', 'select email from crm.users',
    ]) {
      const r = await texto('quark_sql', { consulta: sql });
      expect(r.erro, sql).toBe(true);
      expect(r.texto, sql).toMatch(/permission denied|permissão negada|não consegui consultar/i);
    }
  });

  it('escrita e comandos perigosos são recusados antes de chegar ao banco', async () => {
    for (const sql of ['update ops.cfg_status_contagem set conta_como_lead = true', 'delete from analytics.deals_resumo', 'drop view analytics.deals_resumo', 'select 1; select 2', 'select pg_sleep(60)', 'create table x (a int)']) {
      const r = await texto('quark_sql', { consulta: sql });
      expect(r.erro, sql).toBe(true);
    }
  });

  it('esquema lista só colunas liberadas (sem o título) e atualização mostra as partes', async () => {
    const e = await texto('quark_esquema');
    expect(e.texto).toContain('analytics.negocios_bi');
    expect(e.texto).not.toMatch(/\btitulo\b \(/);
    expect(e.texto).not.toContain('analytics.pessoas');
    const a = await texto('quark_atualizacao');
    expect(a.erro).toBe(false);
    expect(a.texto).toContain('deals');
  });
});
