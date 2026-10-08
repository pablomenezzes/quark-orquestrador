import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { PgDatahubStore } from '../../src/datahub/pg-store';
import { syncDeals, type DealsClient } from '../../src/datahub/sync/deals';
import { connect, hasDbConfig } from './helpers';

/**
 * Negócios (migration 0006) provados dentro de uma transação desfeita (rollback), com o papel orq_sync de verdade.
 * Dados 100% fictícios (regra 8), com IDs altos que não existem no Pipedrive. Pulado até a 0006 ser aplicada.
 */
let client: pg.Client | null = null;
let ready = false;
let before = { raw: 0, crm: 0, checkpoints: 0 };
const counts = async (c: pg.Client) => ({
  raw: Number((await c.query('select count(*)::int n from raw.pd_deals')).rows[0].n),
  crm: Number((await c.query('select count(*)::int n from crm.deals')).rows[0].n),
  checkpoints: Number((await c.query('select count(*)::int n from ops.sync_checkpoints')).rows[0].n),
});

if (hasDbConfig) {
  client = await connect();
  ready = (await client.query(`select to_regclass('raw.pd_deals') is not null as ok`)).rows[0].ok === true;
  if (ready) before = await counts(client);
  else await client.end();
}
const run = describe.skipIf(!ready);

const NOW = new Date('2026-10-07T12:00:00.000Z');
const D = (id: number, over: Record<string, unknown> = {}) => ({
  id, title: `Negócio fictício ${id}`, pipeline_id: 940001, stage_id: 950001, owner_id: 960001, person_id: 1, org_id: 2, currency: 'BRL', value: 100,
  status: 'open', lost_reason: null, add_time: '2025-03-10T10:00:00Z', update_time: '2025-03-11T10:00:00Z', is_deleted: false,
  custom_fields: { ['b'.repeat(40)]: 'x', ['c'.repeat(40)]: null }, ...over,
});
const fakeClient = (data: Record<'normal' | 'archived' | 'deleted', unknown[]>): DealsClient => ({
  usage: { tokens: 0, requests: 0, rateLimited: 0 },
  async listDealsPage(kind) {
    return { items: data[kind], nextCursor: null };
  },
});

