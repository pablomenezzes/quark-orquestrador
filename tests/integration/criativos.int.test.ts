import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { PainelInvalido, PainelNotFound, PgPainelRepo } from '../../studio/lib/painel-repo';
import { connect, hasDbConfig } from './helpers';

/**
 * Agrupamento virtual dos criativos do Meta Ads (migration 0016), provado com dados FICTÍCIOS (transação desfeita), pelo papel orq_panel:
 * criativo = UTM Term da fonte Meta ADS; DOR > Mensagem (2 níveis) e Módulo de Interesse; tudo opcional (em branco).
 * Pulado até a migration 0016 (mkt.cri_mapa) ser aplicada.
 */
let client: pg.Client | null = null;
let ready = false;
let antes = '';
const contagens = async (c: pg.Client) =>
  JSON.stringify((await c.query(`select (select count(*) from mkt.cri_dor) d, (select count(*) from mkt.cri_mensagem) m, (select count(*) from mkt.cri_modulo) o, (select count(*) from mkt.cri_mapa) p`)).rows[0]);
if (hasDbConfig) {
  client = await connect();
  ready = (await client.query(`select to_regclass('mkt.cri_mapa') is not null as ok`)).rows[0].ok === true;
  if (ready) antes = await contagens(client);
  else await client.end();
}
const run = describe.skipIf(!ready);

const KF = `${'f'.repeat(39)}a`; // Fonte do Lead (chave falsa maior que as reais)
const KT = `${'f'.repeat(39)}t`; // UTM Term

