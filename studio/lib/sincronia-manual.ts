/**
 * Gatilho manual da sincronização (pedido do Pablo, 2026-10-27): um botão na aba "Saúde da sincronização" do Painel de Dados que PEDE ao GitHub Actions para rodar
 * agora o mesmo workflow que já roda de 2 em 2 horas. A sincronização não roda dentro do Studio (é longa: Pipedrive, GA4 e Meta, até 45 minutos) e continua com as
 * suas credenciais só nos segredos do GitHub: o Studio guarda apenas um token que SÓ consegue disparar workflows deste repositório.
 *
 *   Variável (só no ambiente, nunca no código): GITHUB_DISPATCH_TOKEN = token fine-grained do GitHub, repositório quark-orquestrador, permissão "Actions: Read and write".
 *   Opcionais: GITHUB_REPO (padrão pablomenezzes/quark-orquestrador) e GITHUB_REF (padrão main).
 *
 * Só dispara os workflows da lista abaixo (nada vindo do navegador vira nome de arquivo), nunca dispara se já há uma execução na fila ou rodando (as duas rotinas têm
 * `concurrency`, mas assim o clique repetido nem entra na fila) e espera 60 segundos entre cliques.
 */
import { IntegracaoErro } from './integracoes.js';

type FetchLike = typeof fetch;

export const WORKFLOWS = {
  sincronia: { arquivo: 'sincronia.yml', nome: 'Sincronia completa (Pipedrive, Google Analytics e estrutura da Meta)', duracao: 'de 5 a 45 minutos' },
  'meta-incremental': { arquivo: 'meta-incremental.yml', nome: 'Meta Ads: desempenho de hoje', duracao: 'alguns minutos' },
} as const;
export type WorkflowId = keyof typeof WORKFLOWS;
export const workflowValido = (x: unknown): x is WorkflowId => typeof x === 'string' && Object.prototype.hasOwnProperty.call(WORKFLOWS, x);

export interface GithubConfig { token: string; repo: string; ref: string }
export function githubConfigDoAmbiente(env: Record<string, string | undefined>): GithubConfig | null {
  const token = env.GITHUB_DISPATCH_TOKEN?.trim();
  if (!token) return null;
  const repo = env.GITHUB_REPO?.trim() || 'pablomenezzes/quark-orquestrador';
  const ref = env.GITHUB_REF?.trim() || 'main';
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) throw new Error('GITHUB_REPO inválido (use dono/repositório).');
  if (!/^[A-Za-z0-9_./-]{1,100}$/.test(ref)) throw new Error('GITHUB_REF inválido.');
  return { token, repo, ref };
}

export interface Execucao {
  workflow: WorkflowId; id: number; situacao: 'na_fila' | 'rodando' | 'concluida'; resultado: string | null;
  inicio: string | null; atualizado: string | null; url: string; origem: string;
}
const situacaoDe = (status: string): Execucao['situacao'] => (status === 'completed' ? 'concluida' : status === 'in_progress' ? 'rodando' : 'na_fila');

export class SincroniaManual {
  private ultimoDisparo = 0;
  constructor(private readonly c: GithubConfig | null, private readonly f: FetchLike = fetch, private readonly agora: () => number = Date.now) {}

  status() {
    return { configurado: !!this.c, repo: this.c?.repo ?? null, workflows: Object.entries(WORKFLOWS).map(([id, w]) => ({ id, nome: w.nome, duracao: w.duracao })) };
  }
  private async chamar(metodo: string, caminho: string, corpo?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    if (!this.c) throw new IntegracaoErro(503, 'Gatilho manual não configurado: falta GITHUB_DISPATCH_TOKEN (token do GitHub com permissão Actions: leitura e escrita neste repositório).');
    const r = await this.f(`https://api.github.com/repos/${this.c.repo}${caminho}`, {
      method: metodo,
      headers: { authorization: `Bearer ${this.c.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'quark-dados', 'content-type': 'application/json' },
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    });
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      if (r.status === 401) throw new IntegracaoErro(502, 'O GitHub recusou o token (vencido ou inválido). Gere outro e atualize GITHUB_DISPATCH_TOKEN.');
      if (r.status === 403 || r.status === 404) throw new IntegracaoErro(502, 'O GitHub não deixou acessar o workflow: o token precisa da permissão "Actions: leitura e escrita" no repositório e o arquivo do workflow precisa existir na branch.');
      throw new IntegracaoErro(502, `O GitHub recusou a operação (${r.status}).`);
    }
    return { status: r.status, json };
  }

  /** As últimas execuções de cada workflow (mais recentes primeiro). */
  async execucoes(): Promise<Execucao[]> {
    const out: Execucao[] = [];
    for (const [id, w] of Object.entries(WORKFLOWS) as Array<[WorkflowId, (typeof WORKFLOWS)[WorkflowId]]>) {
      const { json } = await this.chamar('GET', `/actions/workflows/${w.arquivo}/runs?per_page=4`);
      for (const r of (json.workflow_runs as Array<Record<string, unknown>> | undefined) ?? []) {
        out.push({
          workflow: id, id: Number(r.id), situacao: situacaoDe(String(r.status)), resultado: r.conclusion == null ? null : String(r.conclusion),
          inicio: (r.run_started_at ?? r.created_at ?? null) as string | null, atualizado: (r.updated_at ?? null) as string | null, url: String(r.html_url ?? ''), origem: r.event === 'schedule' ? 'agendada' : r.event === 'workflow_dispatch' ? 'manual' : String(r.event ?? ''),
        });
      }
    }
    return out.sort((a, b) => String(b.inicio).localeCompare(String(a.inicio)));
  }

  async disparar(id: unknown): Promise<{ workflow: WorkflowId; mensagem: string }> {
    if (!workflowValido(id)) throw new IntegracaoErro(400, 'Workflow desconhecido.');
    const w = WORKFLOWS[id];
    const espera = 60_000 - (this.agora() - this.ultimoDisparo);
    if (espera > 0) throw new IntegracaoErro(429, `Aguarde ${Math.ceil(espera / 1000)} segundos antes de disparar de novo.`);
    const { json } = await this.chamar('GET', `/actions/workflows/${w.arquivo}/runs?per_page=5`);
    const ativa = ((json.workflow_runs as Array<Record<string, unknown>> | undefined) ?? []).find((r) => r.status === 'in_progress' || r.status === 'queued' || r.status === 'waiting' || r.status === 'requested' || r.status === 'pending');
    if (ativa) throw new IntegracaoErro(409, `Já existe uma execução ${ativa.status === 'in_progress' ? 'rodando' : 'na fila'} deste workflow. Acompanhe pela lista abaixo.`);
    this.ultimoDisparo = this.agora();
    await this.chamar('POST', `/actions/workflows/${w.arquivo}/dispatches`, { ref: this.c!.ref });
    return { workflow: id, mensagem: `Pedido enviado ao GitHub: ${w.nome}. Costuma levar ${w.duracao}; a lista abaixo se atualiza sozinha.` };
  }
}
