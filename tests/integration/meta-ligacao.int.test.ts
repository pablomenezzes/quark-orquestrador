import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { MetaStore } from '../../src/datahub/meta/meta-sync';
import { connect, hasDbConfig } from './helpers';

/**
 * Ligação dos negócios do Pipedrive com a Meta (migration 0018), provada com negócios e anúncios FICTÍCIOS (transação desfeita), pelo papel
 * orq_sync. Os campos usam chaves falsas MAIORES que as reais, então só os negócios fictícios entram na ligação.
 * Pulado até a migration 0018 (mkt.meta_ligacao) ser aplicada.
 */
let client: pg.Client | null = null;
let ready = false;
let antes = '';
if (hasDbConfig) {
  client = await connect();
  ready = (await client.query(`select to_regclass('mkt.meta_ligacao') is not null as ok`)).rows[0].ok === true;
  if (ready) antes = JSON.stringify((await client.query(`select count(*) n from mkt.meta_ligacao`)).rows[0]);
  else await client.end();
}
const run = describe.skipIf(!ready);

const P = 'f'.repeat(39);
const K = { ad: `${P}1`, adset: `${P}2`, camp: `${P}3`, lead: `${P}4`, form: `${P}5`, ucamp: `${P}6`, ucont: `${P}7`, uterm: `${P}8`, umed: `${P}9`, fonte: `${P}a` };
const NOMES: Array<[keyof typeof K, string]> = [['ad', 'Meta Ad_id'], ['adset', 'Meta Adset_id'], ['camp', 'Meta Campaign_id'], ['lead', 'Meta Lead_id'], ['form', 'Meta Form_id'], ['ucamp', 'UTM CAMPAIGN'], ['ucont', 'UTM Content'], ['uterm', 'UTM Term'], ['umed', 'UTM Medium']];

const CONTA = '999000000000000001';
const C1 = '120999999999990001', C2 = '120999999999990002';
const S1 = '120999999999990011', S2 = '120999999999990012', S3 = '120999999999990013';
const A1 = '120999999999990021', A2 = '120999999999990022', A3 = '120999999999990023', A4 = '120999999999990024', A5 = '120999999999990025';

