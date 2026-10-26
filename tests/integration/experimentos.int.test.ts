import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { PainelNotFound } from '../../studio/lib/painel-repo';
import { PgExperimentosRepo } from '../../studio/lib/experimentos';
import { connect, hasDbConfig } from './helpers';

/**
 * Experimentos de growth (migration 0023), provados em transação desfeita pelo papel orq_panel: cadastro, leitura automática das visões de
 * analytics, fotografia ao concluir e ausência de DELETE. Pulado até a migration 0023 (mkt.experimentos) ser aplicada.
 */
let client: pg.Client | null = null;
let ready = false;
if (hasDbConfig) {
  client = await connect();
  ready = (await client.query(`select to_regclass('mkt.experimentos') is not null as ok`)).rows[0].ok === true;
  if (!ready) await client.end();
}
const run = describe.skipIf(!ready);

run('experimentos (transação com rollback)', () => {
  const c = () => client!;
  const repo = () => new PgExperimentosRepo(c() as never);
  const nova = { titulo: 'FICTÍCIO leads Meta RH', produto: 'rh', canal: 'meta', metrica: 'leads', meta: 2000, orcamento: 30000, inicio: '2026-10-01', fim: '2026-10-31', iceImpacto: 8, iceConfianca: 6, iceFacilidade: 7 };
  async function recusado(sql: string, params: unknown[] = []): Promise<string> {
    await c().query('savepoint d');
    try { await c().query(sql, params); return 'NO_ERROR'; } catch (e) { return (e as { code?: string }).code ?? 'UNKNOWN'; } finally { await c().query('rollback to savepoint d'); }
  }
  beforeAll(async () => { await c().query('begin'); await c().query('set local role orq_panel'); });
  afterAll(async () => { await c().query('rollback'); await c().end(); });

  it('cadastra e devolve o progresso calculado sozinho, com ICE e linha de base automática', async () => {
    const e = await repo().criar(nova);
    expect(e.iceScore).toBe(7);
    expect(e.progresso.totalDias).toBe(31);
    expect(e.progresso.linhaBaseAuto).toBe(true);
    const l = await repo().listar();
    expect(l.experimentos.some((x) => x.id === e.id)).toBe(true);
  });
  it('ao concluir, grava valor final, atingimento e desfecho', async () => {
    const e = await repo().criar({ ...nova, titulo: 'FICTÍCIO concluído', meta: 1 });
    const fim = await repo().atualizar(e.id, { status: 'concluido' });
    expect(fim.status).toBe('concluido');
    expect(fim.desfecho).toBe('atingiu'); // meta de 1 lead: qualquer lead do período a bate
    expect(fim.valorFinal).not.toBeNull();
  });
  it('o painel não apaga (remover é cancelar) e o banco recusa valores fora das regras', async () => {
    expect(await recusado(`delete from mkt.experimentos`)).toBe('42501');
    expect(await recusado(`insert into mkt.experimentos (titulo, produto, metrica, meta, inicio, fim) values ('x', 'rh', 'leads', 1, '2026-10-10', '2026-10-01')`)).toBe('23514');
    expect(await recusado(`insert into mkt.experimentos (titulo, produto, metrica, meta, inicio, fim, ice_impacto) values ('x', 'rh', 'leads', 1, '2026-10-01', '2026-10-02', 11)`)).toBe('23514');
  });
  it('experimento que não existe devolve "não encontrado"', async () => {
    await expect(repo().atualizar(987654321, { titulo: 'x' })).rejects.toThrow(PainelNotFound);
  });
});
