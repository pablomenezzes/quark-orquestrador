import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { PgPainelRepo } from '../../studio/lib/painel-repo';
import { connect, hasDbConfig } from './helpers';

/**
 * Regras do funil (migration 0005), provadas dentro de uma transação desfeita (rollback).
 * Dados 100% fictícios (regra 8). Pulado até a migration 0005 ser aplicada.
 *  - ganho/perdido/aberto/excluído vêm do Status; a etapa só guarda "chegou até aqui"
 *  - MQL = não foi perdido por um motivo marcado (398, 185, 184, 587 de início)
 *  - cada status (open, won, lost, deleted) tem a chave "conta como lead?"
 */
const TABLES = ['ops.cfg_motivo_perda', 'ops.cfg_status_contagem', 'ops.cfg_stage_marco', 'ops.cfg_pipeline_produto'];

let client: pg.Client | null = null;
let before: Record<string, string> = {};
let ready = false;
const snap = async (c: pg.Client) => {
  const out: Record<string, string> = {};
  for (const t of TABLES) out[t] = JSON.stringify((await c.query(`select * from ${t} order by 1`)).rows);
  return out;
};

if (hasDbConfig) {
  client = await connect();
  const r = await client.query(`select to_regclass('ops.cfg_motivo_perda') is not null as t, to_regclass('analytics.motivos_perda') is not null as v`);
  ready = r.rows[0].t && r.rows[0].v;
  if (ready) before = await snap(client);
  else await client.end();
}

const run = describe.skipIf(!ready);

run('regras do funil (transação com rollback)', () => {
  const c = () => client!;
  async function denied(sql: string, params: unknown[] = []): Promise<string> {
    await c().query('savepoint d');
    try {
      await c().query(sql, params);
      return 'NO_ERROR';
    } catch (e) {
      return (e as { code?: string }).code ?? 'UNKNOWN';
    } finally {
      await c().query('rollback to savepoint d');
    }
  }

  beforeAll(async () => {
    await c().query('begin');
    // pipeline e etapa fictícios, criados pelo dono e desfeitos no final
    await c().query(`insert into crm.pipelines (pipeline_id, nome) values (940001, 'Funil Fictício Regras')`);
    await c().query(`insert into crm.stages (stage_id, pipeline_id, nome) values (950001, 940001, 'Etapa fictícia')`);
  });
  afterAll(async () => {
    await c().query('reset role').catch(() => undefined);
    await c().query('rollback');
    expect(await snap(c())).toEqual(before); // a configuração de verdade do Pablo não foi tocada
    await c().end();
  });

  it('o banco nasce com os 4 motivos que tiram do MQL e "excluído" fora da contagem', async () => {
    await c().query('set local role orq_panel');
    const repo = new PgPainelRepo(c() as never);
    const m = await repo.motivosPerda();
    expect(m.filter((x) => x.exclui_mql).map((x) => x.reason_id).sort((a, b) => a - b)).toEqual([184, 185, 398, 587]);
    const s = await repo.statusContagem();
    expect(s.map((x) => x.status)).toEqual(['open', 'won', 'lost', 'deleted']);
    expect(s.find((x) => x.status === 'deleted')!.conta_como_lead).toBe(false);
    expect(s.filter((x) => x.status !== 'deleted').every((x) => x.conta_como_lead)).toBe(true);
    await c().query('reset role');
  });

  it('o Painel liga e desliga "tira do MQL" e "conta como lead", e as views refletem na hora', async () => {
    await c().query('set local role orq_panel');
    const repo = new PgPainelRepo(c() as never);
    await repo.setMotivoExcluiMql(398, false);
    expect((await repo.motivosPerda()).find((x) => x.reason_id === 398)!.exclui_mql).toBe(false);
    await repo.setMotivoExcluiMql(398, true);
    await repo.setStatusContaComoLead('deleted', true);
    expect((await repo.statusContagem()).find((x) => x.status === 'deleted')!.conta_como_lead).toBe(true);
    await c().query('reset role');
  });

  it('motivo que não existe vira "não encontrado", sem gravar nada', async () => {
    await c().query('set local role orq_panel');
    const repo = new PgPainelRepo(c() as never);
    await expect(repo.setMotivoExcluiMql(999999999, true)).rejects.toMatchObject({ name: 'PainelNotFound' });
    await c().query('reset role');
  });

  it('o banco recusa status e marcos fora das listas (ganho, perdido, mql e lead não são marcos de etapa)', async () => {
    await c().query('set local role orq_panel');
    expect(await denied(`insert into ops.cfg_status_contagem (status, conta_como_lead) values ('archived', true)`)).toBe('23514');
    for (const marco of ['ganho', 'perdido', 'mql', 'lead']) {
      expect(await denied(`insert into ops.cfg_stage_marco (stage_id, marco) values (950001, '${marco}')`), marco).toBe('23514');
    }
    for (const marco of ['sql', 'reuniao', 'proposta']) {
      expect(await denied(`insert into ops.cfg_stage_marco (stage_id, marco) values (950001, '${marco}') on conflict (stage_id) do update set marco = excluded.marco`), marco).toBe('NO_ERROR');
    }
    await c().query('reset role');
  });

  it('o Painel não apaga as regras e o orq_sync só lê', async () => {
    await c().query('set local role orq_panel');
    for (const sql of ['delete from ops.cfg_motivo_perda', 'delete from ops.cfg_status_contagem', 'truncate ops.cfg_motivo_perda']) {
      expect(await denied(sql), sql).toBe('42501');
    }
    await c().query('reset role');
    await c().query('set local role orq_sync');
    expect((await c().query('select count(*)::int n from ops.cfg_motivo_perda')).rows[0].n).toBeGreaterThanOrEqual(4);
    for (const sql of ['insert into ops.cfg_motivo_perda (reason_id, exclui_mql) values (1, true)', 'update ops.cfg_status_contagem set conta_como_lead = true', 'delete from ops.cfg_motivo_perda']) {
      expect(await denied(sql), sql).toBe('42501');
    }
    await c().query('reset role');
  });
});
