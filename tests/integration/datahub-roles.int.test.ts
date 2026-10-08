import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { PgDatahubStore } from '../../src/datahub/pg-store';
import { syncBase, type BaseClient } from '../../src/datahub/sync/base';
import { PgPainelRepo } from '../../studio/lib/painel-repo';
import { connect, hasDbConfig } from './helpers';

/**
 * Prova do privilégio mínimo dos papéis do Data Hub, dentro de uma transação desfeita (rollback).
 * Dados 100% fictícios (regra 8). Pulado até a migration 0004 ser aplicada.
 */
const NEW_TABLES = [
  'raw.pd_pipelines', 'raw.pd_stages', 'raw.pd_users', 'raw.pd_field_defs',
  'crm.pipelines', 'crm.stages', 'crm.users', 'crm.field_definitions',
  'ops.cfg_pipeline_produto', 'ops.cfg_stage_marco', 'ops.cfg_field_rotulo',
  'ops.sync_settings', 'ops.sync_jobs', 'ops.sync_checkpoints', 'ops.sync_errors', 'ops.api_usage_daily',
];

let client: pg.Client | null = null;
let before: Record<string, number> = {};
let ready = false;
const counts = async (c: pg.Client) => {
  const out: Record<string, number> = {};
  for (const t of NEW_TABLES) out[t] = Number((await c.query(`select count(*)::int as n from ${t}`)).rows[0].n);
  return out;
};

if (hasDbConfig) {
  client = await connect();
  const r = await client.query(
    `select (select count(*) from pg_roles where rolname in ('orq_sync','orq_panel')) = 2 as roles,
            to_regclass('raw.pd_pipelines') is not null as raw_ok,
            to_regclass('analytics.pipelines_etapas') is not null as view_ok`,
  );
  ready = r.rows[0].roles && r.rows[0].raw_ok && r.rows[0].view_ok;
  if (ready) before = await counts(client);
  else await client.end();
}

const run = describe.skipIf(!ready);

const PIPES = [{ id: 910001, name: 'Funil Fictício RH', order_nr: 1, is_deleted: false }, { id: 910002, name: 'Funil Fictício Clínica', order_nr: 2, is_deleted: false }];
const STAGES = [{ id: 920001, pipeline_id: 910001, name: 'Lead fictício', order_nr: 1 }, { id: 920002, pipeline_id: 910001, name: 'Reunião fictícia', order_nr: 2 }];
const USERS = [{ id: 930001, name: 'Pessoa Fictícia', email: 'ficticia@exemplo.invalid', active_flag: true }];
const fake = (): BaseClient => ({
  usage: { tokens: 0, requests: 0, rateLimited: 0 },
  listPipelines: async () => PIPES,
  listStages: async () => STAGES,
  listUsers: async () => USERS,
  listFieldDefs: async (e) => (e === 'deal' ? [{ field_code: 'f'.repeat(40), field_name: 'Campo fictício', field_type: 'varchar' }] : []),
});

