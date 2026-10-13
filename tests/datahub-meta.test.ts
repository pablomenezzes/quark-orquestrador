import { describe, it, expect } from 'vitest';
import {
  CAMPOS_INSIGHTS, META_VERSAO, MetaClient, MetaErro, STATUS_TODOS, chaveNomeMeta, mapAdDia, mapAnuncio, mapCampanha, mapConjunto,
  metaCredenciaisFromEnv, temAtividade, type FetchLike,
} from '../src/datahub/meta/meta';
import { META_REVISAO_DIAS, syncMetaDesempenho } from '../src/datahub/meta/meta-sync';
import { intervalo } from '../src/datahub/google/ga4-sync';

const resp = (ok: boolean, status: number, body: unknown, uso?: unknown) => ({
  ok, status, json: async () => body, headers: { get: (n: string) => (n === 'x-business-use-case-usage' && uso ? JSON.stringify(uso) : null) },
});

describe('Meta: credenciais', () => {
  it('lê o token e as duas contas (com ou sem o prefixo act_)', () => {
    const c = metaCredenciaisFromEnv({ META_ACCESS_TOKEN: 't', META_AD_ACCOUNT_RH: 'act_111', META_AD_ACCOUNT_CLINIC: '222' });
    expect(c.contas).toEqual([{ id: '111', produto: 'rh' }, { id: '222', produto: 'clinic' }]);
  });
  it('falta de token ou de conta vira erro claro, sem vazar valor', () => {
    expect(() => metaCredenciaisFromEnv({ META_AD_ACCOUNT_RH: '1' })).toThrow(/Faltam/);
    expect(() => metaCredenciaisFromEnv({ META_ACCESS_TOKEN: 'segredo-nao-pode-aparecer' })).toThrow(/Faltam/);
    try { metaCredenciaisFromEnv({ META_ACCESS_TOKEN: 'segredo-nao-pode-aparecer' }); } catch (e) { expect((e as Error).message).not.toContain('segredo'); }
  });
});

