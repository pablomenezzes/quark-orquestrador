/**
 * Integrações do Quark Dados (pedido do Pablo, 2026-10-27): o app continua sendo a fonte dos experimentos.
 *  - Google Sheets: uma cópia para a planilha existente, em guias NOVAS (nunca toca nas guias que já existem): "Experimentos Quark Dados" (uma linha por
 *    experimento, os campos curtos e os números) e "Documentação completa" (os textos longos e o link do documento no ClickUp). A cópia é reescrita por inteiro a
 *    cada sincronização (as duas guias são do app: edição manual nelas é sobrescrita). Valores entram como TEXTO PURO (valueInputOption RAW): nada vira fórmula.
 *  - ClickUp: uma página de Doc por experimento, dentro de um Doc que o Pablo escolhe (CLICKUP_DOC_ID). Enviar de novo atualiza a mesma página.
 * Credenciais só em variáveis de ambiente (nunca no código): GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_PRIVATE_KEY, SHEETS_PLANILHA_ID, CLICKUP_TOKEN,
 * CLICKUP_WORKSPACE_ID e CLICKUP_DOC_ID. A conta de serviço precisa de acesso de editora à planilha.
 */
import { createSign } from 'node:crypto';
import { htmlParaMarkdown, htmlParaTexto } from './html-para-md.js';
import { METRICAS_EXP, type ExperimentoComProgresso } from './experimentos.js';
import { filtroTexto } from './experimentos-escopo.js';

type FetchLike = typeof fetch;
export class IntegracaoErro extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/* ---------- Google Sheets ---------- */
export interface SheetsConfig { clientEmail: string; privateKey: string; planilhaId: string; abaExperimentos: string; abaDocumentacao: string }
export function sheetsConfigDoAmbiente(env: Record<string, string | undefined>): SheetsConfig | null {
  const clientEmail = env.GOOGLE_SA_CLIENT_EMAIL, raw = env.GOOGLE_SA_PRIVATE_KEY, planilhaId = env.SHEETS_PLANILHA_ID?.trim();
  if (!clientEmail || !raw || !planilhaId) return null;
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(planilhaId)) throw new Error('SHEETS_PLANILHA_ID inválido (use só o ID que fica na URL da planilha, entre /d/ e /edit).');
  const privateKey = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw.replace(/\\n/g, '\n');
  return { clientEmail, privateKey, planilhaId, abaExperimentos: env.SHEETS_ABA?.trim() || 'Experimentos Quark Dados', abaDocumentacao: env.SHEETS_ABA_DOC?.trim() || 'Documentação completa' };
}

