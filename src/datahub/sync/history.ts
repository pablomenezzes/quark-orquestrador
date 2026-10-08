import { PipedriveError } from '../pipedrive/client.js';
import { buildStageHistory, trimFlowItems } from '../history.js';
import { payloadHash } from '../parse.js';
import type { HistoryStore, JobResult } from '../store.js';
import { scrubMessage } from './base.js';

/**
 * Histórico de etapas dos negócios (Entrega 5), por ANO DE CRIAÇÃO (o Pablo pediu 2026 primeiro, depois 2025).
 *
 *  1. Negócios que nunca mudaram de etapa (stage_change_time vazio): uma linha "entrou na criação", SEM chamar a API.
 *  2. Os que mudaram: lê o histórico (flow, 40 unidades cada), abertos e ganhos primeiro, e grava a linha do tempo.
 *  3. Depois da carga, só entram na fila os negócios cuja etapa mudou desde a última leitura (stage_change_time diferente).
 * Retomável: o que já foi lido não entra na fila de novo. Para sozinho se a cota do dia passar da fatia permitida.
 */
export const HISTORY_ENTITY = 'deal_history';

export interface HistoryClient {
  readonly usage: { tokens: number; requests: number; rateLimited: number };
  getDealFlow(id: number): Promise<unknown[]>;
}

export type HistoryResult = JobResult & { entity: string; semMudanca: number; pendentesAntes: number; restantes: number; avisos: number };

export async function syncHistory(args: {
  client: HistoryClient;
  store: HistoryStore;
  /** Ano de criação dos negócios (inclusive). Ex.: 2026. */
  year: number;
  modo?: 'backfill' | 'incremental';
  origem?: 'agendada' | 'manual';
  /** Para depois de N negócios (carga gradual). */
  maxDeals?: number;
  now: () => Date;
  onProgress?: (feitos: number, total: number) => void;
}): Promise<HistoryResult> {
  const { client, store, now } = args;
  const range = { from: `${args.year}-01-01T00:00:00Z`, to: `${args.year + 1}-01-01T00:00:00Z` };
  const jobId = await store.startJob({ entity: HISTORY_ENTITY, modo: args.modo ?? 'backfill', origem: args.origem ?? 'manual' });
  const before = { ...client.usage };
  const counts = { lidos: 0, gravados: 0, atualizados: 0, ignorados: 0, falhas: 0 };
  let semMudanca = 0;
  let pendentesAntes = 0;
  let avisos = 0;
  let restantes = 0;
  let result: JobResult;

  try {
    semMudanca = await store.seedNoChangeHistory(range);
    const fila = await store.pendingHistory(range);
    pendentesAntes = fila.length;
    const tasks = args.maxDeals != null ? fila.slice(0, args.maxDeals) : fila;
    let seguidas = 0;
    let parouPorCota: string | null = null;

    for (const [i, t] of tasks.entries()) {
      let flow: unknown[];
      try {
        flow = await client.getDealFlow(t.deal_id);
        seguidas = 0;
      } catch (e) {
        if (e instanceof PipedriveError && e.kind === 'budget') {
          parouPorCota = e.message;
          break;
        }
        if (e instanceof PipedriveError && (e.kind === 'auth' || e.kind === 'rate_limited')) throw e;
        counts.falhas++;
        await store.recordError({ job_id: jobId, entity: HISTORY_ENTITY, source_id: t.deal_id, mensagem: scrubMessage(e instanceof Error ? e.message : String(e)) });
        if (++seguidas >= 10) throw new Error('10 falhas seguidas ao ler históricos; parei para não gastar a cota à toa.');
        continue;
      }
      counts.lidos++;
      const items = trimFlowItems(flow);
      const built = buildStageHistory(t.created_at, t.stage_id, items);
      for (const a of built.avisos) {
        avisos++;
        await store.recordError({ job_id: jobId, entity: HISTORY_ENTITY, source_id: t.deal_id, mensagem: `aviso: ${a}` });
      }
      await store.saveDealHistory({ deal_id: t.deal_id, items, items_hash: payloadHash(items), stage_change_time: t.stage_change_time, rows: built.rows });
      counts.gravados++;
      args.onProgress?.(i + 1, tasks.length);
    }
    restantes = pendentesAntes - counts.lidos - counts.falhas;

    const tokens_gastos = client.usage.tokens - before.tokens;
    const completo = restantes <= 0 && !parouPorCota;
    result = {
      status: !completo || counts.falhas > 0 ? 'parcial' : 'ok',
      ...counts,
      ignorados: semMudanca,
      tokens_gastos,
      ...(completo ? {} : { erro: parouPorCota ?? `Parou após ${counts.lidos} negócio(s) por pedido; ${restantes} ainda na fila.` }),
    };
    await store.finishJob(jobId, result);
    if (completo) await store.saveCheckpoint(HISTORY_ENTITY, { ultimo_sucesso_em: now().toISOString(), ultimo_job: jobId, backfill_concluido: true });
  } catch (e) {
    const erro = scrubMessage(e instanceof Error ? e.message : String(e));
    result = { status: 'erro', ...counts, tokens_gastos: client.usage.tokens - before.tokens, erro };
    await store.finishJob(jobId, result);
    await store.recordError({ job_id: jobId, entity: HISTORY_ENTITY, mensagem: erro });
  }

  const dia = now().toISOString().slice(0, 10);
  await store.addApiUsage(dia, client.usage.tokens - before.tokens, client.usage.requests - before.requests, client.usage.rateLimited - before.rateLimited);
  return { entity: HISTORY_ENTITY, semMudanca, pendentesAntes, restantes, avisos, ...result };
}