run('criativos: DOR, Mensagem e Módulo (transação com rollback)', () => {
  const c = () => client!;
  const repo = () => new PgPainelRepo(c() as never);
  const criativo = async (chave: string) => ((await repo().criativos()) as Array<Record<string, any>>).find((x) => x.termo_chave === chave)!;
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
  // um erro do banco (chave estrangeira, nome repetido) aborta a transação do teste: cada tentativa recusada fica num savepoint
  const recusa = async (fn: () => Promise<unknown>) => {
    await c().query('savepoint r');
    try {
      await fn();
      return null;
    } catch (e) {
      return e;
    } finally {
      await c().query('rollback to savepoint r');
    }
  };
  let dorA = 0, dorB = 0, msgA1 = 0, msgB1 = 0, modPonto = 0;

  beforeAll(async () => {
    await c().query('begin');
    await c().query(`insert into crm.pipelines (pipeline_id, nome) values (940004, 'Funil Fictício Criativos')`);
    await c().query(`insert into crm.stages (stage_id, pipeline_id, nome) values (953001, 940004, 'Lead fictício')`);
    await c().query(`insert into ops.cfg_pipeline_produto (pipeline_id, produto) values (940004, 'rh')`);
    await c().query(`insert into crm.field_definitions (entity, field_key, nome, tipo, opcoes) values ('deal', $1, 'Fonte do Lead', 'enum', $2::jsonb)`, [
      KF, JSON.stringify([{ id: 901, label: 'Marketing [Meta ADS]' }, { id: 902, label: 'Marketing [Google ADS]' }]),
    ]);
    await c().query(`insert into crm.field_definitions (entity, field_key, nome, tipo) values ('deal', $1, 'UTM Term', 'varchar')`, [KT]);
    const D = [
      { id: 98300001, st: 'won', valor: 100, fonte: 901, term: 'AD1 — Cópia' },
      { id: 98300002, st: 'open', valor: 50, fonte: 901, term: '  ad1   — cópia ' }, // o mesmo criativo, escrito diferente
      { id: 98300003, st: 'lost', valor: 10, fonte: 901, term: 'Outro Criativo' },
      { id: 98300004, st: 'open', valor: 0, fonte: 901, term: null }, // Meta sem UTM Term: não é criativo
      { id: 98300005, st: 'open', valor: 0, fonte: 902, term: 'Criativo do Google' }, // outra fonte: fora
    ];
    for (const d of D) {
      await c().query(`insert into crm.deals (pipedrive_id, pipeline_id, stage_id, owner_id, status, is_deleted, valor, created_at) values ($1, 940004, 953001, null, $2, false, $3, '2099-03-10T12:00:00Z')`, [d.id, d.st, d.valor]);
      await c().query(`insert into raw.pd_deals (source_id, payload, payload_hash) values ($1, $2::jsonb, 'h')`, [d.id, JSON.stringify({ id: d.id, custom_fields: { [KF]: d.fonte, [KT]: d.term } })]);
    }
    await c().query('set local role orq_panel');
  });
  afterAll(async () => {
    await c().query('reset role').catch(() => undefined);
    await c().query('rollback');
    expect(await contagens(c())).toBe(antes); // nada do teste permanece
    await c().end();
  });

  it('só entram criativos da fonte Meta ADS com UTM Term; grafias diferentes viram um criativo só', async () => {
    const l = (await repo().criativos()) as Array<Record<string, any>>;
    const meus = l.filter((x) => ['ad1 — cópia', 'outro criativo', 'criativo do google'].includes(x.termo_chave));
    expect(meus.map((x) => x.termo_chave).sort()).toEqual(['ad1 — cópia', 'outro criativo']);
    const ad1 = meus.find((x) => x.termo_chave === 'ad1 — cópia')!;
    expect(ad1).toMatchObject({ leads: 2, ganhos: 1, mrr_ganho: 100, dor_id: null, dor: null, mensagem: null, modulo: null }); // nasce em branco
  });

  it('cria DOR, Mensagem (dentro da DOR) e Módulo; nome repetido é recusado (sem diferenciar maiúsculas)', async () => {
    dorA = (await repo().criarCriativoItem('dor', '  Gestão   manual ')).id;
    dorB = (await repo().criarCriativoItem('dor', 'Medo de multa')).id;
    msgA1 = (await repo().criarCriativoItem('mensagem', 'Planilha não escala', dorA)).id;
    msgB1 = (await repo().criarCriativoItem('mensagem', 'Passivo trabalhista', dorB)).id;
    modPonto = (await repo().criarCriativoItem('modulo', 'Ponto')).id;
    await expect(repo().criarCriativoItem('dor', 'gestão manual')).rejects.toBeInstanceOf(PainelInvalido);
    await expect(repo().criarCriativoItem('modulo', 'PONTO')).rejects.toBeInstanceOf(PainelInvalido);
    await expect(repo().criarCriativoItem('mensagem', 'x')).rejects.toBeInstanceOf(PainelInvalido); // sem DOR
    await expect(repo().criarCriativoItem('mensagem', 'x', 999999999)).rejects.toBeInstanceOf(PainelInvalido);
    await expect(repo().criarCriativoItem('dor', '   ')).rejects.toBeInstanceOf(PainelInvalido);
    const cfg = await repo().criativosConfig();
    expect(cfg.dores.find((d) => d.id === dorA)).toMatchObject({ nome: 'Gestão manual', ativo: true, mensagens: [expect.objectContaining({ nome: 'Planilha não escala' })] });
    // a mesma Mensagem pode existir em outra DOR
    await expect(repo().criarCriativoItem('mensagem', 'planilha não escala', dorB)).resolves.toMatchObject({ restaurado: false });
  });

  it('mapeia o criativo: DOR > Mensagem e Módulo; a Mensagem tem de ser da DOR; trocar a DOR esvazia a Mensagem', async () => {
    expect(await repo().mapearCriativos(['ad1 — cópia'], { dor_id: dorA, mensagem_id: msgA1, modulo_id: modPonto })).toEqual({ atualizados: 1 });
    expect(await criativo('ad1 — cópia')).toMatchObject({ dor: 'Gestão manual', mensagem: 'Planilha não escala', modulo: 'Ponto' });
    expect(await recusa(() => repo().mapearCriativos(['ad1 — cópia'], { dor_id: dorA, mensagem_id: msgB1 }))).toBeInstanceOf(PainelInvalido); // Mensagem de outra DOR
    expect(await recusa(() => repo().mapearCriativos(['ad1 — cópia'], { mensagem_id: msgB1 }))).toBeInstanceOf(PainelInvalido); // idem, sem trocar a DOR
    await repo().mapearCriativos(['ad1 — cópia'], { dor_id: dorB }); // só trocou a DOR: a Mensagem antiga não vale mais
    expect(await criativo('ad1 — cópia')).toMatchObject({ dor: 'Medo de multa', mensagem: null, modulo: 'Ponto' });
    await expect(repo().mapearCriativos(['nao-existe'], { dor_id: dorA })).rejects.toBeInstanceOf(PainelNotFound);
    await expect(repo().mapearCriativos(['ad1 — cópia'], {})).rejects.toBeInstanceOf(PainelInvalido);
    await expect(repo().mapearCriativos([], { dor_id: dorA })).rejects.toBeInstanceOf(PainelInvalido);
  });

  it('o banco também garante: Mensagem sem DOR e Mensagem de outra DOR não existem', async () => {
    await c().query('reset role');
    expect(await denied(`insert into mkt.cri_mapa (termo_chave, mensagem_id) values ('x', $1)`, [msgA1])).toBe('23514');
    expect(await denied(`insert into mkt.cri_mapa (termo_chave, dor_id, mensagem_id) values ('x', $1, $2)`, [dorA, msgB1])).toBe('23503');
    await c().query('set local role orq_panel');
  });

  it('aplica a vários de uma vez e deixa em branco (null) o que não tem equivalente', async () => {
    const r = await repo().mapearCriativos(['ad1 — cópia', 'outro criativo'], { dor_id: dorA, mensagem_id: msgA1, modulo_id: null });
    expect(r.atualizados).toBe(2);
    expect(await criativo('outro criativo')).toMatchObject({ dor: 'Gestão manual', mensagem: 'Planilha não escala', modulo: null });
    await repo().mapearCriativos(['outro criativo'], { dor_id: null, mensagem_id: null, modulo_id: null });
    expect(await criativo('outro criativo')).toMatchObject({ dor_id: null, dor: null, mensagem: null, modulo: null });
  });

  it('os negócios herdam DOR, Mensagem e Módulo do criativo (e ficam em branco se o criativo não foi mapeado)', async () => {
    await repo().mapearCriativos(['ad1 — cópia'], { dor_id: dorA, mensagem_id: msgA1, modulo_id: modPonto });
    const r = (await c().query(`select deal_id, termo_chave, dor, mensagem, modulo from analytics.negocios_criativo where deal_id between 98300001 and 98300005 order by deal_id`)).rows;
    expect(r.map((x) => [Number(x.deal_id), x.termo_chave, x.dor, x.mensagem, x.modulo])).toEqual([
      [98300001, 'ad1 — cópia', 'Gestão manual', 'Planilha não escala', 'Ponto'],
      [98300002, 'ad1 — cópia', 'Gestão manual', 'Planilha não escala', 'Ponto'],
      [98300003, 'outro criativo', null, null, null],
    ]);
  });

  it('remover é desativar: o item some dos relatórios (em branco), o mapa é guardado e restaurar traz tudo de volta', async () => {
    await repo().atualizarCriativoItem('modulo', modPonto, { ativo: false });
    expect(await criativo('ad1 — cópia')).toMatchObject({ modulo: null, modulo_id: modPonto, dor: 'Gestão manual' }); // id guardado, nome em branco
    await expect(repo().mapearCriativos(['ad1 — cópia'], { modulo_id: modPonto })).rejects.toBeInstanceOf(PainelInvalido); // não dá para escolher item removido
    await repo().atualizarCriativoItem('modulo', modPonto, { ativo: true });
    expect(await criativo('ad1 — cópia')).toMatchObject({ modulo: 'Ponto' });
    // remover a DOR leva as Mensagens dela; restaurar uma Mensagem exige a DOR de volta
    await repo().atualizarCriativoItem('dor', dorA, { ativo: false });
    expect(await criativo('ad1 — cópia')).toMatchObject({ dor: null, mensagem: null, modulo: 'Ponto' });
    await expect(repo().atualizarCriativoItem('mensagem', msgA1, { ativo: true })).rejects.toBeInstanceOf(PainelInvalido);
    await repo().atualizarCriativoItem('dor', dorA, { ativo: true });
    expect(await criativo('ad1 — cópia')).toMatchObject({ dor: 'Gestão manual', mensagem: null }); // a Mensagem continua removida
    await repo().atualizarCriativoItem('mensagem', msgA1, { ativo: true });
    expect(await criativo('ad1 — cópia')).toMatchObject({ mensagem: 'Planilha não escala' });
    // criar de novo um nome removido restaura em vez de duplicar
    await repo().atualizarCriativoItem('modulo', modPonto, { ativo: false });
    expect(await repo().criarCriativoItem('modulo', 'ponto')).toEqual({ id: modPonto, restaurado: true });
    await expect(repo().atualizarCriativoItem('dor', 999999999, { ativo: false })).rejects.toBeInstanceOf(PainelNotFound);
  });

  it('renomear: nome repetido na mesma lista é recusado', async () => {
    await repo().atualizarCriativoItem('dor', dorB, { nome: 'Medo de multa trabalhista' });
    expect(await recusa(() => repo().atualizarCriativoItem('dor', dorB, { nome: 'GESTÃO MANUAL' }))).toBeInstanceOf(PainelInvalido);
    expect((await repo().criativosConfig()).dores.find((d) => d.id === dorB)!.nome).toBe('Medo de multa trabalhista');
  });

  it('permissões: o Painel não apaga nada; o conector do Claude só lê as visões', async () => {
    expect(await denied(`delete from mkt.cri_dor where id = $1`, [dorA])).toBe('42501');
    expect(await denied(`delete from mkt.cri_mapa`)).toBe('42501');
    await c().query('reset role');
    await c().query('set local role orq_chat');
    expect((await c().query(`select count(*)::int as n from analytics.criativos_meta where termo_chave = 'ad1 — cópia'`)).rows[0].n).toBe(1);
    expect(await denied(`select * from mkt.cri_mapa`)).toBe('42501');
    expect(await denied(`insert into mkt.cri_dor (nome) values ('x')`)).toMatch(/42501|25006/);
    await c().query('reset role');
    await c().query('set local role orq_sync');
    expect(await denied(`select * from mkt.cri_dor`)).toBe('42501'); // a sincronização não tem nada a ver com isso
    await c().query('reset role');
    await c().query('set local role orq_panel');
  });
});
