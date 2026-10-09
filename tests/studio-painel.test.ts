import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createStudioServer } from '../studio/server';
import { PainelInvalido, PainelNotFound, type PainelRepo } from '../studio/lib/painel-repo';

let server: Server;
let serverSem: Server;
let base: string;
let baseSem: string;
let dir: string;

const calls: Array<[string, unknown[]]> = [];
let failWith: Error | null = null;

const repo: PainelRepo = {
  async saude() {
    if (failWith) throw failWith;
    return {
      entidades: [{ entity: 'pipelines', ultimo_sucesso_em: '2026-10-05T12:00:00.000Z', backfill_concluido: false, ultimo_status: 'ok', atrasada: false }],
      jobs: [{ job_id: 'j1', entity: 'pipelines', status: 'ok', lidos: 2 }],
      erros: [],
      uso: [{ dia: '2026-10-05', tokens_gastos: 70, requisicoes: 7, limite_429: 0 }],
    };
  },
  async config() {
    return [
      { pipeline_id: 1, pipeline: 'Funil RH', pipeline_ordem: 1, produto: 'rh', etapas: [{ stage_id: 11, etapa: 'Lead', etapa_ordem: 1, marco: 'sql' }] },
      { pipeline_id: 2, pipeline: 'Funil Clínica', pipeline_ordem: 2, produto: null, etapas: [] },
    ];
  },
  async usuarios() {
    return [{ user_id: 100, nome: 'Ana Teste', ativo: true }];
  },
  async campos() {
    return [{ entity: 'deal', field_key: 'a'.repeat(40), nome_pipedrive: 'Origem', rotulo: null, tipo: 'enum', ordem: 1 }];
  },
  async setPipelineProduto(id, produto) {
    calls.push(['pipeline', [id, produto]]);
    if (id === 999) throw new PainelNotFound('pipeline');
  },
  async setStageMarco(id, marco) {
    calls.push(['stage', [id, marco]]);
    if (id === 999) throw new PainelNotFound('etapa');
  },
  async negociosResumo() {
    return [{ pipeline_id: 1, pipeline: 'Funil RH', produto: 'rh', status: 'open', is_archived: false, qtd: 3, qtd_mql: 3, valor_total: 300 }];
  },
  async negocios(f) {
    calls.push(['negocios', [f]]);
    return { total: 1, pagina: f.pagina ?? 1, por_pagina: 50, itens: [{ deal_id: 5, titulo: 'Negócio fictício', status: 'open', is_mql: true }] };
  },
  async negocio(id) {
    if (id === 999) throw new PainelNotFound('negócio');
    return {
      negocio: { deal_id: id, titulo: 'Negócio fictício' },
      campos: [{ field_key: 'a'.repeat(40), nome_pipedrive: 'Origem', rotulo: null, valor: 'x' }],
      historico: [{ stage_id: 11, etapa: 'Lead', marco: null, entrou_em: '2026-03-01T09:00:00Z', saiu_em: null, horas_na_etapa: '10.0', etapa_atual: true, movido_por: null, origem_dado: 'criacao' }],
    };
  },
  async historicoProgresso() {
    return [{ ano_criacao: 2026, negocios: 10, sem_mudanca_de_etapa: 4, historico_lido: 3, pendentes: 3, com_linha_do_tempo: 7 }];
  },
  async funilMarcos(ano) {
    calls.push(['funil', [ano]]);
    return [{ pipeline_id: 1, pipeline: 'Funil RH', produto: 'rh', leads: 10, mql: 9, chegou_sql: 5, chegou_reuniao: 3, chegou_proposta: 2, ganhos: 1, perdidos: 6 }];
  },
  async motivosPerda() {
    return [
      { reason_id: 398, motivo: 'Lead Invalido', exclui_mql: true },
      { reason_id: 24, motivo: 'Achou o preço caro', exclui_mql: false },
    ];
  },
  async statusContagem() {
    return [
      { status: 'open', conta_como_lead: true },
      { status: 'deleted', conta_como_lead: false },
    ];
  },
  async setMotivoExcluiMql(id, v) {
    calls.push(['motivo', [id, v]]);
    if (id === 999) throw new PainelNotFound('motivo de perda');
  },
  async setStatusContaComoLead(status, v) {
    calls.push(['status', [status, v]]);
  },
  async conversaoEventos(dias) {
    calls.push(['conv-eventos', [dias]]);
    return [{ evento: 'form_fake', eventos: 5, usuarios: 4, urls: 2, ultimo_dia: '2026-10-08' }];
  },
  async conversaoEventoUrls(evento, dias) {
    calls.push(['conv-urls', [evento, dias]]);
    return [{ host: 'exemplo.test', caminho: '/lp-fake', eventos: 5, usuarios: 4, ultimo_dia: '2026-10-08' }];
  },
  async conversaoRegras() {
    return [];
  },
  async criarConversaoRegra(r) {
    calls.push(['conv-criar', [r]]);
    return { id: 7 };
  },
  async atualizarConversaoRegra(id, r) {
    calls.push(['conv-atualizar', [id, r]]);
    if (id === 999) throw new PainelNotFound('regra');
  },
  async criativosConfig() {
    return { dores: [{ id: 1, nome: 'DOR fictícia', ativo: true, criativos: 1, leads: 3, mensagens: [] }], modulos: [] };
  },
  async criativos() {
    return [{ termo_chave: 'ad1 — cópia', termo: 'AD1 — Cópia', leads: 3, dor_id: null, mensagem_id: null, modulo_id: null }];
  },
  async criarCriativoItem(tipo, nome, paiId) {
    calls.push(['cri-criar', [tipo, nome, paiId]]);
    if (nome === 'repetida') throw new PainelInvalido('Já existe um item com esse nome.');
    return { id: 5, restaurado: false };
  },
  async atualizarCriativoItem(tipo, id, patch) {
    calls.push(['cri-atualizar', [tipo, id, patch]]);
    if (id === 999) throw new PainelNotFound('DOR');
  },
  async mapearCriativos(termos, patch) {
    calls.push(['cri-mapa', [termos, patch]]);
    if (patch.mensagem_id === 13) throw new PainelInvalido('Essa Mensagem não pertence à DOR escolhida.');
    return { atualizados: termos.length };
  },
};

