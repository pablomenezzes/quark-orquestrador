import { describe, it, expect } from 'vitest';
import { PipedriveReadClient, PipedriveError } from '../src/datahub/pipedrive/client';
import { buildStageHistory, trimFlowItems, type FlowItem } from '../src/datahub/history';
import { syncHistory, type HistoryClient } from '../src/datahub/sync/history';
import { MemoryDatahubStore } from './helpers/memory-datahub-store';

// Dados 100% fictícios (regra 8). Os formatos seguem o que o Pipedrive devolveu na sondagem de 2026-10-08.
const change = (id: number, oldV: unknown, newV: unknown, logTime: string, user = 7, field = 'stage_id') => ({
  object: 'dealChange', timestamp: logTime,
  data: { id, item_id: 1, user_id: user, field_key: field, old_value: oldV, new_value: newV, log_time: logTime, change_source: 'app', change_source_user_agent: 'Mozilla/5.0 (muito texto)', is_bulk_update_flag: false, additional_data: { old_value_formatted: 'x', new_value_formatted: 'y' } },
});

describe('trimFlowItems', () => {
  it('guarda só mudanças de ETAPA, só com os campos essenciais, e ignora atividades, notas e outros campos', () => {
    const raw = [
      change(1, 15, 2, '2026-03-01 10:00:00'),
      change(2, null, 500, '2026-03-02 10:00:00', 7, 'value'),
      change(3, 'open', 'won', '2026-03-03 10:00:00', 7, 'status'),
      { object: 'activity', timestamp: '2026-03-04 10:00:00', data: { id: 9, subject: 'ligar' } },
      { object: 'note', data: { content: 'texto sensível' } },
      null,
      'lixo',
    ];
    const t = trimFlowItems(raw as unknown[]);
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual({ id: 1, field_key: 'stage_id', old_value: 15, new_value: 2, log_time: '2026-03-01T10:00:00.000Z', user_id: 7, change_source: 'app', is_bulk_update_flag: false });
    expect(JSON.stringify(t)).not.toMatch(/Mozilla|texto sensível|ligar/); // sem user agent, notas nem atividades
  });
});

