/**
 * Conector do Claude Desktop para conversar com os dados do Quark Data Hub (servidor MCP por stdio, roda no computador do Pablo).
 *
 * - Usa o papel de banco `orq_chat` (CHAT_DB_URL no .env.local): SOMENTE LEITURA, só visões de `analytics`, sem dados pessoais
 *   e sem o título do negócio (migration 0012). Se este programa tentasse escrever ou ler mais, o BANCO recusaria.
 * - As análises são as mesmas do BI do Studio (studio/lib/bi.ts): MQL, inválido, "chegou em SQL ou além" etc. batem com o painel.
 * - Não abre porta nenhuma: o Claude Desktop o inicia e fala com ele pela entrada/saída padrão. Logs só em stderr.
 *
 * Gerar o arquivo que o Claude Desktop executa: npm run mcp:build  (cria mcp/dist/quark-dados.mjs)
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { assertRoleUser, assertSafeDbTarget } from '../../src/db/guard.js';
import { BI_ANALISES, PgBiRepo } from '../../studio/lib/bi.js';
import { DEFINICOES, LIMITE_LINHAS, SqlRecusado, guardaSql, resolverFiltros, textoAnalise, textoSql } from './logica.js';

// Funciona tanto rodando o .ts quanto o arquivo único gerado em mcp/dist: o .env.local fica na raiz do projeto.
const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = [resolve(aqui, '..', '..'), resolve(aqui, '..')].find((d) => existsSync(join(d, '.env.local'))) ?? resolve(aqui, '..', '..');
try {
  process.loadEnvFile(join(raiz, '.env.local'));
} catch {
  /* sem .env.local: usa o ambiente */
}

const url = process.env.CHAT_DB_URL ?? '';
if (!url) {
  console.error('Falta CHAT_DB_URL no .env.local. Rode: node scripts/set-role-password.mjs --role orq_chat --apply');
  process.exit(1);
}
assertSafeDbTarget({ target: url, expectedRef: process.env.SUPABASE_PROJECT_REF ?? '' });
assertRoleUser(url, 'orq_chat');

const pool = new pg.Pool({ connectionString: url, max: 2, ssl: { rejectUnauthorized: false } });
pool.on('error', () => undefined);
const repo = new PgBiRepo(pool);

const limpa = (m: string) => m.replace(/postgres(ql)?:\/\/\S+/gi, '<url>').slice(0, 500);
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const erro = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof SqlRecusado ? e.message : `Não consegui consultar: ${limpa(e instanceof Error ? e.message : String(e))}` }] });

/** Toda consulta roda numa transação SOMENTE LEITURA, que sempre termina em rollback. */
async function lendo<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin read only');
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

const server = new McpServer({ name: 'quark-dados', version: '1.0.0' });
const SOMENTE_LEITURA = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

