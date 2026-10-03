import { createHash, randomUUID } from 'node:crypto';
import type { LeadRepo, LeadRow } from '../../src/identity/resolve-lead';
import type {
  DecisionInsert,
  EventInsert,
  SourceRow,
  Store,
  TouchpointInsert,
  Tx,
} from '../../src/pipeline/types';

type State = {
  sources: SourceRow[];
  leads: LeadRow[];
  touchpoints: Array<TouchpointInsert & { id: string }>;
  events: Array<EventInsert & { id: string }>;
  decisions: Array<DecisionInsert & { id: string }>;
};

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Store em memória com semântica de transação (rollback em exceção) para os testes. */
export class MemoryStore implements Store {
  state: State = { sources: [], leads: [], touchpoints: [], events: [], decisions: [] };
  /** Faz a operação indicada falhar, para testar o caminho de erro. */
  failOn: 'insertEvent' | 'insertTouchpointConflict' | null = null;
  /** Falha uma vez só na primeira transação (para simular erro transitório). */
  failOnce = false;

  addSource(s: Partial<SourceRow> & { slug: string; token: string }): SourceRow {
    const row: SourceRow = {
      id: randomUUID(),
      tipo: 'vercel',
      produto: 'rh',
      ativo: true,
      token_hash: sha256(s.token),
      ...s,
    };
    delete (row as unknown as { token?: string }).token;
    this.state.sources.push(row);
    return row;
  }

  async findSourceBySlug(slug: string) {
    return this.state.sources.find((s) => s.slug === slug) ?? null;
  }

  async withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    try {
      return await fn(this.makeTx());
    } catch (e) {
      this.state = snapshot;
      throw e;
    }
  }

  private makeTx(): Tx {
    const st = () => this.state;
    const leads: LeadRepo = {
      findById: async (id) => st().leads.find((l) => l.id === id) ?? null,
      findByEmail: async (e) => st().leads.find((l) => l.email_norm === e) ?? null,
      findByPhone: async (p) => st().leads.find((l) => l.phone_e164 === p) ?? null,
      create: async (data) => {
        const row: LeadRow = { email_norm: null, phone_e164: null, ...data, id: data.id ?? randomUUID() };
        st().leads.push(row);
        return row;
      },
      fillMissing: async (id, patch) => {
        const r = st().leads.find((l) => l.id === id);
        if (r) Object.assign(r, patch);
      },
    };
    return {
      leads,
      touchpointExists: async (eventId) => st().touchpoints.some((t) => t.event_id === eventId),
      insertTouchpoint: async (t) => {
        if (this.failOn === 'insertTouchpointConflict') return null;
        if (st().touchpoints.some((x) => x.event_id === t.event_id)) return null;
        const id = randomUUID();
        st().touchpoints.push({ ...t, id });
        return id;
      },
      insertEvent: async (e) => {
        if (this.failOn === 'insertEvent' && e.lead_id !== null) {
          if (this.failOnce) this.failOn = null;
          throw new Error('falha simulada ao gravar evento');
        }
        const id = randomUUID();
        st().events.push({ ...e, id });
        return id;
      },
      insertDecision: async (d) => {
        const id = randomUUID();
        st().decisions.push({ ...d, id });
        return id;
      },
    };
  }
}