run('Meta: ligação dos negócios (transação com rollback)', () => {
  const c = () => client!;
  const lig = async (deal: number) => (await c().query(`select metodo, certeza, candidatos, anuncio_id::text a, conjunto_id::text j, campanha_id::text p, meta_lead_id from mkt.meta_ligacao where deal_id = $1`, [deal])).rows[0];

  beforeAll(async () => {
    await c().query('begin');
    for (const [k, nome] of NOMES) await c().query(`insert into crm.field_definitions (entity, field_key, nome, tipo) values ('deal', $1, $2, 'varchar')`, [K[k], nome]);
    await c().query(`insert into crm.field_definitions (entity, field_key, nome, tipo, opcoes) values ('deal', $1, 'Fonte do Lead', 'enum', $2::jsonb)`, [K.fonte, JSON.stringify([{ id: 901, label: 'Marketing [Meta ADS]' }, { id: 902, label: 'Marketing [Orgânico]' }])]);
    await c().query(`insert into mkt.meta_contas (conta_id, produto, nome) values ($1::bigint, 'rh', 'Conta Fictícia')`, [CONTA]);
    await c().query(`insert into mkt.meta_campanhas (campanha_id, conta_id, nome, nome_chave) values ($1::bigint, $3::bigint, 'Campanha Alfa', mkt.chave_nome_meta('Campanha Alfa')), ($2::bigint, $3::bigint, 'Campanha Beta', mkt.chave_nome_meta('Campanha Beta'))`, [C1, C2, CONTA]);
    await c().query(`insert into mkt.meta_conjuntos (conjunto_id, campanha_id, conta_id, nome, nome_chave) values ($1::bigint, $4::bigint, $5::bigint, 'S1', 's1'), ($2::bigint, $6::bigint, $5::bigint, 'S2', 's2'), ($3::bigint, $6::bigint, $5::bigint, 'S3', 's3')`, [S1, S2, S3, C1, CONTA, C2]);
    const ad = (id: string, conj: string, camp: string, nome: string) =>
      c().query(`insert into mkt.meta_anuncios (anuncio_id, conjunto_id, campanha_id, conta_id, nome, nome_chave) values ($1::bigint, $2::bigint, $3::bigint, $4::bigint, $5, mkt.chave_nome_meta($5))`, [id, conj, camp, CONTA, nome]);
    await ad(A1, S1, C1, 'AD Um'); await ad(A2, S1, C1, 'AD Dois'); await ad(A3, S2, C2, 'AD Um'); await ad(A4, S2, C2, 'AD Repetido'); await ad(A5, S3, C2, 'AD Repetido');
    type D = { id: number; fonte?: number; ad?: string; adset?: string; camp?: string; lead?: string; ucamp?: string; ucont?: string; uterm?: string; umed?: string };
    const D: D[] = [
      { id: 98400001, fonte: 901, ad: A1, lead: '555' }, // 1) ad_id
      { id: 98400002, fonte: 901, ad: '999999999999999999', adset: S2 }, // Ad_id que a Meta não conhece, mas o conjunto sim
      { id: 98400003, fonte: 901, camp: C2, uterm: '  AD   um ' }, // campanha + nome (o mesmo nome existe na outra campanha: vale a campanha)
      { id: 98400004, fonte: 901, ucamp: 'campanha  ALFA', ucont: 'ad dois' }, // só por nome
      { id: 98400005, fonte: 901, camp: C2, uterm: 'AD Repetido' }, // nome repetido na campanha: ambíguo
      { id: 98400006, fonte: 901, ucamp: 'Campanha Beta' }, // só a campanha, pelo nome
      { id: 98400007, fonte: 901, camp: C1 }, // só a campanha, pelo ID
      { id: 98400008, fonte: 901 }, // Meta, sem nada para ligar
      { id: 98400009, fonte: 902, uterm: 'AD Um' }, // não é Meta e não tem ID: fica de fora
      { id: 98400010, fonte: 901, ad: 'abc', camp: C1, uterm: 'AD Dois' }, // Ad_id inválido é ignorado
    ];
    for (const d of D) {
      const cf: Record<string, unknown> = { [K.fonte]: d.fonte ?? null, [K.ad]: d.ad ?? null, [K.adset]: d.adset ?? null, [K.camp]: d.camp ?? null, [K.lead]: d.lead ?? null, [K.ucamp]: d.ucamp ?? null, [K.ucont]: d.ucont ?? null, [K.uterm]: d.uterm ?? null, [K.umed]: d.umed ?? null };
      await c().query(`insert into raw.pd_deals (source_id, payload, payload_hash) values ($1, $2::jsonb, 'h')`, [d.id, JSON.stringify({ id: d.id, custom_fields: cf })]);
    }
    await c().query('set local role orq_sync');
  });
  afterAll(async () => {
    await c().query('reset role').catch(() => undefined);
    await c().query('rollback');
    expect(JSON.stringify((await c().query(`select count(*) n from mkt.meta_ligacao`)).rows[0])).toBe(antes);
    await c().end();
  });

  it('o robô de carga recalcula a ligação (e de novo, sem duplicar)', async () => {
    const n = await new MetaStore(c() as never).recalcularLigacao();
    expect(n).toBeGreaterThanOrEqual(9);
    expect(await new MetaStore(c() as never).recalcularLigacao()).toBe(n);
    expect((await c().query(`select count(*)::int n from mkt.meta_ligacao where deal_id between 98400001 and 98400010`)).rows[0].n).toBe(9); // o negócio 9 (não Meta) fica de fora
  });

  it('1) método principal: o Meta Ad_id liga ao anúncio, ao conjunto e à campanha (certeza alta)', async () => {
    expect(await lig(98400001)).toMatchObject({ metodo: 'ad_id', certeza: 'alta', a: A1, j: S1, p: C1, meta_lead_id: '555' });
  });
  it('Ad_id desconhecido cai no conjunto; Ad_id inválido é ignorado e a campanha + nome resolve', async () => {
    expect(await lig(98400002)).toMatchObject({ metodo: 'conjunto_id', certeza: 'alta', a: null, j: S2, p: C2 });
    expect(await lig(98400010)).toMatchObject({ metodo: 'campanha_id+nome', certeza: 'alta', a: A2, j: S1, p: C1 });
  });
  it('2) campanha + nome: o mesmo nome em outra campanha não atrapalha (a campanha decide) e espaços/maiúsculas são ignorados', async () => {
    expect(await lig(98400003)).toMatchObject({ metodo: 'campanha_id+nome', certeza: 'alta', a: A3, j: S2, p: C2, candidatos: 1 });
  });
  it('3) só por nome: campanha e anúncio pelos nomes das UTMs (certeza média)', async () => {
    expect(await lig(98400004)).toMatchObject({ metodo: 'nome', certeza: 'media', a: A2, j: S1, p: C1 });
  });
  it('nome que bate com mais de um anúncio é AMBÍGUO: não escolhe anúncio nem conjunto, mas guarda a campanha comum', async () => {
    expect(await lig(98400005)).toMatchObject({ metodo: 'ambiguo', certeza: 'baixa', candidatos: 2, a: null, j: null, p: C2 });
  });
  it('só a campanha (pelo ID ou pelo nome único) e sem ligação', async () => {
    expect(await lig(98400007)).toMatchObject({ metodo: 'campanha_id', certeza: 'media', a: null, p: C1 });
    expect(await lig(98400006)).toMatchObject({ metodo: 'campanha_nome', certeza: 'baixa', a: null, p: C2 });
    expect(await lig(98400008)).toMatchObject({ metodo: 'sem_ligacao', certeza: 'baixa', a: null, p: null, candidatos: 0 });
    expect(await lig(98400009)).toBeUndefined();
  });
  it('refazer a ligação depois de a Meta ganhar um anúncio resolve o que era "sem ligação" ou ambíguo', async () => {
    await c().query('reset role');
    await c().query(`update mkt.meta_anuncios set nome = 'AD Repetido B', nome_chave = mkt.chave_nome_meta('AD Repetido B') where anuncio_id = $1::bigint`, [A5]);
    await c().query('set local role orq_sync');
    await new MetaStore(c() as never).recalcularLigacao();
    expect(await lig(98400005)).toMatchObject({ metodo: 'campanha_id+nome', certeza: 'alta', a: A4, candidatos: 1 });
  });
});