server.registerTool(
  'quark_definicoes',
  {
    title: 'Definições, análises e filtros disponíveis',
    description:
      'COMECE POR AQUI. Explica o que significam MQL, lead, inválido, safra, taxa de ganho e "chegou em SQL ou além", e lista as análises prontas (ids), os pipelines e as fontes e tipos do lead que podem ser usados como filtro.',
    inputSchema: {},
    annotations: SOMENTE_LEITURA,
  },
  async () => {
    try {
      const o = await lendo(() => repo.opcoes());
      const analises = repo.catalogo().map((a) => `- \`${a.id}\` (página ${a.pagina}): ${a.titulo}. ${a.pergunta}`).join('\n');
      return ok(
        [
          DEFINICOES,
          '\n# Análises prontas (use `quark_analise`)',
          analises,
          '\n# Filtros',
          `- Pipelines: ${o.pipelines.map((p) => `${p.pipeline} (#${p.pipeline_id}, ${p.produto ?? 'sem produto'})`).join('; ')}`,
          `- Fontes do Lead: ${o.fontes.map((f) => `${f.nome} (#${f.id})${f.padrao ? ' [seleção fixa]' : ''}`).join('; ')}`,
          `- Tipos do Lead: ${o.tipos.map((t) => `${t.nome} (#${t.id})${t.padrao ? ' [seleção fixa]' : ''}`).join('; ')}`,
          '- Se `fontes` ou `tipos` não forem informados, valem as seleções fixas do BI. Use ["todas"] para não filtrar.',
        ].join('\n'),
      );
    } catch (e) {
      return erro(e);
    }
  },
);

server.registerTool(
  'quark_analise',
  {
    title: 'Rodar uma análise do BI',
    description:
      'Roda uma das análises prontas do BI com os mesmos números do painel (ids em quark_definicoes: visao-geral, por-mes, funil, motivos-perda, tempo-etapas, por-responsavel, safra-resumo, safra-funil, safra-ganhos, canais-funis, canais-conversoes, canais-resumo, canais-por-mes, canais-rd, qualidade-kpis, qualidade-por-fonte, qualidade-por-mes, qualidade-invalidos, qualidade-branco). Prefira esta ferramenta a SQL livre sempre que existir uma análise para a pergunta.',
    inputSchema: {
      id: z.enum(BI_ANALISES.map((a) => a.id) as [string, ...string[]]).describe('Id da análise'),
      de: z.string().optional().describe('Início do período de CRIAÇÃO do negócio, AAAA-MM-DD (padrão: 1º de janeiro do ano atual)'),
      ate: z.string().optional().describe('Fim do período, AAAA-MM-DD (padrão: hoje)'),
      produto: z.string().optional().describe('"rh" ou "clinica"; vazio = todos'),
      pipeline: z.string().optional().describe('Nome ou id do pipeline; vazio = todos'),
      fontes: z.array(z.string()).optional().describe('Nomes ou ids de Fonte do Lead (ex.: ["Google ADS","Meta ADS"]); vazio = seleção fixa do BI; ["todas"] = sem filtro; "(em branco)" = não preenchido'),
      tipos: z.array(z.string()).optional().describe('Nomes ou ids de Tipo do Lead (ex.: ["Marketing","Indicação"]); vazio = Marketing; ["todas"] = sem filtro'),
    },
    annotations: SOMENTE_LEITURA,
  },
  async (a) => {
    try {
      const analise = BI_ANALISES.find((x) => x.id === a.id);
      if (!analise) throw new SqlRecusado(`Análise "${a.id}" não existe.`);
      const o = await lendo(() => repo.opcoes());
      const { filtros, descricao } = resolverFiltros({ de: a.de, ate: a.ate, produto: a.produto, pipeline: a.pipeline, fontes: a.fontes, tipos: a.tipos }, o);
      const r = await lendo((c) => analise.rodar(c, filtros));
      return ok(textoAnalise(analise.titulo, analise.pergunta, analise.como_ler, descricao, r));
    } catch (e) {
      return erro(e);
    }
  },
);

server.registerTool(
  'quark_esquema',
  {
    title: 'Visões e colunas que podem ser consultadas',
    description: 'Lista as visões de analytics e as colunas que este acesso pode ler (o título do negócio e dados pessoais não aparecem). Use antes de escrever SQL com quark_sql.',
    inputSchema: {},
    annotations: SOMENTE_LEITURA,
  },
  async () => {
    try {
      const r = await lendo((c) =>
        c.query(`select table_name, column_name, data_type from information_schema.columns where table_schema = 'analytics' order by table_name, ordinal_position`),
      );
      const por = new Map<string, string[]>();
      for (const x of r.rows) por.set(x.table_name, [...(por.get(x.table_name) ?? []), `${x.column_name} (${x.data_type})`]);
      return ok(
        [`# Visões de analytics e colunas liberadas`, ...[...por].map(([t, cols]) => `\n**analytics.${t}**\n${cols.join(', ')}`), '\nObservação: `select *` em analytics.deals e analytics.negocios_bi é recusado (a coluna `titulo` é bloqueada): liste as colunas.'].join('\n'),
      );
    } catch (e) {
      return erro(e);
    }
  },
);

server.registerTool(
  'quark_sql',
  {
    title: 'Consulta SQL de leitura',
    description: `Roda UMA consulta SELECT/WITH nas visões de analytics (somente leitura, até ${LIMITE_LINHAS} linhas, 20 s). Use quando nenhuma análise pronta responde. Veja as colunas com quark_esquema. Respeite as definições de quark_definicoes (use is_mql, conta_como_lead e status; datas em criado_em). Dados pessoais e o título do negócio não estão disponíveis.`,
    inputSchema: {
      consulta: z.string().describe('Uma única consulta SELECT ou WITH, sem ponto e vírgula no meio e sem comentários'),
      limite: z.number().int().min(1).max(LIMITE_LINHAS).optional().describe(`Máximo de linhas (padrão e teto ${LIMITE_LINHAS})`),
    },
    annotations: SOMENTE_LEITURA,
  },
  async ({ consulta, limite }) => {
    try {
      const n = limite ?? 50;
      const sql = guardaSql(consulta, n);
      const r = await lendo((c) => c.query(sql));
      return ok(textoSql(r.fields.map((f) => f.name), r.rows, n));
    } catch (e) {
      return erro(e);
    }
  },
);

server.registerTool(
  'quark_atualizacao',
  {
    title: 'Quando os dados foram atualizados pela última vez',
    description: 'Mostra a última atualização bem-sucedida de cada parte dos dados do Pipedrive (negócios, histórico de etapas etc.) e se está atrasada. Cite isso ao responder perguntas sobre "hoje" ou "agora".',
    inputSchema: {},
    annotations: SOMENTE_LEITURA,
  },
  async () => {
    try {
      const r = await lendo((c) => c.query(`select entity, ultimo_sucesso_em, ultimo_status, atrasada, backfill_concluido from analytics.sync_saude order by entity`));
      const f = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
      return ok(
        textoSql(
          ['parte', 'última atualização (horário de São Paulo)', 'status', 'atrasada (>8 h)', 'carga inicial concluída'],
          r.rows.map((x) => ({ parte: x.entity, 'última atualização (horário de São Paulo)': x.ultimo_sucesso_em ? f.format(new Date(x.ultimo_sucesso_em)) : 'nunca', status: x.ultimo_status, 'atrasada (>8 h)': x.atrasada ? 'sim' : 'não', 'carga inicial concluída': x.backfill_concluido ? 'sim' : 'não' })),
          100,
        ),
      );
    } catch (e) {
      return erro(e);
    }
  },
);

await server.connect(new StdioServerTransport());
console.error('quark-dados: conector pronto (somente leitura).');

const encerrar = () => void pool.end().finally(() => process.exit(0));
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
process.stdin.on('close', encerrar);
