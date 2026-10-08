import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { PgDatahubStore } from '../../src/datahub/pg-store';
import { syncHistory, type HistoryClient } from '../../src/datahub/sync/history';
import { PgPainelRepo } from '../../studio/lib/painel-repo';
import { connect, hasDbConfig } from './helpers';

/**
 * Histórico de etapas (migration 0010) com o papel orq_sync de verdade, dentro de uma transação desfeita.
 * Negócios fictícios criados em 2099, para a fila do ano nunca tocar nos negócios reais. Pulado até a 0010 ser aplicada.
 */
let client: pg.Client | null = null;
let ready = false;
let before = { flow: 0, history: 0, checkpoints: 0 };
const counts = async (c: pg.Client) => ({
  flow: Number((await c.query('select count(*)::int n from raw.pd_deal_flow')).rows[0].n),
  history: Number((await c.query('select count(*)::int n from crm.stage_history')).rows[0].n),
  checkpoints: Number((await c.query('select count(*)::int n from ops.sync_checkpoints')).rows[0].n),
});

if (hasDbConfig) {
  client = await connect();
  ready = (await client.query(`select to_regclass('raw.pd_deal_flow') is not null as ok`)).rows[0].ok === true;
  if (ready) before = await counts(client);
  else await client.end();
}
const run = describe.skipIf(!ready);

const flow = (id: number, o: number, n: number, t: string) => ({ object: 'dealChange', data: { id, user_id: 960001, field_key: 'stage_id', old_value: o, new_value: n, log_time: t, change_source: 'app', change_source_user_agent: 'texto longo' } });
const NOW = new Date('2026-10-08T12:00:00.000Z');