describe('buildStageHistory', () => {
  const CRIADO = '2026-03-01T09:00:00.000Z';
  const it_ = (id: number, o: number | null, n: number, t: string, u = 7): FlowItem => ({ id, field_key: 'stage_id', old_value: o, new_value: n, log_time: t, user_id: u });

  it('sem mudança de etapa: uma linha só, na etapa atual, desde a criação', () => {
    const b = buildStageHistory(CRIADO, 11, []);
    expect(b.rows).toEqual([{ stage_id: 11, entrou_em: CRIADO, saiu_em: null, user_id: null, origem_dado: 'criacao' }]);
    expect(b.avisos).toEqual([]);
  });

  it('a etapa inicial é a de origem da primeira mudança; cada mudança fecha a anterior; a última fica aberta', () => {
    const b = buildStageHistory(CRIADO, 6, [
      it_(3, 3, 4, '2026-03-03T10:00:00.000Z'), it_(1, 15, 2, '2026-03-01T10:00:00.000Z', 1), it_(2, 2, 3, '2026-03-02T10:00:00.000Z', 2), it_(4, 4, 6, '2026-03-04T10:00:00.000Z', 3),
    ]); // fora de ordem de propósito
    expect(b.rows.map((r) => [r.stage_id, r.entrou_em, r.saiu_em, r.user_id, r.origem_dado])).toEqual([
      [15, CRIADO, '2026-03-01T10:00:00.000Z', null, 'criacao'],
      [2, '2026-03-01T10:00:00.000Z', '2026-03-02T10:00:00.000Z', 1, 'flow'],
      [3, '2026-03-02T10:00:00.000Z', '2026-03-03T10:00:00.000Z', 2, 'flow'],
      [4, '2026-03-03T10:00:00.000Z', '2026-03-04T10:00:00.000Z', 7, 'flow'],
      [6, '2026-03-04T10:00:00.000Z', null, 3, 'flow'],
    ]);
    expect(b.avisos).toEqual([]);
  });

  it('a mesma mudança registrada duas vezes no mesmo segundo (visto no Pipedrive) vira uma só, sem linha duplicada', () => {
    const b = buildStageHistory(CRIADO, 4, [
      it_(1211060, 15, 2, '2026-03-01T10:00:00.000Z', 22), it_(1211125, 2, 1, '2026-03-01T10:05:00.000Z', 22),
      it_(1211130, 1, 3, '2026-03-01T10:06:00.000Z', 22), it_(1211132, 1, 3, '2026-03-01T10:06:00.000Z', 22), // duplicata
      it_(1212291, 3, 4, '2026-03-02T10:00:00.000Z', 21),
    ]);
    expect(b.rows.map((r) => r.stage_id)).toEqual([15, 2, 1, 3, 4]);
    const chaves = b.rows.map((r) => `${r.stage_id}|${r.entrou_em}`);
    expect(new Set(chaves).size).toBe(chaves.length); // nenhuma chave repetida: o banco não reclama
    expect(b.rows[3]).toMatchObject({ stage_id: 3, entrou_em: '2026-03-01T10:06:00.000Z', saiu_em: '2026-03-02T10:00:00.000Z' });
  });

  it('duas mudanças diferentes para a mesma etapa no mesmo segundo: trava final une e avisa (o banco nunca recebe chave repetida)', () => {
    const b = buildStageHistory(CRIADO, 3, [it_(1, 1, 3, '2026-03-02T10:00:00.000Z'), it_(2, 2, 3, '2026-03-02T10:00:00.000Z')]);
    const chaves = b.rows.map((r) => `${r.stage_id}|${r.entrou_em}`);
    expect(new Set(chaves).size).toBe(chaves.length);
    expect(b.avisos.join(' ')).toMatch(/repetida/);
  });

  it('negócio que sai de uma etapa e volta no mesmo segundo mantém as duas passagens (momentos diferentes não são duplicata)', () => {
    const b = buildStageHistory(CRIADO, 4, [it_(1, 6, 4, '2026-03-02T14:09:11.000Z'), it_(2, 4, 6, '2026-03-02T14:09:09.000Z')]);
    expect(b.rows.map((r) => [r.stage_id, r.entrou_em])).toEqual([[4, CRIADO], [6, '2026-03-02T14:09:09.000Z'], [4, '2026-03-02T14:09:11.000Z']]);
  });

  it('volta para uma etapa anterior vira uma linha nova (a mesma etapa em dois momentos)', () => {
    const b = buildStageHistory(CRIADO, 3, [it_(1, 3, 1, '2026-03-02T10:00:00.000Z'), it_(2, 1, 3, '2026-03-03T10:00:00.000Z')]);
    expect(b.rows.filter((r) => r.stage_id === 3)).toHaveLength(2);
    expect(b.rows.map((r) => r.stage_id)).toEqual([3, 1, 3]);
  });

  it('avisa quando o histórico termina numa etapa diferente da atual, e quando falta a etapa de origem', () => {
    expect(buildStageHistory(CRIADO, 9, [it_(1, 1, 2, '2026-03-02T10:00:00.000Z')]).avisos[0]).toMatch(/termina na etapa 2.*hoje na etapa 9/);
    const semOrigem = buildStageHistory(CRIADO, 2, [it_(1, null, 2, '2026-03-02T10:00:00.000Z')]);
    expect(semOrigem.rows).toHaveLength(1);
    expect(semOrigem.avisos[0]).toMatch(/não informa a etapa de origem/);
  });

  it('sem data de criação ou sem etapa atual e sem mudanças: nada a registrar, com aviso', () => {
    expect(buildStageHistory(null, 5, []).rows).toEqual([]);
    expect(buildStageHistory(CRIADO, null, []).rows).toEqual([]);
  });
});

