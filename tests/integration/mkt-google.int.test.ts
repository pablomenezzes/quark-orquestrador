import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { PgPainelRepo } from '../../studio/lib/painel-repo';
import { connect, hasDbConfig } from './helpers';

/**
 * Bloco Google (migration 0013), provado dentro de uma transação desfeita (rollback), com dados 100% fictícios
 * (propriedade 9999, dia 2099-01-01, host exemplo.test). Pulado até a migration 0013 ser aplicada.
 *  - mkt.caminho_url normaliza URL dos dois lados
 *  - as regras (evento + URL) casam com os eventos do GA4 e com a "URL de Conversão" dos negócios
 *  - papéis: orq_sync grava os dados; orq_panel só grava regras e só lê visões; orq_chat só lê visões agregadas
 */
let client: pg.Client | null = null;
let ready = false;
let regrasAntes = '';
if (hasDbConfig) {
  client = await connect();
  ready = (await client.query(`select to_regclass('mkt.conversao_regras') is not null as t, to_regclass('analytics.site_conversoes_dia') is not null as v`)).rows[0].t;
  if (ready) regrasAntes = JSON.stringify((await client.query(`select * from mkt.conversao_regras order by id`)).rows);
  else await client.end();
}

describe.skipIf(!ready)('bloco Google (transação com rollback)', () => {
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
    await c().query(
      `insert into mkt.ga4_eventos_dia (property_id, dia, host, pagina, evento, eventos, usuarios) values
        (9999, '2099-01-01', 'exemplo.test', '/lp-fake/', 'form_fake', 5, 4),
        (9999, '2099-01-01', 'exemplo.test', '/lp-fake/obrigado', 'form_fake', 2, 2),
        (9999, '2099-01-01', 'exemplo.test', '/outra', 'form_fake', 1, 1),
        (9999, '2099-01-01', 'exemplo.test', '/lp-fake/', 'evento_fake_b', 9, 9)`,
    );
  });
  afterAll(async () => {
    await c().query('reset role').catch(() => undefined);
    await c().query('rollback');
    expect(JSON.stringify((await c().query(`select * from mkt.conversao_regras order by id`)).rows)).toBe(regrasAntes); // regras reais intactas
    await c().end();
  });

  it('mkt.caminho_url: minúsculas, sem domínio, sem query, sem fragmento, sem barra final; raiz vira "/"', async () => {
    const casos: Array<[string | null, string]> = [
      ['https://www.Exemplo.test/LP-Fake/?utm_source=x#topo', '/lp-fake'],
      ['exemplo.test/lp-fake', '/lp-fake'],
      ['/lp-fake/', '/lp-fake'],
      ['https://exemplo.test', '/'],
      ['/', '/'],
      ['', '/'],
      [null, '/'],
      ['/blog/post-1?x=1', '/blog/post-1'],
    ];
    for (const [entrada, saida] of casos) {
      expect((await c().query(`select mkt.caminho_url($1) as r`, [entrada])).rows[0].r, String(entrada)).toBe(saida);
    }
  });

  it('o Painel cria regras, e a visão só conta o que casa (evento e URL), respeitando "ativo" e "ignorar"', async () => {
    await c().query('set local role orq_panel');
    const repo = new PgPainelRepo(c() as never);
    const igual = await repo.criarConversaoRegra({ nome: 'ficticia igual', tipo: 'lead', evento: 'form_fake', url_modo: 'igual', url_valor: 'https://exemplo.test/lp-fake' });
    const comeca = await repo.criarConversaoRegra({ nome: 'ficticia comeca', tipo: 'intermediaria', evento: 'form_fake', url_modo: 'comeca', url_valor: '/lp-fake' });
    const qualquer = await repo.criarConversaoRegra({ nome: 'ficticia qualquer', tipo: 'lead', evento: 'evento_fake_b', url_modo: 'qualquer', url_valor: null });
    const ign = await repo.criarConversaoRegra({ nome: 'ficticia ignorar', tipo: 'ignorar', evento: 'form_fake', url_modo: 'qualquer', url_valor: null });
    const soma = async (id: number) =>
      Number((await c().query(`select coalesce(sum(eventos),0) as n from analytics.site_conversoes_dia where regra_id = $1 and dia = '2099-01-01'`, [id])).rows[0].n);
    expect(await soma(igual.id)).toBe(5); // só /lp-fake (a barra final do GA4 é ignorada)
    expect(await soma(comeca.id)).toBe(7); // /lp-fake e /lp-fake/obrigado
    expect(await soma(qualquer.id)).toBe(9);
    expect(await soma(ign.id)).toBe(0); // "ignorar" nunca vira conversão
    await repo.atualizarConversaoRegra(igual.id, { ativo: false });
    expect(await soma(igual.id)).toBe(0);
    await repo.atualizarConversaoRegra(igual.id, { ativo: true, url_modo: 'contem', url_valor: 'obrigado', evento: 'form_fake', nome: 'ficticia contem', tipo: 'lead' });
    expect(await soma(igual.id)).toBe(2);
    const lista = (await repo.conversaoRegras()) as Array<{ id: number; eventos_30d: number; negocios_30d: number | null }>;
    expect(lista.find((r) => Number(r.id) === qualquer.id)!.negocios_30d).toBeNull(); // sem URL, não liga ao campo URL de Conversão
    const ev = (await repo.conversaoEventos(36500)) as Array<{ evento: string; eventos: number; urls: number }>;
    expect(ev.find((e) => e.evento === 'form_fake')).toMatchObject({ eventos: 8, urls: 3 });
    const urls = (await repo.conversaoEventoUrls('form_fake', 36500)) as Array<{ caminho: string; eventos: number }>;
    expect(urls.map((u) => u.caminho)).toEqual(['/lp-fake', '/lp-fake/obrigado', '/outra']);
    await c().query('reset role');
  });

  it('regra com URL obrigatória: o banco recusa modo "igual" sem caminho', async () => {
    await c().query('set local role orq_panel');
    expect(await denied(`insert into mkt.conversao_regras (nome, tipo, evento, url_modo, url_valor) values ('x','lead','e','igual',' ')`)).toBe('23514');
    expect(await denied(`insert into mkt.conversao_regras (nome, tipo, evento, url_modo) values ('x','ganho','e','qualquer')`)).toBe('23514');
    await c().query('reset role');
  });

  it('orq_panel não grava dados do Google, não apaga regra e não enxerga as tabelas do schema mkt de dados', async () => {
    await c().query('set local role orq_panel');
    expect(await denied(`insert into mkt.ga4_eventos_dia (property_id, dia, host, pagina, evento, eventos, usuarios) values (9999,'2099-01-02','h','/p','e',1,1)`)).toBe('42501');
    expect(await denied(`update mkt.ga4_eventos_dia set eventos = 0`)).toBe('42501');
    expect(await denied(`select * from mkt.ga4_eventos_dia`)).toBe('42501');
    expect(await denied(`select * from mkt.gads_campanha_dia`)).toBe('42501');
    expect(await denied(`delete from mkt.conversao_regras`)).toBe('42501');
    expect((await c().query(`select count(*)::int as n from analytics.site_eventos_dia`)).rows[0].n).toBeGreaterThanOrEqual(4);
    await c().query('reset role');
  });

  it('orq_sync grava os dados do Google (upsert idempotente), só lê as regras e não toca em analytics', async () => {
    await c().query('set local role orq_sync');
    const ins = `insert into mkt.ga4_paginas_dia (property_id, dia, host, pagina, visualizacoes, usuarios_ativos) values (9999,'2099-01-02','exemplo.test','/p',3,2)
                 on conflict (property_id, dia, host, pagina) do update set visualizacoes = excluded.visualizacoes`;
    await c().query(ins);
    await c().query(ins);
    expect((await c().query(`select count(*)::int as n from mkt.ga4_paginas_dia where property_id = 9999`)).rows[0].n).toBe(1);
    expect(await denied(`insert into mkt.conversao_regras (nome, tipo, evento) values ('x','lead','e')`)).toBe('42501');
    expect(await denied(`select 1 from analytics.site_eventos_dia limit 1`)).toBe('42501');
    await c().query('reset role');
  });

  it('orq_chat lê só as visões agregadas e nunca escreve', async () => {
    await c().query('set local role orq_chat');
    expect((await c().query(`select count(*)::int as n from analytics.site_eventos_dia where property_id = 9999`)).rows[0].n).toBe(4);
    await c().query(`select 1 from analytics.negocios_url limit 1`);
    await c().query(`select 1 from analytics.ads_campanha_dia limit 1`);
    expect(await denied(`select * from mkt.ga4_eventos_dia`)).toBe('42501');
    expect(await denied(`insert into mkt.conversao_regras (nome, tipo, evento) values ('x','lead','e')`)).toMatch(/42501|25006/);
    expect(await denied(`select titulo from analytics.negocios_url`)).toBe('42703'); // a visão nem tem título de negócio
    await c().query('reset role');
  });

  it('negocios_url entrega só o caminho normalizado, nunca a URL completa com query string', async () => {
    const cols = (await c().query(`select column_name from information_schema.columns where table_schema = 'analytics' and table_name = 'negocios_url'`)).rows.map((r) => r.column_name);
    expect(cols).toContain('caminho_url');
    expect(cols).not.toContain('url_conversao');
    expect(cols).not.toContain('titulo');
  });

  it('custo do Google Ads: micros viram moeda na visão', async () => {
    await c().query(`insert into mkt.gads_campanhas (customer_id, campaign_id, nome, status) values (9990000001, 9990000002, 'Campanha Fictícia', 'ENABLED')`);
    await c().query(`insert into mkt.gads_campanha_dia (customer_id, campaign_id, dia, impressoes, cliques, custo_micros, conversoes) values (9990000001, 9990000002, '2099-01-01', 100, 10, 12340000, 1.5)`);
    const r = (await c().query(`select campanha, custo::float8 as custo, cliques from analytics.ads_campanha_dia where customer_id = 9990000001`)).rows[0];
    expect(r).toEqual({ campanha: 'Campanha Fictícia', custo: 12.34, cliques: '10' });
  });
});
