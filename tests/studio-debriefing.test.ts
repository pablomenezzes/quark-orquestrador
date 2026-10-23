import { describe, it, expect } from 'vitest';
import { BI_ANALISES, BI_PAGINAS } from '../studio/lib/bi';
import { ANALISES_DEBRIEFING } from '../studio/lib/debriefing';
import { agoraLocal, semanasCompletas, somaDias } from '../studio/lib/monitor';

const { hoje } = agoraLocal();
const semanas = semanasCompletas(hoje, 2);
const A = semanas[0]!;
const B = semanas[1]!;
const dias = (j: { de: string; ate: string }) => { const o: string[] = []; for (let d = j.de; d <= j.ate; d = somaDias(d, 1)) o.push(d); return o; };

/** Banco de mentira: devolve linhas conforme a consulta (reconhecida pelo texto do SQL). Meta: 100 de gasto por dia nas duas semanas, 1 lead por dia em A e 2 por dia em B. */
function dbFalso() {
  const consultas: string[] = [];
  const query = async (sql: string) => {
    const s = sql.replace(/\s+/g, ' ');
    consultas.push(s);
    // negócios: leads e MQL por dia (Meta), ganhos e reuniões
    if (s.includes("to_char(") && s.includes('as leads') && s.includes('negocios_bi')) {
      return { rows: [...dias(A).map((d) => ({ dia: d, fonte: 'Marketing [Meta ADS]', leads: 1, mql: 1 })), ...dias(B).map((d) => ({ dia: d, fonte: 'Marketing [Meta ADS]', leads: 2, mql: 2 }))] };
    }
    if (s.includes("to_char(") && s.includes('as ganhos') && s.includes('negocios_bi')) return { rows: [{ dia: B.de, fonte: 'Marketing [Meta ADS]', ganhos: 2, mrr: 1000 }] };
    if (s.includes('as reunioes') || s.includes('as ganhos') || s.includes('as leads')) return { rows: [] };
    // investimento da Meta por dia (alimenta o funil) e da Google
    if (s.includes('from analytics.meta_desempenho_dia m') && s.includes('as gasto, sum(impressoes)')) {
      return { rows: [...dias(A), ...dias(B)].map((d) => ({ dia: d, gasto: 100, impressoes: 10000, cliques: 100 })) };
    }
    if (s.includes('from analytics.ads_investimento_dia')) return { rows: [] };
    if (s.includes('from analytics.site_sessoes_dia') && s.includes('max(dia)')) return { rows: [{ dia: somaDias(hoje, -1) }] };
    if (s.includes('from analytics.site_sessoes_dia')) return { rows: [] };
    // campanhas da Meta: A gastou muito mais que B em uma e a outra só gastou em B
    if (s.includes('campanha_id::text as id') && s.includes('meta_desempenho_dia')) {
      return { rows: [{ id: '1', campanha: 'Campanha que cresceu', ga: 700, gb: 300, la: 14, lb: 10 }, { id: '2', campanha: 'Campanha que parou', ga: 0, gb: 400, la: 0, lb: 8 }] };
    }
    if (s.includes('campaign_id::text as id') && s.includes('ads_campanha_dia') && !s.includes('max(status)')) return { rows: [{ id: '9', campanha: 'Google A', ga: 100, gb: 200, ca: 20, cb: 40 }] };
    // anúncios: um parou (pausado hoje), um é novo, um segue ativo
    if (s.includes('anuncio_id::text as id') && s.includes('analytics.meta_anuncios')) {
      return {
        rows: [
          { id: '10', anuncio: 'Anúncio pausado', campanha: 'Campanha X', primeiro: '2026-01-10', ultimo: somaDias(A.de, 1), ga: 80, gb: 200, la: 3, status: 'PAUSED' },
          { id: '11', anuncio: 'Anúncio novo', campanha: 'Campanha X', primeiro: A.de, ultimo: hoje, ga: 150, gb: 0, la: 5, status: 'ACTIVE' },
          { id: '12', anuncio: 'Anúncio ativo', campanha: 'Campanha X', primeiro: '2026-01-10', ultimo: hoje, ga: 300, gb: 300, la: 9, status: 'ACTIVE' },
          { id: '13', anuncio: 'Anúncio sem importância', campanha: 'Campanha X', primeiro: '2026-01-10', ultimo: somaDias(A.de, 1), ga: 5, gb: 10, la: 0, status: 'ARCHIVED' },
        ],
      };
    }
    if (s.includes('max(status)') && s.includes('ads_campanha_dia')) return { rows: [{ id: '9', campanha: 'Google parada', status: 'PAUSED', primeiro: '2026-02-01', ultimo: somaDias(A.de, 2), ga: 40, gb: 90 }] };
    return { rows: [] };
  };
  return { db: { query } as never, consultas };
}
const rodar = async (id: string, f: Record<string, unknown> = {}) => { const { db } = dbFalso(); return ANALISES_DEBRIEFING.find((a) => a.id === id)!.rodar(db, { de: '2020-01-01', ate: '2020-01-02', ...f } as never); };

