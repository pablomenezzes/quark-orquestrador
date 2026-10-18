import { describe, it, expect } from 'vitest';
import { MetaClient, type AdDia, type FetchLike } from '../src/datahub/meta/meta';
import {
  blocosDeDias, blocosMensais, intervaloRodada, CARTAO_TEXTO, compararLinhas, definirPausaCota, gravarRodada, hashLinha, reconciliar, RodadaRecusada, simularRodada, situacaoTrimestre, totaisDe, trimestreIntervalo,
  type CartaoRodada, type RodadaStoreLike,
} from '../src/datahub/meta/meta-rodadas';

definirPausaCota(1); // nos testes a pausa de cota é de 1 ms (em produção, 5 min)
const linha = (o: Partial<AdDia> = {}): AdDia => ({
  anuncio_id: '120000000000000001', dia: '2026-07-01', conta_id: '1', conjunto_id: '2', campanha_id: '3', gasto: 10.5, impressoes: 1000, alcance: 800, cliques: 30, cliques_link: 20,
  visitas_pagina: 15, leads_meta: 2, video_reproducoes: 0, video_3s: 0, video_p25: 0, video_p50: 0, video_p75: 0, video_p95: 0, video_p100: 0, video_thruplay: 0, video_tempo_medio: null, ...o,
});

describe('Meta: trimestres', () => {
  it('intervalos de calendário', () => {
    expect(trimestreIntervalo('2026-T3')).toEqual({ de: '2026-07-01', ate: '2026-09-30' });
    expect(trimestreIntervalo('2026-T4')).toEqual({ de: '2026-10-01', ate: '2026-12-31' });
    expect(trimestreIntervalo('2025-T1')).toEqual({ de: '2025-01-01', ate: '2025-03-31' });
    expect(trimestreIntervalo('2026-T2')).toEqual({ de: '2026-04-01', ate: '2026-06-30' });
    expect(() => trimestreIntervalo('2026-T5')).toThrow();
  });
  it('o intervalo lido nunca passa de hoje (a Meta recusa datas futuras no trimestre em curso)', () => {
    expect(intervaloRodada('2026-T4', '2026-10-18')).toEqual({ de: '2026-10-01', ate: '2026-10-18' });
    expect(intervaloRodada('2026-T3', '2026-10-18')).toEqual({ de: '2026-07-01', ate: '2026-09-30' });
  });
  it('situação: corrente, fechando (até 30 dias depois do fim), fechado', () => {
    expect(situacaoTrimestre('2026-T4', '2026-10-13')).toBe('corrente');
    expect(situacaoTrimestre('2026-T3', '2026-10-13')).toBe('fechando');
    expect(situacaoTrimestre('2026-T2', '2026-10-13')).toBe('fechado');
    expect(situacaoTrimestre('2026-T4', '2026-09-01')).toBe('futuro');
  });
  it('a leitura anda de 7 em 7 dias, sem furo nem sobreposição (o último bloco pode ser menor)', () => {
    const b = blocosDeDias('2026-07-01', '2026-09-30');
    expect(b).toHaveLength(14);
    expect(b[0]).toEqual({ inicio: '2026-07-01', fim: '2026-07-07' });
    expect(b[1]!.inicio).toBe('2026-07-08');
    expect(b.at(-1)).toEqual({ inicio: '2026-09-30', fim: '2026-09-30' });
    for (let i = 1; i < b.length; i++) expect(Date.parse(b[i]!.inicio) - Date.parse(b[i - 1]!.fim)).toBe(86_400_000);
  });
  it('blocos mensais cobrem o trimestre sem furo nem sobreposição', () => {
    expect(blocosMensais('2026-07-01', '2026-09-30')).toEqual([{ inicio: '2026-07-01', fim: '2026-07-31' }, { inicio: '2026-08-01', fim: '2026-08-31' }, { inicio: '2026-09-01', fim: '2026-09-30' }]);
  });
});

