import { ParseError, parseDeal, payloadHash } from '../parse.js';
import type { Checkpoint, DealRow, DealsStore, JobResult } from '../store.js';
import { PipedriveError, type DealListKind } from '../pipedrive/client.js';
import { scrubMessage } from './base.js';

/**
 * Sincronização dos negócios (Entrega 2). Três listas, cada uma com a sua marca-d'água:
 *   deals           lista normal (abertos, ganhos, perdidos)
 *   deals_archived  arquivados (desde 2025-07-15 não aparecem na lista normal)
 *   deals_deleted   excluídos nos últimos 30 dias (marcados com is_deleted, NUNCA apagados do banco)
 *
 * CARGA INICIAL (backfill): lê tudo desde `desde` até um instante fixo (`until`), página a página, e GRAVA O CURSOR depois
 * de cada página. Se parar (erro, cota, desligamento), a próxima rodada continua de onde parou, sem recomeçar.
 * DEPOIS: só o que mudou desde a marca-d'água (menos uma folga), e o que tem o mesmo hash não é regravado.
 */
export const DEAL_KINDS = ['normal', 'archived', 'deleted'] as const;
export const DEAL_ENTITY: Record<DealListKind, string> = { normal: 'deals', archived: 'deals_archived', deleted: 'deals_deleted' };

export interface DealsClient {
  readonly usage: { tokens: number; requests: number; rateLimited: number };
  listDealsPage(
    kind: DealListKind,
    p: { updatedSince?: string | null; updatedUntil?: string | null; cursor?: string | null },
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
}

export type DealsResult = JobResult & { entity: string; kind: DealListKind; paginas: number; backfill: boolean };

type Cursor = { cursor: string | null; since?: string; until?: string };
const asCursor = (v: unknown): Cursor | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Cursor) : null);

const guessId = (item: unknown): number | null => {
  const v = (item as { id?: unknown } | null)?.id;
  return typeof v === 'number' ? v : null;
};

export async function syncDeals(args: {
  client: DealsClient;
  store: DealsStore;
  kinds?: readonly DealListKind[];
  desde: string; // início do histórico (RFC 3339), ex.: 2025-01-01T00:00:00Z
  origem: 'agendada' | 'manual';
  now: () => Date;
  /** Folga recuada da marca-d'água para não perder o que mudou no instante da rodada anterior. */
  overlapMinutes?: number;
  /** Para a rodada depois de N páginas (a carga continua na próxima). Sem isso, vai até o fim ou até a cota. */
  maxPages?: number;
}): Promise<DealsResult[]> {
  const { client, store, desde, origem, now } = args;
  const overlapMs = (args.overlapMinutes ?? 10) * 60_000;
  const results: DealsResult[] = [];

  for (const kind of args.kinds ?? DEAL_KINDS) {
    const entity = DEAL_ENTITY[kind];
    const cp: Checkpoint | null = await store.getCheckpoint(entity);
    const backfill = !cp?.backfill_concluido;
    const saved = backfill ? asCursor(cp?.cursor_atual) : null;
    const startedAt = now();
    const until = saved?.until ?? startedAt.toISOString();
    const since = backfill ? (saved?.since ?? desde) : new Date(Date.parse(cp?.marca_dagua ?? desde) - overlapMs).toISOString();
    let cursor: string | null = saved?.cursor ?? null;

    const jobId = await store.startJob({ entity, modo: backfill ? 'backfill' : 'incremental', origem });
    const before = { ...client.usage };
    const counts = { lidos: 0, gravados: 0, atualizados: 0, ignorados: 0, falhas: 0 };
    let paginas = 0;
    let result: JobResult;

    try {
      const existing = await store.existingDealHashes();
      const reasons = await store.lostReasonIds();
      let finished = false;
      let stoppedByBudget: string | null = null;

      while (!finished) {
        if (args.maxPages != null && paginas >= args.maxPages) break;
        let page: { items: unknown[]; nextCursor: string | null };
        try {
          page = await client.listDealsPage(kind, { updatedSince: since, updatedUntil: until, cursor });
        } catch (e) {
          if (e instanceof PipedriveError && e.kind === 'budget') {
            stoppedByBudget = e.message;
            break;
          }
          throw e;
        }
        paginas++;
        counts.lidos += page.items.length;

        const rows: DealRow[] = [];
        for (const item of page.items) {
          try {
            const parsed = parseDeal(item, kind, reasons, now());
            const key = String(parsed.pipedrive_id);
            const hash = payloadHash(item);
            const prev = existing.get(key);
            if (prev === hash) {
              counts.ignorados++;
              continue;
            }
            const { source_add_time, source_update_time, ...crm } = parsed;
            rows.push({ raw: { key, payload: item, payload_hash: hash, source_add_time, source_update_time, origem_lista: kind }, crm });
            existing.set(key, hash);
            if (prev === undefined) counts.gravados++;
            else counts.atualizados++;
          } catch (e) {
            counts.falhas++;
            await store.recordError({
              job_id: jobId,
              entity,
              source_id: guessId(item),
              mensagem: scrubMessage(e instanceof ParseError || e instanceof Error ? e.message : String(e)),
              payload: item,
            });
          }
        }
        if (rows.length) await store.upsertDeals(rows);

        cursor = page.nextCursor;
        finished = cursor === null;
        // Ponto de retomada depois de CADA página: se parar aqui, a próxima rodada continua daqui.
        if (backfill && !finished) await store.saveCheckpoint(entity, { cursor_atual: { cursor, since, until } satisfies Cursor });
      }

      const tokens_gastos = client.usage.tokens - before.tokens;
      if (finished) {
        result = { status: counts.falhas > 0 ? 'parcial' : 'ok', ...counts, tokens_gastos };
        await store.finishJob(jobId, result);
        await store.saveCheckpoint(entity, {
          marca_dagua: until,
          cursor_atual: { cursor: null },
          ultimo_sucesso_em: now().toISOString(),
          ultimo_job: jobId,
          backfill_concluido: true,
        });
      } else {
        // Parou antes do fim (cota ou limite de páginas): não é erro; o progresso fica guardado.
        result = { status: 'parcial', ...counts, tokens_gastos, cursor_final: { cursor, since, until }, erro: stoppedByBudget ?? `Parou após ${paginas} página(s) por pedido; continua na próxima rodada.` };
        await store.finishJob(jobId, result);
        // Incremental interrompido: a marca-d'água NÃO avança (a próxima rodada relê a mesma janela; o hash evita regravar).
      }
    } catch (e) {
      const erro = scrubMessage(e instanceof Error ? e.message : String(e));
      result = { status: 'erro', ...counts, tokens_gastos: client.usage.tokens - before.tokens, erro };
      await store.finishJob(jobId, result);
      await store.recordError({ job_id: jobId, entity, mensagem: erro });
    }

    const dia = now().toISOString().slice(0, 10);
    await store.addApiUsage(dia, client.usage.tokens - before.tokens, client.usage.requests - before.requests, client.usage.rateLimited - before.rateLimited);
    results.push({ entity, kind, paginas, backfill, ...result });
  }
  return results;
}
