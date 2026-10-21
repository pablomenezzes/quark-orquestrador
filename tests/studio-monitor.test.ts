import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createStudioServer } from '../studio/server';
import { agoraLocal, CANAIS, montarMonitor, periodosDe, veredito, ZERO, type CanalId, type DadosMonitor, type Soma, type MonitorRepo } from '../studio/lib/monitor';

const soma = (o: Partial<Soma>): Soma => ({ ...ZERO, ...o });
const vazio = (): Record<CanalId, Map<string, Soma>> => ({ google: new Map(), meta: new Map(), social: new Map(), organico: new Map() });
const semOntem = (): Record<CanalId, Soma> => ({ google: ZERO, meta: ZERO, social: ZERO, organico: ZERO });

describe('Monitor: janelas de comparação (mesmo número de dias desde o início do período)', () => {
  it('hoje contra ontem', () => {
    const j = periodosDe('2026-10-21');
    expect(j.dia).toEqual({ atual: { de: '2026-10-21', ate: '2026-10-21', dias: 1 }, anterior: { de: '2026-10-20', ate: '2026-10-20', dias: 1 } });
  });
  it('semana começa na segunda e compara o mesmo trecho da semana anterior', () => {
    const j = periodosDe('2026-10-21'); // quarta
    expect(j.semana.atual).toEqual({ de: '2026-10-19', ate: '2026-10-21', dias: 3 });
    expect(j.semana.anterior).toEqual({ de: '2026-10-12', ate: '2026-10-14', dias: 3 });
    expect(periodosDe('2026-10-25').semana.atual.dias).toBe(7); // domingo: semana inteira
    expect(periodosDe('2026-10-19').semana.anterior).toEqual({ de: '2026-10-12', ate: '2026-10-12', dias: 1 }); // segunda: 1 dia contra 1 dia
  });
  it('mês contra o mesmo trecho do mês anterior, inclusive quando o anterior é mais curto', () => {
    const j = periodosDe('2026-10-21');
    expect(j.mes.atual).toEqual({ de: '2026-10-01', ate: '2026-10-21', dias: 21 });
    expect(j.mes.anterior).toEqual({ de: '2026-09-01', ate: '2026-09-21', dias: 21 });
    const mar = periodosDe('2026-03-31'); // fevereiro tem 28 dias
    expect(mar.mes.anterior).toEqual({ de: '2026-02-01', ate: '2026-02-28', dias: 28 });
    expect(periodosDe('2026-01-15').mes.anterior).toEqual({ de: '2025-12-01', ate: '2025-12-15', dias: 15 }); // vira o ano
  });
  it('o dia é o de America/Fortaleza (meia-noite local), não o de UTC', () => {
    expect(agoraLocal(new Date('2026-10-22T02:30:00Z'))).toEqual({ hoje: '2026-10-21', hora: '23:30' });
    expect(agoraLocal(new Date('2026-10-22T03:05:00Z'))).toEqual({ hoje: '2026-10-22', hora: '00:05' });
  });
});