describe('Meta: comparação e reconciliação', () => {
  it('hash ignora tipo (texto do banco x número da Meta)', () => {
    const doBanco = { anuncio_id: '120000000000000001', dia: '2026-07-01', gasto: '10.50', impressoes: 1000, alcance: 800, cliques: 30, cliques_link: 20, visitas_pagina: 15, leads_meta: 2, video_reproducoes: 0, video_3s: 0, video_p25: 0, video_p50: 0, video_p75: 0, video_p95: 0, video_p100: 0, video_thruplay: 0, video_tempo_medio: null };
    expect(hashLinha(doBanco)).toBe(hashLinha(linha() as never));
    expect(hashLinha({ ...doBanco, gasto: '10.51' })).not.toBe(hashLinha(linha() as never));
  });
  it('separa inserir, atualizar e manter, e conta o que sumiu da Meta (nunca apaga)', () => {
    const existentes = [
      { ...linha(), anuncio_id: 'A', dia: '2026-07-01' }, { ...linha(), anuncio_id: 'B', dia: '2026-07-01' }, { ...linha(), anuncio_id: 'SUMIU', dia: '2026-07-01' },
    ] as never[];
    const novas = [linha({ anuncio_id: 'A' }), linha({ anuncio_id: 'B', gasto: 99 }), linha({ anuncio_id: 'C' })];
    const r = compararLinhas(novas, existentes);
    expect([r.inserir.map((x) => x.anuncio_id), r.atualizar.map((x) => x.anuncio_id), r.manter, r.remover_na_meta]).toEqual([['C'], ['B'], 1, 1]);
  });
  it('reconciliação: bate dentro de 5 centavos; qualquer outra diferença não é explicada', () => {
    const t = totaisDe([linha(), linha({ gasto: 4.5, impressoes: 10, cliques: 1, leads_meta: 1 })]);
    expect(t).toEqual({ gasto: 15, impressoes: 1010, cliques: 31, leads: 3 });
    expect(reconciliar(t, t).explicada).toBe(true);
    expect(reconciliar({ ...t, gasto: 15.04 }, t).explicada).toBe(true);
    expect(reconciliar({ ...t, leads: 4 }, t).explicada).toBe(false);
  });
});

/* ---------- simulação e gravação com Meta e banco de mentira ---------- */
function fakeMeta(opts: { leadsConta?: number } = {}) {
  const f: FetchLike = async (url) => {
    const u = new URL(url);
    const { since, until } = JSON.parse(u.searchParams.get('time_range')!) as { since: string; until: string };
    const tem = (dia: string) => since <= dia && dia <= until; // o dado de julho está no dia 01/07 e o de agosto no dia 01/08
    if (u.searchParams.get('level') === 'account') {
      const d = tem('2026-07-01') ? { spend: '10.50', impressions: '1000', clicks: '30', leads: opts.leadsConta ?? 2 } : tem('2026-08-01') ? { spend: '4.50', impressions: '1000', clicks: '30', leads: 2 } : null;
      const data = d ? [{ spend: d.spend, impressions: d.impressions, clicks: d.clicks, actions: [{ action_type: 'lead', value: String(d.leads) }] }] : [];
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data }) };
    }
    const dados = tem('2026-07-01') ? [{ ad_id: '1', adset_id: '2', campaign_id: '3', date_start: '2026-07-01', spend: '10.50', impressions: '1000', clicks: '30', inline_link_clicks: '20', reach: '800', actions: [{ action_type: 'lead', value: '2' }, { action_type: 'landing_page_view', value: '15' }] }] :
      tem('2026-08-01') ? [{ ad_id: '1', adset_id: '2', campaign_id: '3', date_start: '2026-08-01', spend: '4.50', impressions: '1000', clicks: '30', inline_link_clicks: '20', reach: '800', actions: [{ action_type: 'lead', value: '2' }] }] : [];
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: dados }) };
  };
  return new MetaClient('TOKEN-FICTICIO', f as never, async () => {});
}
function fakeStore(over: Partial<RodadaStoreLike> & { simulacao?: { rodada_id: number; cartao: CartaoRodada } | null; fechado?: boolean } = {}) {
  const gravadas: unknown[] = [];
  const rodadas: Array<Record<string, unknown>> = [];
  const store: RodadaStoreLike = {
    contaConfigurada: async () => 'rh',
    existentes: async () => [],
    tamanhoBancoMb: async () => 268,
    criarRodada: async (r) => { rodadas.push(r); return rodadas.length; },
    finalizarRodada: async () => {},
    simulacaoPrevia: async () => over.simulacao ?? null,
    gravarLinhas: async (rows) => void gravadas.push(...rows),
    marcarTrimestre: async () => {},
    trimestreFechado: async () => over.fechado ?? false,
    ...over,
  };
  return { store, gravadas, rodadas };
}
const CONTA = { id: '287516640670266', produto: 'rh' as const };