describe('Meta: mapeamento', () => {
  it('IDs de 18 dígitos ficam como texto (Number() perderia os últimos dígitos)', () => {
    const a = mapAnuncio({ id: '120251349622780158', adset_id: '120251349622830158', campaign_id: '120251349622680158', name: 'AD1', creative: { id: '1901795161226973', name: 'c', url_tags: 'utm_content={{ad.name}}' } }, '287516640670266');
    expect(a).toMatchObject({ anuncio_id: '120251349622780158', conjunto_id: '120251349622830158', campanha_id: '120251349622680158', criativo_id: '1901795161226973', conta_id: '287516640670266' });
    expect(a.url_tags).toBe('utm_content={{ad.name}}');
    expect(String(Number('120251349622780158'))).not.toBe('120251349622780158'); // a prova de que o texto era necessário
  });
  it('orçamentos vêm em centavos e viram reais; sem orçamento fica nulo', () => {
    expect(mapCampanha({ id: '1', name: 'C', daily_budget: '25000', objective: 'OUTCOME_LEADS', effective_status: 'ACTIVE' }, '9')).toMatchObject({ orcamento_diario: 250, orcamento_total: null, objetivo: 'OUTCOME_LEADS', status: 'ACTIVE' });
    expect(mapConjunto({ id: '2', campaign_id: '1', name: 'S', optimization_goal: 'LEAD_GENERATION' }, '9')).toMatchObject({ campanha_id: '1', otimizacao: 'LEAD_GENERATION', orcamento_diario: null });
  });
  it('chave de nome: minúsculas e sem espaços, para "[Growth][83]" e "[Growth] [83]" serem o mesmo nome', () => {
    expect(chaveNomeMeta('[Growth] [83] [QuarkRH]')).toBe(chaveNomeMeta('[Growth][83][QuarkRH]'));
    expect(chaveNomeMeta('AD1 — Cópia')).toBe('ad1—cópia');
    expect(chaveNomeMeta('  ')).toBeNull();
    expect(chaveNomeMeta(null)).toBeNull();
  });
  it('desempenho: ações, vídeo e tempo médio viram colunas (3 segundos = action_type video_view)', () => {
    const d = mapAdDia({
      ad_id: '10', adset_id: '20', campaign_id: '30', date_start: '2026-10-05', spend: '3.32', impressions: '87', reach: '74', clicks: '2', inline_link_clicks: '1',
      actions: [{ action_type: 'link_click', value: '1' }, { action_type: 'landing_page_view', value: '1' }, { action_type: 'lead', value: '2' }, { action_type: 'video_view', value: '40' }, { action_type: 'post_reaction', value: '9' }],
      video_play_actions: [{ action_type: 'video_view', value: '35' }], video_p25_watched_actions: [{ action_type: 'video_view', value: '20' }],
      video_p50_watched_actions: [{ action_type: 'video_view', value: '10' }], video_p75_watched_actions: [{ action_type: 'video_view', value: '5' }],
      video_p95_watched_actions: [{ action_type: 'video_view', value: '3' }], video_p100_watched_actions: [{ action_type: 'video_view', value: '2' }],
      video_thruplay_watched_actions: [{ action_type: 'video_view', value: '4' }], video_avg_time_watched_actions: [{ action_type: 'video_view', value: '6.4' }],
    }, '9');
    expect(d).toEqual({
      anuncio_id: '10', dia: '2026-10-05', conta_id: '9', conjunto_id: '20', campanha_id: '30', gasto: 3.32, impressoes: 87, alcance: 74, cliques: 2, cliques_link: 1,
      visitas_pagina: 1, leads_meta: 2, video_reproducoes: 35, video_3s: 40, video_p25: 20, video_p50: 10, video_p75: 5, video_p95: 3, video_p100: 2, video_thruplay: 4, video_tempo_medio: 6.4,
    });
  });
  it('anúncio sem vídeo: colunas de vídeo em zero e tempo médio nulo; linha sem atividade não é guardada', () => {
    const d = mapAdDia({ ad_id: '1', date_start: '2026-10-05', spend: '0', impressions: '0', clicks: '0' }, '9');
    expect(d).toMatchObject({ video_reproducoes: 0, video_3s: 0, video_tempo_medio: null, gasto: 0 });
    expect(temAtividade(d)).toBe(false);
    expect(temAtividade({ ...d, impressoes: 1 })).toBe(true);
  });
  it('pede todos os campos de vídeo e não pede objetos excluídos (a Meta recusa)', () => {
    for (const f of ['video_p25_watched_actions', 'video_p100_watched_actions', 'video_thruplay_watched_actions', 'video_play_actions', 'inline_link_clicks', 'reach']) expect(CAMPOS_INSIGHTS).toContain(f);
    expect(STATUS_TODOS).not.toContain('DELETED');
    expect(META_VERSAO).toBe('v26.0');
  });
});