const mkServer = (painel: PainelRepo | null) =>
  createStudioServer({
    formsDir: join(dir, 'forms'),
    publicDir: join(dir, 'public'),
    trackingDir: join(dir, 'tracking'),
    sources: [],
    dbInfo: () => ({ connected: true }),
    submit: async () => ({ status: 200, body: {} }),
    painel,
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'studio-painel-'));
  for (const d of ['forms', 'public', 'tracking']) mkdirSync(join(dir, d));
  writeFileSync(join(dir, 'public', 'painel.html'), '<h1>painel de dados</h1>');
  writeFileSync(join(dir, 'public', 'index.html'), '<h1>builder</h1>');
  writeFileSync(join(dir, 'public', 'inicio.html'), '<h1>inicio</h1>');
  writeFileSync(join(dir, 'public', 'form.html'), '<h1>form</h1>');
  server = mkServer(repo);
  serverSem = mkServer(null);
  await Promise.all([server, serverSem].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  baseSem = `http://127.0.0.1:${(serverSem.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await Promise.all([server, serverSem].map((s) => new Promise((r) => s.close(r))));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
  failWith = null;
});

const J = { 'content-type': 'application/json' };
const put = (path: string, body: unknown, headers: Record<string, string> = {}, b = base) =>
  fetch(`${b}${path}`, { method: 'PUT', headers: { ...J, ...headers }, body: JSON.stringify(body) });

describe('páginas e leitura', () => {
  it('serve a página do Painel', async () => {
    expect(await (await fetch(`${base}/painel`)).text()).toContain('painel de dados');
  });
  it('saúde: entidades, jobs, erros e uso da cota', async () => {
    const j = await (await fetch(`${base}/api/painel/saude`)).json();
    expect(j.entidades[0]).toMatchObject({ entity: 'pipelines', ultimo_status: 'ok' });
    expect(j.jobs).toHaveLength(1);
    expect(j.uso[0].tokens_gastos).toBe(70);
  });
  it('configuração: pipelines com etapas, produto e marco', async () => {
    const j = await (await fetch(`${base}/api/painel/config`)).json();
    expect(j).toHaveLength(2);
    expect(j[0]).toMatchObject({ pipeline: 'Funil RH', produto: 'rh' });
    expect(j[0].etapas[0]).toMatchObject({ etapa: 'Lead', marco: 'sql' });
    expect(j[1].produto).toBeNull();
  });
  it('usuários (sem e-mail) e campos', async () => {
    const u = await (await fetch(`${base}/api/painel/usuarios`)).json();
    expect(u[0]).toEqual({ user_id: 100, nome: 'Ana Teste', ativo: true });
    const c = await (await fetch(`${base}/api/painel/campos`)).json();
    expect(c[0].field_key).toHaveLength(40);
  });
});

describe('negócios (somente leitura)', () => {
  const get = (p: string) => fetch(`${base}${p}`);
  it('resumo por pipeline e status', async () => {
    const j = await (await get('/api/painel/negocios/resumo')).json();
    expect(j[0]).toMatchObject({ pipeline: 'Funil RH', status: 'open', qtd: 3, qtd_mql: 3 });
  });
  it('lista com filtros válidos repassa exatamente o que foi pedido', async () => {
    const r = await get('/api/painel/negocios?pipeline=1&status=lost&mql=sim&mes=2025-03&q=ana&pagina=2');
    expect(r.status).toBe(200);
    expect(calls).toEqual([['negocios', [{ pipeline_id: 1, status: 'lost', mql: true, mes: '2025-03', q: 'ana', pagina: 2 }]]]);
    expect((await r.json()).itens[0].deal_id).toBe(5);
  });
  it('sem filtros: lista tudo, página 1', async () => {
    await get('/api/painel/negocios');
    expect(calls).toEqual([['negocios', [{}]]]);
  });
  it.each([
    'pipeline=abc', 'pipeline=1;drop', 'status=archived', 'status=OPEN', 'mes=2025-13', 'mes=25-01', 'pagina=0', 'pagina=-1', 'pagina=abc', `q=${'x'.repeat(101)}`,
  ])('filtro inválido (%s) é recusado e nada é consultado', async (qs) => {
    expect((await get(`/api/painel/negocios?${qs}`)).status).toBe(400);
    expect(calls).toEqual([]);
  });
  it('ficha do negócio com campos personalizados; ID inválido 400; inexistente 404', async () => {
    const j = await (await get('/api/painel/negocios/5')).json();
    expect(j.negocio.deal_id).toBe(5);
    expect(j.campos[0].field_key).toHaveLength(40);
    expect(j.historico[0]).toMatchObject({ etapa: 'Lead', etapa_atual: true, origem_dado: 'criacao' }); // linha do tempo na ficha
    expect((await get('/api/painel/negocios/abc')).status).toBe(400);
    expect((await get('/api/painel/negocios/999')).status).toBe(404);
  });
  it('andamento da carga do histórico e funil por ano de criação', async () => {
    const p = await (await get('/api/painel/historico/progresso')).json();
    expect(p[0]).toMatchObject({ ano_criacao: 2026, pendentes: 3 });
    const f = await (await get('/api/painel/funil?ano=2025')).json();
    expect(f[0]).toMatchObject({ pipeline: 'Funil RH', chegou_proposta: 2, ganhos: 1 });
    expect(calls).toEqual([['funil', [2025]]]);
  });
  it.each(['', 'ano=', 'ano=abc', 'ano=1999', 'ano=20260', 'ano=2026;drop'])('funil com ano inválido (%s) é recusado', async (qs) => {
    expect((await get(`/api/painel/funil?${qs}`)).status).toBe(400);
    expect(calls).toEqual([]);
  });
  it('não há como escrever em negócios pelo Painel', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const p of ['/api/painel/negocios', '/api/painel/negocios/5', '/api/painel/negocios/resumo', '/api/painel/funil?ano=2026', '/api/painel/historico/progresso']) {
        const r = await fetch(`${base}${p}`, { method, headers: J, body: '{}' });
        expect([404, 405], `${method} ${p}`).toContain(r.status);
      }
    }
    expect(calls).toEqual([]);
  });
});

describe('conversões do site (GA4): eventos, URLs e regras', () => {
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: J, body: JSON.stringify(body) });
  const regra = { nome: ' Lead da LP ', tipo: 'lead', evento: ' form_fake ', url_modo: 'igual', url_valor: ' /lp-fake ' };
  it('lista eventos e as URLs onde o evento aparece (nome com espaço vai por parâmetro)', async () => {
    const e = await (await fetch(`${base}/api/painel/conversoes/eventos?dias=90`)).json();
    expect(e[0]).toMatchObject({ evento: 'form_fake', urls: 2 });
    const u = await (await fetch(`${base}/api/painel/conversoes/eventos/urls?evento=${encodeURIComponent('RD Formulario Embutido')}&dias=7`)).json();
    expect(u[0]).toMatchObject({ caminho: '/lp-fake' });
    expect(calls).toEqual([['conv-eventos', [90]], ['conv-urls', ['RD Formulario Embutido', 7]]]);
  });
  it('período e evento inválidos são recusados', async () => {
    for (const d of ['0', '1000', 'abc', '-1']) expect((await fetch(`${base}/api/painel/conversoes/eventos?dias=${d}`)).status, d).toBe(400);
    expect((await fetch(`${base}/api/painel/conversoes/eventos/urls`)).status).toBe(400);
    expect(calls).toEqual([]);
  });
  it('cria regra (campos aparados) e responde 201 com o id', async () => {
    const r = await post('/api/painel/conversoes/regras', regra);
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ id: 7 });
    expect(calls).toEqual([['conv-criar', [{ nome: 'Lead da LP', tipo: 'lead', evento: 'form_fake', url_modo: 'igual', url_valor: '/lp-fake' }]]]);
  });
  it('"qualquer URL" não guarda caminho', async () => {
    await post('/api/painel/conversoes/regras', { ...regra, url_modo: 'qualquer', url_valor: '/ignorado' });
    expect((calls[0]![1][0] as any).url_valor).toBeNull();
  });
  it('regra inválida é recusada e nada é gravado', async () => {
    const ruins = [
      { ...regra, nome: '' }, { ...regra, nome: 'x'.repeat(81) }, { ...regra, tipo: 'ganho' }, { ...regra, evento: '' },
      { ...regra, url_modo: 'regex' }, { ...regra, url_modo: 'contem', url_valor: '  ' }, { ...regra, url_valor: 'x'.repeat(301) }, { ...regra, ativo: 'sim' }, {},
    ];
    for (const b of ruins) expect((await post('/api/painel/conversoes/regras', b)).status, JSON.stringify(b).slice(0, 60)).toBe(400);
    expect(calls).toEqual([]);
  });
  it('edita e liga/desliga; regra inexistente dá 404; id estranho dá 400', async () => {
    expect((await put('/api/painel/conversoes/regras/7', regra)).status).toBe(200);
    expect((await put('/api/painel/conversoes/regras/7', { ativo: false })).status).toBe(200);
    expect(calls[1]).toEqual(['conv-atualizar', [7, { ativo: false }]]);
    expect((await put('/api/painel/conversoes/regras/7', { ativo: 'nao' })).status).toBe(400);
    expect((await put('/api/painel/conversoes/regras/999', { ativo: true })).status).toBe(404);
    expect((await put('/api/painel/conversoes/regras/abc', { ativo: true })).status).toBe(400);
  });
  it('não há como apagar regra pela API (desativa)', async () => {
    expect((await fetch(`${base}/api/painel/conversoes/regras/7`, { method: 'DELETE' })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('criativos do Meta Ads: DOR > Mensagem e Módulo de Interesse', () => {
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: J, body: JSON.stringify(body) });
  it('lista a configuração e os criativos', async () => {
    const c = await (await fetch(`${base}/api/painel/criativos/config`)).json();
    expect(c.dores[0]).toMatchObject({ nome: 'DOR fictícia', leads: 3 });
    const l = await (await fetch(`${base}/api/painel/criativos`)).json();
    expect(l[0]).toMatchObject({ termo: 'AD1 — Cópia', dor_id: null });
  });
  it('cria DOR, Mensagem (dentro de uma DOR) e Módulo', async () => {
    expect((await post('/api/painel/criativos/dores', { nome: 'Gestão manual' })).status).toBe(201);
    expect((await post('/api/painel/criativos/mensagens', { nome: 'Planilha não escala', dor_id: 1 })).status).toBe(201);
    expect((await post('/api/painel/criativos/modulos', { nome: 'Ponto' })).status).toBe(201);
    expect(calls).toEqual([['cri-criar', ['dor', 'Gestão manual', undefined]], ['cri-criar', ['mensagem', 'Planilha não escala', 1]], ['cri-criar', ['modulo', 'Ponto', undefined]]]);
  });
  it('nome vazio, longo demais, Mensagem sem DOR e nome repetido são recusados', async () => {
    for (const b of [{ nome: '' }, { nome: '   ' }, { nome: 'x'.repeat(121) }, {}, { nome: 5 }]) expect((await post('/api/painel/criativos/dores', b)).status, JSON.stringify(b)).toBe(400);
    expect((await post('/api/painel/criativos/mensagens', { nome: 'x' })).status).toBe(400);
    expect((await post('/api/painel/criativos/mensagens', { nome: 'x', dor_id: 'a' })).status).toBe(400);
    expect((await post('/api/painel/criativos/dores', { nome: 'repetida' })).status).toBe(400);
  });
  it('renomeia, remove e restaura (remover é desativar; não existe DELETE)', async () => {
    expect((await put('/api/painel/criativos/dores/1', { nome: 'Novo nome' })).status).toBe(200);
    expect((await put('/api/painel/criativos/mensagens/2', { ativo: false })).status).toBe(200);
    expect((await put('/api/painel/criativos/modulos/3', { ativo: true })).status).toBe(200);
    expect(calls).toEqual([['cri-atualizar', ['dor', 1, { nome: 'Novo nome' }]], ['cri-atualizar', ['mensagem', 2, { ativo: false }]], ['cri-atualizar', ['modulo', 3, { ativo: true }]]]);
    for (const b of [{}, { ativo: 'nao' }, { nome: '' }]) expect((await put('/api/painel/criativos/dores/1', b)).status, JSON.stringify(b)).toBe(400);
    expect((await put('/api/painel/criativos/dores/abc', { ativo: false })).status).toBe(400);
    expect((await put('/api/painel/criativos/dores/999', { ativo: false })).status).toBe(404);
    expect((await fetch(`${base}/api/painel/criativos/dores/1`, { method: 'DELETE', headers: J, body: '{}' })).status).toBe(405);
  });
  it('mapeia criativos (um ou vários) e aceita deixar em branco (null)', async () => {
    expect((await put('/api/painel/criativos/mapa', { termos: ['ad1 — cópia', 'ad2'], dor_id: 1, mensagem_id: 2 })).status).toBe(200);
    expect((await put('/api/painel/criativos/mapa', { termos: ['ad1 — cópia'], dor_id: null, mensagem_id: null, modulo_id: null })).status).toBe(200);
    expect(calls).toEqual([['cri-mapa', [['ad1 — cópia', 'ad2'], { dor_id: 1, mensagem_id: 2 }]], ['cri-mapa', [['ad1 — cópia'], { dor_id: null, mensagem_id: null, modulo_id: null }]]]);
  });
  it('mapa inválido: sem criativos, sem campos, ids estranhos, Mensagem de outra DOR', async () => {
    for (const b of [{ dor_id: 1 }, { termos: [] }, { termos: ['a'] }, { termos: [1], dor_id: 1 }, { termos: ['a'], dor_id: 'x' }, { termos: ['a'], dor_id: 0 }, { termos: ['a'], modulo_id: 1.5 }, { termos: Array(1001).fill('a'), dor_id: 1 }, { termos: ['a'.repeat(501)], dor_id: 1 }]) {
      expect((await put('/api/painel/criativos/mapa', b)).status, JSON.stringify(b).slice(0, 60)).toBe(400);
    }
    expect((await put('/api/painel/criativos/mapa', { termos: ['a'], dor_id: 1, mensagem_id: 13 })).status).toBe(400);
    expect((await fetch(`${base}/api/painel/criativos/mapa`, { method: 'POST', headers: J, body: '{}' })).status).toBe(405);
  });
});

describe('gravar a configuração (a única escrita do Painel)', () => {
  it.each(['rh', 'clinic', null])('pipeline -> produto %s', async (produto) => {
    const r = await put('/api/painel/config/pipeline/1', { produto });
    expect(r.status).toBe(200);
    expect(calls).toEqual([['pipeline', [1, produto]]]);
  });
  it.each(['sql', 'reuniao', 'proposta', null])('etapa -> "chegou até aqui" %s', async (marco) => {
    const r = await put('/api/painel/config/stage/11', { marco });
    expect(r.status).toBe(200);
    expect(calls).toEqual([['stage', [11, marco]]]);
  });
  it('valores fora da lista são recusados e nada é gravado', async () => {
    for (const body of [{ produto: 'outro' }, { produto: '' }, { produto: 1 }, {}, { produto: ['rh'] }]) {
      expect((await put('/api/painel/config/pipeline/1', body)).status, JSON.stringify(body)).toBe(400);
    }
    // ganho/perdido/MQL/lead NÃO são marcos de etapa: o status vem do negócio e MQL é regra de motivo de perda
    for (const body of [{ marco: 'qualificado' }, { marco: 'GANHO' }, { marco: 'ganho' }, { marco: 'perdido' }, { marco: 'mql' }, { marco: 'lead' }, {}]) {
      expect((await put('/api/painel/config/stage/11', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toEqual([]);
  });
  it('lista os motivos de perda (ID e nome juntos) e a contagem por status', async () => {
    const m = await (await fetch(`${base}/api/painel/motivos-perda`)).json();
    expect(m[0]).toEqual({ reason_id: 398, motivo: 'Lead Invalido', exclui_mql: true });
    const s = await (await fetch(`${base}/api/painel/status-contagem`)).json();
    expect(s).toContainEqual({ status: 'deleted', conta_como_lead: false });
  });
  it.each([true, false])('motivo de perda -> exclui do MQL = %s', async (v) => {
    const r = await put('/api/painel/config/motivo-perda/398', { exclui_mql: v });
    expect(r.status).toBe(200);
    expect(calls).toEqual([['motivo', [398, v]]]);
  });
  it.each(['open', 'won', 'lost', 'deleted'])('status %s -> conta como lead', async (st) => {
    const r = await put(`/api/painel/config/status/${st}`, { conta_como_lead: true });
    expect(r.status).toBe(200);
    expect(calls).toEqual([['status', [st, true]]]);
  });
  it('motivo e status: valores inválidos são recusados, motivo inexistente dá 404', async () => {
    for (const body of [{ exclui_mql: 'sim' }, { exclui_mql: 1 }, { exclui_mql: null }, {}]) {
      expect((await put('/api/painel/config/motivo-perda/398', body)).status, JSON.stringify(body)).toBe(400);
    }
    for (const id of ['abc', '1.5', '-1', '1;drop']) {
      expect((await put(`/api/painel/config/motivo-perda/${encodeURIComponent(id)}`, { exclui_mql: true })).status, id).toBe(400);
    }
    for (const st of ['archived', 'OPEN', '']) {
      expect((await put(`/api/painel/config/status/${st}`, { conta_como_lead: true })).status, st).toBe(st === '' ? 404 : 400);
    }
    for (const body of [{ conta_como_lead: 'true' }, { conta_como_lead: 0 }, {}]) {
      expect((await put('/api/painel/config/status/open', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toEqual([]);
    expect((await put('/api/painel/config/motivo-perda/999', { exclui_mql: true })).status).toBe(404);
  });
  it('as novas rotas também recusam outra origem e métodos que não sejam PUT', async () => {
    expect((await put('/api/painel/config/status/open', { conta_como_lead: true }, { origin: 'https://site-malicioso.com' })).status).toBe(403);
    for (const method of ['POST', 'DELETE', 'PATCH']) {
      for (const p of ['/api/painel/config/status/open', '/api/painel/config/motivo-perda/398']) {
        expect([404, 405], `${method} ${p}`).toContain((await fetch(`${base}${p}`, { method, headers: J, body: '{}' })).status);
      }
    }
    expect(calls).toEqual([]);
  });
  it('ID inválido é recusado', async () => {
    for (const id of ['abc', '1.5', '-1', '1;drop', '99999999999999999999']) {
      expect((await put(`/api/painel/config/pipeline/${encodeURIComponent(id)}`, { produto: 'rh' })).status, id).toBe(400);
    }
    expect(calls).toEqual([]);
  });
  it('pipeline ou etapa que não existe: 404', async () => {
    expect((await put('/api/painel/config/pipeline/999', { produto: 'rh' })).status).toBe(404);
    expect((await put('/api/painel/config/stage/999', { marco: 'sql' })).status).toBe(404);
  });
  it('o Painel NÃO oferece nenhuma outra escrita: POST/DELETE nas rotas dele não existem', async () => {
    for (const p of ['/api/painel/saude', '/api/painel/config', '/api/painel/usuarios', '/api/painel/config/pipeline/1']) {
      for (const method of ['POST', 'DELETE', 'PATCH']) {
        const r = await fetch(`${base}${p}`, { method, headers: J, body: '{}' });
        expect([404, 405], `${method} ${p}`).toContain(r.status);
      }
    }
    expect(calls).toEqual([]);
  });
});

describe('proteções e falhas', () => {
  it('escrita vinda de outra origem é barrada (anti CSRF)', async () => {
    const r = await put('/api/painel/config/pipeline/1', { produto: 'rh' }, { origin: 'https://site-malicioso.com' });
    expect(r.status).toBe(403);
    expect(calls).toEqual([]);
  });
  it('sem o banco do Painel configurado: 503 com explicação, sem quebrar o Studio', async () => {
    const r = await fetch(`${baseSem}/api/painel/saude`);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe('painel_nao_configurado');
    expect(await (await fetch(`${baseSem}/painel`)).text()).toContain('painel de dados'); // a página abre e avisa
    expect(await (await fetch(`${baseSem}/`)).text()).toContain('inicio'); // o Início abre e avisa
    expect(await (await fetch(`${baseSem}/studio`)).text()).toContain('builder'); // o Studio de testes continua funcionando
  });
  it('erro do banco: 500 genérico, sem vazar a mensagem', async () => {
    failWith = new Error('senha=segredo postgresql://u:p@h/db');
    const r = await fetch(`${base}/api/painel/saude`);
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain('segredo');
  });
});
