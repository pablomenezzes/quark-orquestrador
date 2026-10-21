import { describe, it, expect } from 'vitest';
import { MetaClient, type AdDia, type FetchLike } from '../src/datahub/meta/meta';
import { atualizarIncremental, DIAS_DIARIA, DIAS_HORA, diasDaExecucao, trimestreDe, type IncStore } from '../src/datahub/meta/meta-incremental';

const CONTA = { id: '287516640670266', produto: 'rh' as const };
const linhaApi = (dia: string, gasto = '10.00', ad = '1') => ({ ad_id: ad, adset_id: '2', campaign_id: '3', date_start: dia, spend: gasto, impressions: '1000', clicks: '30', inline_link_clicks: '20', reach: '800', actions: [{ action_type: 'lead', value: '2' }] });

/** Meta de mentira: uma linha por dia pedido no nivel anuncio e o total da conta somando essas linhas. */
function metaFalsa(opts: { gastoPorDia?: Record<string, string>; contaExtra?: number; usoNaPrimeira?: number } = {}) {
  const pedidos: Array<{ since: string; until: string; nivel: string }> = [];
  let n = 0;
  const f: FetchLike = async (url) => {
    const u = new URL(url);
    const { since, until } = JSON.parse(u.searchParams.get('time_range')!) as { since: string; until: string };
    const nivel = u.searchParams.get('level')!;
    pedidos.push({ since, until, nivel });
    const dias: string[] = [];
    for (let d = since; d <= until; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) dias.push(d);
    const uso = ++n === 1 && opts.usoNaPrimeira ? { '1': [{ call_count: 1, total_cputime: 1, total_time: opts.usoNaPrimeira }] } : null;
    const hdr = { get: (h: string) => (h === 'x-business-use-case-usage' && uso ? JSON.stringify(uso) : null) };
    if (nivel === 'account') {
      const gasto = dias.reduce((s, d) => s + Number(opts.gastoPorDia?.[d] ?? '10.00'), 0) + (opts.contaExtra ?? 0);
      return { ok: true, status: 200, headers: hdr, json: async () => ({ data: [{ spend: gasto.toFixed(2), impressions: String(dias.length * 1000), clicks: String(dias.length * 30), actions: [{ action_type: 'lead', value: String(dias.length * 2) }] }] }) };
    }
    return { ok: true, status: 200, headers: hdr, json: async () => ({ data: dias.map((d) => linhaApi(d, opts.gastoPorDia?.[d])) }) };
  };
  return { client: new MetaClient('TOKEN-FICTICIO', f as never, async () => {}), pedidos };
}

function storeFalso(opts: { existentes?: Array<Record<string, unknown>>; fechados?: string[] } = {}) {
  const gravadas: AdDia[] = [];
  const store: IncStore = {
    existentes: async (_c, de, ate) => (opts.existentes ?? []).filter((e) => String(e.dia) >= de && String(e.dia) <= ate) as never,
    gravarLinhas: async (rows) => void gravadas.push(...rows),
    trimestreFechado: async (t) => (opts.fechados ?? []).includes(t),
  };
  return { store, gravadas };
}