run('negócios (transação com rollback)', () => {
  const c = () => client!;
  async function denied(sql: string): Promise<string> {
    await c().query('savepoint d');
    try {
      await c().query(sql);
      return 'NO_ERROR';
    } catch (e) {
      return (e as { code?: string }).code ?? 'UNKNOWN';
    } finally {
      await c().query('rollback to savepoint d');
    }
  }

  beforeAll(async () => {
    await c().query('begin');
    // isola do estado real: a carga de verdade já pode ter marca-d'água; aqui dentro (e desfeito no fim) começamos do zero
    await c().query(`delete from ops.sync_checkpoints where entity in ('deals','deals_archived','deals_deleted')`);
    await c().query(`insert into crm.pipelines (pipeline_id, nome) values (940001, 'Funil Fictício Negócios')`);
    await c().query(`insert into crm.stages (stage_id, pipeline_id, nome) values (950001, 940001, 'Etapa fictícia')`);
    await c().query(`insert into crm.users (user_id, nome) values (960001, 'Vendedor Fictício')`);
    await c().query(`insert into ops.cfg_pipeline_produto (pipeline_id, produto) values (940001, 'rh')`);
    await c().query(
      `insert into crm.field_definitions (entity, field_key, nome, tipo, opcoes) values ('deal', 'lost_reason', 'Motivo da perda', 'varchar_options', $1::jsonb)
       on conflict (entity, field_key) do update set opcoes = excluded.opcoes`,
      [JSON.stringify([{ id: 398, label: 'Lead Invalido' }, { id: 24, label: 'Achou o preço caro' }])],
    );
  });
  afterAll(async () => {
    await c().query('reset role').catch(() => undefined);
    await c().query('rollback');
    expect(await counts(c())).toEqual(before); // nada de teste permanece (regra 5)
    await c().end();
  });

  it('o orq_sync grava a carga inicial (raw + crm) e a segunda rodada não regrava nada', async () => {
    await c().query('set local role orq_sync');
    const data = {
      normal: [D(98000001), D(98000002, { status: 'lost', lost_reason: 'Lead Invalido' }), D(98000003, { status: 'lost', lost_reason: 'Achou o preço caro' }), D(98000004, { status: 'won', won_time: '2025-04-01T00:00:00Z' })],
      archived: [D(98000005, { is_archived: true })],
      deleted: [D(98000006, { status: 'deleted' })],
    };
    const store = new PgDatahubStore(c());
    const r1 = await syncDeals({ client: fakeClient(data), store, desde: '2025-01-01T00:00:00Z', origem: 'manual', now: () => NOW });
    expect(r1.map((r) => [r.entity, r.status, r.gravados])).toEqual([['deals', 'ok', 4], ['deals_archived', 'ok', 1], ['deals_deleted', 'ok', 1]]);
    const r2 = await syncDeals({ client: fakeClient(data), store, desde: '2025-01-01T00:00:00Z', origem: 'manual', now: () => new Date('2026-10-07T13:00:00Z') });
    expect(r2.map((r) => [r.backfill, r.gravados, r.atualizados, r.ignorados])).toEqual([[false, 0, 0, 4], [false, 0, 0, 1], [false, 0, 0, 1]]);
    await c().query('reset role');
  });

  it('o banco guarda o original, os IDs, o motivo de perda com ID e as marcas de arquivado/excluído', async () => {
    const raw = await c().query(`select payload, origem_lista from raw.pd_deals where source_id = 98000002`);
    expect(raw.rows[0].payload.lost_reason).toBe('Lead Invalido');
    const crm = await c().query(`select pipeline_id, stage_id, owner_id, motivo_perda, motivo_perda_id, status, is_archived, is_deleted, status_original, custom_fields from crm.deals where pipedrive_id = any($1) order by pipedrive_id`, [[98000002, 98000005, 98000006]]);
    expect(crm.rows[0]).toMatchObject({ pipeline_id: '940001', stage_id: '950001', owner_id: '960001', motivo_perda: 'Lead Invalido', motivo_perda_id: '398', status: 'lost' });
    // economia de espaço (D-40): os campos personalizados ficam SÓ no JSON de raw, sem as chaves vazias
    expect(crm.rows[0].custom_fields).toBeNull();
    expect(Object.keys(raw.rows[0].payload.custom_fields)).toEqual(['b'.repeat(40)]);
    expect(crm.rows[1]).toMatchObject({ is_archived: true });
    expect(crm.rows[2]).toMatchObject({ is_deleted: true, status: null, status_original: 'deleted' });
  });

  it('o Painel vê os negócios SÓ pelas views, com produto, MQL e a contagem por status', async () => {
    await c().query('set local role orq_panel');
    const v = await c().query(`select deal_id, status, produto, pipeline, etapa, responsavel, conta_como_lead, is_mql from analytics.deals where deal_id between 98000001 and 98000006 order by deal_id`);
    const by = Object.fromEntries(v.rows.map((r) => [r.deal_id, r]));
    expect(by['98000001']).toMatchObject({ status: 'open', produto: 'rh', pipeline: 'Funil Fictício Negócios', etapa: 'Etapa fictícia', responsavel: 'Vendedor Fictício', is_mql: true });
    expect(by['98000002']).toMatchObject({ status: 'lost', is_mql: false }); // perdido por 398 (Lead Invalido): não é MQL
    expect(by['98000003']).toMatchObject({ status: 'lost', is_mql: true }); // perdido por outro motivo: é MQL
    expect(by['98000004']).toMatchObject({ status: 'won', is_mql: true });
    expect(by['98000006']).toMatchObject({ status: 'deleted', conta_como_lead: false, is_mql: false });
    const campos = await c().query(`select field_key, valor from analytics.deal_campos where deal_id = 98000001`);
    expect(campos.rows[0].field_key).toHaveLength(40);
    const resumo = await c().query(`select status, sum(qtd)::int qtd, sum(qtd_mql)::int mql from analytics.deals_resumo where pipeline_id = 940001 group by status order by status`);
    expect(resumo.rows).toEqual([{ status: 'deleted', qtd: 1, mql: 0 }, { status: 'lost', qtd: 2, mql: 1 }, { status: 'open', qtd: 2, mql: 2 }, { status: 'won', qtd: 1, mql: 1 }]); // o arquivado (status aberto) soma no aberto; a view também separa por is_archived
    await c().query('reset role');
  });

  it('o Painel NÃO enxerga raw nem crm; o orq_sync NÃO apaga nada e continua sem acesso a core e orq', async () => {
    await c().query('set local role orq_panel');
    for (const sql of ['select * from crm.deals', 'select * from raw.pd_deals', 'select titulo from crm.deals', 'insert into crm.deals (pipedrive_id) values (1)']) {
      expect(await denied(sql), sql).toBe('42501');
    }
    await c().query('reset role');
    await c().query('set local role orq_sync');
    for (const sql of ['delete from crm.deals', 'delete from raw.pd_deals', 'truncate crm.deals', 'select * from core.leads', 'select * from orq.events', 'update core.leads set nome = \'x\'']) {
      expect(await denied(sql), sql).toBe('42501');
    }
    await c().query('reset role');
  });

  it('a restrição de status do negócio continua valendo (só open, won ou lost)', async () => {
    expect(await denied(`insert into crm.deals (pipedrive_id, status) values (98000099, 'deleted')`)).toBe('23514');
  });
});