describe('Meta: cliente', () => {
  it('manda o token no cabeçalho (nunca na URL) e segue a paginação', async () => {
    const urls: string[] = [];
    const f: FetchLike = async (url, init) => {
      urls.push(url);
      expect(init!.headers!.authorization).toBe('Bearer TOKEN-FICTICIO');
      expect(url).not.toContain('TOKEN-FICTICIO');
      return url.includes('page=2') ? resp(true, 200, { data: [{ id: 3 }] }) : resp(true, 200, { data: [{ id: 1 }, { id: 2 }], paging: { next: 'https://graph.facebook.com/v26.0/x?page=2' } });
    };
    const c = new MetaClient('TOKEN-FICTICIO', f as never, async () => {});
    expect((await c.todas('act_1/ads', { fields: 'id' })).map((r) => r.id)).toEqual([1, 2, 3]);
    expect(urls[0]).toContain('/v26.0/act_1/ads?');
    expect(urls[0]).toContain('limit=500');
  });
  it('limite de cota: espera e tenta de novo; erro de permissão não é repetido e a mensagem não traz a URL', async () => {
    let n = 0;
    const esperas: number[] = [];
    const limite: FetchLike = async () => (++n < 3 ? resp(false, 400, { error: { code: 17, message: 'User request limit reached' } }) : resp(true, 200, { data: [] }));
    await new MetaClient('t', limite as never, async (ms) => void esperas.push(ms)).get('x');
    expect(n).toBe(3);
    expect(esperas).toEqual([60_000, 120_000]);
    let m = 0;
    const negado: FetchLike = async () => { m++; return resp(false, 403, { error: { code: 200, message: 'Permissions error', fbtrace_id: 'x' } }); };
    const err = await new MetaClient('t', negado as never, async () => {}).get('act_1/ads').catch((e: unknown) => e);
    expect(m).toBe(1);
    expect(err).toBeInstanceOf(MetaErro);
    expect((err as MetaErro).message).toContain('Permissions error');
    expect((err as MetaErro).message).not.toMatch(/https?:/);
  });
  it('erro temporário da Meta (código 1) é repetido e, se persistir, vira erro claro', async () => {
    let n = 0;
    const f: FetchLike = async () => { n++; return resp(false, 500, { error: { code: 1, message: 'An unknown error occurred' } }); };
    await expect(new MetaClient('t', f as never, async () => {}).get('x')).rejects.toThrow(/codigo 1/);
    expect(n).toBe(6); // 1 + 5 repetições
  });
  it('perto do limite de cota o cliente espera antes da próxima chamada', async () => {
    const esperas: number[] = [];
    const f: FetchLike = async () => resp(true, 200, { data: [] }, { '123': [{ call_count: 95, total_cputime: 10, total_time: 20, estimated_time_to_regain_access: 2 }] });
    const c = new MetaClient('t', f as never, async (ms) => void esperas.push(ms));
    await c.get('x');
    expect(esperas).toEqual([120_000]);
    expect(c.usoMaximo).toMatchObject({ callCount: 95, esperaMin: 2 });
  });
});

describe('Meta: início da carga', () => {
  const intervalos = async (marca: string | null, desde: string) => {
    const lidos: Array<{ since: string; until: string }> = [];
    const f: FetchLike = async (url) => {
      lidos.push(JSON.parse(new URL(url).searchParams.get('time_range')!));
      return resp(true, 200, { data: [] });
    };
    const store = { marcaDagua: async () => marca } as never;
    await syncMetaDesempenho(new MetaClient('t', f as never, async () => {}), store, { id: '1', produto: 'rh' }, { desde, apply: false, maxBlocos: 1 });
    return lidos[0]!;
  };
  it('uma marca d\'água anterior ao início pedido (sobra de uma carga que começava antes) é ignorada: começa em 2026-01-01', async () => {
    expect((await intervalos('2025-07-05', '2026-01-01')).since).toBe('2026-01-01');
  });
  it('uma marca d\'água depois do início vale: relê só os últimos 28 dias', async () => {
    const r = await intervalos('2026-06-10', '2026-01-01');
    expect(r.since).toBe('2026-05-14'); // 2026-06-10 menos 27 dias
  });
});

describe('Meta: janela de releitura', () => {
  it('depois da carga, cada rodada relê os últimos 28 dias (a Meta ajusta números por até 28 dias)', () => {
    expect(META_REVISAO_DIAS).toBe(28);
    expect(intervalo('2025-01-01', '2026-10-12', '2026-10-13', META_REVISAO_DIAS)).toEqual({ inicio: '2026-09-15', fim: '2026-10-12', modo: 'incremental' });
    expect(intervalo('2025-01-01', null, '2026-10-13', META_REVISAO_DIAS).modo).toBe('backfill');
  });
});
