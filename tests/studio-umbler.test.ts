import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createStudioServer } from '../studio/server';
import { UmblerCliente, UmblerErro, ocultarToken } from '../studio/lib/umbler/cliente';
import { diaBR, normalizaCusto, normalizaSessao, normalizaCanais, pick } from '../studio/lib/umbler/normaliza';
import { acrescentarPreco, configVazia, definirFixado, lerConfig, pertenceAoMarketing, precoVigente, salvarConfig, ConfigInvalida, type ConfigUmbler } from '../studio/lib/umbler/config';
import { CacheUmbler } from '../studio/lib/umbler/cache';
import { gerarCsv, montarPainel, validarFiltros, FiltroInvalido, somar, type Filtros } from '../studio/lib/umbler/painel';
import { ServicoUmbler } from '../studio/lib/umbler/servico';
import { ArquivoConfigStore, PgConfigStore } from '../studio/lib/umbler/config-store';
import { sanitizar } from '../studio/lib/umbler/sanitiza';

const TOKEN = 'tok_FICTICIO_abcdef0123456789';
const resp = (corpo: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json', ...headers } });

/* ---------- cliente ---------- */
describe('Umbler: cliente somente leitura', () => {
  it('o código-fonte do cliente não tem nenhum caminho de escrita', () => {
    const fonte = readFileSync('studio/lib/umbler/cliente.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(fonte).not.toMatch(/['"`](POST|PUT|PATCH|DELETE)['"`]/i);
    expect(fonte).not.toMatch(/\.(post|put|patch|delete|request|send)\s*\(/i);
    const metodos = [...fonte.matchAll(/method:\s*['"`](\w+)['"`]/g)].map((m) => m[1]);
    expect(metodos).toEqual(['GET']);
    // nenhum método público de escrita
    const publicos = Object.getOwnPropertyNames(UmblerCliente.prototype).filter((n) => n !== 'constructor');
    expect(publicos).not.toContain('post');
    expect(publicos).not.toContain('put');
    expect(publicos).not.toContain('delete');
    expect(publicos).not.toContain('request');
  });

  it('manda o token só no cabeçalho, usa GET e nunca coloca o token na URL', async () => {
    const vistos: { url: string; init: RequestInit }[] = [];
    const c = new UmblerCliente({ token: TOKEN, fetchFn: (async (url: string, init: RequestInit) => { vistos.push({ url: String(url), init }); return resp({ ok: 1 }); }) as unknown as typeof fetch });
    await c.get('/v1/channels/', { organizationId: 'org1', ids: ['a', 'b'] });
    expect(vistos[0]!.init.method).toBe('GET');
    expect((vistos[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(vistos[0]!.url).not.toContain(TOKEN);
    expect(vistos[0]!.url).toContain('ids=a&ids=b');
  });

  it('recusa outro domínio e rotas fora de /v1/', async () => {
    expect(() => new UmblerCliente({ token: TOKEN, base: 'https://evil.example.com/api' })).toThrow(UmblerErro);
    const c = new UmblerCliente({ token: TOKEN, fetchFn: (async () => resp({})) as unknown as typeof fetch });
    await expect(c.get('//evil.example.com/x')).rejects.toThrow(/Rota inválida/);
    await expect(c.get('/v1/../admin')).rejects.toThrow(/Rota inválida/);
    expect(() => new UmblerCliente({ token: '' })).toThrow();
  });

  it('atende no máximo uma requisição por vez, na ordem', async () => {
    let ativas = 0, maximo = 0;
    const ordem: string[] = [];
    const c = new UmblerCliente({ token: TOKEN, fetchFn: (async (url: string) => { ativas++; maximo = Math.max(maximo, ativas); ordem.push(String(url).split('/v1/')[1]!); await new Promise((r) => setTimeout(r, 5)); ativas--; return resp({}); }) as unknown as typeof fetch });
    await Promise.all(['/v1/a/', '/v1/b/', '/v1/c/', '/v1/d/'].map((r) => c.get(r)));
    expect(maximo).toBe(1);
    expect(ordem).toEqual(['a/', 'b/', 'c/', 'd/']);
  });

  it('respeita a janela de limite (espera quando enche)', async () => {
    let t = 0;
    const esperas: number[] = [];
    const c = new UmblerCliente({ token: TOKEN, limite: 3, janelaMs: 5000, agora: () => t, dorme: async (ms) => { esperas.push(ms); t += ms; }, fetchFn: (async () => resp({})) as unknown as typeof fetch });
    for (let i = 0; i < 4; i++) await c.get('/v1/x/');
    expect(esperas.length).toBeGreaterThan(0);
    expect(esperas[0]).toBeGreaterThanOrEqual(4000);
  });

  it('recua e tenta de novo no 429, e desiste com mensagem clara', async () => {
    const esperas: number[] = [];
    let n = 0;
    const c = new UmblerCliente({ token: TOKEN, dorme: async (ms) => { esperas.push(ms); }, fetchFn: (async () => (++n <= 2 ? resp({}, 429, { 'retry-after': '2' }) : resp({ ok: true }))) as unknown as typeof fetch });
    expect(await c.get('/v1/x/')).toEqual({ ok: true });
    expect(esperas).toEqual([2000, 2000]);
    const sempre = new UmblerCliente({ token: TOKEN, tentativas429: 2, dorme: async () => undefined, fetchFn: (async () => resp({}, 429)) as unknown as typeof fetch });
    await expect(sempre.get('/v1/x/')).rejects.toThrow(/429/);
  });

  it('o token nunca aparece nas mensagens de erro', async () => {
    const c401 = new UmblerCliente({ token: TOKEN, fetchFn: (async () => resp({ detail: TOKEN }, 401)) as unknown as typeof fetch });
    const e1 = (await c401.get('/v1/x/').catch((e: unknown) => e)) as Error;
    expect(String(e1.message)).not.toContain(TOKEN);
    const cRede = new UmblerCliente({ token: TOKEN, fetchFn: (async () => { throw new Error(`socket fechado com Bearer ${TOKEN}`); }) as unknown as typeof fetch });
    const e2 = (await cRede.get('/v1/x/').catch((e: unknown) => e)) as Error;
    expect(String(e2.message)).not.toContain(TOKEN);
    expect(ocultarToken(`x ${TOKEN} y Bearer abcdefgh12345`, TOKEN)).toBe('x *** y Bearer ***');
  });
});

/* ---------- normalização tolerante ---------- */
describe('Umbler: normalização tolerante', () => {
  const base = { id: 's1', createdAtUTC: '2026-10-15T02:30:00Z', title: 'Black', type: 'Template', channel: { id: 'c1' }, messagesSent: 200, totalRead: 120, totalFailed: 4, totalAnswered: 30, answersFlowId: 'f1', template: { id: 't1', label: 'Oferta' } };

  it('lê os campos conhecidos e converte o dia para o horário do Brasil', () => {
    const s = normalizaSessao(base)!;
    expect(s).toMatchObject({ id: 's1', tipo: 'Template', canalId: 'c1', modeloId: 't1', modeloNome: 'Oferta', dia: '2026-10-14' });
    expect(s.enviadas).toEqual({ v: 200, m: null });
    expect(s.respondidas.v).toBe(30);
    expect(diaBR('2026-10-15T02:30:00Z')).toBe('2026-10-14');
  });

  it('aceita variações de nome (maiúsculas, totalSent, contagem por estado)', () => {
    const s = normalizaSessao({ Id: 's2', CreatedAtUTC: '2026-10-10T12:00:00Z', totalSent: 50, messageStates: [{ state: 'Read', count: 20 }, { state: 'Failed', count: 3 }, { state: 'Error', count: 1 }] })!;
    expect(s.enviadas.v).toBe(50);
    expect(s.lidas.v).toBe(20);
    expect(s.falhas.v).toBe(4);
    expect(pick({ ABC: 1 }, 'abc')).toBe(1);
  });

  it('ausência vira null COM motivo; zero verdadeiro continua zero', () => {
    const s = normalizaSessao({ id: 's3', createdAtUTC: '2026-10-10T12:00:00Z', type: 'Bot' })!;
    for (const k of ['enviadas', 'lidas', 'respondidas', 'falhas'] as const) {
      expect(s[k].v).toBeNull();
      expect(s[k].m).toMatch(/\S/);
    }
    const zero = normalizaSessao({ id: 's4', createdAtUTC: '2026-10-10T12:00:00Z', messagesSent: 0, totalFailed: 0 })!;
    expect(zero.enviadas.v).toBe(0);
    expect(zero.falhas.v).toBe(0);
    expect(normalizaSessao({ createdAtUTC: 'x' })).toBeNull(); // sem id não vira sessão
  });

  it('custo: total, soma das linhas e ausência', () => {
    expect(normalizaCusto({ totalCredits: 0, lines: [{ credits: 0 }] })).toEqual({ v: 0, m: null });
    expect(normalizaCusto({ totalCredits: 0, lines: [] }).v).toBeNull(); // sem linha de cobrança = sem registro, não custo zero
    expect(normalizaCusto({ lines: [{ credits: 2 }, { credits: 3 }] }).v).toBe(5);
    const f = normalizaCusto({});
    expect(f.v).toBeNull();
    expect(f.m).toMatch(/ausente/);
    expect(normalizaCusto(null).v).toBeNull();
  });

  it('canais: lista pura ou paginada, sem quebrar por campo faltando', () => {
    expect(normalizaCanais([{ id: 'c1', name: 'Vendas' }, { id: 'c2' }, { semId: 1 }]).map((c) => c.nome)).toEqual(['Vendas', '(sem nome) c2']);
    expect(normalizaCanais({ items: [{ id: 'c9', name: 'X' }] })).toHaveLength(1);
    expect(normalizaCanais(null)).toEqual([]);
  });
});

/* ---------- configuração, pertencimento e preço ---------- */
describe('Umbler: pertencimento ao Marketing e preço por vigência', () => {
  const agora = new Date('2026-10-30T12:00:00Z');
  const comCanal = (c: ConfigUmbler = configVazia()) => definirFixado(c, 'canais', 'c1', 'Marketing', true, agora);

  it('sem canal fixado nada é do Marketing', () => {
    expect(pertenceAoMarketing(configVazia(), { canalId: 'c1', tipo: 'Template', botId: null, botNome: null })).toBe(false);
  });
  it('canal fixado: template entra; canal de fora não', () => {
    const c = comCanal();
    expect(pertenceAoMarketing(c, { canalId: 'c1', tipo: 'Template', botId: null, botNome: null })).toBe(true);
    expect(pertenceAoMarketing(c, { canalId: 'c2', tipo: 'Template', botId: null, botNome: null })).toBe(false);
    expect(pertenceAoMarketing(c, { canalId: null, tipo: 'Template', botId: null, botNome: null })).toBe(false);
  });
  it('sem bots fixados valem todos os bots do canal fixado', () => {
    expect(pertenceAoMarketing(comCanal(), { canalId: 'c1', tipo: 'Bot', botId: 'b9', botNome: 'Qualquer' })).toBe(true);
  });
  it('com bots fixados, o bot da sessão precisa estar fixado (por ID ou nome); template não é afetado', () => {
    const c = definirFixado(comCanal(), 'bots', 'b1', 'Boas-vindas', true, agora);
    expect(pertenceAoMarketing(c, { canalId: 'c1', tipo: 'Bot', botId: 'b1', botNome: null })).toBe(true);
    expect(pertenceAoMarketing(c, { canalId: 'c1', tipo: 'Bot', botId: null, botNome: 'Boas-vindas' })).toBe(true);
    expect(pertenceAoMarketing(c, { canalId: 'c1', tipo: 'Bot', botId: 'b2', botNome: 'Outro' })).toBe(false);
    expect(pertenceAoMarketing(c, { canalId: 'c1', tipo: 'Template', botId: null, botNome: null })).toBe(true);
    // bot fixado mas em canal não fixado continua de fora
    expect(pertenceAoMarketing(c, { canalId: 'c2', tipo: 'Bot', botId: 'b1', botNome: null })).toBe(false);
  });
  it('desafixar volta atrás e registra a data da alteração', () => {
    const a = comCanal();
    const b = definirFixado(a, 'canais', 'c1', 'Marketing', false, new Date('2026-11-01T00:00:00Z'));
    expect(b.canais[0]).toMatchObject({ fixado: false, alteradoEm: '2026-11-01T00:00:00.000Z' });
    expect(a.canais[0]!.fixado).toBe(true); // não muta o original
  });

  it('preço: usa o vigente na data da sessão, e sem preço devolve null', () => {
    let c = configVazia();
    expect(precoVigente(c, '2026-10-10')).toBeNull();
    c = acrescentarPreco(c, '2026-01-01', 0.4, agora);
    c = acrescentarPreco(c, '2026-10-01', 0.5, agora);
    expect(precoVigente(c, '2025-12-31')).toBeNull();
    expect(precoVigente(c, '2026-01-01')).toBe(0.4);
    expect(precoVigente(c, '2026-09-30')).toBe(0.4);
    expect(precoVigente(c, '2026-10-01')).toBe(0.5);
    expect(precoVigente(c, null)).toBeNull();
  });
  it('preço só se acrescenta: data repetida, anterior, valor ruim ou data torta são recusados', () => {
    const c = acrescentarPreco(configVazia(), '2026-10-01', 0.5, agora);
    expect(() => acrescentarPreco(c, '2026-10-01', 0.6, agora)).toThrow(ConfigInvalida);
    expect(() => acrescentarPreco(c, '2026-09-01', 0.6, agora)).toThrow(/posterior/);
    expect(() => acrescentarPreco(c, '2026-11-01', 0, agora)).toThrow(ConfigInvalida);
    expect(() => acrescentarPreco(c, '2026-11-01', Number.NaN, agora)).toThrow(ConfigInvalida);
    expect(() => acrescentarPreco(c, '2026-02-31', 1, agora)).toThrow(ConfigInvalida);
    expect(c.precoCredito).toHaveLength(1);
  });

  it('salva e relê o JSON; arquivo torto dá erro claro e não é sobrescrito', () => {
    const dir = mkdtempSync(join(tmpdir(), 'umb-cfg-'));
    try {
      const f = join(dir, 'sub', 'c.json');
      const c = acrescentarPreco(comCanal(), '2026-10-01', 0.5, agora);
      salvarConfig(f, c);
      expect(lerConfig(f)).toEqual(c);
      expect(readFileSync(f, 'utf8')).not.toMatch(/token|bearer/i);
      expect(lerConfig(join(dir, 'nao-existe.json'))).toEqual(configVazia());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/* ---------- cache ---------- */
describe('Umbler: cache', () => {
  it('vale por 15 minutos, guarda o JSON original e recusa conteúdo com o token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'umb-cache-'));
    try {
      let t = 1_000_000;
      const c = new CacheUmbler(dir, () => t, undefined, TOKEN);
      c.gravar('k', { a: [1, 2], campoNovo: 'x' });
      expect(c.ler('k')?.dado).toEqual({ a: [1, 2], campoNovo: 'x' });
      t += 14 * 60_000;
      expect(c.ler('k')).not.toBeNull();
      t += 2 * 60_000;
      expect(c.ler('k')).toBeNull();
      expect(c.ler('k', true)).not.toBeNull();
      c.gravar('k3', [{ id: 'c1', phoneNumber: '+5511999990000', contactEmail: 'a@b.com', nome: 'ok' }]);
      expect(readFileSync(join(dir, readdirSync(dir).find((f) => readFileSync(join(dir, f), 'utf8').includes('"k3"'))!), 'utf8')).not.toMatch(/5511|a@b\.com/);
      expect(c.ler<{ nome: string }[]>('k3')?.dado[0]!.nome).toBe('ok');
      expect(() => c.gravar('k2', { vazou: `Bearer ${TOKEN}` })).toThrow(/token/);
      expect(readdirSync(dir).join()).not.toContain('k2');
      c.limpar();
      expect(existsSync(dir)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/* ---------- agregações ---------- */
const sess = (o: Record<string, unknown>) => ({ id: 's', createdAtUTC: '2026-10-10T15:00:00Z', title: 'T', type: 'Template', channel: { id: 'c1' }, messagesSent: 200, totalRead: 100, totalFailed: 0, totalAnswered: 20, answersFlowId: 'f', template: { id: 't1', label: 'Modelo A' }, ...o });
const F: Filtros = { de: '2026-10-01', ate: '2026-10-31', escopo: 'marketing' };
const cfgBase = (): ConfigUmbler => acrescentarPreco(definirFixado(configVazia(), 'canais', 'c1', 'Canal', true), '2026-01-01', 0.5);
const comCusto = (o: Record<string, unknown>, creditos: number | null) => {
  const s = normalizaSessao(sess(o))!;
  return { ...s, creditos: creditos == null ? { v: null, m: 'rota de custo falhou' } : { v: creditos, m: null } };
};

describe('Umbler: painel, completude e amostra', () => {
  it('soma, completude, R$ pelo preço vigente e custo por resposta', () => {
    const a = comCusto({ id: 'a', messagesSent: 200, totalRead: 100, totalAnswered: 20 }, 100);
    const b = comCusto({ id: 'b', messagesSent: 300, totalRead: 150, totalAnswered: 30 }, 150);
    const p = montarPainel(cfgBase(), [a, b], new Map([['c1', 'Canal Marketing']]), F);
    expect(p.cartoes.enviadas.v).toBe(500);
    expect(p.cartoes.respondidas.v).toBe(50);
    expect(p.cartoes.custoCreditos.v).toBe(250);
    expect(p.cartoes.custoReais.v).toBe(125); // 250 créditos x R$ 0,50
    expect(p.cartoes.cprReais.v).toBe(2.5); // 125 / 50
    expect(p.completude.custo).toEqual({ x: 2, y: 2 });
    expect(p.sessoes[0]!.canalNome).toBe('Canal Marketing');
  });

  it('completude parcial: custo em 1 de 2 sessões, e a razão usa só as sessões com os dois valores', () => {
    const a = comCusto({ id: 'a', messagesSent: 200, totalAnswered: 20 }, 100);
    const b = comCusto({ id: 'b', messagesSent: 300, totalAnswered: 30 }, null);
    const p = montarPainel(cfgBase(), [a, b], new Map(), F);
    expect(p.completude.custo).toEqual({ x: 1, y: 2 });
    expect(p.completude.respondidas).toEqual({ x: 2, y: 2 });
    expect(p.cartoes.custoCreditos).toMatchObject({ v: 100, x: 1, y: 2 });
    expect(p.cartoes.cprReais.v).toBe(2.5); // 50 / 20: a sessão sem custo não entra
    expect(p.sessoes.find((s) => s.id === 'b')!.reais.m).toMatch(/rota de custo falhou/);
  });

  it('sem preço vigente: créditos aparecem e R$ fica indisponível com motivo', () => {
    const cfg = definirFixado(configVazia(), 'canais', 'c1', 'Canal', true);
    const p = montarPainel(cfg, [comCusto({ id: 'a' }, 10)], new Map(), F);
    expect(p.cartoes.custoCreditos.v).toBe(10);
    expect(p.cartoes.custoReais.v).toBeNull();
    expect(p.cartoes.custoReais.m).toMatch(/preço do crédito/i);
    expect(p.avisos.join(' ')).toMatch(/preço do crédito/i);
  });

  it('nada fixado: sem sessões e com aviso; "tudo" ignora o fixado', () => {
    const s = [comCusto({ id: 'a' }, 1)];
    const vazio = montarPainel(configVazia(), s, new Map(), F);
    expect(vazio.sessoes).toHaveLength(0);
    expect(vazio.avisos.join(' ')).toMatch(/Nenhum canal está fixado/);
    expect(montarPainel(configVazia(), s, new Map(), { ...F, escopo: 'tudo' }).sessoes).toHaveLength(1);
  });

  it('filtros: período (dia do Brasil), canal, tipo, template e sessão', () => {
    const cfg = definirFixado(cfgBase(), 'canais', 'c2', 'Outro', true);
    const todas = [
      comCusto({ id: 'a' }, 1),
      comCusto({ id: 'b', channel: { id: 'c2' } }, 1),
      comCusto({ id: 'c', type: 'Bot', bot: { id: 'b1', botName: 'Fluxo', triggerName: 'g' }, template: undefined }, 1),
      comCusto({ id: 'd', createdAtUTC: '2026-09-30T20:00:00Z' }, 1), // fora do mês
      comCusto({ id: 'e', createdAtUTC: '2026-11-01T01:00:00Z' }, 1), // 31/10 no Brasil: dentro
    ];
    const ids = (f: Partial<Filtros>) => montarPainel(cfg, todas, new Map(), { ...F, ...f }).sessoes.map((s) => s.id).sort();
    expect(ids({})).toEqual(['a', 'b', 'c', 'e']);
    expect(ids({ canais: ['c2'] })).toEqual(['b']);
    expect(ids({ tipo: 'Bot' })).toEqual(['c']);
    expect(ids({ modelo: 't1' })).toEqual(['a', 'b', 'e']);
    expect(ids({ modelo: 'b1' })).toEqual(['c']);
    expect(ids({ sessao: 'a' })).toEqual(['a']);
  });

  it('funil com queda entre passos', () => {
    const p = montarPainel(cfgBase(), [comCusto({ id: 'a', messagesSent: 200, totalRead: 100, totalAnswered: 20 }, 1)], new Map(), F);
    expect(p.funil.map((e) => e.v)).toEqual([200, 100, 20]);
    expect(p.funil[0]!.queda).toBeNull();
    expect(p.funil[1]!.queda).toBeCloseTo(0.5);
    expect(p.funil[2]!.queda).toBeCloseTo(0.8);
  });

  it('série por dia agrega envios, respostas e custo', () => {
    const p = montarPainel(cfgBase(), [comCusto({ id: 'a', createdAtUTC: '2026-10-10T15:00:00Z' }, 10), comCusto({ id: 'b', createdAtUTC: '2026-10-10T18:00:00Z' }, 5), comCusto({ id: 'c', createdAtUTC: '2026-10-11T15:00:00Z' }, 1)], new Map(), F);
    expect(p.serie.map((d) => [d.dia, d.envios, d.creditos])).toEqual([['2026-10-10', 400, 15], ['2026-10-11', 200, 1]]);
  });

  it('amostra pequena não é ranqueada; as demais são ordenadas pela taxa de resposta', () => {
    const cfg = cfgBase(); // amostra mínima 100
    const ss = [
      comCusto({ id: 'a', messagesSent: 400, totalAnswered: 40, template: { id: 'tA', label: 'A' } }, 1), // 10%
      comCusto({ id: 'b', messagesSent: 400, totalAnswered: 80, template: { id: 'tB', label: 'B' } }, 1), // 20%
      comCusto({ id: 'c', messagesSent: 30, totalAnswered: 30, template: { id: 'tC', label: 'C' } }, 1), // 100%, mas só 30 envios
    ];
    const p = montarPainel(cfg, ss, new Map(), F);
    const por = Object.fromEntries(p.modelos.map((g) => [g.nome, g]));
    expect(por.B!.posicao).toBe(1);
    expect(por.A!.posicao).toBe(2);
    expect(por.C!.posicao).toBeNull();
    expect(por.C!.amostraPequena).toBe(true);
    expect(por.A!.amostraPequena).toBe(false);
    // a amostra mínima é configurável
    const p2 = montarPainel({ ...cfg, amostraMinima: 20 }, ss, new Map(), F);
    expect(p2.modelos.find((g) => g.nome === 'C')!.amostraPequena).toBe(false);
  });

  it('fluxos: paradas por motivo, com quantas sessões trouxeram o dado', () => {
    const bot = (id: string, paradas: unknown) => comCusto({ id, type: 'Bot', bot: { id: 'b1', botName: 'Fluxo', triggerName: 'g' }, template: undefined, botStopReasons: paradas }, 1);
    const p = montarPainel(cfgBase(), [bot('a', [{ state: 'ReachedFlowEnd', count: 5 }, { state: 'MemberTookOver', count: 2 }]), bot('b', undefined)], new Map(), F);
    expect(p.paradas).toMatchObject({ sessoesComDado: 1, sessoesDeBot: 2, itens: [{ motivo: 'ReachedFlowEnd', n: 5 }, { motivo: 'MemberTookOver', n: 2 }] });
    expect(montarPainel(cfgBase(), [comCusto({ id: 'a' }, 1)], new Map(), F).paradas).toBeNull();
  });

  it('somar nunca transforma ausência em zero', () => {
    expect(somar([{ v: null, m: 'x' }, { v: null, m: 'y' }])).toMatchObject({ v: null, x: 0, y: 2 });
    expect(somar([{ v: 0, m: null }])).toMatchObject({ v: 0, x: 1, y: 1 });
    expect(somar([])).toMatchObject({ v: null });
  });

  it('valida filtros', () => {
    expect(() => validarFiltros({ de: '2026-10-31', ate: '2026-10-01' })).toThrow(FiltroInvalido);
    expect(() => validarFiltros({ de: '2026-10-01', ate: '2026-10-31', tipo: 'X' })).toThrow(FiltroInvalido);
    expect(() => validarFiltros({ de: '2026-10-01', ate: '2026-10-31', canal: "a'b" })).toThrow(FiltroInvalido);
    expect(() => validarFiltros({ de: '2024-01-01', ate: '2026-10-31' })).toThrow(/400 dias/);
    expect(validarFiltros({ de: '2026-10-01', ate: '2026-10-31' }).escopo).toBe('marketing');
    expect(validarFiltros({ de: '2026-10-01', ate: '2026-10-31', escopo: 'tudo' }).escopo).toBe('tudo');
  });
});

describe('Umbler: CSV', () => {
  it('ponto e vírgula, BOM, ausência como célula vazia explicada, sem fórmula solta', () => {
    const a = comCusto({ id: 'a', title: '=SOMA(A1)', messagesSent: 200, totalAnswered: 20 }, 100);
    const b = comCusto({ id: 'b', title: 'Com; ponto e vírgula', messagesSent: 10, totalAnswered: undefined, answersFlowId: undefined }, null);
    const csv = gerarCsv(montarPainel(cfgBase(), [a, b], new Map(), F));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const linhas = csv.slice(1).trim().split('\r\n');
    expect(linhas[0]).toMatch(/^# Quark Dados/);
    expect(linhas[1]).toMatch(/Célula vazia = dado indisponível/);
    expect(linhas[2]).toBe('data;titulo;tipo;canal;template_ou_fluxo;enviadas;lidas;respondidas;falhas;creditos;reais;custo_por_resposta_reais;campos_disponiveis;motivos_de_ausencia');
    const linhaB = linhas.find((l) => l.includes('ponto e vírgula'))!;
    expect(linhaB).toContain('"Com; ponto e vírgula"');
    expect(linhaB).toMatch(/respondidas: /); // motivo explicado
    expect(linhaB.split(';').length).toBeGreaterThan(10);
    const linhaA = linhas.find((l) => l.includes('SOMA'))!;
    expect(linhaA).toContain("'=SOMA(A1)");
    expect(linhaA).toContain(';200;'); // enviadas
    expect(linhaA).toContain(';50;'); // R$ = 100 x 0,50
  });
});

/* ---------- serviço (com a Umbler de mentira) ---------- */
function umblerFalsa(opts: { custoFalha?: boolean } = {}) {
  const chamadas: string[] = [];
  const base = (n: number) => ({ id: `s${n}`, createdAtUTC: `2026-10-${String(10 + n).padStart(2, '0')}T15:00:00Z`, title: `Sessão ${n}`, type: 'Template', channel: { id: 'c1' }, messagesSent: 100 * n, totalSent: 100 * n, totalRead: 50 * n, totalFailed: 1, totalAnswered: 10 * n, answersFlowId: 'f', template: { id: 't1', label: 'Modelo' } });
  const leitor = {
    async get(rota: string, q: Record<string, unknown> = {}) {
      chamadas.push(rota);
      if (rota === '/v1/members/me/') return { displayName: 'NOME PESSOAL', email: 'pessoa@exemplo.com', organizations: [{ id: 'org1', name: 'Quark' }] };
      if (rota === '/v1/channels/') return [{ id: 'c1', name: 'Canal Marketing', state: 'Live', phoneNumber: '+5511999990000' }, { id: 'c2', name: 'Canal CS', state: 'Live' }];
      if (rota === '/v1/bots/') return { page: {}, items: [{ id: 'b1', title: 'Fluxo A', active: true }] };
      if (rota === '/v1/sectors/') return [{ id: 'z1', name: 'Vendas' }];
      if (rota === '/v1/tags/') return { items: [{ id: 'g1', name: 'Lead' }] };
      if (rota === '/v1/bulk-send-session/') return { page: { totalItems: 3 }, items: Number(q.Skip) === 0 ? [base(3), base(2), base(1)] : [] };
      if (rota.endsWith('/costs/')) { if (opts.custoFalha) throw new UmblerErro(`falhou com Bearer ${TOKEN}`, 500, rota); return { totalCredits: Number(/s(\d)/.exec(rota)![1]) * 10, lines: [] }; }
      const det = /\/v1\/bulk-send-session\/s(\d)\/$/.exec(rota);
      if (det) return base(Number(det[1]));
      throw new Error(`rota inesperada ${rota}`);
    },
  };
  return { leitor, chamadas };
}

describe('Umbler: serviço', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'umb-svc-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const novo = (sub: string, falsa = umblerFalsa(), agora = () => 1_000_000) => {
    const svc = new ServicoUmbler({ leitor: falsa.leitor, cache: new CacheUmbler(join(dir, sub, 'cache'), agora, undefined, TOKEN), store: new ArquivoConfigStore(join(dir, sub, 'cfg.json')), token: TOKEN, agora });
    return { svc, ...falsa, agora };
  };

  it('painel completo: lê só rotas de leitura, usa o cache e "atualizar agora" ignora o cache', async () => {
    const { svc, chamadas } = novo('a');
    await svc.fixar('canais', 'c1', 'Canal Marketing', true);
    await svc.preco('2026-01-01', 0.5);
    const p1 = await svc.painel(F);
    expect(p1.sessoes).toHaveLength(3);
    expect(p1.cartoes.enviadas.v).toBe(600);
    expect(p1.cartoes.custoCreditos.v).toBe(60); // 10 + 20 + 30
    expect(p1.cartoes.custoReais.v).toBe(30);
    expect(p1.completude.custo).toEqual({ x: 3, y: 3 });
    expect(p1.chamadas).toBeGreaterThan(0);
    expect(chamadas.every((r) => r.startsWith('/v1/'))).toBe(true);
    const total1 = chamadas.length;
    const p2 = await svc.painel(F); // dentro dos 15 minutos
    expect(chamadas.length).toBe(total1);
    expect(p2.chamadas).toBe(0);
    await svc.painel(F, true);
    expect(chamadas.length).toBeGreaterThan(total1);
  });

  it('cache vencido (15 min) consulta de novo', async () => {
    let t = 1_000_000;
    const { svc, chamadas } = novo('b', umblerFalsa(), () => t);
    await svc.fixar('canais', 'c1', 'Canal', true);
    await svc.painel(F);
    const n = chamadas.length;
    t += 16 * 60_000;
    await svc.painel(F);
    expect(chamadas.length).toBeGreaterThan(n);
  });

  it('rota de custo falhando vira null com motivo e aviso; a tela não quebra e o token não vaza', async () => {
    const { svc } = novo('c', umblerFalsa({ custoFalha: true }));
    await svc.fixar('canais', 'c1', 'Canal', true);
    const p = await svc.painel(F);
    expect(p.completude.custo).toEqual({ x: 0, y: 3 });
    expect(p.cartoes.custoCreditos.v).toBeNull();
    expect(p.sessoes[0]!.creditos.m).toMatch(/rota de custo falhou/);
    expect(p.avisos.join(' ')).toMatch(/custo falhou em 3/);
    expect(JSON.stringify(p)).not.toContain(TOKEN);
  });

  it('o token e dados pessoais da conta nunca vão para o cache em disco nem para a saída', async () => {
    const { svc } = novo('d');
    await svc.fixar('canais', 'c1', 'Canal Marketing', true);
    const cat = await svc.catalogo();
    await svc.painel(F);
    const todos = [JSON.stringify(cat), ...readdirSync(join(dir, 'd', 'cache')).map((f) => readFileSync(join(dir, 'd', 'cache', f), 'utf8')), readFileSync(join(dir, 'd', 'cfg.json'), 'utf8')].join('\n');
    expect(todos).not.toContain(TOKEN);
    expect(todos).not.toContain('pessoa@exemplo.com'); // /members/me traz o e-mail do usuário: não é guardado
    expect(todos).not.toContain('NOME PESSOAL');
    expect(todos).not.toContain('5511999990000'); // telefone do canal: não é normalizado nem gravado
  });

  it('catálogo: itens fixados primeiro, e o que sumiu da API continua listado', async () => {
    const { svc } = novo('e');
    await svc.fixar('canais', 'c1', 'Canal Marketing', true);
    await svc.fixar('canais', 'velho', 'Canal antigo', true);
    const cat = await svc.catalogo();
    expect(cat.canais.itens.map((i) => [i.id, i.fixado, i.presente])).toEqual([['velho', true, false], ['c1', true, true], ['c2', false, true]]); // fixados primeiro (por nome), depois os demais
    expect(cat.bots.itens[0]!.nome).toBe('Fluxo A');
    expect(cat.setores.itens).toHaveLength(1);
    expect(cat.etiquetas.itens).toHaveLength(1);
  });

  it('sem token: configura preço/amostra, mas os dados avisam o que falta', async () => {
    const svc = new ServicoUmbler({ leitor: null, cache: new CacheUmbler(join(dir, 'f', 'cache')), store: new ArquivoConfigStore(join(dir, 'f', 'cfg.json')) });
    expect(svc.configurado().ok).toBe(false);
    expect((await svc.amostra(250)).amostraMinima).toBe(250);
    await expect(svc.painel(F)).rejects.toThrow(/UMBLER_TOKEN/);
  });
});

/* ---------- rotas do Studio ---------- */
describe('Umbler: rotas do Studio', () => {
  let server: Server, base: string, dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'umb-srv-'));
    const umbler = new ServicoUmbler({ leitor: null, cache: new CacheUmbler(join(dir, 'cache')), store: new ArquivoConfigStore(join(dir, 'cfg.json')) });
    server = createStudioServer({ formsDir: join(dir, 'forms'), publicDir: join(process.cwd(), 'studio', 'public'), trackingDir: join(process.cwd(), 'tracking'), sources: [], dbInfo: () => ({ connected: false }), submit: async () => ({ status: 200, body: {} }), umbler });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  const put = (rota: string, corpo: unknown, headers: Record<string, string> = {}, method = 'PUT') => fetch(base + rota, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(corpo) });

  it('a página abre e o estado diz que falta o token', async () => {
    expect((await fetch(`${base}/umbler`)).status).toBe(200);
    const st = await (await fetch(`${base}/api/umbler/estado`)).json();
    expect(st).toMatchObject({ ok: false });
    expect(st.motivo).toMatch(/UMBLER_TOKEN/);
    const r = await fetch(`${base}/api/umbler/painel?de=2026-10-01&ate=2026-10-31`);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toBe('umbler_sem_token');
  });

  it('fixar grava no JSON; preço e amostra validam; origem estranha e tipo errado são barrados', async () => {
    const r = await put('/api/umbler/config/fixar', { tipo: 'canais', id: 'c1', nome: 'Canal', fixado: true });
    expect(r.status).toBe(200);
    expect(lerConfig(join(dir, 'cfg.json')).canais[0]).toMatchObject({ id: 'c1', fixado: true });
    expect((await put('/api/umbler/config/fixar', { tipo: 'x', id: 'c1', fixado: true })).status).toBe(400);
    expect((await put('/api/umbler/config/preco', { desde: '2026-10-01', preco: 0.5 }, {}, 'POST')).status).toBe(200);
    expect((await put('/api/umbler/config/preco', { desde: '2026-09-01', preco: 0.6 }, {}, 'POST')).status).toBe(400);
    expect((await put('/api/umbler/config/amostra', { valor: 0 })).status).toBe(400);
    expect((await put('/api/umbler/config/fixar', { tipo: 'canais', id: 'c1', fixado: false }, { origin: 'http://evil.example.com' })).status).toBe(403);
    expect((await fetch(`${base}/api/umbler/config/fixar`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
  });

  it('a API do Studio não expõe nenhuma rota que escreva na Umbler', async () => {
    const fonte = readFileSync('studio/server.ts', 'utf8');
    const bloco = fonte.slice(fonte.indexOf("path.startsWith('/api/umbler/')"), fonte.indexOf('// BI: só leitura'));
    expect(bloco).not.toMatch(/\.(post|put|delete)\(/i);
    expect(bloco).not.toMatch(/fetch\(/);
  });

  it('filtro inválido dá 400 claro', async () => {
    const r = await fetch(`${base}/api/umbler/csv?de=ontem&ate=2026-10-31`);
    // sem token o erro de filtro vem antes de qualquer consulta à Umbler
    expect(r.status).toBe(400);
  });
});

describe('Umbler: modo publicado', () => {
  it('a área Umbler não existe no modo publicado (só na máquina local)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'umb-pub-'));
    const umbler = new ServicoUmbler({ leitor: null, cache: new CacheUmbler(join(dir, 'c')), store: new ArquivoConfigStore(join(dir, 'c.json')) });
    const server = createStudioServer({ formsDir: dir, publicDir: join(process.cwd(), 'studio', 'public'), trackingDir: dir, sources: [], dbInfo: () => ({ connected: false }), submit: async () => ({ status: 200, body: {} }), umbler, acesso: { servico: { entrar: async () => null, listar: async () => [], criar: async () => { throw new Error('x'); }, atualizar: async () => { throw new Error('x'); }, remover: async () => undefined, papelDe: async () => null } as never, segredo: 'segredo-de-teste-com-tamanho-suficiente-123456', seguro: false } });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const b = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // sem sessão, qualquer rota pede login; o ponto é que nada de Umbler responde dados
      const r = await fetch(`${b}/api/umbler/estado`, { redirect: 'manual' });
      expect([401, 404]).toContain(r.status);
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

/* ---------- sanitização das amostras ---------- */
describe('Umbler: sanitização de amostras', () => {
  it('remove nome, telefone, e-mail, token e links; troca IDs por rótulos; corta listas', () => {
    const s = sanitizar({ id: 'abc123', contactName: 'Maria da Silva', contactPhoneNumber: '+55 11 99999-0000', email: 'm@x.com', note: 'oi', pic: 'https://x.com/a.png', state: 'Read', title: 'Black Friday', createdAtUTC: '2026-10-10T10:00:00Z', channel: { id: 'abc123' }, items: [1, 2, 3, 4, 5], solto: 'fale comigo no 11 99999-0000', creditos: 12 }) as Record<string, unknown>;
    const txt = JSON.stringify(s);
    expect(txt).not.toMatch(/Maria|99999|m@x\.com|https?:|Black Friday|oi"/);
    expect(s.id).toBe('ID-1');
    expect((s.channel as { id: string }).id).toBe('ID-1'); // mesmo ID, mesmo rótulo
    expect(s.state).toBe('Read');
    expect(s.createdAtUTC).toBe('2026-10-10T10:00:00Z');
    expect(s.creditos).toBe(12);
    expect(s.items).toEqual([1, 2, 3]);
  });
});

describe('Umbler: formato real conferido na API', () => {
  it('sessão de Bot: enviadas vem de totalSent (messagesSent vem 0) e leitura zerada sem estados é "não rastreado"', () => {
    const s = normalizaSessao({ id: 'b', createdAtUTC: '2026-10-30T11:00:00Z', type: 'Bot', messagesSent: 0, totalScheduled: 46, totalSent: 46, totalRead: 0, totalFailed: 0, totalAnswered: null, answersFlowId: null, messageStates: [], scheduleStates: [{ state: 'Sent', count: 46 }], botStopReasons: [{ state: 'ReachedFlowEnd', count: 10 }], bot: { id: 'x', botName: 'F', triggerName: 'g' }, channel: { id: 'c' } })!;
    expect(s.enviadas.v).toBe(46);
    expect(s.lidas.v).toBeNull();
    expect(s.lidas.m).toMatch(/não rastreia/);
    expect(s.falhas.v).toBe(0);
    expect(s.respondidas.v).toBeNull();
    expect(s.paradas).toEqual([{ motivo: 'ReachedFlowEnd', n: 10 }]);
  });
});

describe('Umbler: configuração no banco e execução na Vercel', () => {
  it('PgConfigStore grava a linha única e relê passando pela validação', async () => {
    const consultas: { sql: string; params?: unknown[] }[] = [];
    let guardado: string | null = null;
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        consultas.push({ sql, params });
        if (/insert into ops\.cfg_umbler/.test(sql)) { guardado = String(params![0]); return { rows: [] }; }
        return { rows: guardado ? [{ config: JSON.parse(guardado) }] : [] };
      },
    };
    const store = new PgConfigStore(pool as never);
    expect(await store.ler()).toEqual(configVazia());
    const c = acrescentarPreco(definirFixado(configVazia(), 'canais', 'c1', 'Canal', true), '2026-10-01', 0.0001);
    await store.salvar(c);
    expect(await store.ler()).toEqual(c);
    const dado = consultas.map((q) => q.sql).join(' ');
    expect(dado).toMatch(/on conflict \(chave\) do update/);
    expect(dado).not.toMatch(/\bpublic\./);
    // lixo no banco não quebra: vira configuração segura
    guardado = JSON.stringify({ canais: 'x', precoCredito: [{ desde: 'ontem', preco: -1 }], amostraMinima: 'muito' });
    expect(await store.ler()).toEqual(configVazia());
  });

  it('o serviço usa o store informado (banco) e informa a origem', async () => {
    let guardado: string | null = null;
    const store = { origem: 'banco' as const, ler: async () => (guardado ? JSON.parse(guardado) : configVazia()), salvar: async (c: unknown) => { guardado = JSON.stringify(c); } };
    const svc = new ServicoUmbler({ leitor: null, cache: new CacheUmbler(join(tmpdir(), 'umb-x1')), store });
    await svc.fixar('canais', 'c1', 'Canal', true);
    expect(JSON.parse(guardado!).canais[0]).toMatchObject({ id: 'c1', fixado: true });
    expect(svc.origemConfig).toBe('banco');
  });

  it('orçamento de tempo: devolve o que deu, marca pendentes e termina nas chamadas seguintes pelo cache', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'umb-orc-'));
    try {
      let t = 0;
      const falsa = umblerFalsa();
      const lento = { async get(rota: string, q?: Record<string, unknown>) { t += 20_000; return falsa.leitor.get(rota, q); } }; // cada consulta "demora" 20 s
      const store = new ArquivoConfigStore(join(dir2, 'cfg.json'));
      const svc = new ServicoUmbler({ leitor: lento, cache: new CacheUmbler(join(dir2, 'c'), () => 1_000_000), store, agora: () => t, orcamentoMs: 50_000 });
      await svc.fixar('canais', 'c1', 'Canal', true);
      const rodadas: number[] = [];
      let p = await svc.painel(F);
      rodadas.push(p.pendentes);
      expect(p.pendentes).toBeGreaterThan(0);
      expect(p.avisos.join(' ')).toMatch(/parcial/);
      expect(p.sessoes.some((s) => s.creditos.m?.includes('Ainda não consultado'))).toBe(true);
      for (let i = 0; i < 10 && p.pendentes > 0; i++) { p = await svc.painel(F); rodadas.push(p.pendentes); }
      expect(p.pendentes).toBe(0);
      expect(p.completude.custo).toEqual({ x: 3, y: 3 });
      await expect(svc.csv(F)).resolves.toMatch(/^﻿/);
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  });

  it('CSV recusa exportar enquanto o painel está parcial', async () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'umb-csv-'));
    try {
      let t = 0;
      const falsa = umblerFalsa();
      const lento = { async get(rota: string, q?: Record<string, unknown>) { t += 30_000; return falsa.leitor.get(rota, q); } };
      const svc = new ServicoUmbler({ leitor: lento, cache: new CacheUmbler(join(dir3, 'c'), () => 1), store: new ArquivoConfigStore(join(dir3, 'cfg.json')), agora: () => t, orcamentoMs: 40_000 });
      await svc.fixar('canais', 'c1', 'Canal', true);
      await expect(svc.csv(F)).rejects.toThrow(/ainda está carregando/);
    } finally { rmSync(dir3, { recursive: true, force: true }); }
  });

  it('a função da Vercel usa o banco para a configuração, /tmp para o cache e o limite de 60 s', () => {
    const fn = readFileSync('api/studio.ts', 'utf8');
    expect(fn).toMatch(/new PgConfigStore\(pool\)/);
    expect(fn).toMatch(/tmpdir\(\)/);
    expect(fn).not.toMatch(/ArquivoConfigStore/);
    expect(JSON.parse(readFileSync('vercel.json', 'utf8')).functions['api/studio.ts'].maxDuration).toBe(60);
    const sql = readFileSync('supabase/migrations/0034_umbler_config.sql', 'utf8').replace(/--.*$/gm, '');
    expect(sql).toMatch(/create table ops\.cfg_umbler/);
    expect(sql).not.toMatch(/\b(drop|delete|truncate|rename)\b/i);
    expect([...sql.matchAll(/alter table [^;]+;/gi)].every((m) => /enable row level security/i.test(m[0]))).toBe(true);
    expect(sql).not.toMatch(/\bpublic\./);
    expect(sql).toMatch(/grant select, insert, update on ops\.cfg_umbler to orq_panel/);
  });
});

describe('Umbler: estimativa, mês a mês e passos do fluxo', () => {
  const semRegistro = (o: Record<string, unknown>) => { const s = normalizaSessao(sess(o))!; return { ...s, creditos: normalizaCusto({ totalCredits: 0, lines: [] }) }; };

  it('estimativa só para sessão sem registro de custo, separada do custo real, e sem base não inventa', () => {
    const cfg = cfgBase();
    const real = comCusto({ id: 'a', messagesSent: 100 }, 1000);
    const sem = semRegistro({ id: 'b', messagesSent: 200, totalSent: 200 });
    const falhou = comCusto({ id: 'c' }, null); // rota falhou: não é "sem registro", não se estima
    const p = montarPainel(cfg, [real, sem, falhou], new Map(), F, { Template: { creditosPorEnvio: 10, amostra: 5 } });
    expect(p.cartoes.custoCreditos.v).toBe(1000); // a estimativa NÃO entra no custo real
    expect(p.estimativa.sessoes).toEqual({ x: 1, y: 1 });
    expect(p.estimativa.creditos.v).toBe(2000); // 200 envios x 10
    expect(p.estimativa.reais.v).toBe(1000); // x R$ 0,50
    const semBase = montarPainel(cfg, [sem], new Map(), F, {});
    expect(semBase.estimativa.creditos.v).toBeNull();
    expect(semBase.estimativa.creditos.m).toMatch(/Sem base/);
  });

  it('mensal: agrupa por mês, usa dia do Brasil e inclui estimativa', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'umb-mes-'));
    try {
      const agora = Date.parse('2026-10-30T15:00:00Z');
      const sessoesApi = [
        { id: 'o1', createdAtUTC: '2026-10-05T15:00:00Z', title: 'o', type: 'Template', channel: { id: 'c1' }, messagesSent: 100, totalSent: 100, totalRead: 50, totalFailed: 0, template: { id: 't', label: 'M' } },
        { id: 's1', createdAtUTC: '2026-09-20T15:00:00Z', title: 's', type: 'Template', channel: { id: 'c1' }, messagesSent: 300, totalSent: 300, totalRead: 90, totalFailed: 0, template: { id: 't', label: 'M' } },
      ];
      const leitor = { async get(rota: string) {
        if (rota === '/v1/members/me/') return { organizations: [{ id: 'org1', name: 'Q', active: true }] };
        if (rota === '/v1/channels/') return [{ id: 'c1', name: 'Canal' }];
        if (rota === '/v1/bulk-send-session/') return { items: sessoesApi };
        const id = /session\/(\w+)\//.exec(rota)![1];
        if (rota.endsWith('/costs/')) return id === 'o1' ? { totalCredits: 500, lines: [{ credits: 500 }] } : { totalCredits: 0, lines: [] };
        return sessoesApi.find((x) => x.id === id);
      } };
      const svc = new ServicoUmbler({ leitor, cache: new CacheUmbler(join(dir, 'c'), () => agora), store: new ArquivoConfigStore(join(dir, 'cfg.json')), agora: () => agora });
      await svc.fixar('canais', 'c1', 'Canal', true);
      const r = await svc.mensal('marketing', 3);
      expect(r.meses.map((m) => m.mes)).toEqual(['2026-08', '2026-09', '2026-10']);
      const [ago, set, out] = r.meses;
      expect(ago!.sessoes).toBe(0);
      expect(set!.enviadas.v).toBe(300);
      expect(set!.creditos.v).toBeNull(); // setembro sem registro de custo
      expect(set!.estimativa.creditos.v).toBe(1500); // 300 envios x 5 créditos/envio observados em outubro
      expect(out!.creditos.v).toBe(500);
      expect(out!.estimativa.creditos.v).toBeNull(); // nada a estimar em outubro
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('passos: nomes do fluxo, quantos chegaram em cada passo e onde terminaram', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'umb-pas-'));
    try {
      const nav = (...ids: string[]) => ids.map((stepId) => ({ stepId }));
      const leitor = { async get(rota: string) {
        if (rota === '/v1/members/me/') return { organizations: [{ id: 'org1', name: 'Q', active: true }] };
        if (rota === '/v1/bots/b1/') return { bot: { steps: [{ id: 'p1', _t: 'FlowchartBotManualStartedEventModel', triggerName: 'Início' }, { id: 'p2', _t: 'SendMessageActionModel', message: 'Olá, tudo bem?' }, { id: 'p3', _t: 'MemberTransferActionModel' }] } };
        return { page: { totalItems: 3 }, items: [{ status: 'Complete', navigationPath: nav('p1', 'p2', 'p3') }, { status: 'Running', navigationPath: nav('p1', 'p2') }, { status: 'Running', navigationPath: nav('p1') }] };
      } };
      const svc = new ServicoUmbler({ leitor, cache: new CacheUmbler(join(dir, 'c')), store: new ArquivoConfigStore(join(dir, 'cfg.json')) });
      const g = await svc.passos('b1', '2026-09-01', '2026-09-30');
      expect(g.rotulosOk).toBe(true);
      expect(g.porPasso.map((x) => [x.rotulo, x.alcancaram, x.pararam])).toEqual([['Início do fluxo: Início', 3, 1], ['Mensagem: Olá, tudo bem?', 2, 1], ['Transferir para atendente', 1, 1]]);
      expect(g.porStatus).toEqual([{ status: 'Running', n: 2 }, { status: 'Complete', n: 1 }]);
      expect(readdirSync(join(dir, 'c')).map((f) => readFileSync(join(dir, 'c', f), 'utf8')).join('')).not.toContain('navigationPath'); // o bruto das instâncias não vai para o cache
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('Umbler: referência de custo por template (tudo como marketing)', () => {
  const linhaTpl = (templateId: string, count: number, credits: number) => ({ tipo: 'Template', templateId, templateNome: templateId.toUpperCase(), count, credits });
  const tpl = (id: string, nome: string, categoria: string) => ({ id, nome, categoria, status: 'APPROVED' });
  const sessaoTpl = (id: string, modeloId: string, envios: number, linhas: ReturnType<typeof linhaTpl>[] | null) => ({ ...normalizaSessao(sess({ id, messagesSent: envios, totalSent: envios, template: { id: modeloId, label: modeloId } }))!, custoLinhas: linhas });

  it('usa o observado nos templates de marketing e a tarifa de referência nos demais, fluxos e sem base', async () => {
    const { tabelaReferencia } = await import('../studio/lib/umbler/painel');
    const sessoes = [
      sessaoTpl('s1', 'a', 100, [linhaTpl('a', 100, 390_000), linhaTpl('u', 10, 20_000)]), // a (marketing) 3.900/msg; u (utilidade) 2.000/msg
      sessaoTpl('s2', 'u', 50, null), // utilidade sem cobrança nesta sessão
      sessaoTpl('s3', 'n', 40, null), // template sem cobrança e fora do catálogo
      { ...normalizaSessao(sess({ id: 'f1', type: 'Bot', messagesSent: 0, totalSent: 60, template: undefined, bot: { id: 'b', botName: 'F', triggerName: 'g' } }))!, custoLinhas: null },
    ];
    const t = tabelaReferencia(cfgBase(), sessoes, [tpl('a', 'Oferta A', 'MARKETING'), tpl('u', 'Aviso', 'UTILITY')], [], '2026-10-01', '2026-10-31');
    expect(t.referenciaMarketing).toMatchObject({ creditosPorMsg: 3900, origem: 'categoria marketing', templates: 1 });
    const por = Object.fromEntries(t.linhas.map((l) => [l.id, l]));
    expect(por.a).toMatchObject({ creditosPorMsgObs: 3900, taxaUsada: 3900, origem: 'observado (marketing)', creditosEst: 390_000 });
    expect(por.u).toMatchObject({ creditosPorMsgObs: 2000, taxaUsada: 3900, origem: 'referência de marketing', creditosEst: 50 * 3900 }); // utilidade é cobrada como marketing no cenário
    expect(por.n).toMatchObject({ taxaUsada: 3900, creditosEst: 40 * 3900 });
    // 100x3900 + 50x3900 + 40x3900 + 60 do fluxo x 3900
    expect(t.totais).toMatchObject({ envios: 250, enviosTemplate: 190, enviosFluxo: 60, creditos: 250 * 3900, enviosSemBase: 0 });
    expect(t.totais.reais).toBe(250 * 3900 * 0.5); // preço vigente do cfgBase = R$ 0,50
    const sim = tabelaReferencia(cfgBase(), sessoes, [tpl('a', 'Oferta A', 'MARKETING'), tpl('u', 'Aviso', 'UTILITY')], [], '2026-10-01', '2026-10-31', 0.0001);
    expect(sim.totais.reais).toBeCloseTo(250 * 3900 * 0.0001);
  });

  it('sem nenhuma cobrança observada não inventa tarifa: créditos e R$ ficam indisponíveis', async () => {
    const { tabelaReferencia } = await import('../studio/lib/umbler/painel');
    const t = tabelaReferencia(cfgBase(), [sessaoTpl('s1', 'a', 100, null)], [tpl('a', 'A', 'MARKETING')], [], '2026-10-01', '2026-10-31');
    expect(t.referenciaMarketing.creditosPorMsg).toBeNull();
    expect(t.totais.creditos).toBeNull();
    expect(t.totais.reais).toBeNull();
    expect(t.totais.enviosSemBase).toBe(100);
  });

  it('cobranças da amostra extra entram na tarifa, sem contar a mesma sessão duas vezes', async () => {
    const { tabelaReferencia } = await import('../studio/lib/umbler/painel');
    const sessoes = [sessaoTpl('s1', 'a', 10, [linhaTpl('a', 10, 10_000)])];
    const t = tabelaReferencia(cfgBase(), sessoes, [tpl('a', 'A', 'MARKETING')], [{ id: 's1', linhas: [linhaTpl('a', 10, 10_000)] }, { id: 'x9', linhas: [linhaTpl('a', 10, 30_000)] }], '2026-10-01', '2026-10-31');
    expect(t.referenciaMarketing).toMatchObject({ mensagens: 20, creditosPorMsg: 2000 }); // (10.000 + 30.000) / 20
  });
});
