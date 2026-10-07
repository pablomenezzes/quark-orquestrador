import { randomUUID } from 'node:crypto';
import type { Checkpoint, DealRow, DealsStore, JobResult, RawKind, CrmKind, RawRow } from '../../src/datahub/store';

/** Store em memória para testar a sincronização sem banco. Dados fictícios (regra 8). */
export class MemoryDatahubStore implements DealsStore {
  dealsRaw = new Map<string, DealRow['raw']>();
  dealsCrm = new Map<string, Record<string, unknown>>();
  lostReasons = new Map<string, number>();
  failDeals = false;

  async existingDealHashes(): Promise<Map<string, string>> {
    return new Map([...this.dealsRaw].map(([k, v]) => [k, v.payload_hash]));
  }
  async upsertDeals(rows: DealRow[]): Promise<void> {
    if (this.failDeals) throw new Error('falha simulada ao gravar negócios');
    for (const r of rows) {
      this.dealsRaw.set(r.raw.key, r.raw);
      this.dealsCrm.set(r.raw.key, r.crm);
    }
  }
  async lostReasonIds(): Promise<Map<string, number>> {
    return this.lostReasons;
  }
  async getCheckpoint(entity: string): Promise<Checkpoint | null> {
    const c = this.checkpoints.get(entity) as Partial<Checkpoint> | undefined;
    if (!c) return null;
    return { marca_dagua: c.marca_dagua ?? null, cursor_atual: c.cursor_atual ?? null, ultimo_sucesso_em: c.ultimo_sucesso_em ?? null, backfill_concluido: c.backfill_concluido === true };
  }

  raw: Record<RawKind, Map<string, RawRow>> = { pipelines: new Map(), stages: new Map(), users: new Map(), field_defs: new Map() };
  crm: Record<CrmKind, Map<string, Record<string, unknown>>> = { pipeline: new Map(), stage: new Map(), user: new Map(), field_def: new Map() };
  jobs = new Map<string, { entity: string; modo: string; origem: string; result?: JobResult }>();
  errors: Array<{ job_id: string; entity: string; source_id?: string | number | null; mensagem: string; payload?: unknown }> = [];
  checkpoints = new Map<string, Record<string, unknown>>();
  usage = new Map<string, { tokens: number; requisicoes: number; limite_429: number }>();
  failUpsert: RawKind | null = null;

  async existingHashes(kind: RawKind): Promise<Map<string, string>> {
    return new Map([...this.raw[kind]].map(([k, v]) => [k, v.payload_hash]));
  }
  async upsertRaw(kind: RawKind, rows: RawRow[]): Promise<void> {
    if (this.failUpsert === kind) throw new Error('falha simulada ao gravar raw');
    for (const r of rows) this.raw[kind].set(r.key, r);
  }
  async upsertCrm(kind: CrmKind, rows: Array<Record<string, unknown>>): Promise<void> {
    const keyOf = (r: Record<string, unknown>) =>
      kind === 'field_def' ? `${r.entity}|${r.field_key}` : String(r[`${kind}_id`]);
    for (const r of rows) this.crm[kind].set(keyOf(r), r);
  }
  async startJob(j: { entity: string; modo: string; origem: string }): Promise<string> {
    const id = randomUUID();
    this.jobs.set(id, { ...j });
    return id;
  }
  async finishJob(id: string, r: JobResult): Promise<void> {
    this.jobs.get(id)!.result = r;
  }
  async recordError(e: { job_id: string; entity: string; source_id?: string | number | null; mensagem: string; payload?: unknown }): Promise<void> {
    this.errors.push(e);
  }
  async saveCheckpoint(entity: string, c: Record<string, unknown>): Promise<void> {
    this.checkpoints.set(entity, { ...(this.checkpoints.get(entity) ?? {}), ...c });
  }
  async addApiUsage(dia: string, tokens: number, requisicoes: number, limite429: number): Promise<void> {
    const cur = this.usage.get(dia) ?? { tokens: 0, requisicoes: 0, limite_429: 0 };
    this.usage.set(dia, { tokens: cur.tokens + tokens, requisicoes: cur.requisicoes + requisicoes, limite_429: cur.limite_429 + limite429 });
  }
}
