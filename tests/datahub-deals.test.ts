import { describe, it, expect } from 'vitest';
import { PipedriveReadClient, PipedriveError } from '../src/datahub/pipedrive/client';
import { parseDeal, normalizeReasonText } from '../src/datahub/parse';
import { syncDeals, type DealsClient } from '../src/datahub/sync/deals';
import { MemoryDatahubStore } from './helpers/memory-datahub-store';

// Dados 100% fictícios (regra 8).
const NOW = new Date('2026-10-07T12:00:00.000Z');
const reasons = new Map([[normalizeReasonText('Lead Invalido'), 398], [normalizeReasonText('Perda de prioridade'), 33]]);

const deal = (id: number, over: Record<string, unknown> = {}) => ({
  id, title: `Negócio fictício ${id}`, pipeline_id: 1, stage_id: 11, owner_id: 7, person_id: 100 + id, org_id: 200 + id,
  currency: 'BRL', value: 1500, status: 'open', lost_reason: null, add_time: '2025-03-10T10:00:00Z', update_time: '2025-03-11T10:00:00Z',
  stage_change_time: '2025-03-11T10:00:00Z', is_deleted: false, is_archived: false, custom_fields: { [`${'a'.repeat(39)}1`]: 'valor' }, ...over,
});

describe('parseDeal', () => {
  it('traz IDs e datas normalizados, mantém os campos personalizados com o ID original', () => {
    const p = parseDeal(deal(1), 'normal', reasons, NOW);
    expect(p).toMatchObject({ pipedrive_id: 1, pipeline_id: 1, stage_id: 11, owner_id: 7, person_id: 101, org_id: 201, status: 'open', status_original: 'open', valor: 1500, moeda: 'BRL', is_deleted: false, is_archived: false });
    expect(p.created_at).toBe('2025-03-10T10:00:00.000Z');
    expect(Object.keys(p.custom_fields!)[0]).toHaveLength(40);
  });
  it('motivo de perda vem como TEXTO: o ID sai do casamento com as opções do campo (sem se importar com caixa e espaços)', () => {
    expect(parseDeal(deal(2, { status: 'lost', lost_reason: ' lead   invalido ' }), 'normal', reasons, NOW)).toMatchObject({ motivo_perda: 'lead   invalido', motivo_perda_id: 398 });
    expect(parseDeal(deal(3, { status: 'lost', lost_reason: 'Motivo que não existe mais' }), 'normal', reasons, NOW).motivo_perda_id).toBeNull();
  });
  it('motivo de perda como objeto ({id,label}) também é entendido', () => {
    expect(parseDeal(deal(4, { status: 'lost', lost_reason: { id: 398, label: 'Lead Invalido' } }), 'normal', reasons, NOW)).toMatchObject({ motivo_perda: 'Lead Invalido', motivo_perda_id: 398 });
  });
  it('excluído: is_deleted, status nulo, o que o Pipedrive disse em status_original, e a data da detecção', () => {
    const p = parseDeal(deal(5, { status: 'deleted' }), 'deleted', reasons, NOW);
    expect(p).toMatchObject({ is_deleted: true, status: null, status_original: 'deleted', deleted_detected_at: NOW.toISOString() });
    expect(parseDeal(deal(6), 'deleted', reasons, NOW).is_deleted).toBe(true); // veio na lista de excluídos
  });
  it('arquivado vem da lista de arquivados', () => {
    expect(parseDeal(deal(7), 'archived', reasons, NOW).is_archived).toBe(true);
  });
  it('registro sem ID é recusado; campos ausentes viram null', () => {
    expect(() => parseDeal({ title: 'x' }, 'normal', reasons, NOW)).toThrow();
    expect(() => parseDeal('texto', 'normal', reasons, NOW)).toThrow();
    expect(parseDeal({ id: 9 }, 'normal', reasons, NOW)).toMatchObject({ pipedrive_id: 9, titulo: null, stage_id: null, valor: null, custom_fields: null, is_deleted: false });
  });
  it('referências v1 ({value}) e números como texto são aceitos', () => {
    expect(parseDeal({ id: 10, person_id: { value: 55 }, org_id: { value: 66 }, user_id: { id: 3 }, value: '10.5' }, 'normal', reasons, NOW)).toMatchObject({ person_id: 55, org_id: 66, owner_id: 3, valor: 10.5 });
  });
});

