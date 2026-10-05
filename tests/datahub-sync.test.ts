import { describe, it, expect, beforeEach } from 'vitest';
import { syncBase, E1_ENTITIES, type BaseClient, type E1Entity } from '../src/datahub/sync/base';
import { MemoryDatahubStore } from './helpers/memory-datahub-store';

// Dados 100% fictícios (regra 8).
const PIPES = [
  { id: 1, name: 'Funil RH', order_nr: 1, is_deleted: false, update_time: '2026-03-01T10:00:00Z' },
  { id: 2, name: 'Funil Clínica', order_nr: 2, is_deleted: false, update_time: '2026-03-02T10:00:00Z' },
];
const STAGES = [
  { id: 11, pipeline_id: 1, name: 'Lead', order_nr: 1 },
  { id: 12, pipeline_id: 1, name: 'Reunião', order_nr: 2 },
  { id: 21, pipeline_id: 2, name: 'Novo', order_nr: 1 },
];
const USERS = [
  { id: 100, name: 'Ana Teste', email: 'ana@exemplo.invalid', active_flag: true },
  { id: 101, name: 'Beto Teste', email: 'beto@exemplo.invalid', active_flag: false },
];
const FIELDS = {
  deal: [{ field_code: 'a'.repeat(40), field_name: 'Origem', field_type: 'enum', options: [{ id: 1, label: 'Google' }] }, { field_code: 'title', field_name: 'Título', field_type: 'varchar' }],
  person: [{ field_code: 'email', field_name: 'E-mail', field_type: 'varchar' }],
  organization: [{ field_code: 'name', field_name: 'Nome', field_type: 'varchar' }],
  activity: [{ field_code: 'subject', field_name: 'Assunto', field_type: 'varchar' }],
};

let data: { pipelines: unknown[]; stages: unknown[]; users: unknown[]; fields: typeof FIELDS };
let tokens: number;
let requests: number;
let calls: string[];

const client = (): BaseClient => ({
  get usage() {
    return { tokens, requests, rateLimited: 0 };
  },
  async listPipelines() { calls.push('pipelines'); tokens += 5; requests++; return data.pipelines; },
  async listStages() { calls.push('stages'); tokens += 5; requests++; return data.stages; },
  async listUsers() { calls.push('users'); tokens += 20; requests++; return data.users; },
  async listFieldDefs(e: 'deal' | 'person' | 'organization' | 'activity') { calls.push(`fields:${e}`); tokens += 10; requests++; return data.fields[e]; },
});

let store: MemoryDatahubStore;
const run = (entities: readonly E1Entity[] = E1_ENTITIES) =>
  syncBase({ client: client(), store, entities, modo: 'incremental', origem: 'manual', now: () => new Date('2026-10-05T12:00:00Z') });

beforeEach(() => {
  store = new MemoryDatahubStore();
  data = { pipelines: structuredClone(PIPES), stages: structuredClone(STAGES), users: structuredClone(USERS), fields: structuredClone(FIELDS) };
  tokens = 0;
  requests = 0;
  calls = [];
});

describe('primeira rodada', () => {
  it('grava o original (raw) e o normalizado (crm) de todas as entidades', async () => {
    const results = await run();
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(store.raw.pipelines.size).toBe(2);
    expect(store.raw.stages.size).toBe(3);
    expect(store.raw.users.size).toBe(2);
    expect(store.raw.field_defs.size).toBe(5);
    expect(store.crm.pipeline.size).toBe(2);
    expect(store.crm.stage.size).toBe(3);
    expect(store.crm.user.size).toBe(2);
    expect(store.crm.field_def.size).toBe(5);
  });

  it('o payload original é guardado inteiro, sem perder campos que não conhecemos', async () => {
    data.pipelines = [{ id: 1, name: 'Funil RH', campo_novo_do_pipedrive: { x: [1, 2, 3] } }];
    await run(['pipelines']);
    expect((store.raw.pipelines.get('1')!.payload as { campo_novo_do_pipedrive: unknown }).campo_novo_do_pipedrive).toEqual({ x: [1, 2, 3] });
  });

  it('ID e nome sempre juntos', async () => {
    await run();
    expect(store.crm.pipeline.get('1')).toMatchObject({ pipeline_id: 1, nome: 'Funil RH' });
    expect(store.crm.stage.get('12')).toMatchObject({ stage_id: 12, pipeline_id: 1, nome: 'Reunião' });
    expect(store.crm.user.get('100')).toMatchObject({ user_id: 100, nome: 'Ana Teste' });
    expect(store.crm.field_def.get(`deal|${'a'.repeat(40)}`)).toMatchObject({ field_key: 'a'.repeat(40), nome: 'Origem' });
  });

  it('o ID original do campo personalizado (40 caracteres) é preservado', async () => {
    await run(['deal_fields']);
    expect([...store.crm.field_def.keys()].some((k) => k === `deal|${'a'.repeat(40)}`)).toBe(true);
  });

  it('registra o job (início, fim, contagens, unidades gastas) e o ponto de controle', async () => {
    await run(['pipelines']);
    const [job] = [...store.jobs.values()];
    expect(job).toMatchObject({ entity: 'pipelines', modo: 'incremental', origem: 'manual' });
    expect(job!.result).toMatchObject({ status: 'ok', lidos: 2, gravados: 2, atualizados: 0, ignorados: 0, falhas: 0, tokens_gastos: 5 });
    expect(store.checkpoints.get('pipelines')).toMatchObject({ ultimo_sucesso_em: '2026-10-05T12:00:00.000Z' });
    expect(store.usage.get('2026-10-05')).toMatchObject({ tokens: 5, requisicoes: 1 });
  });
});