describe('Monitor: montagem por canal e total', () => {
  const dados = (): DadosMonitor => {
    const d = vazio();
    d.meta.set('2026-10-21', soma({ leads: 40, mql: 30, reunioes: 4, ganhos: 1, mrr: 500, invest: 1000 }));
    d.meta.set('2026-10-20', soma({ leads: 50, mql: 40, reunioes: 5, ganhos: 2, mrr: 900, invest: 1200 }));
    d.google.set('2026-10-21', soma({ leads: 5, mql: 4, ganhos: 0, invest: 200 }));
    d.google.set('2026-10-20', soma({ leads: 6, mql: 3, ganhos: 1, mrr: 300, invest: 250 }));
    d.organico.set('2026-10-21', soma({ leads: 10, mql: 9, ganhos: 1, mrr: 700 }));
    d.organico.set('2026-10-20', soma({ leads: 12, mql: 8 }));
    d.social.set('2026-09-05', soma({ leads: 3 }));
    // contagens de ontem ATÉ A MESMA HORA (menores que o dia inteiro)
    const o = semOntem();
    o.meta = soma({ leads: 30, mql: 25, reunioes: 3, ganhos: 1, mrr: 400 });
    o.google = soma({ leads: 4, mql: 2 });
    o.organico = soma({ leads: 8, mql: 6 });
    return { diario: d, ontemMesmaHora: o, hora: '12:00' };
  };
  const m = montarMonitor(dados(), '2026-10-21');
  const canal = (id: string) => m.canais.find((c) => c.id === id)!;

  it('traz o total e os quatro canais, cada um independente', () => {
    expect(m.canais.map((c) => c.id)).toEqual(['total', 'google', 'meta', 'social', 'organico']);
    expect(CANAIS.map((c) => c.fonte)).toEqual(['Marketing [Google ADS]', 'Marketing [Meta ADS]', 'Marketing [Social]', 'Marketing [Orgânico]']);
  });
  it('o total é a soma dos canais; cada canal só vê os próprios números', () => {
    expect(canal('total').periodos.dia.atual).toMatchObject({ leads: 55, mql: 43, ganhos: 2, mrr: 1200, invest: 1200 });
    expect(canal('meta').periodos.dia.atual).toMatchObject({ leads: 40, invest: 1000 });
    expect(canal('google').periodos.dia.atual).toMatchObject({ leads: 5, invest: 200 });
    expect(canal('organico').periodos.dia.atual).toMatchObject({ leads: 10, invest: 0 });
  });
  it('no dia, as contagens de ontem vão até a mesma hora e os custos usam o ontem inteiro', () => {
    const t = canal('total').periodos.dia.anterior;
    expect(t.leads).toBe(42); // 30 + 4 + 8 (até 12:00), e não 68 (dia inteiro)
    expect(t.invest).toBe(1450); // gasto só existe por dia: ontem inteiro
    expect(t.cpl).toBeCloseTo(1450 / 68, 6); // razão de custo: ontem inteiro de ponta a ponta
    expect(t.cac).toBeCloseTo(1450 / 3, 6);
  });
  it('semana e mês comparam janelas de mesmo tamanho', () => {
    const t = canal('total');
    expect(t.periodos.semana.atual.leads).toBe(55 + 68); // 19/10 a 21/10 tem 20 e 21 com dados
    expect(t.periodos.mes.anterior.leads).toBe(3); // só o social de 05/09
  });
  it('canal sem verba tem custo em branco (não se aplica), nunca zero; com verba, CPL e CAC saem do investimento', () => {
    expect(canal('organico').periodos.mes.atual.cpl).toBeNull();
    expect(canal('organico').periodos.mes.atual.cac).toBeNull();
    expect(canal('organico').pago).toBe(false);
    expect(canal('meta').periodos.dia.atual.cpl).toBeCloseTo(1000 / 40, 6);
    expect(canal('meta').periodos.dia.atual.cac).toBeCloseTo(1000, 6);
    expect(canal('meta').periodos.dia.atual.pctMql).toBeCloseTo(30 / 40, 6);
  });
  it('a série de 30 dias termina em hoje e é por canal', () => {
    const s = canal('meta').serie;
    expect(s.dias).toHaveLength(30);
    expect(s.dias.at(-1)).toBe('2026-10-21');
    expect(s.leads.at(-1)).toBe(40);
    expect(s.invest.at(-2)).toBe(1200);
  });
  it('veredito: só semana e mês, só piora acima de 5%, e CAC subindo é piora', () => {
    if (m.veredito.pior) expect(m.veredito.pior.periodo).not.toBe('dia');
    const base = canal('total');
    const igual = { ...base, periodos: { dia: base.periodos.dia, semana: { atual: base.periodos.semana.atual, anterior: base.periodos.semana.atual }, mes: { atual: base.periodos.mes.atual, anterior: base.periodos.mes.atual } } };
    expect(veredito(igual).pior).toBeNull();
    const cacSobe = { ...igual, periodos: { ...igual.periodos, mes: { atual: { ...base.periodos.mes.atual, cac: 130 }, anterior: { ...base.periodos.mes.atual, cac: 100 } } } };
    expect(veredito(cacSobe).pior).toMatchObject({ metrica: 'cac', periodo: 'mes' });
    const cacCai = { ...igual, periodos: { ...igual.periodos, mes: { atual: { ...base.periodos.mes.atual, cac: 80 }, anterior: { ...base.periodos.mes.atual, cac: 100 } } } };
    expect(veredito(cacCai).pior).toBeNull();
  });
});

describe('Monitor: página e API', () => {
  let server: Server; let semRepo: Server; let base: string; let baseSem: string; let dir: string;
  const chamadas: Array<string | undefined> = [];
  const repo: MonitorRepo = { async monitor(p) { chamadas.push(p); return montarMonitor({ diario: vazio(), ontemMesmaHora: semOntem(), hora: '10:00' }, '2026-10-21'); } };
  const mk = (monitor: MonitorRepo | null) => createStudioServer({ formsDir: join(dir, 'forms'), publicDir: join(dir, 'public'), trackingDir: join(dir, 'tracking'), sources: [], dbInfo: () => ({ connected: true }), submit: async () => ({ status: 200, body: {} }), monitor });
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'studio-monitor-'));
    for (const d of ['forms', 'public', 'tracking']) mkdirSync(join(dir, d));
    writeFileSync(join(dir, 'public', 'monitor.html'), '<h1>monitor.html</h1>');
    server = mk(repo); semRepo = mk(null);
    await Promise.all([server, semRepo].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    baseSem = `http://127.0.0.1:${(semRepo.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await Promise.all([server, semRepo].map((s) => new Promise((r) => s.close(r)))); rmSync(dir, { recursive: true, force: true }); });
  it('serve a página e a API só com GET, com o produto validado', async () => {
    expect(await (await fetch(`${base}/monitor`)).text()).toContain('monitor.html');
    const r = await fetch(`${base}/api/monitor?produto=rh`);
    expect(r.status).toBe(200);
    expect((await r.json()).canais).toHaveLength(5);
    expect(chamadas).toEqual(['rh']);
    expect((await fetch(`${base}/api/monitor?produto=outro`)).status).toBe(400);
    expect((await fetch(`${base}/api/monitor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(405);
  });
  it('sem o papel do painel, a API explica o que falta (503)', async () => {
    const r = await fetch(`${baseSem}/api/monitor`);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe('monitor_nao_configurado');
  });
  it('a página segue a marca: Red Hat Display, laranja único #EA8C0C e nenhum texto laranja sobre fundo claro', () => {
    const html = readFileSync(new URL('../studio/public/monitor.html', import.meta.url), 'utf8');
    expect(html).toContain('Red+Hat+Display');
    expect(html).toContain('#EA8C0C');
    expect(html).not.toMatch(/#F76B00|#C96501|Arial|Roboto|Inter\b/);
    expect(html).not.toMatch(/(?<![-\w])color:\s*(var\(--m-laranja\)|#EA8C0C)/i); // laranja só em preenchimento, nunca em texto
    const js = readFileSync(new URL('../studio/public/monitor.js', import.meta.url), 'utf8');
    expect(js).not.toMatch(/fetch\([^)]*\b(insert|update|delete)\b/i);
    expect(js).toContain('/api/monitor');
  });
});