describe('cliente: negócios', () => {
  const resp = (body: unknown, headers: Record<string, string> = {}) => ({ status: 200, body, headers });
  function mk(responses: Array<{ status: number; body: unknown; headers: Record<string, string> }>, over: object = {}) {
    const calls: string[] = [];
    let i = 0;
    const fn = (async (url: string, init: RequestInit) => {
      expect(init.method).toBe('GET');
      calls.push(String(url));
      const r = responses[Math.min(i++, responses.length - 1)]!;
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...r.headers } });
    }) as unknown as typeof fetch;
    return { client: new PipedriveReadClient({ domain: 'quark', apiToken: 'T', fetchImpl: fn, sleep: async () => undefined, minIntervalMs: 0, ...over }), calls };
  }

  it('usa as rotas e os filtros certos para cada lista', async () => {
    const { client, calls } = mk([resp({ success: true, data: [{ id: 1 }], additional_data: { next_cursor: 'abc' } })]);
    const page = await client.listDealsPage('normal', { updatedSince: '2025-01-01T00:00:00Z', updatedUntil: '2026-10-07T00:00:00Z', cursor: null });
    expect(page).toEqual({ items: [{ id: 1 }], nextCursor: 'abc' });
    await client.listDealsPage('archived', { updatedSince: '2025-01-01T00:00:00Z', cursor: 'abc' });
    await client.listDealsPage('deleted', { updatedSince: '2025-01-01T00:00:00Z' });
    const u = calls.map((c) => new URL(c));
    expect(u[0]!.pathname).toBe('/api/v2/deals');
    expect(u[0]!.searchParams.get('limit')).toBe('500');
    expect(u[0]!.searchParams.get('updated_since')).toBe('2025-01-01T00:00:00Z');
    expect(u[0]!.searchParams.get('updated_until')).toBe('2026-10-07T00:00:00Z');
    expect(u[0]!.searchParams.has('cursor')).toBe(false);
    expect(u[0]!.searchParams.has('status')).toBe(false);
    expect(u[1]!.pathname).toBe('/api/v2/deals/archived');
    expect(u[1]!.searchParams.get('cursor')).toBe('abc');
    expect(u[2]!.pathname).toBe('/api/v2/deals');
    expect(u[2]!.searchParams.get('status')).toBe('deleted');
    expect(client.usage.tokens).toBe(10 + 20 + 10); // custos da documentação
  });

  it('manda as datas sem milissegundos (o Pipedrive recusa com HTTP 400)', async () => {
    const { client, calls } = mk([resp({ success: true, data: [] })]);
    await client.listDealsPage('normal', { updatedSince: '2026-10-07T11:50:00.000Z', updatedUntil: '2026-10-07T12:00:00.123Z' });
    const q = new URL(calls[0]!).searchParams;
    expect(q.get('updated_since')).toBe('2026-10-07T11:50:00Z');
    expect(q.get('updated_until')).toBe('2026-10-07T12:00:00Z');
  });

  it('lê a cota diária do cabeçalho e PARA antes de passar da fatia permitida (40% do dia)', async () => {
    const h = (rem: number) => ({ 'x-daily-ratelimit-token-limit': '1000', 'x-daily-ratelimit-token-remaining': String(rem) });
    const { client, calls } = mk([resp({ success: true, data: [] }, h(700)), resp({ success: true, data: [] }, h(605)), resp({ success: true, data: [] }, h(595))], { keepFreeShare: 0.6 });
    await client.listDealsPage('normal', {}); // sobram 700
    expect(client.daily).toEqual({ limit: 1000, remaining: 700 });
    await client.listDealsPage('normal', {}); // sobram 605: a próxima (10) deixaria 595 < 600
    await expect(client.listDealsPage('normal', {})).rejects.toMatchObject({ kind: 'budget' });
    expect(calls).toHaveLength(2); // a terceira chamada nem saiu
  });

  it('sem cabeçalho de cota, segue normalmente', async () => {
    const { client } = mk([resp({ success: true, data: [] })]);
    await client.listDealsPage('normal', {});
    await client.listDealsPage('normal', {});
    expect(client.daily).toEqual({ limit: null, remaining: null });
  });
});

/** Pipedrive de mentira: respeita updated_since/until e pagina por cursor. */
function fakePipedrive(data: Record<'normal' | 'archived' | 'deleted', Array<ReturnType<typeof deal>>>, pageSize = 2, failAfterCalls = Infinity) {
  const calls: Array<{ kind: string; since?: string | null; until?: string | null; cursor?: string | null }> = [];
  const client: DealsClient & { stopAfter: number } = {
    usage: { tokens: 0, requests: 0, rateLimited: 0 },
    stopAfter: failAfterCalls,
    async listDealsPage(kind, p) {
      if (calls.length >= client.stopAfter) throw new PipedriveError('cota do dia', 'budget');
      calls.push({ kind, since: p.updatedSince, until: p.updatedUntil, cursor: p.cursor });
      client.usage.tokens += 10;
      client.usage.requests += 1;
      const all = data[kind].filter((d) => (!p.updatedSince || Date.parse(String(d.update_time)) >= Date.parse(p.updatedSince)) && (!p.updatedUntil || Date.parse(String(d.update_time)) <= Date.parse(p.updatedUntil)));
      const start = p.cursor ? Number(p.cursor) : 0;
      const items = all.slice(start, start + pageSize);
      return { items, nextCursor: start + pageSize < all.length ? String(start + pageSize) : null };
    },
  };
  return { client, calls };
}