describe('BI: página Debriefing semanal', () => {
  it('é uma página do BI com as 6 análises, na ordem: resumo, o que caiu, o que mudou, o que foi pausado, CPL e conversão', () => {
    expect(BI_PAGINAS.map((p) => p.id)).toContain('debriefing');
    expect(BI_ANALISES.filter((a) => a.pagina === 'debriefing').map((a) => a.id)).toEqual(['deb-resumo', 'deb-quedas', 'deb-mudou', 'deb-pausados', 'deb-cpl', 'deb-conversao']);
    for (const a of ANALISES_DEBRIEFING) { expect(a.pergunta.length).toBeGreaterThan(20); expect(a.como_ler.length).toBeGreaterThan(40); }
  });
  it('a semana é a última semana COMPLETA (segunda a domingo), contra a anterior, e o filtro de período não vale', async () => {
    const r = await rodar('deb-resumo');
    expect(r.avisos[0]).toContain('última semana completa');
    expect(r.avisos[0]).toContain('O filtro de período não vale');
    expect(new Date(`${A.de}T00:00:00Z`).getUTCDay()).toBe(1); // segunda
    expect(new Date(`${A.ate}T00:00:00Z`).getUTCDay()).toBe(0); // domingo
    expect(A.ate < hoje).toBe(true);
    expect(somaDias(B.ate, 1)).toBe(A.de);
  });
  it('resumo: investimento, leads, CPL, taxas de conversão e resultado, cada um com a semana anterior e a variação', async () => {
    const r = await rodar('deb-resumo');
    expect(r.grafico.tipo).toBe('kpis');
    const itens = (r.grafico as { itens: Array<{ id: string; rotulo: string; valor: number | null; dica: string }> }).itens;
    expect(itens.map((i) => i.id)).toEqual(['invest', 'leads', 'cpl', 'txLead', 'pctMql', 'reuniaoMql', 'reunioes', 'ganhos', 'mrr', 'cac']);
    const por = (id: string) => itens.find((i) => i.id === id)!;
    expect(por('invest').valor).toBe(700); // 7 dias x 100
    expect(por('leads').valor).toBe(7);
    expect(por('cpl').valor).toBeCloseTo(100, 6); // 700 ÷ 7 leads de mídia paga
    expect(por('cpl').dica).toContain('semana anterior: R$ 50,00'); // 700 ÷ 14
    expect(por('cpl').dica).toContain('▲ 100,0%'); // o CPL dobrou
    expect(por('leads').dica).toContain('▼ 50,0%');
    expect(por('txLead').valor).toBeCloseTo(7 / 700, 6);
    expect(r.tabela.linhas).toHaveLength(10);
  });
  it('o que caiu: só piora acima de 10%, CPL subindo conta como piora, e contagem pequena fica de fora', async () => {
    const r = await rodar('deb-quedas');
    const linhas = r.tabela.linhas as Array<{ quem: string; indicador: string; piora: number }>;
    const meta = linhas.filter((l) => l.quem === 'Meta Ads');
    expect(meta.some((l) => l.indicador === 'Leads')).toBe(true);
    expect(meta.some((l) => l.indicador === 'CPL')).toBe(true);
    expect(linhas.every((l) => l.piora >= 0.1)).toBe(true);
    expect(linhas.some((l) => l.indicador === 'Investimento')).toBe(false); // neutro
    expect(meta.some((l) => l.indicador === 'Ganhos')).toBe(true); // 2 ganhos na semana anterior e nenhum agora: queda de 100%
    expect(linhas.some((l) => l.quem === 'Meta Ads' && l.indicador === 'Reuniões agendadas')).toBe(false); // nenhuma reunião nas duas semanas: nada a comparar
    for (let i = 1; i < linhas.length; i++) expect(linhas[i - 1]!.piora).toBeGreaterThanOrEqual(linhas[i]!.piora);
  });
  it('o que mudou: campanhas ordenadas pela maior mudança de investimento, com CPL da plataforma', async () => {
    const r = await rodar('deb-mudou');
    const linhas = r.tabela.linhas as Array<{ canal: string; campanha: string; delta: number; cpla: number | null; cplb: number | null }>;
    expect(linhas[0]!.campanha).toBe('Campanha que cresceu'); // +400
    expect(linhas[1]!.campanha).toBe('Campanha que parou'); // −400, mesma grandeza; fica logo depois
    expect(linhas[0]!.cpla).toBeCloseTo(700 / 14, 6);
    expect(linhas[0]!.cplb).toBeCloseTo(300 / 10, 6);
    expect(linhas.find((l) => l.canal === 'Google Ads')!.delta).toBe(-100);
  });
  it('o que foi pausado: parou de gastar com o status de hoje, e o que entrou; o irrelevante fica de fora', async () => {
    const r = await rodar('deb-pausados');
    const linhas = r.tabela.linhas as Array<{ situacao: string; item: string; status: string }>;
    const parou = linhas.filter((l) => l.situacao === 'Parou de gastar');
    expect(parou.map((l) => l.item)).toContain('Anúncio pausado');
    expect(parou.find((l) => l.item === 'Anúncio pausado')!.status).toBe('Pausado');
    expect(parou.some((l) => l.item.startsWith('Campanha: Google parada'))).toBe(true);
    expect(linhas.filter((l) => l.situacao === 'Novo').map((l) => l.item)).toEqual(['Anúncio novo']);
    expect(linhas.some((l) => l.item === 'Anúncio ativo')).toBe(false); // segue gastando
    expect(linhas.some((l) => l.item === 'Anúncio sem importância')).toBe(false); // R$ 15 nas duas semanas
    expect(r.avisos.join(' ')).toMatch(/pararam de gastar/);
    expect(linhas[0]!.situacao).toBe('Parou de gastar'); // os que pararam vêm primeiro
  });
  it('CPL e conversão: 8 semanas completas, da mais antiga para a mais recente', async () => {
    for (const id of ['deb-cpl', 'deb-conversao']) {
      const r = await rodar(id);
      expect(r.grafico.tipo).toBe('colunas');
      const g = r.grafico as { categorias: string[]; series: Array<{ valores: number[] }> };
      expect(g.categorias).toHaveLength(8);
      expect([...g.categorias].sort()).toEqual(g.categorias);
      expect(g.categorias.at(-1)).toBe(A.de);
      for (const s of g.series) expect(s.valores).toHaveLength(8);
      expect(r.tabela.linhas).toHaveLength(8);
    }
  });
  it('o filtro de Produto vale: QuarkClinic não consulta o Google Ads', async () => {
    const { db, consultas } = dbFalso();
    await ANALISES_DEBRIEFING.find((a) => a.id === 'deb-mudou')!.rodar(db, { de: '2020-01-01', ate: '2020-01-02', produto: 'clinic' } as never);
    expect(consultas.some((q) => q.includes('ads_campanha_dia'))).toBe(false);
    expect(consultas.some((q) => q.includes('produto = $5'))).toBe(true);
  });
});