describe('Meta: simulação e gravação de uma rodada', () => {
  it('a simulação lê, compara, reconcilia e monta o cartão; NÃO grava dados', async () => {
    const { store, gravadas, rodadas } = fakeStore();
    const r = await simularRodada(fakeMeta(), store, CONTA, '2026-T3', '2026-10-13');
    expect(gravadas).toHaveLength(0);
    expect(rodadas[0]).toMatchObject({ modo: 'simulacao', status: 'simulada', trimestre: '2026-T3', de: '2026-07-01', ate: '2026-09-30' });
    expect(r.cartao).toMatchObject({ linhas_lidas: 2, inserir: 2, atualizar: 0, manter: 0, completa: true, situacao: 'fechando', produto: 'rh' });
    expect(r.cartao.reconciliacao.explicada).toBe(true);
    expect(r.cartao.chamadas).toBe(28); // 14 blocos de 7 dias (o último com 1 dia) x (linhas por anúncio + total da conta)
    expect(r.cartao.reconciliacao.por_mes).toHaveLength(14);
    expect(r.cartao.mb_previsto).toBeCloseTo((2 * 227) / 1048576, 2);
    const txt = CARTAO_TEXTO(r.cartao);
    expect(txt).toContain('CARTAO DA RODADA');
    expect(txt).toContain('a inserir: 2');
    expect(txt).toContain('Reconciliacao');
  });
  it('diferença na reconciliação aparece como risco', async () => {
    const r = await simularRodada(fakeMeta({ leadsConta: 9 }), fakeStore().store, CONTA, '2026-T3', '2026-10-13');
    expect(r.cartao.reconciliacao.explicada).toBe(false);
    expect(r.cartao.riscos.join(' ')).toMatch(/DIFERENCA NAO EXPLICADA/);
    expect(r.cartao.reconciliacao.por_mes!.filter((m) => !m.explicada).map((m) => m.mes)).toEqual(['2026-07-01 a 2026-07-07']); // localiza o bloco de 7 dias com a diferença
    expect(CARTAO_TEXTO(r.cartao)).toContain('<- DIFERENCA');
  });
  it('conta fora da configuração fica em quarentena', async () => {
    await expect(simularRodada(fakeMeta(), fakeStore({ contaConfigurada: async () => null }).store, CONTA, '2026-T3', '2026-10-13')).rejects.toThrow(/quarentena/);
  });
  it('a leitura para a 75% da cota: cartão incompleto e sem permissão para gravar', async () => {
    const f: FetchLike = async () => ({ ok: true, status: 200, headers: { get: (n: string) => (n === 'x-business-use-case-usage' ? JSON.stringify({ '1': [{ call_count: 1, total_cputime: 1, total_time: 80 }] }) : null) }, json: async () => ({ data: [] }) });
    const r = await simularRodada(new MetaClient('t', f as never, async () => {}), fakeStore().store, CONTA, '2026-T3', '2026-10-13');
    expect(r.cartao.completa).toBe(false);
    expect(r.cartao.parou).toMatch(/80%/);
    expect(CARTAO_TEXTO(r.cartao)).toContain('INCOMPLETO');
  });

  it('parou por cota no meio de um mês: espera, relê o MESMO mês e termina a rodada (não aborta)', async () => {
    let jul = 0;
    const base = fakeMeta();
    const f: FetchLike = async (url) => {
      const u = new URL(url);
      const since = u.searchParams.get('time_range') ? (JSON.parse(u.searchParams.get('time_range')!).since as string) : '';
      // a primeira leitura de julho (nível anúncio) vem com 80% de uso: a rodada para; depois da pausa volta a 10%
      if (since === '2026-07-01' && u.searchParams.get('level') === 'ad' && ++jul === 1) {
        return { ok: true, status: 200, headers: { get: (n: string) => (n === 'x-business-use-case-usage' ? JSON.stringify({ '1': [{ call_count: 1, total_cputime: 1, total_time: 80 }] }) : null) }, json: async () => ({ data: [] }) };
      }
      return (base as any).doFetch(url);
    };
    const c = new MetaClient('t', f as never, async () => {});
    // o cliente de mentira devolve julho vazio na primeira tentativa (bloco interrompido); a segunda usa os dados normais
    const r = await simularRodada(c, fakeStore().store, CONTA, '2026-T3', '2026-10-13');
    expect(r.cartao.completa).toBe(true);
    expect(r.cartao.linhas_lidas).toBe(2);
    expect(jul).toBe(2);
  });
  it('a gravação RECUSA sem autorização, sem simulação prévia e com trimestre fechado', async () => {
    const sim = await simularRodada(fakeMeta(), fakeStore().store, CONTA, '2026-T3', '2026-10-13');
    const previa = { rodada_id: 7, cartao: sim.cartao };
    await expect(gravarRodada(fakeMeta(), fakeStore({ simulacao: previa }).store, CONTA, '2026-T3', '2026-10-13', { autorizacao: '  ' })).rejects.toThrow(/autorizacao/);
    const semSim = fakeStore();
    await expect(gravarRodada(fakeMeta(), semSim.store, CONTA, '2026-T3', '2026-10-13', { autorizacao: 'pode seguir' })).rejects.toBeInstanceOf(RodadaRecusada);
    expect(semSim.gravadas).toHaveLength(0);
    const fechado = fakeStore({ simulacao: previa, fechado: true });
    await expect(gravarRodada(fakeMeta(), fechado.store, CONTA, '2026-T3', '2026-10-13', { autorizacao: 'pode seguir' })).rejects.toThrow(/FECHADO/);
    expect(fechado.gravadas).toHaveLength(0);
  });
  it('a gravação recusa diferença não explicada, e com simulação, autorização e reconciliação grava só novas e alteradas', async () => {
    const sim = await simularRodada(fakeMeta(), fakeStore().store, CONTA, '2026-T3', '2026-10-13');
    const previa = { rodada_id: 7, cartao: sim.cartao };
    const dif = fakeStore({ simulacao: previa });
    await expect(gravarRodada(fakeMeta({ leadsConta: 9 }), dif.store, CONTA, '2026-T3', '2026-10-13', { autorizacao: 'pode seguir' })).rejects.toThrow(/DIFERENCA/);
    expect(dif.gravadas).toHaveLength(0);
    const ok = fakeStore({ simulacao: previa, existentes: async () => [{ ...linha({ anuncio_id: '1', dia: '2026-07-01', conjunto_id: '2', campanha_id: '3' }), gasto: '10.50', alcance: 800 } as never] });
    const g = await gravarRodada(fakeMeta(), ok.store, CONTA, '2026-T3', '2026-10-13', { autorizacao: 'pode seguir (Pablo, 2026-10-13)' });
    expect(ok.rodadas.at(-1)).toMatchObject({ modo: 'gravacao', simulacao_de_origem: 7, autorizacao: 'pode seguir (Pablo, 2026-10-13)' });
    expect(g.cartao.manter).toBe(1);
    expect(ok.gravadas).toHaveLength(1); // a linha de agosto; a de julho já estava igual
  });
});