describe('Meta: atualização incremental (só os últimos dias)', () => {
  it('só hoje de hora em hora e só as últimas 48h (2 dias) às 06 UTC; nunca a carga toda', () => {
    expect(DIAS_HORA).toBe(1);
    expect(DIAS_DIARIA).toBe(2);
    expect(diasDaExecucao(new Date('2026-10-21T06:20:00Z'))).toBe(2);
    for (const h of [0, 1, 5, 7, 12, 23]) expect(diasDaExecucao(new Date(`2026-10-21T${String(h).padStart(2, '0')}:20:00Z`)), `hora ${h}`).toBe(1);
    expect(trimestreDe('2026-10-21')).toBe('2026-T4');
    expect(trimestreDe('2026-03-31')).toBe('2026-T1');
  });
  it('lê só a janela pedida (2 dias = 1 bloco) e grava o que é novo', async () => {
    const { client, pedidos } = metaFalsa();
    const { store, gravadas } = storeFalso();
    const r = await atualizarIncremental(client, store, CONTA, '2026-10-21', 2);
    expect(r).toMatchObject({ de: '2026-10-20', ate: '2026-10-21', blocos: 1, linhas_lidas: 2, inseridas: 2, atualizadas: 0, mantidas: 0 });
    expect(pedidos.every((p) => p.since >= '2026-10-20' && p.until <= '2026-10-21')).toBe(true);
    expect(pedidos).toHaveLength(2); // linhas por anúncio + total da conta
    expect(gravadas.map((g) => g.dia)).toEqual(['2026-10-20', '2026-10-21']);
    expect(r.diferencas).toEqual([]);
  });
  it('só grava o que mudou: igual fica, valor diferente é atualizado, dia novo é inserido', async () => {
    const { client } = metaFalsa();
    const igual = { ...linhaApi('2026-10-20'), anuncio_id: '1', dia: '2026-10-20', gasto: '10.00', impressoes: 1000, alcance: 800, cliques: 30, cliques_link: 20, visitas_pagina: 0, leads_meta: 2, video_reproducoes: 0, video_3s: 0, video_p25: 0, video_p50: 0, video_p75: 0, video_p95: 0, video_p100: 0, video_thruplay: 0, video_tempo_medio: null };
    const { store, gravadas } = storeFalso({ existentes: [igual] });
    const r = await atualizarIncremental(client, store, CONTA, '2026-10-21', 2);
    expect([r.inseridas, r.atualizadas, r.mantidas]).toEqual([1, 0, 1]);
    expect(gravadas.map((g) => [g.dia, g.gasto])).toEqual([['2026-10-21', 10]]);
    // a Meta revisou o gasto do dia 20 para 12,00: vira atualização
    const rev = metaFalsa({ gastoPorDia: { '2026-10-20': '12.00' } });
    const s2 = storeFalso({ existentes: [igual] });
    const r2 = await atualizarIncremental(rev.client, s2.store, CONTA, '2026-10-21', 2);
    expect([r2.inseridas, r2.atualizadas, r2.mantidas]).toEqual([1, 1, 0]);
    expect(s2.gravadas.map((g) => [g.dia, g.gasto])).toEqual([['2026-10-21', 10], ['2026-10-20', 12]]);
  });
  it('trimestre FECHADO nunca é tocado', async () => {
    const { client, pedidos } = metaFalsa();
    const { store, gravadas } = storeFalso({ fechados: ['2026-T4'] });
    const r = await atualizarIncremental(client, store, CONTA, '2026-10-21', 2);
    expect(r).toMatchObject({ blocos: 0, ignorados_fechados: 1, inseridas: 0 });
    expect(pedidos).toHaveLength(0);
    expect(gravadas).toHaveLength(0);
  });
  it('nunca a carga toda: pedir mais de 2 dias é recusado antes de chamar a Meta', async () => {
    const { client, pedidos } = metaFalsa();
    const { store } = storeFalso();
    await expect(atualizarIncremental(client, store, CONTA, '2026-10-21', 3)).rejects.toThrow(/nunca a carga toda/);
    await expect(atualizarIncremental(client, store, CONTA, '2026-10-21', 28)).rejects.toThrow(/nunca a carga toda/);
    expect(pedidos).toHaveLength(0);
  });
  it('diferença com o total da conta nos dias recentes é registrada, mas não trava a atualização', async () => {
    const { client } = metaFalsa({ contaExtra: 0.07 });
    const { store, gravadas } = storeFalso();
    const r = await atualizarIncremental(client, store, CONTA, '2026-10-21', 2);
    expect(gravadas).toHaveLength(2);
    expect(r.diferencas).toHaveLength(1);
    expect(r.diferencas[0]).toContain('gasto -0.07');
  });
  it('cota a 75%: espera, relê só o bloco e termina; se continuar quente, para sem gravar o bloco e sem falhar', async () => {
    const { client } = metaFalsa({ usoNaPrimeira: 80 });
    const { store, gravadas } = storeFalso();
    let esperas = 0;
    const r = await atualizarIncremental(client, store, CONTA, '2026-10-21', 2, { esfriar: async () => void esperas++ });
    expect(esperas).toBe(1);
    expect(r.inseridas).toBe(2);
    expect(gravadas).toHaveLength(2);
    // sem como esfriar: para (parou) e nada do bloco foi gravado
    const quente = metaFalsa({ usoNaPrimeira: 80 });
    const s2 = storeFalso();
    const r2 = await atualizarIncremental(quente.client, s2.store, CONTA, '2026-10-21', 2);
    expect(r2.parou).toMatch(/80%/);
    expect(s2.gravadas).toHaveLength(0);
  });
});
