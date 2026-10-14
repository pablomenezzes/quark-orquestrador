import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { PgPainelRepo } from '../../studio/lib/painel-repo';
import { connect, hasDbConfig } from './helpers';

/**
 * Conversões Globais (migration 0020), em transação desfeita: catálogo (tipo e pontos), a leitura das três origens e o perfil do lead.
 * Pulado até a migration 0020 ser aplicada. O catálogo real (a linha da etapa Reunião agendada) fica intacto.
 */
let client: pg.Client | null = null;
let ready = false;
let antes = '';
const contagem = async (c: pg.Client) => JSON.stringify((await c.query(`select (select count(*) from mkt.conversao_catalogo) c, (select count(*) from crm.deal_atributos) a`)).rows[0]);
if (hasDbConfig) {
  client = await connect();
  ready = (await client.query(`select to_regclass('mkt.conversao_catalogo') is not null as ok`)).rows[0].ok === true;
  if (ready) antes = await contagem(client);
  else await client.end();
}
const run = describe.skipIf(!ready);

run('Conversões Globais (transação com rollback)', () => {
  const c = () => client!;
  const repo = () => new PgPainelRepo(c());
  beforeAll(async () => { await c().query('begin'); });
  afterAll(async () => {
    await c().query('rollback');
    expect(await contagem(c())).toBe(antes);
    await c().end();
  });

  it('o catálogo nasce com a etapa Reunião agendada como Agendamento de Reunião (Bofu), sem pontos', async () => {
    const r = (await c().query(`select tipo_conversao, pontos from mkt.conversao_catalogo where origem = 'pipe' and evento = '[Etapa] Reunião agendada'`)).rows[0];
    expect(r).toEqual({ tipo_conversao: 'agendamento_reuniao', pontos: null });
  });

  it('classifica um evento do RD (cadastro) e depois o reclassifica; a lista global traz a linha sem contagem', async () => {
    await repo().salvarConversaoCatalogo({ origem: 'rd', evento: 'evento rd fictício zz', tipo_conversao: 'material', pontos: 5 });
    await repo().salvarConversaoCatalogo({ origem: 'rd', evento: 'evento rd fictício zz', tipo_conversao: 'levantada_de_mao', pontos: 20 });
    const g = (await repo().conversoesGlobais(30)) as Array<Record<string, any>>;
    const rd = g.filter((x) => x.evento === 'evento rd fictício zz');
    expect(rd).toHaveLength(1);
    expect(rd[0]).toMatchObject({ origem: 'rd', tipo_conversao: 'levantada_de_mao', pontos: 20, ocorrencias: null, no_catalogo: true });
  });

  it('a lista global traz as conversões do Pipedrive (identificador RD) com contagem e as classificações do catálogo', async () => {
    const g = (await repo().conversoesGlobais(36500)) as Array<Record<string, any>>;
    const pipe = g.filter((x) => x.origem === 'pipe' && x.ocorrencias != null);
    expect(pipe.length).toBeGreaterThan(0);
    expect(g.find((x) => x.evento === '[Etapa] Reunião agendada')).toMatchObject({ origem: 'pipe', tipo_conversao: 'agendamento_reuniao' });
  });

  it('recusa tipo e pontos fora da lista no banco', async () => {
    for (const sql of [
      `insert into mkt.conversao_catalogo (origem, evento, tipo_conversao) values ('rd', 'x1', 'compra')`,
      `insert into mkt.conversao_catalogo (origem, evento, pontos) values ('rd', 'x2', 5000)`,
      `insert into mkt.conversao_catalogo (origem, evento) values ('tiktok', 'x3')`,
    ]) {
      await c().query('savepoint s');
      await expect(c().query(sql)).rejects.toThrow();
      await c().query('rollback to savepoint s');
    }
  });

  it('o perfil do lead: negocio() traz a lista de conversões do negócio (vazia ou não, mas lista)', async () => {
    const id = Number((await c().query(`select deal_id from analytics.deals limit 1`)).rows[0].deal_id);
    const f = await repo().negocio(id);
    expect(Array.isArray(f.conversoes)).toBe(true);
  });
});
