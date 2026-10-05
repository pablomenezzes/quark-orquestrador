import { FIELD_ENTITIES, ParseError, parseFieldDef, parsePipeline, parseStage, parseUser, payloadHash, type FieldEntity } from '../parse.js';
import type { CrmKind, DatahubStore, JobResult, RawKind, RawRow } from '../store.js';

/** Entidades da Entrega 1: pipelines, etapas, usuários e definição de campos. */
export const E1_ENTITIES = ['pipelines', 'stages', 'users', 'deal_fields', 'person_fields', 'organization_fields', 'activity_fields'] as const;
export type E1Entity = (typeof E1_ENTITIES)[number];

export interface BaseClient {
  readonly usage: { tokens: number; requests: number; rateLimited: number };
  listPipelines(): Promise<unknown[]>;
  listStages(): Promise<unknown[]>;
  listUsers(): Promise<unknown[]>;
  listFieldDefs(entity: FieldEntity): Promise<unknown[]>;
}

type Parsed = Record<string, unknown> & { source_add_time?: string | null; source_update_time?: string | null };
type Spec = {
  rawKind: RawKind;
  crmKind: CrmKind;
  fetch: (c: BaseClient) => Promise<unknown[]>;
  parse: (item: unknown) => Parsed;
  keyOf: (p: Parsed) => string;
};

const fieldSpec = (entity: FieldEntity): Spec => ({
  rawKind: 'field_defs',
  crmKind: 'field_def',
  fetch: (c) => c.listFieldDefs(entity),
  parse: (item) => parseFieldDef(entity, item),
  keyOf: (p) => `${p.entity}|${p.field_key}`,
});

const SPECS: Record<E1Entity, Spec> = {
  pipelines: { rawKind: 'pipelines', crmKind: 'pipeline', fetch: (c) => c.listPipelines(), parse: parsePipeline, keyOf: (p) => String(p.pipeline_id) },
  stages: { rawKind: 'stages', crmKind: 'stage', fetch: (c) => c.listStages(), parse: parseStage, keyOf: (p) => String(p.stage_id) },
  users: { rawKind: 'users', crmKind: 'user', fetch: (c) => c.listUsers(), parse: parseUser, keyOf: (p) => String(p.user_id) },
  deal_fields: fieldSpec('deal'),
  person_fields: fieldSpec('person'),
  organization_fields: fieldSpec('organization'),
  activity_fields: fieldSpec('activity'),
};
void FIELD_ENTITIES;

/** Mensagens gravadas no banco nunca levam segredo nem URL de conexão. */
export function scrubMessage(msg: string): string {
  return msg
    .replace(/postgres(ql)?:\/\/\S+/gi, '<url>')
    .replace(/(x-api-token|api_token|authorization)\s*[=:]\s*\S+/gi, '$1=***')
    .slice(0, 500);
}

const guessId = (item: unknown): string | number | null => {
  const o = item as { id?: unknown; field_code?: unknown; key?: unknown } | null;
  const v = o && typeof o === 'object' ? (o.id ?? o.field_code ?? o.key) : null;
  return typeof v === 'number' || typeof v === 'string' ? v : null;
};

export type EntityResult = JobResult & { entity: E1Entity };

export async function syncBase(args: {
  client: BaseClient;
  store: DatahubStore;
  entities: readonly E1Entity[];
  modo: 'backfill' | 'incremental';
  origem: 'agendada' | 'manual';
  now: () => Date;
}): Promise<EntityResult[]> {
  const { client, store, modo, origem, now } = args;
  const results: EntityResult[] = [];

  for (const entity of args.entities) {
    const spec = SPECS[entity];
    const jobId = await store.startJob({ entity, modo, origem });
    const before = { ...client.usage };
    const counts = { lidos: 0, gravados: 0, atualizados: 0, ignorados: 0, falhas: 0 };
    let result: JobResult;

    try {
      const items = await spec.fetch(client);
      counts.lidos = items.length;
      const existing = await store.existingHashes(spec.rawKind);
      const rawRows: RawRow[] = [];
      const crmRows: Array<Record<string, unknown>> = [];

      for (const item of items) {
        try {
          const parsed = spec.parse(item);
          const key = spec.keyOf(parsed);
          const hash = payloadHash(item);
          const prev = existing.get(key);
          if (prev === hash) {
            counts.ignorados++;
            continue;
          }
          rawRows.push({ key, payload: item, payload_hash: hash, source_add_time: parsed.source_add_time ?? null, source_update_time: parsed.source_update_time ?? null });
          crmRows.push(parsed);
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

      await store.upsertRaw(spec.rawKind, rawRows);
      await store.upsertCrm(spec.crmKind, crmRows);
      result = { status: counts.falhas > 0 ? 'parcial' : 'ok', ...counts, tokens_gastos: client.usage.tokens - before.tokens };
      await store.finishJob(jobId, result);
      await store.saveCheckpoint(entity, { ultimo_sucesso_em: now().toISOString(), ultimo_job: jobId });
    } catch (e) {
      const erro = scrubMessage(e instanceof Error ? e.message : String(e));
      result = { status: 'erro', ...counts, gravados: 0, atualizados: 0, tokens_gastos: client.usage.tokens - before.tokens, erro };
      await store.finishJob(jobId, result);
      await store.recordError({ job_id: jobId, entity, mensagem: erro });
    }

    const dia = now().toISOString().slice(0, 10);
    await store.addApiUsage(dia, client.usage.tokens - before.tokens, client.usage.requests - before.requests, client.usage.rateLimited - before.rateLimited);
    results.push({ entity, ...result });
  }
  return results;
}
