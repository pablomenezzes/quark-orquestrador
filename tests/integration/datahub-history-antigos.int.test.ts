import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { PgDatahubStore } from '../../src/datahub/pg-store';
import { connect, hasDbConfig } from './helpers';

/**
 * Leads ANTIGOS (criados antes de 2025) que são mexidos no Pipedrive: a fila do histórico só traz os que já tinham sido lidos e depois mudaram de
 * etapa, ou os alterados no período; nunca todos os antigos. Negócios fictícios de 2018, transação desfeita.
 */
let client: pg.Client | null = null;
if (hasDbConfig) client = await connect();
const run = describe.skipIf(!hasDbConfig);
const RANGE = { from: '2018-01-01T00:00:00Z', to: '2019-01-01T00:00:00Z' };
const DESDE = '2026-10-01T00:00:00Z';

run('fila do histórico dos negócios antigos (transação com rollback)', () => {
  const c = () => client!;
  beforeAll(async () => {
    await c().query('begin');
    await c().query(`insert into crm.pipelines (pipeline_id, nome) values (940007, 'Funil Fictício Antigos')`);
    await c().query(`insert into crm.stages (stage_id, pipeline_id, nome) values (950071, 940007, 'Etapa fictícia')`);
    const deal = (id: number) => c().query(`insert into crm.deals (pipedrive_id, pipeline_id, stage_id, status, created_at, stage_change_time) values ($1, 940007, 950071, 'open', '2018-05-01T09:00:00Z', '2026-10-10T10:00:00Z')`, [id]);
    const raw = (id: number, atualizado: string) => c().query(`insert into raw.pd_deals (source_id, payload, payload_hash, source_add_time, source_update_time) values ($1, '{}'::jsonb, 'h', '2018-05-01T09:00:00Z', $2)`, [id, atualizado]);
    await deal(97100001); await raw(97100001, '2026-10-12T09:00:00Z'); // nunca lido, mexido agora: entra
    await deal(97100002); await raw(97100002, '2024-01-01T09:00:00Z'); // nunca lido e parado há anos: NÃO entra
    await deal(97100003); await raw(97100003, '2024-01-01T09:00:00Z'); // já lido, depois mudou de etapa: entra
    await c().query(`insert into raw.pd_deal_flow (deal_id, items, items_hash, stage_change_time_vista) values (97100003, '[]'::jsonb, 'x', '2024-01-01T00:00:00Z')`);
    await deal(97100004); await raw(97100004, '2026-10-12T09:00:00Z'); // já lido e SEM mudança de etapa desde a leitura: não entra
    await c().query(`insert into raw.pd_deal_flow (deal_id, items, items_hash, stage_change_time_vista) values (97100004, '[]'::jsonb, 'x', '2026-10-10T10:00:00Z')`);
  });
  afterAll(async () => {
    await c().query('rollback');
    await c().end();
  });

  it('sem o filtro (anos normais) todos os que nunca foram lidos entram; com o filtro só os alterados ou já lidos que mudaram', async () => {
    const store = new PgDatahubStore(c());
    const todos = (await store.pendingHistory(RANGE)).map((t) => t.deal_id).sort();
    expect(todos).toEqual([97100001, 97100002, 97100003]);
    const antigos = (await store.pendingHistory(RANGE, { alteradosDesde: DESDE })).map((t) => t.deal_id).sort();
    expect(antigos).toEqual([97100001, 97100003]);
  });
});