const base = (store: MemoryDatahubStore, client: DealsClient, extra: object = {}) =>
  syncDeals({ client, store, desde: '2025-01-01T00:00:00Z', origem: 'manual', now: () => NOW, ...extra });

describe('sincronização de negócios', () => {
  const five = [1, 2, 3, 4, 5].map((i) => deal(i, { update_time: `2025-0${i}-15T10:00:00Z` }));

  it('carga inicial: lê todas as páginas, grava raw e crm, e fecha com marca-d\'água', async () => {
    const store = new MemoryDatahubStore();
    const { client, calls } = fakePipedrive({ normal: five, archived: [], deleted: [] });
    const [r] = await base(store, client, { kinds: ['normal'] });
    expect(r).toMatchObject({ entity: 'deals', status: 'ok', lidos: 5, gravados: 5, ignorados: 0, paginas: 3, backfill: true });
    expect(store.dealsRaw.size).toBe(5);
    expect(store.dealsCrm.get('3')).toMatchObject({ pipedrive_id: 3, titulo: 'Negócio fictício 3' });
    expect(store.dealsRaw.get('3')!.origem_lista).toBe('normal');
    expect(calls[0]).toMatchObject({ since: '2025-01-01T00:00:00Z', until: NOW.toISOString() });
    expect(store.checkpoints.get('deals')).toMatchObject({ backfill_concluido: true, marca_dagua: NOW.toISOString() });
    expect([...store.usage.values()][0]).toMatchObject({ tokens: 30, requisicoes: 3 });
  });

  it('carga RETOMÁVEL: se a cota acaba no meio, o cursor fica guardado e a próxima rodada continua sem repetir', async () => {
    const store = new MemoryDatahubStore();
    const pd = fakePipedrive({ normal: five, archived: [], deleted: [] }, 2, 2); // só 2 chamadas e para
    const [a] = await base(store, pd.client, { kinds: ['normal'] });
    expect(a!).toMatchObject({ status: 'parcial', lidos: 4, gravados: 4, paginas: 2 });
    expect(a!.erro).toMatch(/cota/);
    expect(store.checkpoints.get('deals')).toMatchObject({ cursor_atual: { cursor: '4', since: '2025-01-01T00:00:00Z', until: NOW.toISOString() } });
    expect(store.checkpoints.get('deals')!.backfill_concluido).toBeFalsy();

    const later = new Date('2026-10-08T09:00:00.000Z'); // outro dia: a janela continua a MESMA (until fixo)
    pd.client.stopAfter = Infinity;
    const [b] = await base(store, pd.client, { kinds: ['normal'], now: () => later });
    expect(b).toMatchObject({ status: 'ok', lidos: 1, gravados: 1, paginas: 1, backfill: true });
    expect(pd.calls[2]).toMatchObject({ cursor: '4', until: NOW.toISOString() });
    expect(store.dealsRaw.size).toBe(5);
    expect(store.checkpoints.get('deals')).toMatchObject({ backfill_concluido: true, marca_dagua: NOW.toISOString() });
  });

  it('depois da carga, só pede o que mudou desde a marca-d\'água (com folga) e não regrava o que é igual', async () => {
    const store = new MemoryDatahubStore();
    const data = { normal: five, archived: [], deleted: [] };
    await base(store, fakePipedrive(data).client, { kinds: ['normal'] });

    const later = new Date('2026-10-07T16:00:00.000Z');
    const changed = deal(5, { update_time: '2026-10-07T13:30:00Z', stage_id: 12 });
    const novo = deal(6, { update_time: '2026-10-07T14:00:00Z' });
    const pd = fakePipedrive({ normal: [...five.slice(0, 4), changed, novo], archived: [], deleted: [] });
    const [r] = await base(store, pd.client, { kinds: ['normal'], now: () => later });
    expect(r).toMatchObject({ status: 'ok', backfill: false, lidos: 2, gravados: 1, atualizados: 1, ignorados: 0, paginas: 1 });
    expect(Date.parse(pd.calls[0]!.since!)).toBe(Date.parse(NOW.toISOString()) - 10 * 60_000); // marca-d'água - 10 min
    expect(pd.calls).toHaveLength(1);
    expect(store.dealsCrm.get('5')).toMatchObject({ stage_id: 12 });
    expect(store.checkpoints.get('deals')).toMatchObject({ marca_dagua: later.toISOString() });
  });

  it('o que veio igual (mesmo hash) é ignorado, mesmo dentro da janela de folga', async () => {
    const store = new MemoryDatahubStore();
    const d = deal(1, { update_time: '2026-10-07T11:55:00Z' });
    await base(store, fakePipedrive({ normal: [d], archived: [], deleted: [] }).client, { kinds: ['normal'] });
    const [r] = await base(store, fakePipedrive({ normal: [d], archived: [], deleted: [] }).client, { kinds: ['normal'], now: () => new Date('2026-10-07T16:00:00Z') });
    expect(r).toMatchObject({ lidos: 1, gravados: 0, atualizados: 0, ignorados: 1 });
  });

  it('excluídos e arquivados têm lista, marca-d\'água e marcação próprias; nada é apagado', async () => {
    const store = new MemoryDatahubStore();
    const normal = [deal(1), deal(2)];
    await base(store, fakePipedrive({ normal, archived: [], deleted: [] }).client);
    expect(store.dealsCrm.get('1')).toMatchObject({ is_deleted: false });

    const pd = fakePipedrive({ normal: [], archived: [deal(9, { is_archived: true, update_time: '2026-10-07T13:00:00Z' })], deleted: [deal(1, { status: 'deleted', update_time: '2026-10-07T11:59:00Z' })] });
    const res = await base(store, pd.client, { now: () => new Date('2026-10-07T18:00:00Z') });
    expect(res.map((r) => r.entity)).toEqual(['deals', 'deals_archived', 'deals_deleted']);
    expect(store.dealsCrm.get('1')).toMatchObject({ is_deleted: true, status: null, status_original: 'deleted' });
    expect(store.dealsRaw.get('1')!.origem_lista).toBe('deleted');
    expect(store.dealsCrm.get('9')).toMatchObject({ is_archived: true });
    expect(store.dealsCrm.get('2')).toMatchObject({ is_deleted: false }); // os outros não foram tocados
    expect(store.dealsCrm.size).toBe(3); // nada sumiu
  });

  it('motivo de perda ganha o ID usando as opções do campo', async () => {
    const store = new MemoryDatahubStore();
    store.lostReasons = reasons;
    await base(store, fakePipedrive({ normal: [deal(1, { status: 'lost', lost_reason: 'Lead Invalido' })], archived: [], deleted: [] }).client, { kinds: ['normal'] });
    expect(store.dealsCrm.get('1')).toMatchObject({ motivo_perda: 'Lead Invalido', motivo_perda_id: 398, status: 'lost' });
  });

  it('um registro ruim não derruba a rodada: vira falha registrada, o resto grava', async () => {
    const store = new MemoryDatahubStore();
    const ruim = { title: 'sem id', update_time: '2025-03-11T10:00:00Z' } as unknown as ReturnType<typeof deal>;
    const [r] = await base(store, fakePipedrive({ normal: [deal(1), ruim, deal(3)], archived: [], deleted: [] }, 10).client, { kinds: ['normal'] });
    expect(r!).toMatchObject({ status: 'parcial', gravados: 2, falhas: 1 });
    expect(store.errors).toHaveLength(1);
  });

  it('erro ao gravar: a rodada acaba como erro, SEM marcar a carga como concluída', async () => {
    const store = new MemoryDatahubStore();
    store.failDeals = true;
    const [r] = await base(store, fakePipedrive({ normal: five, archived: [], deleted: [] }).client, { kinds: ['normal'] });
    expect(r!.status).toBe('erro');
    expect(store.checkpoints.get('deals')?.backfill_concluido).toBeFalsy();
    expect(store.errors.at(-1)!.mensagem).toContain('falha simulada');
  });

  it('limite de páginas por rodada (carga gradual): para e continua depois', async () => {
    const store = new MemoryDatahubStore();
    const pd = fakePipedrive({ normal: five, archived: [], deleted: [] });
    const [a] = await base(store, pd.client, { kinds: ['normal'], maxPages: 1 });
    expect(a).toMatchObject({ status: 'parcial', paginas: 1, lidos: 2 });
    const [b] = await base(store, pd.client, { kinds: ['normal'] });
    expect(b).toMatchObject({ status: 'ok', paginas: 2, lidos: 3, gravados: 3 });
    expect(store.dealsRaw.size).toBe(5);
  });

  it('mensagens de erro não carregam segredo', async () => {
    const store = new MemoryDatahubStore();
    const pd = fakePipedrive({ normal: [], archived: [], deleted: [] });
    pd.client.listDealsPage = async () => {
      throw new Error('falha em postgresql://orq_sync:SENHA@host/db');
    };
    await base(store, pd.client, { kinds: ['normal'] });
    expect(JSON.stringify(store.errors)).not.toContain('SENHA');
  });
});