describe('cliente: histórico do negócio', () => {
  function mk(pages: unknown[]) {
    const calls: string[] = [];
    let i = 0;
    const fn = (async (url: string, init: RequestInit) => {
      expect(init.method).toBe('GET');
      calls.push(String(url));
      return new Response(JSON.stringify(pages[Math.min(i++, pages.length - 1)]), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { client: new PipedriveReadClient({ domain: 'quark', apiToken: 'T', fetchImpl: fn, sleep: async () => undefined, minIntervalMs: 0 }), calls };
  }
  it('pede só dealChange, custa 40 unidades e segue a paginação', async () => {
    const { client, calls } = mk([
      { success: true, data: [change(1, 1, 2, '2026-03-01 10:00:00')], additional_data: { pagination: { more_items_in_collection: true, next_start: 500 } } },
      { success: true, data: [change(2, 2, 3, '2026-03-02 10:00:00')], additional_data: { pagination: { more_items_in_collection: false } } },
    ]);
    const items = await client.getDealFlow(123);
    expect(items).toHaveLength(2);
    const u = calls.map((c) => new URL(c));
    expect(u[0]!.pathname).toBe('/v1/deals/123/flow');
    expect(u[0]!.searchParams.get('items')).toBe('dealChange');
    expect(u[0]!.searchParams.has('start')).toBe(false);
    expect(u[1]!.searchParams.get('start')).toBe('500');
    expect(client.usage.tokens).toBe(80);
  });
  it('recusa ID inválido sem chamar a API', async () => {
    const { client, calls } = mk([{ success: true, data: [] }]);
    for (const id of [0, -1, 1.5, NaN]) await expect(client.getDealFlow(id)).rejects.toBeInstanceOf(PipedriveError);
    expect(calls).toHaveLength(0);
  });
});

describe('sincronização do histórico', () => {
  const NOW = new Date('2026-10-08T12:00:00.000Z');
  const addDeal = (s: MemoryDatahubStore, id: number, over: Record<string, unknown> = {}) =>
    s.dealsCrm.set(String(id), { pipedrive_id: id, status: 'lost', is_deleted: false, stage_id: 2, created_at: '2026-03-01T09:00:00.000Z', stage_change_time: null, ...over });

  function fake(flows: Record<number, unknown[]>, over: Partial<{ stopAfter: number; failIds: number[] }> = {}) {
    const calls: number[] = [];
    const client: HistoryClient & { stopAfter: number } = {
      usage: { tokens: 0, requests: 0, rateLimited: 0 },
      stopAfter: over.stopAfter ?? Infinity,
      async getDealFlow(id) {
        if (calls.length >= client.stopAfter) throw new PipedriveError('cota do dia', 'budget');
        calls.push(id);
        client.usage.tokens += 40;
        client.usage.requests += 1;
        if (over.failIds?.includes(id)) throw new PipedriveError('Pipedrive devolveu erro (HTTP 404)', 'client');
        return flows[id] ?? [];
      },
    };
    return { client, calls };
  }
  const run = (store: MemoryDatahubStore, client: HistoryClient, extra: object = {}) => syncHistory({ client, store, year: 2026, now: () => NOW, ...extra });

  it('negócio sem mudança de etapa NÃO chama a API: ganha a linha da criação', async () => {
    const store = new MemoryDatahubStore();
    addDeal(store, 1); addDeal(store, 2, { stage_id: 5 });
    const { client, calls } = fake({});
    const r = await run(store, client);
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ status: 'ok', semMudanca: 2, lidos: 0, tokens_gastos: 0 });
    expect([...store.stageHistory.values()].map((h) => [h.deal_id, h.stage_id, h.origem_dado, h.saiu_em])).toEqual([[1, 2, 'criacao', null], [2, 5, 'criacao', null]]);
  });

  it('negócio que mudou: lê o histórico, grava a linha do tempo, e a fila prioriza abertos e ganhos', async () => {
    const store = new MemoryDatahubStore();
    addDeal(store, 10, { status: 'lost', stage_id: 4, stage_change_time: '2026-03-04T10:00:00.000Z' });
    addDeal(store, 11, { status: 'open', stage_id: 3, stage_change_time: '2026-03-03T10:00:00.000Z' });
    addDeal(store, 12, { status: 'won', stage_id: 6, stage_change_time: '2026-03-05T10:00:00.000Z' });
    const { client, calls } = fake({
      10: [change(1, 1, 4, '2026-03-04 10:00:00')],
      11: [change(2, 1, 3, '2026-03-03 10:00:00')],
      12: [change(3, 1, 6, '2026-03-05 10:00:00')],
    });
    const r = await run(store, client);
    expect(calls).toEqual([11, 12, 10]); // aberto, ganho, perdido
    expect(r).toMatchObject({ status: 'ok', lidos: 3, gravados: 3, tokens_gastos: 120, restantes: 0 });
    const h10 = [...store.stageHistory.values()].filter((h) => h.deal_id === 10);
    expect(h10.map((h) => [h.stage_id, h.entrou_em, h.saiu_em])).toEqual([[1, '2026-03-01T09:00:00.000Z', '2026-03-04T10:00:00.000Z'], [4, '2026-03-04T10:00:00.000Z', null]]);
    expect(store.dealFlow.get(10)!.items).toHaveLength(1);
    expect(store.checkpoints.get('deal_history')).toMatchObject({ backfill_concluido: true });
  });

  it('só considera o ano pedido (2026) e ignora excluídos', async () => {
    const store = new MemoryDatahubStore();
    addDeal(store, 20, { created_at: '2025-12-31T23:00:00.000Z', stage_change_time: '2026-01-02T10:00:00.000Z' });
    addDeal(store, 21, { created_at: '2026-01-01T00:00:00.000Z', stage_change_time: '2026-01-02T10:00:00.000Z', stage_id: 3 });
    addDeal(store, 22, { is_deleted: true, stage_change_time: '2026-03-02T10:00:00.000Z' });
    const { client, calls } = fake({ 21: [change(1, 1, 3, '2026-01-02 10:00:00')] });
    await run(store, client);
    expect(calls).toEqual([21]);
  });

  it('retomável: o que já foi lido não é lido de novo; só volta à fila se a etapa mudou depois', async () => {
    const store = new MemoryDatahubStore();
    addDeal(store, 30, { status: 'open', stage_id: 3, stage_change_time: '2026-03-03T10:00:00.000Z' });
    addDeal(store, 31, { status: 'open', stage_id: 3, stage_change_time: '2026-03-03T11:00:00.000Z' });
    const flows = { 30: [change(1, 1, 3, '2026-03-03 10:00:00')], 31: [change(2, 1, 3, '2026-03-03 11:00:00')] };
    const a = fake(flows, { stopAfter: 1 });
    expect(await run(store, a.client)).toMatchObject({ status: 'parcial', lidos: 1, restantes: 1 });
    const b = fake(flows);
    expect(await run(store, b.client)).toMatchObject({ status: 'ok', lidos: 1, restantes: 0 });
    expect(b.calls).toEqual([31]); // o 30 já estava lido
    const c = fake(flows);
    expect((await run(store, c.client)).lidos).toBe(0); // nada pendente: custo zero
    // o negócio 30 muda de etapa: volta à fila
    store.dealsCrm.get('30')!.stage_change_time = '2026-03-09T10:00:00.000Z';
    store.dealsCrm.get('30')!.stage_id = 4;
    const d = fake({ 30: [change(1, 1, 3, '2026-03-03 10:00:00'), change(5, 3, 4, '2026-03-09 10:00:00')] });
    expect(await run(store, d.client)).toMatchObject({ lidos: 1, gravados: 1 });
    expect(d.calls).toEqual([30]);
    expect([...store.stageHistory.values()].filter((h) => h.deal_id === 30 && h.stage_id === 3)[0]!.saiu_em).toBe('2026-03-09T10:00:00.000Z'); // a linha anterior foi fechada
  });

  it('um negócio que falha (ex.: 404) não derruba a rodada; 10 falhas seguidas param tudo', async () => {
    const store = new MemoryDatahubStore();
    for (const id of [40, 41, 42]) addDeal(store, id, { status: 'open', stage_id: 3, stage_change_time: `2026-03-0${id - 38}T10:00:00.000Z` });
    const f = fake({ 40: [change(1, 1, 3, '2026-03-02 10:00:00')], 42: [change(2, 1, 3, '2026-03-04 10:00:00')] }, { failIds: [41] });
    const r = await run(store, f.client);
    expect(r).toMatchObject({ status: 'parcial', lidos: 2, gravados: 2, falhas: 1 });
    expect(store.errors.some((e) => e.source_id === 41)).toBe(true);

    const store2 = new MemoryDatahubStore();
    const ids = Array.from({ length: 12 }, (_, i) => 100 + i);
    for (const id of ids) addDeal(store2, id, { status: 'open', stage_change_time: '2026-03-02T10:00:00.000Z' });
    const r2 = await run(store2, fake({}, { failIds: ids }).client);
    expect(r2.status).toBe('erro');
    expect(r2.erro).toMatch(/10 falhas seguidas/);
  });

  it('avisos de inconsistência são registrados sem derrubar nem contar como falha', async () => {
    const store = new MemoryDatahubStore();
    addDeal(store, 50, { status: 'open', stage_id: 9, stage_change_time: '2026-03-02T10:00:00.000Z' });
    const r = await run(store, fake({ 50: [change(1, 1, 3, '2026-03-02 10:00:00')] }).client);
    expect(r).toMatchObject({ status: 'ok', avisos: 1, falhas: 0 });
    expect(store.errors[0]!.mensagem).toMatch(/^aviso:/);
  });

  it('com consultas em paralelo o resultado é o mesmo: todos lidos, cada um gravado uma vez', async () => {
    const store = new MemoryDatahubStore();
    const ids = [200, 201, 202, 203, 204, 205, 206];
    const flows: Record<number, unknown[]> = {};
    for (const id of ids) {
      addDeal(store, id, { status: 'open', stage_id: 3, stage_change_time: '2026-03-02T10:00:00.000Z' });
      flows[id] = [change(id, 1, 3, '2026-03-02 10:00:00')];
    }
    const f = fake(flows);
    const r = await run(store, f.client, { concurrency: 3 });
    expect(r).toMatchObject({ status: 'ok', lidos: 7, gravados: 7, restantes: 0, tokens_gastos: 280 });
    expect([...f.calls].sort()).toEqual([...ids].sort());
    expect(store.dealFlow.size).toBe(7);
  });

  it('em paralelo, a cota acabando para a rodada sem erro e o que ficou continua na fila', async () => {
    const store = new MemoryDatahubStore();
    const ids = [210, 211, 212, 213, 214, 215];
    for (const id of ids) addDeal(store, id, { status: 'open', stage_id: 3, stage_change_time: '2026-03-02T10:00:00.000Z' });
    const flows = Object.fromEntries(ids.map((id) => [id, [change(id, 1, 3, '2026-03-02 10:00:00')]]));
    const a = fake(flows, { stopAfter: 3 });
    const r = await run(store, a.client, { concurrency: 3 });
    expect(r.status).toBe('parcial');
    expect(r.gravados).toBe(3);
    expect(r.restantes).toBe(3);
    const b = fake(flows);
    expect(await run(store, b.client, { concurrency: 3 })).toMatchObject({ status: 'ok', lidos: 3 });
    expect(store.dealFlow.size).toBe(6);
  });

  it('limite de negócios por rodada (carga gradual)', async () => {
    const store = new MemoryDatahubStore();
    for (const id of [60, 61, 62]) addDeal(store, id, { status: 'open', stage_id: 3, stage_change_time: '2026-03-02T10:00:00.000Z' });
    const f = fake({ 60: [change(1, 1, 3, '2026-03-02 10:00:00')], 61: [change(2, 1, 3, '2026-03-02 10:00:00')], 62: [change(3, 1, 3, '2026-03-02 10:00:00')] });
    const r = await run(store, f.client, { maxDeals: 2 });
    expect(r).toMatchObject({ status: 'parcial', lidos: 2, pendentesAntes: 3, restantes: 1 });
  });

  it('mensagens de erro não carregam segredo', async () => {
    const store = new MemoryDatahubStore();
    addDeal(store, 70, { status: 'open', stage_change_time: '2026-03-02T10:00:00.000Z' });
    const client: HistoryClient = { usage: { tokens: 0, requests: 0, rateLimited: 0 }, getDealFlow: async () => { throw new PipedriveError('x-api-token=SEGREDO123 postgresql://u:SENHA@h/db', 'auth'); } };
    await run(store, client);
    expect(JSON.stringify([...store.errors, ...store.jobs.values()])).not.toMatch(/SEGREDO123|SENHA/);
  });
});
