import { describe, it, expect } from 'vitest';
import { arquivarMes, desempacotar, empacotar, mesesParaArquivar, restaurarMes } from '../src/datahub/google/ga4-arquivo';
import { REVISAO_DIAS } from '../src/datahub/google/ga4-sync';

const linhas = Array.from({ length: 500 }, (_, i) => ({ property_id: '382708044', dia: '2025-03-15', host: 'quarkrh.com.br', pagina: `/pagina-${i % 40}`, visualizacoes: i, usuarios_ativos: i % 7, atualizado_em: '2026-10-01T00:00:00Z' }));

describe('Arquivo comprimido do histórico do GA4', () => {
  it('comprime muito e volta idêntico (hash e número de linhas conferidos)', () => {
    const p = empacotar(linhas);
    expect(p.linhas).toBe(500);
    expect(p.dados.length).toBeLessThan(p.bytes_originais / 5);
    expect(desempacotar(p)).toHaveLength(500);
    expect(new Set(desempacotar(p).map((l) => JSON.stringify(l)))).toEqual(new Set(linhas.map((l) => JSON.stringify(l))));
  });
  it('mesmo conteúdo em outra ordem dá o mesmo hash', () => {
    expect(empacotar([...linhas].reverse()).sha256).toBe(empacotar(linhas).sha256);
  });
  it('arquivo adulterado ou com linhas faltando é recusado', () => {
    const p = empacotar(linhas);
    expect(() => desempacotar({ ...p, sha256: 'x'.repeat(64) })).toThrow(/hash/);
    expect(() => desempacotar({ ...p, linhas: 499 })).toThrow(/499/);
    expect(() => desempacotar({ ...p, dados: Buffer.from('nao e gzip') })).toThrow();
  });
  it('mês vazio também se arquiva e se restaura (0 linhas)', () => {
    expect(desempacotar(empacotar([]))).toEqual([]);
  });
  it('só arquiva INSERINDO (nunca regrava) e só meses fechados e ainda não arquivados', async () => {
    const sqls: string[] = [];
    const q = { query: async (sql: string) => { sqls.push(sql.replace(/\s+/g, ' ').trim()); return { rows: [{ j: { dia: '2025-03-01' } }, { mes: '2025-03' }], rowCount: 1 }; } };
    await arquivarMes(q as never, 'ga4_paginas_dia', '2025-03');
    const ins = sqls.find((s) => s.startsWith('insert into mkt.ga4_arquivo'))!;
    expect(ins).toContain('on conflict (tabela, mes) do nothing');
    expect(sqls.join(' ')).not.toMatch(/\b(update|delete)\b/i);
    await mesesParaArquivar(q as never, 'ga4_ads_dia');
    expect(sqls.at(-1)).toMatch(/not exists \(select 1 from mkt\.ga4_arquivo/);
    await restaurarMes({ query: async (sql: string) => (sql.includes('from mkt.ga4_arquivo') ? { rows: [{ linhas: 0, sha256: empacotar([]).sha256, dados: empacotar([]).dados }] } : { rows: [], rowCount: 0 }) } as never, 'ga4_dia', '2025-03');
  });
  it('a sincronização do GA4 revisa só os últimos 3 dias (o GA4 ajusta por 2 a 3 dias), nunca o histórico', () => {
    expect(REVISAO_DIAS).toBe(3);
  });
});