run('histórico de etapas (transação com rollback)', () => {
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
  const fake = (): HistoryClient & { calls: number[] } => {
    const calls: number[] = [];
    return {
      calls,
      usage: { tokens: 0, requests: 0, rateLimited: 0 },
      async getDealFlow(id) {
        calls.push(id);
        return id === 97000002 ? [flow(1, 950001, 950002, '2099-03-03 10:00:00'), flow(2, 950002, 950003, '2099-03-05 10:00:00')] : [];
      },
    };
  };

  beforeAll(async () => {
    await c().query('begin');
    await c().query(`insert into crm.pipelines (pipeline_id, nome) values (940001, 'Funil Fictício Histórico')`);
    await c().query(`insert into crm.stages (stage_id, pipeline_id, nome) values (950001, 940001, 'Lead fictício'), (950002, 940001, 'Reunião fictícia'), (950003, 940001, 'Proposta fictícia')`);
    await c().query(`insert into crm.users (user_id, nome) values (960001, 'Vendedor Fictício')`);
    await c().query(`insert into ops.cfg_stage_marco (stage_id, marco) values (950003, 'proposta')`);
    const deal = (id: number, status: string, stage: number, sct: string | null, closed: string | null) =>
      c().query(`insert into crm.deals (pipedrive_id, pipeline_id, stage_id, status, created_at, stage_change_time, close_time) values ($1, 940001, $2, $3, '2099-03-01T09:00:00Z', $4, $5)`, [id, stage, status, sct, closed]);
    await deal(97000001, 'lost', 950001, null, '2099-03-02T09:00:00Z'); // nunca mudou de etapa
    await deal(97000002, 'won', 950003, '2099-03-05T10:00:00Z', '2099-03-06T10:00:00Z'); // Lead -> Reunião -> Proposta, ganho em Proposta
  });
  afterAll(async () => {
    await c().query('reset role').catch(() => undefined);
    await c().query('rollback');
    expect(await counts(c())).toEqual(before); // nada de teste permanece (regra 5)
    await c().end();
  });

  it('o orq_sync grava só o que mudou de etapa consultando a API; o que nunca mudou ganha a linha da criação sem custo', async () => {
    await c().query('set local role orq_sync');
    const api = fake();
    const r = await syncHistory({ client: api, store: new PgDatahubStore(c()), year: 2099, now: () => NOW });
    expect(r).toMatchObject({ status: 'ok', semMudanca: 1, lidos: 1, gravados: 1, restantes: 0 });
    expect(api.calls).toEqual([97000002]); // o negócio sem mudança NÃO foi consultado
    const again = await syncHistory({ client: fake(), store: new PgDatahubStore(c()), year: 2099, now: () => NOW });
    expect(again).toMatchObject({ semMudanca: 0, lidos: 0, pendentesAntes: 0 }); // segunda rodada: nada novo, custo zero
    await c().query('reset role');
  });

  it('a linha do tempo fica correta e o JSON guardado é só o essencial (sem user agent)', async () => {
    const h = await c().query(`select deal_id, estagio, stage_id, entrou_em, saiu_em, user_id, origem_dado from crm.stage_history where deal_id >= 97000000 order by deal_id, entrou_em`);
    expect(h.rows.map((x) => [x.deal_id, x.estagio, x.saiu_em ? 'fechada' : 'aberta', x.origem_dado])).toEqual([
      ['97000001', 'Lead fictício #950001', 'aberta', 'criacao'],
      ['97000002', 'Lead fictício #950001', 'fechada', 'criacao'],
      ['97000002', 'Reunião fictícia #950002', 'fechada', 'flow'],
      ['97000002', 'Proposta fictícia #950003', 'aberta', 'flow'],
    ]);
    expect(h.rows[2].user_id).toBe('960001');
    const raw = await c().query(`select items, stage_change_time_vista from raw.pd_deal_flow where deal_id = 97000002`);
    expect(raw.rows[0].items).toHaveLength(2);
    expect(JSON.stringify(raw.rows[0].items)).not.toContain('texto longo');
  });

  it('duas etapas de pipelines diferentes com o MESMO NOME no mesmo segundo (automação) não colidem: nome e ID juntos', async () => {
    await c().query(`insert into crm.pipelines (pipeline_id, nome) values (940002, 'Outro Funil Fictício')`);
    await c().query(`insert into crm.stages (stage_id, pipeline_id, nome) values (950011, 940001, 'Conexão fictícia'), (950012, 940002, 'Conexão fictícia'), (950013, 940002, 'Contratação fictícia')`);
    await c().query(`insert into crm.deals (pipedrive_id, pipeline_id, stage_id, status, created_at, stage_change_time) values (97000003, 940002, 950013, 'open', '2099-04-01T09:00:00Z', '2099-04-01T09:00:09Z')`);
    await c().query('set local role orq_sync');
    const client: HistoryClient = {
      usage: { tokens: 0, requests: 0, rateLimited: 0 },
      getDealFlow: async () => [flow(1, 950099, 950011, '2099-04-01 09:00:05'), flow(2, 950011, 950012, '2099-04-01 09:00:05'), flow(3, 950012, 950013, '2099-04-01 09:00:09')],
    };
    const r = await syncHistory({ client, store: new PgDatahubStore(c()), year: 2099, now: () => NOW });
    expect(r.status).toBe('ok');
    await c().query('reset role');
    const h = await c().query(`select estagio, stage_id from crm.stage_history where deal_id = 97000003 and entrou_em = '2099-04-01T09:00:05Z' order by stage_id`);
    expect(h.rows.map((x) => x.estagio)).toEqual(['Conexão fictícia #950011', 'Conexão fictícia #950012']);
  });

  it('o Painel lê o histórico, os marcos e o andamento, só por views', async () => {
    await c().query('set local role orq_panel');
    const t = await c().query(`select etapa, marco, horas_na_etapa, etapa_atual, movido_por from analytics.historico_etapas where deal_id = 97000002 order by entrou_em`);
    expect(t.rows.map((x) => [x.etapa, x.marco, x.etapa_atual])).toEqual([['Lead fictício', null, false], ['Reunião fictícia', null, false], ['Proposta fictícia', 'proposta', true]]);
    expect(Number(t.rows[1].horas_na_etapa)).toBe(48);
    expect(Number(t.rows[2].horas_na_etapa)).toBe(24); // etapa atual de negócio GANHO conta até o fechamento, não até hoje
    expect(t.rows[2].movido_por).toBe('Vendedor Fictício');
    const m = await c().query(`select marco from analytics.negocios_marcos where deal_id = 97000002`);
    expect(m.rows).toEqual([{ marco: 'proposta' }]); // ganho dado em Proposta também "chegou em proposta"
    const p = await c().query(`select negocios, sem_mudanca_de_etapa, historico_lido, pendentes from analytics.historico_progresso where ano_criacao = 2099`);
    expect(p.rows[0]).toEqual({ negocios: 3, sem_mudanca_de_etapa: 1, historico_lido: 2, pendentes: 0 });
    const repo = new PgPainelRepo(c() as never);
    const ficha = await repo.negocio(97000002);
    expect((ficha as { historico: unknown[] }).historico).toHaveLength(3);
    await c().query('reset role');
  });

  it('o Painel NÃO enxerga raw nem crm do histórico, e o orq_sync NÃO apaga', async () => {
    await c().query('set local role orq_panel');
    for (const sql of ['select * from raw.pd_deal_flow', 'select * from crm.stage_history', 'insert into crm.stage_history (deal_id, estagio, entrou_em) values (1, \'x\', now())']) {
      expect(await denied(sql), sql).toBe('42501');
    }
    await c().query('reset role');
    await c().query('set local role orq_sync');
    for (const sql of ['delete from crm.stage_history', 'delete from raw.pd_deal_flow', 'truncate crm.stage_history']) expect(await denied(sql), sql).toBe('42501');
    await c().query('reset role');
  });
});