export class SheetsClient {
  private token: { valor: string; expira: number } | null = null;
  constructor(private readonly c: SheetsConfig, private readonly f: FetchLike = fetch) {}
  get email(): string { return this.c.clientEmail; }
  private async accessToken(): Promise<string> {
    const agora = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expira - 60 > agora) return this.token.valor;
    const corpo = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: this.c.clientEmail, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600 })}`;
    const assinatura = createSign('RSA-SHA256').update(corpo).sign(this.c.privateKey, 'base64url');
    const r = await this.f('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${corpo}.${assinatura}` }).toString() });
    const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!r.ok || !j.access_token) throw new IntegracaoErro(502, `Não foi possível autenticar no Google (${j.error ?? r.status}).`);
    this.token = { valor: j.access_token, expira: agora + Number(j.expires_in ?? 3600) };
    return this.token.valor;
  }
  private async chamar(metodo: string, caminho: string, corpo?: unknown): Promise<Record<string, unknown>> {
    const r = await this.f(`https://sheets.googleapis.com/v4/spreadsheets/${this.c.planilhaId}${caminho}`, {
      method: metodo, headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' }, ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: { status?: string; message?: string } };
    if (!r.ok) {
      if (r.status === 403 || r.status === 404) throw new IntegracaoErro(r.status, `O Google não deixou acessar a planilha. Compartilhe com ${this.c.clientEmail} como editora e confira o ID e se a Google Sheets API está ativada.`);
      throw new IntegracaoErro(502, `Google Sheets recusou a operação (${r.status}: ${j.error?.status ?? ''}).`);
    }
    return j;
  }
  /** Cria a guia se ainda não existe. Nunca mexe nas guias existentes. */
  async garantirAba(titulo: string): Promise<void> {
    const j = (await this.chamar('GET', '?fields=sheets.properties.title')) as { sheets?: Array<{ properties?: { title?: string } }> };
    if ((j.sheets ?? []).some((s) => s.properties?.title === titulo)) return;
    await this.chamar('POST', ':batchUpdate', { requests: [{ addSheet: { properties: { title: titulo } } }] });
  }
  /** Limpa a guia e escreve tudo de novo (cabeçalho + linhas), como texto puro. */
  async reescrever(titulo: string, linhas: string[][]): Promise<void> {
    const faixa = encodeURIComponent(`'${titulo.replace(/'/g, "''")}'`);
    await this.chamar('POST', `/values/${faixa}:clear`, {});
    if (!linhas.length) return;
    await this.chamar('PUT', `/values/${faixa}!A1?valueInputOption=RAW`, { range: `'${titulo.replace(/'/g, "''")}'!A1`, majorDimension: 'ROWS', values: linhas });
  }
  get abas() { return { experimentos: this.c.abaExperimentos, documentacao: this.c.abaDocumentacao }; }
}

/* ---------- ClickUp ---------- */
export interface ClickUpConfig { token: string; workspaceId: string; docId: string }
export function clickUpConfigDoAmbiente(env: Record<string, string | undefined>): ClickUpConfig | null {
  const token = env.CLICKUP_TOKEN?.trim(), workspaceId = env.CLICKUP_WORKSPACE_ID?.trim(), docId = env.CLICKUP_DOC_ID?.trim();
  if (!token || !workspaceId || !docId) return null;
  if (!/^\d{3,15}$/.test(workspaceId)) throw new Error('CLICKUP_WORKSPACE_ID inválido (só números).');
  if (!/^[A-Za-z0-9-]{3,40}$/.test(docId)) throw new Error('CLICKUP_DOC_ID inválido.');
  return { token, workspaceId, docId };
}

export class ClickUpClient {
  constructor(private readonly c: ClickUpConfig, private readonly f: FetchLike = fetch) {}
  private base = () => `https://api.clickup.com/api/v3/workspaces/${this.c.workspaceId}/docs/${this.c.docId}/pages`;
  private async chamar(metodo: string, url: string, corpo: unknown): Promise<Record<string, unknown>> {
    const r = await this.f(url, { method: metodo, headers: { authorization: this.c.token, 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) throw new IntegracaoErro(r.status, 'O ClickUp recusou o token: confira CLICKUP_TOKEN e o acesso ao Doc.');
      if (r.status === 404) throw new IntegracaoErro(404, 'O ClickUp não achou o Doc ou a página: confira CLICKUP_WORKSPACE_ID e CLICKUP_DOC_ID.');
      throw new IntegracaoErro(502, `O ClickUp recusou a operação (${r.status}).`);
    }
    return j;
  }
  urlPagina = (paginaId: string): string => `https://app.clickup.com/${this.c.workspaceId}/v/dc/${this.c.docId}/${paginaId}`;
  async criarPagina(nome: string, markdown: string): Promise<string> {
    const j = await this.chamar('POST', this.base(), { name: nome, content: markdown, content_format: 'text/md' });
    if (typeof j.id !== 'string') throw new IntegracaoErro(502, 'O ClickUp não devolveu o ID da página.');
    return j.id;
  }
  async atualizarPagina(paginaId: string, nome: string, markdown: string): Promise<void> {
    await this.chamar('PUT', `${this.base()}/${encodeURIComponent(paginaId)}`, { name: nome, content: markdown, content_edit_mode: 'replace', content_format: 'text/md' });
  }
}

/* ---------- conteúdo (puro) ---------- */
const CELULA_MAX = 45_000; // a célula do Sheets aceita 50 mil caracteres
const AVISO_CORTE = '\n[texto cortado: veja o documento completo]';
const corta = (s: string, max = CELULA_MAX) => (s.length > max ? `${s.slice(0, max - AVISO_CORTE.length)}${AVISO_CORTE}` : s);
const n = (v: number | null | undefined, casas = 4): string => (v == null || !Number.isFinite(v) ? '' : String(Math.round(v * 10 ** casas) / 10 ** casas));
const iso = (s: string | null) => s ?? '';

export interface ExperimentoParaSync extends ExperimentoComProgresso { documentacaoHtml: string | null }
const ESTADO = { carregando: 'Calculando', sem_metrica: 'Sem acompanhamento', cancelado: 'Cancelado', nao_iniciou: 'Ainda não começou', cedo: 'Poucos dias de dados', sem_dados: 'Sem dados', atingida: 'Meta atingida', em_linha: 'Em linha', atencao: 'Atenção', fora: 'Abaixo do previsto' } as const;

export const CABECALHO_EXPERIMENTOS = ['ID', 'Título', 'Tipo', 'Status', 'Responsável', 'Área de impacto', 'Produto', 'Canal', 'Página de destino', 'Campanhas (Meta)', 'Identificador de conversão', 'Filtros por campo (Pipedrive)', 'Contabilização', 'Métrica chave', 'Meta', 'Real (atual)', 'Atingimento', 'Situação', 'Investimento previsto (R$)', 'Gasto real (R$)', 'Início', 'Fim', 'ICE', 'Avaliação', 'Desfecho', 'Documentação (ClickUp)', 'Atualizado em'];
export function linhasExperimentos(exps: readonly ExperimentoParaSync[], rotuloMetrica: (id: string | null) => string): string[][] {
  return [CABECALHO_EXPERIMENTOS, ...exps.map((e) => [
    String(e.id), e.titulo, e.tipo, e.status, e.responsavel ?? '', e.areaImpacto ?? '', e.produto, e.canal,
    e.paginaCaminho ? `${e.paginaHost ?? ''}${e.paginaCaminho}` : '', e.campanhas.map((c) => (c.id ? `${c.nome ?? 'Campanha'} (${c.id})` : (c.nome ?? ''))).join('; '), e.identificadorConversao ?? '', e.filtros.map(filtroTexto).join('; '),
    e.contabilizacao === 'manual' ? `Manual (${e.regras.length} regras)` : 'Automática', rotuloMetrica(e.metrica), n(e.meta), n(e.progresso.atual), n(e.progresso.atingimento), ESTADO[e.progresso.estado],
    n(e.investimento, 2), n(e.progresso.gasto, 2), iso(e.inicio), iso(e.fim), n(e.iceScore, 2), e.avaliacao ?? '', e.desfecho ?? '', e.clickupUrl ?? '', e.atualizadoEm,
  ])];
}
export const CABECALHO_DOCUMENTACAO = ['ID', 'Título', 'Documento no ClickUp', 'Hipótese', 'Resultado esperado', 'Evidências', 'Aprendizados', 'Texto da documentação', 'Atualizado em'];
export function linhasDocumentacao(exps: readonly ExperimentoParaSync[]): string[][] {
  return [CABECALHO_DOCUMENTACAO, ...exps.map((e) => [
    String(e.id), e.titulo, e.clickupUrl ?? '', corta(e.hipotese ?? ''), corta(e.resultadoEsperado ?? ''), corta(e.evidencias ?? ''), corta(e.aprendizado ?? ''), e.documentacaoHtml ? corta(htmlParaTexto(e.documentacaoHtml)) : '', e.atualizadoEm,
  ])];
}

/** Markdown da página do ClickUp: a documentação salva, ou um resumo do cadastro se ainda não existe. */
export function markdownDoExperimento(e: ExperimentoParaSync, rotuloMetrica: (id: string | null) => string): string {
  const cab = `> Gerado pelo Quark Dados em ${new Date().toISOString().slice(0, 10)}. A fonte é o Quark Dados: edições feitas aqui são sobrescritas no próximo envio.\n\n`;
  if (e.documentacaoHtml) return cab + htmlParaMarkdown(e.documentacaoHtml);
  const linhas = [
    `# ${e.titulo}`, '',
    `**Status:** ${e.status}${e.responsavel ? ` · **Responsável:** ${e.responsavel}` : ''}`, '',
    e.hipotese ? `## Hipótese\n\n${e.hipotese}\n` : '', e.resultadoEsperado ? `## Resultado esperado\n\n${e.resultadoEsperado}\n` : '',
    e.metrica ? `## Métrica chave\n\n${rotuloMetrica(e.metrica)}: real ${n(e.progresso.atual)} contra meta ${n(e.meta)} (${ESTADO[e.progresso.estado]}).\n` : '',
    e.aprendizado ? `## Aprendizados\n\n${e.aprendizado}\n` : '',
  ];
  return cab + linhas.filter((x) => x !== '').join('\n');
}

/* ---------- orquestração ---------- */
export interface RepoSync {
  /** Todos os experimentos com o progresso e a documentação salva. */
  paraSincronizar(): Promise<ExperimentoParaSync[]>;
  paraClickUp(id: number): Promise<ExperimentoParaSync>;
  registrarClickUp(id: number, paginaId: string, url: string): Promise<void>;
}
const rotuloMetrica = (id: string | null): string => (id ? (METRICAS_EXP.find((m) => m.id === id)?.rotulo ?? id) : '');

export class Integracoes {
  constructor(private readonly repo: RepoSync, private readonly sheets: SheetsClient | null, private readonly clickup: ClickUpClient | null, readonly cronSecret: string | null = null) {}
  status() {
    return { sheets: { configurado: !!this.sheets, abas: this.sheets?.abas ?? null, contaDeServico: this.sheets?.email ?? null }, clickup: { configurado: !!this.clickup }, cron: !!this.cronSecret };
  }
  /** Reescreve as duas guias da planilha com o estado atual dos experimentos. */
  async sincronizarPlanilha(): Promise<{ experimentos: number; abas: string[] }> {
    if (!this.sheets) throw new IntegracaoErro(503, 'Google Sheets não configurado: faltam GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_PRIVATE_KEY e SHEETS_PLANILHA_ID.');
    const exps = await this.repo.paraSincronizar();
    const { experimentos, documentacao } = this.sheets.abas;
    await this.sheets.garantirAba(experimentos);
    await this.sheets.garantirAba(documentacao);
    await this.sheets.reescrever(experimentos, linhasExperimentos(exps, rotuloMetrica));
    await this.sheets.reescrever(documentacao, linhasDocumentacao(exps));
    return { experimentos: exps.length, abas: [experimentos, documentacao] };
  }
  /** Cria (ou atualiza) a página do experimento no Doc do ClickUp e guarda o link; em seguida atualiza a planilha, se ela estiver configurada. */
  async enviarClickUp(id: number): Promise<{ url: string; criada: boolean; planilha: 'ok' | 'nao_configurada' | 'erro'; aviso?: string }> {
    if (!this.clickup) throw new IntegracaoErro(503, 'ClickUp não configurado: faltam CLICKUP_TOKEN, CLICKUP_WORKSPACE_ID e CLICKUP_DOC_ID.');
    const e = await this.repo.paraClickUp(id);
    const nome = `#${e.id} ${e.titulo}`.slice(0, 200);
    const md = markdownDoExperimento(e, rotuloMetrica);
    let paginaId = e.clickupPaginaId;
    const criada = !paginaId;
    if (paginaId) await this.clickup.atualizarPagina(paginaId, nome, md);
    else paginaId = await this.clickup.criarPagina(nome, md);
    const url = this.clickup.urlPagina(paginaId);
    await this.repo.registrarClickUp(id, paginaId, url);
    if (!this.sheets) return { url, criada, planilha: 'nao_configurada' };
    try { await this.sincronizarPlanilha(); return { url, criada, planilha: 'ok' }; } catch (err) { return { url, criada, planilha: 'erro', aviso: err instanceof Error ? err.message : 'falha ao atualizar a planilha' }; }
  }
}