run('papéis do Data Hub (transação com rollback)', () => {
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
  });
  afterAll(async () => {
    await c().query('reset role').catch(() => undefined);
    await c().query('rollback');
    expect(await counts(c())).toEqual(before); // nada de teste permanece (regra 5)
    await c().end();
  });

  describe('orq_sync', () => {
    beforeAll(async () => {
      await c().query('set local role orq_sync');
    });
    afterAll(async () => {
      await c().query('reset role');
    });

    it('a sincronização completa funciona só com os privilégios do papel', async () => {
      const results = await syncBase({ client: fake(), store: new PgDatahubStore(c()), entities: ['pipelines', 'stages', 'users', 'deal_fields'], modo: 'incremental', origem: 'manual', now: () => new Date() });
      expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
      expect(results.map((r) => r.gravados)).toEqual([2, 2, 1, 1]);
    });

    it('guarda o original (raw) e o normalizado (crm), com ID e nome juntos', async () => {
      const raw = await c().query(`select payload from raw.pd_pipelines where source_id = 910001`);
      expect(raw.rows[0].payload).toMatchObject({ name: 'Funil Fictício RH' });
      const crm = await c().query(`select pipeline_id, nome from crm.pipelines where pipeline_id = 910001`);
      expect(crm.rows[0]).toEqual({ pipeline_id: '910001', nome: 'Funil Fictício RH' });
      const f = await c().query(`select field_key from crm.field_definitions where entity = 'deal' and nome = 'Campo fictício'`);
      expect(f.rows[0].field_key).toHaveLength(40);
    });

    it('a segunda rodada não regrava nada (hash igual)', async () => {
      const [r] = await syncBase({ client: fake(), store: new PgDatahubStore(c()), entities: ['pipelines'], modo: 'incremental', origem: 'manual', now: () => new Date() });
      expect(r).toMatchObject({ gravados: 0, atualizados: 0, ignorados: 2 });
    });

    it('registra job, ponto de controle e uso da cota', async () => {
      expect((await c().query(`select count(*)::int n from ops.sync_jobs where entity = 'pipelines'`)).rows[0].n).toBeGreaterThanOrEqual(2);
      expect((await c().query(`select ultimo_sucesso_em from ops.sync_checkpoints where entity = 'stages'`)).rows[0].ultimo_sucesso_em).toBeTruthy();
    });

    it('NÃO pode apagar nada em raw, crm nem ops', async () => {
      for (const sql of ['delete from raw.pd_pipelines', 'delete from crm.pipelines', 'delete from ops.sync_jobs', 'truncate crm.stages', 'truncate raw.pd_users']) {
        expect(await denied(sql), sql).toBe('42501');
      }
    });

    it('NÃO enxerga o orquestrador (orq.*) e de core.leads lê SÓ id, e-mail e telefone (para o vínculo, Entrega 3)', async () => {
      for (const sql of [
        'select * from orq.events', 'select * from orq.sources', 'select * from orq.touchpoints',
        'insert into orq.rate_limits (bucket, window_start) values (\'x\', now())',
        'update core.leads set nome = \'x\'', 'select nome from core.leads', 'select * from core.leads', 'select empresa, cargo, produto from core.leads',
        'insert into core.leads (email_norm) values (\'x@exemplo.invalid\')', 'delete from core.leads',
      ]) {
        expect(await denied(sql), sql).toBe('42501');
      }
      expect(await denied('select id, email_norm, phone_e164 from core.leads limit 1')).toBe('NO_ERROR');
    });

    it('NÃO escreve na configuração do Painel nem cria objetos', async () => {
      for (const sql of ["insert into ops.cfg_pipeline_produto (pipeline_id, produto) values (910001, 'rh')", 'create table raw.invasor (x int)', 'create role invasor', 'alter role orq_sync superuser']) {
        expect(await denied(sql), sql).toBe('42501');
      }
    });

    it('não é superusuário nem ignora RLS', async () => {
      const r = await c().query(`select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = current_user`);
      expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    });
  });

  describe('orq_panel', () => {
    beforeAll(async () => {
      await c().query('set local role orq_panel');
    });
    afterAll(async () => {
      await c().query('reset role');
    });

    it('lê pelas views de analytics (inclusive os dados que a sincronização acabou de gravar)', async () => {
      const repo = new PgPainelRepo(c() as never);
      const cfg = await repo.config();
      const p = cfg.find((x) => x.pipeline_id === 910001)!;
      expect(p.pipeline).toBe('Funil Fictício RH');
      expect(p.etapas.map((e) => e.etapa)).toEqual(['Lead fictício', 'Reunião fictícia']);
      expect(p.produto).toBeNull();
      expect((await repo.usuarios()).find((u: any) => u.user_id === '930001' || u.user_id === 930001)).toBeTruthy();
      expect((await repo.campos()).length).toBeGreaterThan(0);
    });

    it('a view de usuários NÃO expõe o e-mail', async () => {
      const r = await c().query(`select * from analytics.usuarios limit 1`);
      expect(Object.keys(r.rows[0] ?? { user_id: 1, nome: 1, ativo: 1 })).toEqual(['user_id', 'nome', 'ativo']);
    });

    it('grava a configuração (pipeline -> produto, etapa -> marco) e a view reflete na hora', async () => {
      const repo = new PgPainelRepo(c() as never);
      await repo.setPipelineProduto(910001, 'rh');
      await repo.setStageMarco(920001, 'sql');
      await repo.setStageMarco(920002, 'reuniao');
      const p = (await repo.config()).find((x) => x.pipeline_id === 910001)!;
      expect(p.produto).toBe('rh');
      expect(p.etapas.map((e) => e.marco)).toEqual(['sql', 'reuniao']);
      await repo.setPipelineProduto(910001, null);
      expect((await repo.config()).find((x) => x.pipeline_id === 910001)!.produto).toBeNull();
    });

    it('pipeline ou etapa inexistente vira "não encontrado" (e não erro de banco)', async () => {
      const repo = new PgPainelRepo(c() as never);
      await c().query('savepoint nf');
      await expect(repo.setPipelineProduto(999999999, 'rh')).rejects.toMatchObject({ name: 'PainelNotFound' });
      await c().query('rollback to savepoint nf');
      await c().query('savepoint nf2');
      await expect(repo.setStageMarco(999999999, 'sql')).rejects.toMatchObject({ name: 'PainelNotFound' });
      await c().query('rollback to savepoint nf2');
    });

    it('valores fora da lista são barrados pelo próprio banco', async () => {
      expect(await denied(`insert into ops.cfg_pipeline_produto (pipeline_id, produto) values (910002, 'outro')`)).toBe('23514');
      expect(await denied(`insert into ops.cfg_stage_marco (stage_id, marco) values (920001, 'qualificado')`)).toBe('23514');
    });

    it('NÃO enxerga raw, crm, core nem orq (dados pessoais só por views)', async () => {
      for (const sql of ['select * from raw.pd_users', 'select * from crm.users', 'select email from crm.users', 'select * from crm.pipelines', 'select * from core.leads', 'select * from orq.events']) {
        expect(await denied(sql), sql).toBe('42501');
      }
    });

    it('NÃO grava em nada além da configuração', async () => {
      for (const sql of [
        "insert into ops.sync_jobs (entity, modo, origem, status) values ('x','backfill','manual','ok')",
        'update ops.sync_jobs set status = \'ok\'',
        'delete from ops.sync_errors',
        'update crm.pipelines set nome = \'x\'',
        'insert into raw.pd_pipelines (source_id, payload, payload_hash) values (1, \'{}\', \'h\')',
        'create view analytics.invasor as select 1',
        'delete from ops.cfg_pipeline_produto', // a configuração só se edita, não se apaga
      ]) {
        expect(await denied(sql), sql).toBe('42501');
      }
    });

    it('só altera as colunas de frequência em ops.sync_settings', async () => {
      await c().query('reset role');
      await c().query(`insert into ops.sync_settings (entity) values ('entidade_ficticia')`);
      await c().query('set local role orq_panel');
      expect(await denied(`update ops.sync_settings set intervalo_minutos = 120 where entity = 'entidade_ficticia'`)).toBe('NO_ERROR');
      expect(await denied(`update ops.sync_settings set entity = 'outra' where entity = 'entidade_ficticia'`)).toBe('42501');
      expect(await denied(`update ops.sync_settings set intervalo_minutos = 5 where entity = 'entidade_ficticia'`)).toBe('23514'); // mínimo 15
    });

    it('não é superusuário e não ignora RLS', async () => {
      const r = await c().query(`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`);
      expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });
  });
});
