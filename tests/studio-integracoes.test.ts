import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createStudioServer } from '../studio/server';
import { htmlParaMarkdown, htmlParaTexto } from '../studio/lib/html-para-md';
import {
  CABECALHO_DOCUMENTACAO, CABECALHO_EXPERIMENTOS, ClickUpClient, IntegracaoErro, Integracoes, SheetsClient, clickUpConfigDoAmbiente, linhasDocumentacao, linhasExperimentos,
  markdownDoExperimento, sheetsConfigDoAmbiente, type ExperimentoParaSync, type RepoSync,
} from '../studio/lib/integracoes';
import type { AuthService, Papel } from '../studio/lib/auth';

const chave = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const ID_PLANILHA = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

describe('HTML do editor -> Markdown e texto', () => {
  it('converte títulos, parágrafos, negrito, itálico, links, listas, citações e tabelas', () => {
    const md = htmlParaMarkdown('<h1>Título</h1><p>Um <b>negrito</b> e <i>itálico</i> com <a href="https://x.com/a?b=1">link</a>.</p><ul><li>um</li><li>dois</li></ul><ol><li>a</li><li>b</li></ol><blockquote>citação</blockquote><h2>Sub</h2><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2 | 3</td></tr></table>');
    expect(md).toContain('# Título');
    expect(md).toContain('Um **negrito** e _itálico_ com [link](https://x.com/a?b=1).');
    expect(md).toMatch(/- um\n- dois/);
    expect(md).toMatch(/1\. a\n2\. b/);
    expect(md).toContain('> citação');
    expect(md).toContain('## Sub');
    expect(md).toContain('| A | B |\n| --- | --- |\n| 1 | 2 \\| 3 |');
  });
  it('gráfico SVG vira uma linha com o título; script, estilo e link perigoso não passam', () => {
    const md = htmlParaMarkdown('<p>antes</p><figure><svg viewBox="0 0 1 1" aria-label="CPL por dia"><rect/></svg></figure><script>alert(1)</script><style>p{}</style><a href="javascript:alert(1)">clique</a>');
    expect(md).toContain('_[gráfico: CPL por dia]_');
    expect(md).not.toContain('alert');
    expect(md).not.toContain('<svg');
    expect(md).not.toMatch(/\(javascript:/);
    expect(md).toContain('clique');
  });
  it('decodifica entidades e entrega texto simples sem marcação', () => {
    expect(htmlParaMarkdown('<p>R$ 1 &amp; 2 &lt; 3 &nbsp;fim</p>')).toBe('R$ 1 & 2 < 3  fim'.replace('  ', ' '));
    const t = htmlParaTexto('<h2>Título</h2><p>Um <b>forte</b> e <a href="https://x.com">link</a></p><table><tr><th>A</th></tr><tr><td>1</td></tr></table>');
    expect(t).not.toMatch(/[#*]/);
    expect(t).toContain('Título');
    expect(t).toContain('Um forte e link (https://x.com)');
    expect(t).not.toContain('---');
  });
});

describe('Integrações: configuração', () => {
  it('Sheets: sem as três variáveis não está configurado; aceita a chave com \\n escapado; recusa ID estranho', () => {
    expect(sheetsConfigDoAmbiente({})).toBeNull();
    expect(sheetsConfigDoAmbiente({ GOOGLE_SA_CLIENT_EMAIL: 'sa@p.iam.gserviceaccount.com', GOOGLE_SA_PRIVATE_KEY: chave.replace(/\n/g, '\\n') })).toBeNull(); // falta o ID
    const c = sheetsConfigDoAmbiente({ GOOGLE_SA_CLIENT_EMAIL: 'sa@p.iam.gserviceaccount.com', GOOGLE_SA_PRIVATE_KEY: chave.replace(/\n/g, '\\n'), SHEETS_PLANILHA_ID: ID_PLANILHA })!;
    expect(c.privateKey).toContain('\n');
    expect(c.abaExperimentos).toBe('Experimentos Quark Dados');
    expect(c.abaDocumentacao).toBe('Documentação completa');
    expect(() => sheetsConfigDoAmbiente({ GOOGLE_SA_CLIENT_EMAIL: 'a', GOOGLE_SA_PRIVATE_KEY: 'b', SHEETS_PLANILHA_ID: 'https://docs.google.com/x' })).toThrow(/SHEETS_PLANILHA_ID/);
  });
  it('ClickUp: precisa de token, workspace e Doc; recusa IDs fora do formato', () => {
    expect(clickUpConfigDoAmbiente({ CLICKUP_TOKEN: 't' })).toBeNull();
    expect(clickUpConfigDoAmbiente({ CLICKUP_TOKEN: 'pk_1', CLICKUP_WORKSPACE_ID: '9011315768', CLICKUP_DOC_ID: '8chvh1r-31291' })).toEqual({ token: 'pk_1', workspaceId: '9011315768', docId: '8chvh1r-31291' });
    expect(() => clickUpConfigDoAmbiente({ CLICKUP_TOKEN: 't', CLICKUP_WORKSPACE_ID: 'abc', CLICKUP_DOC_ID: '8chvh1r-31291' })).toThrow(/WORKSPACE/);
    expect(() => clickUpConfigDoAmbiente({ CLICKUP_TOKEN: 't', CLICKUP_WORKSPACE_ID: '9011315768', CLICKUP_DOC_ID: '../x' })).toThrow(/DOC_ID/);
  });
});

type Chamada = { url: string; metodo: string; corpo: any; auth?: string };
function fake(resposta: (c: Chamada) => { status?: number; corpo?: unknown }) {
  const chamadas: Chamada[] = [];
  const f = (async (url: string, init: any = {}) => {
    const c: Chamada = { url, metodo: init.method ?? 'GET', auth: init.headers?.authorization, corpo: typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body };
    chamadas.push(c);
    const r = resposta(c);
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.corpo ?? {} };
  }) as unknown as typeof fetch;
  return { f, chamadas };
}

describe('Integrações: Google Sheets (simulado)', () => {
  const cfg = { clientEmail: 'sa@p.iam.gserviceaccount.com', privateKey: chave, planilhaId: ID_PLANILHA, abaExperimentos: 'Experimentos Quark Dados', abaDocumentacao: 'Documentação completa' };
  it('autentica pela conta de serviço, cria só a guia que falta e escreve como texto puro', async () => {
    const { f, chamadas } = fake((c) => {
      if (c.url.includes('oauth2.googleapis.com')) return { corpo: { access_token: 'tok', expires_in: 3600 } };
      if (c.metodo === 'GET') return { corpo: { sheets: [{ properties: { title: 'Guia antiga' } }, { properties: { title: 'Experimentos Quark Dados' } }] } };
      return { corpo: {} };
    });
    const s = new SheetsClient(cfg, f);
    await s.garantirAba('Experimentos Quark Dados');
    await s.garantirAba('Documentação completa');
    await s.reescrever("Guia d'um", [['ID', 'Título'], ['1', '=HYPERLINK("http://x")']]);
    const tok = chamadas.find((c) => c.url.includes('oauth2'))!;
    expect(String(tok.corpo)).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    const jwt = new URLSearchParams(String(tok.corpo)).get('assertion')!.split('.');
    expect(JSON.parse(Buffer.from(jwt[1]!, 'base64url').toString()).scope).toBe('https://www.googleapis.com/auth/spreadsheets');
    const adds = chamadas.filter((c) => c.url.endsWith(':batchUpdate'));
    expect(adds).toHaveLength(1); // só a "Documentação completa" faltava; a antiga e a existente não são tocadas
    expect(adds[0]!.corpo).toEqual({ requests: [{ addSheet: { properties: { title: 'Documentação completa' } } }] });
    const limpa = chamadas.find((c) => c.url.includes(':clear'))!;
    expect(limpa.url).toContain(`/spreadsheets/${ID_PLANILHA}/values/${encodeURIComponent("'Guia d''um'")}:clear`);
    const grava = chamadas.find((c) => c.metodo === 'PUT')!;
    expect(grava.url).toContain('valueInputOption=RAW'); // nada vira fórmula
    expect(grava.corpo.values[1][1]).toBe('=HYPERLINK("http://x")');
    expect(grava.auth).toBe('Bearer tok');
    expect(chamadas.filter((c) => c.url.includes('oauth2'))).toHaveLength(1); // o token é reaproveitado
  });
  it('sem acesso à planilha, a mensagem diz com quem compartilhar', async () => {
    const { f } = fake((c) => (c.url.includes('oauth2') ? { corpo: { access_token: 'tok' } } : { status: 403, corpo: { error: { status: 'PERMISSION_DENIED' } } }));
    await expect(new SheetsClient(cfg, f).garantirAba('x')).rejects.toThrow(/Compartilhe com sa@p\.iam\.gserviceaccount\.com/);
    const { f: f2 } = fake(() => ({ status: 401, corpo: { error: 'invalid_grant' } }));
    await expect(new SheetsClient(cfg, f2).garantirAba('x')).rejects.toThrow(/autenticar no Google/);
  });
});

describe('Integrações: ClickUp (simulado)', () => {
  const cfg = { token: 'pk_segredo', workspaceId: '9011315768', docId: '8chvh1r-31291' };
  it('cria e atualiza a página com o token no cabeçalho e Markdown; o link segue o padrão do ClickUp', async () => {
    const { f, chamadas } = fake((c) => (c.metodo === 'POST' ? { status: 201, corpo: { id: '8chvh1r-9999' } } : { corpo: {} }));
    const c = new ClickUpClient(cfg, f);
    const id = await c.criarPagina('#1 Teste', '# oi');
    expect(id).toBe('8chvh1r-9999');
    await c.atualizarPagina(id, '#1 Teste', '# oi 2');
    expect(chamadas[0]).toMatchObject({ metodo: 'POST', url: 'https://api.clickup.com/api/v3/workspaces/9011315768/docs/8chvh1r-31291/pages', auth: 'pk_segredo' });
    expect(chamadas[0]!.corpo).toEqual({ name: '#1 Teste', content: '# oi', content_format: 'text/md' });
    expect(chamadas[1]).toMatchObject({ metodo: 'PUT', url: 'https://api.clickup.com/api/v3/workspaces/9011315768/docs/8chvh1r-31291/pages/8chvh1r-9999' });
    expect(chamadas[1]!.corpo).toEqual({ name: '#1 Teste', content: '# oi 2', content_edit_mode: 'replace', content_format: 'text/md' });
    expect(c.urlPagina('8chvh1r-9999')).toBe('https://app.clickup.com/9011315768/v/dc/8chvh1r-31291/8chvh1r-9999');
  });
  it('traduz os erros do ClickUp e não vaza o token', async () => {
    for (const [status, msg] of [[401, /CLICKUP_TOKEN/], [404, /CLICKUP_DOC_ID/], [500, /recusou a operação/]] as const) {
      const { f } = fake(() => ({ status, corpo: {} }));
      const err = await new ClickUpClient(cfg, f).criarPagina('x', 'y').catch((e) => e);
      expect(err).toBeInstanceOf(IntegracaoErro);
      expect(err.message).toMatch(msg);
      expect(err.message).not.toContain('pk_segredo');
    }
    const { f: semId } = fake(() => ({ status: 201, corpo: {} }));
    await expect(new ClickUpClient(cfg, semId).criarPagina('x', 'y')).rejects.toThrow(/não devolveu o ID/);
  });
});

describe('Integrações: conteúdo das guias e orquestração', () => {
  const exp = (o: Partial<ExperimentoParaSync> = {}): ExperimentoParaSync => ({
    id: 3, titulo: 'Campanha de Diagnóstico', tipo: 'experimento', responsavel: 'Pablo', areaImpacto: 'Anúncio', hipotese: 'Baixar o CPL', resultadoEsperado: 'CPL de R$ 30', produto: 'rh', canal: 'meta',
    metrica: 'cpl', meta: 30, linhaBase: null, investimento: 9000, inicio: '2026-09-25', fim: '2026-11-08', status: 'rodando', avaliacao: null, evidencias: 'link', temDocumentacao: true,
    paginaHost: 'quarkrh-diagnostico.lovable.app', paginaCaminho: '/', campanhas: [{ id: '120251054032640158', nome: 'Diag 77' }], identificadorConversao: 'diagnostico-quarkrh', escopoModo: 'campanha_so_investimento',
    contabilizacao: 'manual', regras: [{ metrica: 'leads', formula: [{ k: 'campo', v: 'identificador.leads' }] }], clickupPaginaId: null, clickupUrl: null,
    iceImpacto: 5, iceConfianca: 5, iceFacilidade: 2, iceScore: 4, valorFinal: null, atingimentoFinal: null, desfecho: null, aprendizado: 'Aprendeu', criadoEm: '', atualizadoEm: '2026-10-27T10:00:00Z',
    progresso: { estado: 'em_linha', atual: 22.8314545, atingimento: 0.91, gasto: 2511, esperado: 30, dadosAte: '2026-10-26', diasCompletos: 32, totalDias: 45, decorrido: 0.7, linhaBase: null, linhaBaseAuto: true, projecao: null, usoOrcamento: 0.3, orcamentoAdiantado: false, serie: [], trajetoria: null },
    documentacaoHtml: '<h1>Doc</h1><p>Texto <b>forte</b></p>', ...o,
  } as ExperimentoParaSync);
  const rotulo = (id: string | null) => (id === 'cpl' ? 'CPL' : (id ?? ''));

  it('a guia principal tem uma linha por experimento, na ordem do cabeçalho, com números puros', () => {
    const l = linhasExperimentos([exp(), exp({ id: 4, titulo: 'Ideia', metrica: null, meta: null, contabilizacao: 'automatica', regras: [], campanhas: [], paginaCaminho: null, identificadorConversao: null, clickupUrl: 'https://app.clickup.com/1/v/dc/2/3', progresso: { ...exp().progresso, estado: 'sem_metrica', atual: null, atingimento: null, gasto: 0 } })], rotulo);
    expect(l[0]).toEqual(CABECALHO_EXPERIMENTOS);
    expect(l[1]).toHaveLength(CABECALHO_EXPERIMENTOS.length);
    const col = (nome: string) => CABECALHO_EXPERIMENTOS.indexOf(nome);
    expect(l[1]![col('ID')]).toBe('3');
    expect(l[1]![col('Página de destino')]).toBe('quarkrh-diagnostico.lovable.app/');
    expect(l[1]![col('Campanhas (Meta)')]).toBe('Diag 77 (120251054032640158)');
    expect(l[1]![col('Contabilização')]).toBe('Manual (1 regras)');
    expect(l[1]![col('Real (atual)')]).toBe('22.8315');
    expect(l[1]![col('Atingimento')]).toBe('0.91');
    expect(l[1]![col('Situação')]).toBe('Em linha');
    expect(l[1]![col('Gasto real (R$)')]).toBe('2511');
    expect(l[2]![col('Real (atual)')]).toBe('');
    expect(l[2]![col('Situação')]).toBe('Sem acompanhamento');
    expect(l[2]![col('Documentação (ClickUp)')]).toBe('https://app.clickup.com/1/v/dc/2/3');
  });
  it('a guia de documentação traz os textos longos em texto simples, o link e corta o que passa do limite da célula', () => {
    const l = linhasDocumentacao([exp({ clickupUrl: 'https://app.clickup.com/1/v/dc/2/3', aprendizado: 'x'.repeat(60_000) })]);
    expect(l[0]).toEqual(CABECALHO_DOCUMENTACAO);
    const col = (nome: string) => CABECALHO_DOCUMENTACAO.indexOf(nome);
    expect(l[1]![col('Documento no ClickUp')]).toBe('https://app.clickup.com/1/v/dc/2/3');
    expect(l[1]![col('Hipótese')]).toBe('Baixar o CPL');
    expect(l[1]![col('Texto da documentação')]).toContain('Texto forte');
    expect(l[1]![col('Texto da documentação')]).not.toContain('<');
    expect(l[1]![col('Aprendizados')]!.length).toBeLessThanOrEqual(45_000);
    expect(l[1]![col('Aprendizados')]!).toContain('texto cortado');
  });
  it('a página do ClickUp usa a documentação salva ou, sem ela, um resumo do cadastro', () => {
    expect(markdownDoExperimento(exp(), rotulo)).toContain('# Doc');
    const resumo = markdownDoExperimento(exp({ documentacaoHtml: null }), rotulo);
    expect(resumo).toContain('# Campanha de Diagnóstico');
    expect(resumo).toContain('## Métrica chave');
    expect(resumo).toContain('Quark Dados');
  });

  function montar(opts: { sheets?: boolean; clickup?: boolean; sheetsFalha?: boolean; paginaExistente?: string | null }) {
    const registrados: Array<[number, string, string]> = [];
    const repo: RepoSync = {
      async paraSincronizar() { return [exp({ clickupPaginaId: opts.paginaExistente ?? null })]; },
      async paraClickUp() { return exp({ clickupPaginaId: opts.paginaExistente ?? null }); },
      async registrarClickUp(id, p, u) { registrados.push([id, p, u]); },
    };
    const gs = fake((c) => {
      if (c.url.includes('oauth2')) return { corpo: { access_token: 't' } };
      if (opts.sheetsFalha) return { status: 403 };
      return { corpo: c.metodo === 'GET' ? { sheets: [] } : {} };
    });
    const cu = fake((c) => (c.metodo === 'POST' ? { status: 201, corpo: { id: 'pag-1' } } : {}));
    const integ = new Integracoes(repo, opts.sheets === false ? null : new SheetsClient({ clientEmail: 'sa@p', privateKey: chave, planilhaId: ID_PLANILHA, abaExperimentos: 'A', abaDocumentacao: 'B' }, gs.f), opts.clickup === false ? null : new ClickUpClient({ token: 't', workspaceId: '123456', docId: 'doc-1' }, cu.f), 'segredo-cron');
    return { integ, registrados, gs, cu };
  }
  it('sincronizar a planilha reescreve as duas guias; sem configuração responde 503', async () => {
    const { integ, gs } = montar({});
    expect(await integ.sincronizarPlanilha()).toEqual({ experimentos: 1, abas: ['A', 'B'] });
    expect(gs.chamadas.filter((c) => c.metodo === 'PUT')).toHaveLength(2);
    await expect(montar({ sheets: false }).integ.sincronizarPlanilha()).rejects.toMatchObject({ status: 503 });
    expect(montar({}).integ.status()).toMatchObject({ sheets: { configurado: true, contaDeServico: 'sa@p' }, clickup: { configurado: true }, cron: true });
  });
  it('enviar ao ClickUp cria a página na primeira vez, atualiza a mesma depois, guarda o link e atualiza a planilha', async () => {
    const novo = montar({});
    const r1 = await novo.integ.enviarClickUp(3);
    expect(r1).toMatchObject({ criada: true, planilha: 'ok', url: 'https://app.clickup.com/123456/v/dc/doc-1/pag-1' });
    expect(novo.registrados).toEqual([[3, 'pag-1', 'https://app.clickup.com/123456/v/dc/doc-1/pag-1']]);
    expect(novo.cu.chamadas[0]!.corpo.name).toBe('#3 Campanha de Diagnóstico');
    expect(novo.cu.chamadas[0]!.corpo.content).toContain('# Doc');
    const de_novo = montar({ paginaExistente: 'pag-1' });
    const r2 = await de_novo.integ.enviarClickUp(3);
    expect(r2.criada).toBe(false);
    expect(de_novo.cu.chamadas[0]!.metodo).toBe('PUT'); // atualiza, não duplica
  });
  it('se a planilha falhar, o ClickUp já foi enviado e o aviso diz o que houve; sem ClickUp configurado, 503', async () => {
    const r = await montar({ sheetsFalha: true }).integ.enviarClickUp(3);
    expect(r.planilha).toBe('erro');
    expect(r.aviso).toMatch(/Compartilhe com/);
    expect((await montar({ sheets: false }).integ.enviarClickUp(3)).planilha).toBe('nao_configurada');
    await expect(montar({ clickup: false }).integ.enviarClickUp(3)).rejects.toMatchObject({ status: 503 });
  });
});

describe('Integrações: rotas do servidor', () => {
  const chamadas: string[] = [];
  const integ = {
    cronSecret: 'segredo-cron-de-teste',
    status: () => ({ sheets: { configurado: true }, clickup: { configurado: false }, cron: true }),
    async sincronizarPlanilha() { chamadas.push('sync'); return { experimentos: 2, abas: ['A', 'B'] }; },
    async enviarClickUp(id: number) { chamadas.push(`clickup:${id}`); if (id === 9) throw new IntegracaoErro(404, 'não achou'); return { url: 'https://app.clickup.com/x', criada: true, planilha: 'ok' as const }; },
  } as unknown as Integracoes;
  const auth: AuthService = {
    async entrar(email, senha) { return senha === 'Senha12345' ? { id: '00000000-0000-0000-0000-00000000000e', email, nome: 'Ed', papel: 'editor' as Papel } : null; },
    async vigente() { return 'editor'; }, async listar() { return []; }, async criar() { throw new Error('x'); }, async atualizar() { throw new Error('x'); }, async remover() { /* nada */ },
  };
  let publico: Server, local: Server, localSem: Server, urlP: string, urlL: string, urlS: string, dir: string;
  const mk = (extra: object) => createStudioServer({ formsDir: join(dir, 'f'), publicDir: join(dir, 'p'), trackingDir: join(dir, 't'), sources: [], dbInfo: () => ({ connected: true }), submit: async () => ({ status: 200, body: {} }), ...extra } as never);
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'studio-integ-'));
    for (const d of ['f', 'p', 't']) mkdirSync(join(dir, d));
    publico = mk({ integracoes: integ, acesso: { servico: auth, segredo: 'segredo-de-teste-com-mais-de-32-caracteres!!', seguro: true } });
    local = mk({ integracoes: integ });
    localSem = mk({});
    await Promise.all([publico, local, localSem].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    const u = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    urlP = u(publico); urlL = u(local); urlS = u(localSem);
  });
  afterAll(async () => { await Promise.all([publico, local, localSem].map((s) => new Promise((r) => s.close(r)))); rmSync(dir, { recursive: true, force: true }); });
  const post = (base: string, path: string, cookie?: string) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: '{}' });

  it('local: estado, sincronizar e enviar; erro do ClickUp vira 502 com a mensagem; sem integrações, 503 com o que falta', async () => {
    expect(await (await fetch(`${urlL}/api/integracoes`)).json()).toMatchObject({ sheets: { configurado: true }, clickup: { configurado: false } });
    expect(await (await post(urlL, '/api/experimentos/sincronizar')).json()).toEqual({ experimentos: 2, abas: ['A', 'B'] });
    expect(await (await post(urlL, '/api/experimentos/3/clickup')).json()).toMatchObject({ url: 'https://app.clickup.com/x', criada: true });
    const erro = await post(urlL, '/api/experimentos/9/clickup');
    expect(erro.status).toBe(502);
    expect((await erro.json()).detail).toBe('não achou');
    const sem = await post(urlS, '/api/experimentos/sincronizar');
    expect(sem.status).toBe(503);
    expect((await sem.json()).error).toBe('integracao_nao_configurada');
    expect((await post(urlS, '/api/experimentos/3/clickup')).status).toBe(503);
    expect(await (await fetch(`${urlS}/api/integracoes`)).json()).toMatchObject({ sheets: { configurado: false }, clickup: { configurado: false } });
  });
  it('publicado: as rotas exigem login; o cron só aceita o segredo certo e nunca por cookie ou parâmetro', async () => {
    expect((await post(urlP, '/api/experimentos/sincronizar')).status).toBe(401);
    expect((await post(urlP, '/api/experimentos/3/clickup')).status).toBe(401);
    const login = await post(urlP, '/api/login');
    expect(login.status).toBe(401);
    const entrou = await fetch(`${urlP}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: urlP }, body: JSON.stringify({ email: 'ed@quark.com', senha: 'Senha12345' }) });
    const cookie = (entrou.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect((await post(urlP, '/api/experimentos/sincronizar', cookie)).status).toBe(200);
    expect((await post(urlP, '/api/experimentos/3/clickup', cookie)).status).toBe(200);
    const antes = chamadas.length;
    expect((await fetch(`${urlP}/api/cron/experimentos`)).status).toBe(401);
    expect((await fetch(`${urlP}/api/cron/experimentos`, { headers: { authorization: 'Bearer errado' } })).status).toBe(401);
    expect((await fetch(`${urlP}/api/cron/experimentos?secret=segredo-cron-de-teste`)).status).toBe(401);
    expect((await fetch(`${urlP}/api/cron/experimentos`, { headers: { cookie } })).status).toBe(401);
    expect(chamadas.length).toBe(antes);
    const ok = await fetch(`${urlP}/api/cron/experimentos`, { headers: { authorization: 'Bearer segredo-cron-de-teste' } });
    expect(ok.status).toBe(200);
    expect(chamadas.at(-1)).toBe('sync');
  });
  it('o cron está agendado e as chaves não estão no código', () => {
    const vj = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    expect(vj.crons).toEqual([{ path: '/api/cron/experimentos', schedule: '0 11 * * *' }]);
    const fontes = ['../studio/lib/integracoes.ts', '../api/studio.ts'].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
    expect(fontes).not.toMatch(/pk_[0-9]|-----BEGIN/);
    expect(readFileSync(new URL('../studio/public/experimentos.html', import.meta.url), 'utf8')).toContain('id="sync-sheets"');
    expect(readFileSync(new URL('../studio/public/experimentos-doc.js', import.meta.url), 'utf8')).toContain('/clickup');
  });
});