describe('segunda rodada (idempotência)', () => {
  it('sem mudança na origem: nada é regravado, tudo vira "ignorado"', async () => {
    await run();
    const results = await run();
    for (const r of results) expect(r).toMatchObject({ gravados: 0, atualizados: 0, falhas: 0, status: 'ok' });
    expect(results.find((r) => r.entity === 'pipelines')!.ignorados).toBe(2);
    expect(store.raw.pipelines.size).toBe(2);
  });

  it('mudou um nome: só aquele registro é atualizado, e o raw e o crm acompanham', async () => {
    await run();
    (data.pipelines[0] as { name: string }).name = 'Funil RH (novo nome)';
    const r = (await run(['pipelines']))[0]!;
    expect(r).toMatchObject({ atualizados: 1, ignorados: 1, gravados: 0 });
    expect(store.crm.pipeline.get('1')!.nome).toBe('Funil RH (novo nome)');
    expect((store.raw.pipelines.get('1')!.payload as { name: string }).name).toBe('Funil RH (novo nome)');
  });

  it('apareceu um registro novo: é gravado, os antigos ficam ignorados', async () => {
    await run();
    data.pipelines.push({ id: 3, name: 'Funil novo', order_nr: 3 });
    const r = (await run(['pipelines']))[0]!;
    expect(r).toMatchObject({ gravados: 1, ignorados: 2 });
    expect(store.crm.pipeline.size).toBe(3);
  });

  it('um registro some da origem: continua no banco (nada é apagado em silêncio)', async () => {
    await run();
    data.pipelines.pop();
    await run(['pipelines']);
    expect(store.crm.pipeline.size).toBe(2);
    expect(store.raw.pipelines.size).toBe(2);
  });
});

describe('falhas', () => {
  it('um item inválido não derruba a rodada: é registrado e o status fica "parcial"', async () => {
    data.pipelines.push({ id: 'lixo' });
    const r = (await run(['pipelines']))[0]!;
    expect(r).toMatchObject({ status: 'parcial', gravados: 2, falhas: 1 });
    expect(store.errors).toHaveLength(1);
    expect(store.errors[0]).toMatchObject({ entity: 'pipelines' });
    expect(store.errors[0]!.mensagem).toMatch(/id/i);
  });

  it('erro geral (API caiu): status "erro", mensagem guardada, nada parcial gravado, e a próxima entidade continua', async () => {
    const c = client();
    c.listPipelines = async () => { throw new Error('Pipedrive fora do ar'); };
    const results = await syncBase({ client: c, store, entities: ['pipelines', 'stages'], modo: 'incremental', origem: 'manual', now: () => new Date('2026-10-05T12:00:00Z') });
    expect(results.find((r) => r.entity === 'pipelines')).toMatchObject({ status: 'erro' });
    expect([...store.jobs.values()].find((j) => j.entity === 'pipelines')!.result!.erro).toContain('fora do ar');
    expect(results.find((r) => r.entity === 'stages')).toMatchObject({ status: 'ok' });
    expect(store.crm.pipeline.size).toBe(0);
    // ponto de controle de sucesso NÃO avança numa rodada com erro
    expect(store.checkpoints.get('pipelines')?.ultimo_sucesso_em).toBeUndefined();
  });

  it('falha ao gravar no banco: o job termina em "erro"', async () => {
    store.failUpsert = 'pipelines';
    const r = (await run(['pipelines']))[0]!;
    expect(r.status).toBe('erro');
    expect(store.crm.pipeline.size).toBe(0);
  });

  it('o erro registrado nunca contém o token nem uma URL de conexão', async () => {
    const c = client();
    c.listUsers = async () => { throw new Error('falha em postgresql://u:senha@h/db com x-api-token=ABC'); };
    await syncBase({ client: c, store, entities: ['users'], modo: 'incremental', origem: 'manual', now: () => new Date() });
    const msg = [...store.jobs.values()][0]!.result!.erro!;
    expect(msg).not.toContain('senha');
    expect(msg).not.toContain('postgresql://');
  });
});

describe('uso da API', () => {
  it('soma as unidades gastas por entidade e por dia', async () => {
    await run();
    // pipelines 5 + stages 5 + users 20 + 4 definições de campos x 10 = 70
    expect(store.usage.get('2026-10-05')).toMatchObject({ tokens: 70, requisicoes: 7 });
  });
  it('as quatro definições de campos viram quatro chamadas', async () => {
    await run(['deal_fields', 'person_fields', 'organization_fields', 'activity_fields']);
    expect(calls).toEqual(['fields:deal', 'fields:person', 'fields:organization', 'fields:activity']);
  });
});
