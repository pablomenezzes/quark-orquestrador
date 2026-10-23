/**
 * Página "Debriefing semanal" do BI (pedido do Pablo, 2026-10-23): o que mudou, o que foi pausado, o que caiu, e o resumo de CPL e das taxas de conversão.
 * A semana de referência é SEMPRE a última semana completa (segunda a domingo, fuso America/Fortaleza), comparada com a semana anterior: o filtro de
 * período do BI não vale aqui (Produto vale). Os números por canal vêm do mesmo cálculo do Monitor (studio/lib/monitor.ts); campanhas e anúncios
 * vêm das visões da Meta e do Google Ads. Só leitura.
 */
import type pg from 'pg';
import type { BiAnalise, BiFiltros, BiResultado, Coluna } from './bi.js';
import {
  agoraLocal, BOM_SE_SOBE, CANAIS, lerDadosMonitor, metricasDe, semanasCompletas, somaDias,
  type CanalId, type DadosMonitor, type Janela, type Metricas,
} from './monitor.js';

type Db = Pick<pg.Pool, 'query'>;
type Row = Record<string, any>;
const n = (v: unknown) => (v == null ? 0 : Number(v));
const col = (id: string, rotulo: string, tipo: Coluna['tipo'] = 'texto'): Coluna => ({ id, rotulo, tipo });
const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const nomeSemana = (j: Janela) => `${dm(j.de)} a ${dm(j.ate)}`;

type Fmt = 'int' | 'pct' | 'brl' | 'brl2';
const nf0 = new Intl.NumberFormat('pt-BR');
const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtv = (f: Fmt, v: number | null): string => (v == null ? '—' : f === 'int' ? nf0.format(Math.round(v)) : f === 'pct' ? `${nf2.format(v * 100)}%` : f === 'brl' ? `R$ ${nf0.format(Math.round(v))}` : `R$ ${nf2.format(v)}`);
const variacao = (a: number | null, b: number | null): number | null => (a == null || b == null || b === 0 ? null : a / b - 1);
const sinal = (p: number | null) => (p == null ? '—' : `${p > 0 ? '▲' : p < 0 ? '▼' : '='} ${nf1.format(Math.abs(p) * 100)}%`);

/* ---------- dados da semana (um carregamento compartilhado entre as análises da página) ---------- */
interface Ctx { hoje: string; semanas: Janela[]; dados: DadosMonitor; A: Janela; B: Janela }
const caches = new WeakMap<object, Map<string, { t: number; p: Promise<Ctx> }>>();
const TTL_MS = 120_000;
function contexto(db: Db, f: BiFiltros): Promise<Ctx> {
  const produto = f.produto === 'rh' || f.produto === 'clinic' ? f.produto : undefined;
  const { hoje, hora } = agoraLocal();
  const semanas = semanasCompletas(hoje, 8);
  const carregar = (): Promise<Ctx> => lerDadosMonitor(db, hoje, hora, produto, semanas.at(-1)!.de).then((dados) => ({ hoje, semanas, dados, A: semanas[0]!, B: semanas[1]! }));
  // só o pool real guarda em cache (as 6 análises da página pedem ao mesmo tempo); conexões avulsas, como as dos testes, sempre releem
  if (!('totalCount' in db)) return carregar();
  let m = caches.get(db);
  if (!m) caches.set(db, (m = new Map()));
  const k = `${produto ?? ''}|${hoje}`;
  const c = m.get(k);
  if (c && Date.now() - c.t < TTL_MS) return c.p;
  const p = carregar();
  m.set(k, { t: Date.now(), p });
  p.catch(() => m!.delete(k));
  return p;
}
const AVISO_PERIODO = (c: Ctx) => `Semana de referência: ${nomeSemana(c.A)} (última semana completa), contra ${nomeSemana(c.B)}. O filtro de período não vale nesta página; o de Produto vale.`;

/* ---------- indicadores comparáveis ---------- */
interface Ind { id: keyof Metricas; rot: string; f: Fmt; contagem?: number }
/** `contagem`: menor valor da semana anterior para a queda valer como sinal (poucos casos oscilam demais). */
const INDICADORES: Ind[] = [
  { id: 'invest', rot: 'Investimento', f: 'brl' },
  { id: 'leads', rot: 'Leads', f: 'int', contagem: 5 },
  { id: 'mql', rot: 'MQL', f: 'int', contagem: 5 },
  { id: 'pctMql', rot: '% MQL', f: 'pct' },
  { id: 'reunioes', rot: 'Reuniões Agendadas', f: 'int', contagem: 3 },
  { id: 'ganhos', rot: 'Ganhos', f: 'int', contagem: 2 },
  { id: 'mrr', rot: 'MRR novo', f: 'brl', contagem: 500 },
  { id: 'impressoes', rot: 'Impressões', f: 'int' },
  { id: 'trafego', rot: 'Cliques e visitas', f: 'int' },
  { id: 'ctr', rot: 'CTR', f: 'pct' },
  { id: 'txLead', rot: 'Taxa clique ou visita → lead', f: 'pct' },
  { id: 'cpm', rot: 'CPM', f: 'brl2' },
  { id: 'cpc', rot: 'CPC', f: 'brl2' },
  { id: 'cpl', rot: 'CPL', f: 'brl2' },
  { id: 'cac', rot: 'CAC de mídia', f: 'brl2' },
];
const NOME_QUEM: Record<string, string> = { total: 'Total dos 4 canais', pagos: 'Mídia paga (Google + Meta)', ...Object.fromEntries(CANAIS.map((c) => [c.id, c.nome])) };

/* ---------- 1. Resumo ---------- */
const resumo: BiAnalise = {
  id: 'deb-resumo',
  pagina: 'debriefing',
  titulo: 'Debriefing: a semana em números',
  pergunta: 'Como foi a última semana completa contra a anterior: investimento, leads, CPL, taxas de conversão e resultado?',
  como_ler: 'Cada número é a última semana completa (segunda a domingo) e, na dica, a semana anterior e a variação. Leads e MQL pela data de criação; Reuniões Agendadas pela entrada na etapa; ganhos e MRR novo pela data do fechamento (fluxo). CPL e CAC de mídia = investimento ÷ leads (ou ganhos) dos canais PAGOS, sem Social e Orgânico. A "taxa clique → lead" é de mídia paga (leads ÷ cliques no link); "% MQL" é MQL ÷ leads da semana; "Reunião Agendada ÷ MQL" compara fluxos da mesma semana (não é safra). Semanas recentes ainda amadurecem: o que virou Reunião Agendada ou ganho depois do domingo não está aqui.',
  largura: 'cheia',
  async rodar(db, f): Promise<BiResultado> {
    const c = await contexto(db, f);
    const a = metricasDe(c.dados, 'total', c.A);
    const b = metricasDe(c.dados, 'total', c.B);
    const pa = metricasDe(c.dados, 'pagos', c.A);
    const pb = metricasDe(c.dados, 'pagos', c.B);
    const reuniaoMql = (m: Metricas) => (m.mql > 0 ? m.reunioes / m.mql : null);
    // [id, rótulo, valor atual, valor anterior, formato, melhor se sobe (null = neutro), dica]
    const L: Array<[string, string, number | null, number | null, Fmt, boolean | null, string?]> = [
      ['invest', 'Investimento', a.invest, b.invest, 'brl', null, 'Meta Ads + Google Ads'],
      ['leads', 'Leads', a.leads, b.leads, 'int', true],
      ['cpl', 'CPL de mídia paga', a.cpl, b.cpl, 'brl2', false, 'Investimento ÷ leads de Google e Meta'],
      ['txLead', 'Taxa clique → lead (mídia paga)', pa.txLead, pb.txLead, 'pct', true, 'Leads ÷ cliques no link'],
      ['pctMql', '% MQL', a.pctMql, b.pctMql, 'pct', true, 'MQL ÷ leads da semana'],
      ['reuniaoMql', 'Reunião Agendada ÷ MQL (fluxo)', reuniaoMql(a), reuniaoMql(b), 'pct', true, 'Reuniões Agendadas na semana ÷ MQL da semana'],
      ['reunioes', 'Reuniões Agendadas', a.reunioes, b.reunioes, 'int', true],
      ['ganhos', 'Ganhos', a.ganhos, b.ganhos, 'int', true],
      ['mrr', 'MRR novo', a.mrr, b.mrr, 'brl', true],
      ['cac', 'CAC de mídia', a.cac, b.cac, 'brl2', false, 'Investimento ÷ ganhos de Google e Meta'],
    ];
    const itens = L.map(([id, rotulo, va, vb, formato, , dica]) => ({
      id, rotulo, valor: va, formato: formato === 'pct' ? ('pct' as const) : formato, dica: `${dica ? `${dica} · ` : ''}semana anterior: ${fmtv(formato, vb)} · ${sinal(variacao(va, vb))}`,
    }));
    const linhas = L.map(([, rotulo, va, vb, formato]) => ({ indicador: rotulo, anterior: fmtv(formato, vb), semana: fmtv(formato, va), variacao: variacao(va, vb) }));
    return {
      grafico: { tipo: 'kpis', itens },
      tabela: { colunas: [col('indicador', 'Indicador'), col('anterior', `Semana anterior (${nomeSemana(c.B)})`), col('semana', `Semana (${nomeSemana(c.A)})`), col('variacao', 'Variação', 'pct')], linhas },
      avisos: [AVISO_PERIODO(c)],
    };
  },
};

/* ---------- 2. O que caiu ---------- */
const quedas: BiAnalise = {
  id: 'deb-quedas',
  pagina: 'debriefing',
  titulo: 'Debriefing: o que caiu',
  pergunta: 'Que indicadores pioraram mais de 10% contra a semana anterior, no total e em cada canal?',
  como_ler: 'Só entram indicadores que PIORARAM mais de 10%: queda do que é bom subir (leads, MQL, reuniões, ganhos, MRR, CTR, taxas) e alta do que é bom descer (CPL, CPC, CPM, CAC). Contagens pequenas ficam de fora (menos de 5 leads ou MQL, 3 reuniões, 2 ganhos ou R$ 500 de MRR na semana anterior), porque oscilam sem querer dizer nada. Investimento sozinho não é bom nem ruim e não aparece. Ordenado da pior piora para a menor.',
  largura: 'cheia',
  async rodar(db, f): Promise<BiResultado> {
    const c = await contexto(db, f);
    const quem: Array<CanalId | 'total'> = ['total', ...CANAIS.map((x) => x.id)];
    const achados: Array<{ quem: string; ind: Ind; ant: number; atual: number; piora: number; variacao: number }> = [];
    for (const q of quem) {
      const a = metricasDe(c.dados, q, c.A);
      const b = metricasDe(c.dados, q, c.B);
      for (const ind of INDICADORES) {
        const bom = BOM_SE_SOBE[ind.id];
        if (bom == null) continue; // investimento e impressões: neutros
        const va = a[ind.id] as number | null;
        const vb = b[ind.id] as number | null;
        if (va == null || vb == null || vb === 0) continue;
        if (ind.contagem != null && vb < ind.contagem) continue;
        const v = va / vb - 1;
        const piora = bom ? -v : v;
        if (piora >= 0.1) achados.push({ quem: NOME_QUEM[q]!, ind, ant: vb, atual: va, piora, variacao: v });
      }
    }
    achados.sort((x, y) => y.piora - x.piora);
    return {
      grafico: { tipo: 'barras', formato: 'pct', itens: achados.slice(0, 12).map((x) => ({ rotulo: `${x.quem} · ${x.ind.rot}`, valor: x.piora, detalhe: `${fmtv(x.ind.f, x.ant)} → ${fmtv(x.ind.f, x.atual)}` })) },
      tabela: {
        colunas: [col('quem', 'Canal'), col('indicador', 'Indicador'), col('anterior', 'Semana anterior'), col('semana', 'Semana'), col('variacao', 'Variação', 'pct'), col('piora', 'Piora', 'pct')],
        linhas: achados.map((x) => ({ quem: x.quem, indicador: x.ind.rot, anterior: fmtv(x.ind.f, x.ant), semana: fmtv(x.ind.f, x.atual), variacao: x.variacao, piora: x.piora })),
      },
      avisos: [AVISO_PERIODO(c), ...(achados.length ? [] : ['Nenhum indicador piorou mais de 10% contra a semana anterior.'])],
    };
  },
};

/* ---------- 3. O que mudou: campanhas ---------- */
const mudou: BiAnalise = {
  id: 'deb-mudou',
  pagina: 'debriefing',
  titulo: 'Debriefing: o que mudou nas campanhas',
  pergunta: 'Que campanhas de mídia paga mudaram o investimento, os leads e o custo por lead contra a semana anterior?',
  como_ler: 'Campanhas do Meta Ads e do Google Ads, ordenadas pela maior mudança de investimento (em reais). No Meta, "Leads (Meta)" são os leads que a plataforma atribui à campanha e o CPL é investimento ÷ esses leads; é uma leitura da plataforma e pode diferir dos leads do Pipedrive. No Google Ads mostramos investimento e cliques (o CPC), porque o lead não vem por campanha. O gráfico mostra o investimento da semana de referência das 10 campanhas que mais mudaram, com a variação na dica.',
  largura: 'cheia',
  async rodar(db, f): Promise<BiResultado> {
    const c = await contexto(db, f);
    const p = [c.B.de, c.B.ate, c.A.de, c.A.ate];
    const prod = f.produto === 'rh' || f.produto === 'clinic' ? f.produto : null;
    const [meta, google] = await Promise.all([
      db.query(
        `select campanha_id::text as id, max(campanha) as campanha,
                coalesce(sum(gasto) filter (where dia between $3::date and $4::date), 0)::float8 as ga, coalesce(sum(gasto) filter (where dia between $1::date and $2::date), 0)::float8 as gb,
                coalesce(sum(leads_meta) filter (where dia between $3::date and $4::date), 0)::float8 as la, coalesce(sum(leads_meta) filter (where dia between $1::date and $2::date), 0)::float8 as lb
           from analytics.meta_desempenho_dia where dia between $1::date and $4::date${prod ? ' and produto = $5' : ''} group by 1 having sum(gasto) > 0`,
        prod ? [...p, prod] : p,
      ),
      prod === 'clinic'
        ? Promise.resolve({ rows: [] as Row[] })
        : db.query(
            `select campaign_id::text as id, max(campanha) as campanha,
                    coalesce(sum(custo) filter (where dia between $3::date and $4::date), 0)::float8 as ga, coalesce(sum(custo) filter (where dia between $1::date and $2::date), 0)::float8 as gb,
                    coalesce(sum(cliques) filter (where dia between $3::date and $4::date), 0)::float8 as ca, coalesce(sum(cliques) filter (where dia between $1::date and $2::date), 0)::float8 as cb
               from analytics.ads_campanha_dia where dia between $1::date and $4::date group by 1 having sum(custo) > 0`,
            p,
          ),
    ]);
    type L = { canal: string; campanha: string; gb: number; ga: number; delta: number; pct: number | null; lb: number | null; la: number | null; cplb: number | null; cpla: number | null; cpcb: number | null; cpca: number | null };
    const linhas: L[] = [
      ...meta.rows.map((r: Row): L => ({ canal: 'Meta Ads', campanha: r.campanha ?? `#${r.id}`, gb: n(r.gb), ga: n(r.ga), delta: n(r.ga) - n(r.gb), pct: variacao(n(r.ga), n(r.gb)), lb: n(r.lb), la: n(r.la), cplb: n(r.lb) > 0 ? n(r.gb) / n(r.lb) : null, cpla: n(r.la) > 0 ? n(r.ga) / n(r.la) : null, cpcb: null, cpca: null })),
      ...google.rows.map((r: Row): L => ({ canal: 'Google Ads', campanha: r.campanha || `#${r.id}`, gb: n(r.gb), ga: n(r.ga), delta: n(r.ga) - n(r.gb), pct: variacao(n(r.ga), n(r.gb)), lb: null, la: null, cplb: null, cpla: null, cpcb: n(r.cb) > 0 ? n(r.gb) / n(r.cb) : null, cpca: n(r.ca) > 0 ? n(r.ga) / n(r.ca) : null })),
    ].sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, 30);
    return {
      grafico: { tipo: 'barras', formato: 'brl', itens: linhas.slice(0, 10).map((l) => ({ rotulo: `${l.canal} · ${l.campanha}`, valor: l.ga, detalhe: `${l.delta >= 0 ? '+' : '−'}R$ ${nf0.format(Math.round(Math.abs(l.delta)))} contra a semana anterior (${fmtv('brl', l.gb)} → ${fmtv('brl', l.ga)})` })) },
      tabela: {
        colunas: [col('canal', 'Canal'), col('campanha', 'Campanha'), col('gb', 'Investimento anterior', 'brl'), col('ga', 'Investimento semana', 'brl'), col('delta', 'Mudança (R$)', 'brl'), col('pct', 'Mudança', 'pct'),
          col('lb', 'Leads (Meta) anterior', 'int'), col('la', 'Leads (Meta) semana', 'int'), col('cplb', 'CPL (Meta) anterior', 'brl2'), col('cpla', 'CPL (Meta) semana', 'brl2'), col('cpcb', 'CPC (Google) anterior', 'brl2'), col('cpca', 'CPC (Google) semana', 'brl2')],
        linhas: linhas.map((l) => ({ ...l })),
      },
      avisos: [AVISO_PERIODO(c), ...(linhas.length ? [] : ['Nenhuma campanha com investimento nas duas semanas.'])],
    };
  },
};

/* ---------- 4. O que foi pausado e o que entrou ---------- */
const STATUS_ROTULO: Record<string, string> = { ACTIVE: 'Ativo', PAUSED: 'Pausado', CAMPAIGN_PAUSED: 'Campanha pausada', ADSET_PAUSED: 'Conjunto pausado', ARCHIVED: 'Arquivado', DISAPPROVED: 'Reprovado', WITH_ISSUES: 'Com problemas', ENABLED: 'Ativa' };
const pausados: BiAnalise = {
  id: 'deb-pausados',
  pagina: 'debriefing',
  titulo: 'Debriefing: o que foi pausado e o que entrou',
  pergunta: 'Que anúncios e campanhas pararam de gastar na semana (e qual o status hoje), e quais entraram?',
  como_ler: 'Parou de gastar = teve gasto até o começo da semana de referência (ou depois) e não gasta há 2 dias ou mais; o status é o de hoje na plataforma (pausado, conjunto ou campanha pausada, arquivado, reprovado...). Novo = o primeiro dia com gasto é dentro da semana de referência ou depois. Valores abaixo de R$ 30 somados nas duas semanas ficam de fora. Meta Ads por anúncio; Google Ads por campanha. O gráfico mostra o gasto das duas semanas dos itens que pararam (os maiores primeiro).',
  largura: 'cheia',
  async rodar(db, f): Promise<BiResultado> {
    const c = await contexto(db, f);
    const prod = f.produto === 'rh' || f.produto === 'clinic' ? f.produto : null;
    const [meta, google] = await Promise.all([
      db.query(
        `with s as (
           select m.anuncio_id::text as id, max(m.anuncio) as anuncio, max(m.campanha) as campanha,
                  to_char(min(m.dia) filter (where m.gasto > 0), 'YYYY-MM-DD') as primeiro, to_char(max(m.dia) filter (where m.gasto > 0), 'YYYY-MM-DD') as ultimo,
                  coalesce(sum(m.gasto) filter (where m.dia between $1::date and $2::date), 0)::float8 as ga, coalesce(sum(m.gasto) filter (where m.dia between $3::date and $4::date), 0)::float8 as gb,
                  coalesce(sum(m.leads_meta) filter (where m.dia between $1::date and $2::date), 0)::float8 as la
             from analytics.meta_desempenho_dia m${prod ? ' where m.produto = $5' : ''} group by m.anuncio_id)
         select s.*, a.status from s left join analytics.meta_anuncios a on a.anuncio_id::text = s.id where s.ultimo is not null`,
        prod ? [c.A.de, c.A.ate, c.B.de, c.B.ate, prod] : [c.A.de, c.A.ate, c.B.de, c.B.ate],
      ),
      prod === 'clinic'
        ? Promise.resolve({ rows: [] as Row[] })
        : db.query(
            `select campaign_id::text as id, max(campanha) as campanha, max(status) as status,
                    to_char(min(dia) filter (where custo > 0), 'YYYY-MM-DD') as primeiro, to_char(max(dia) filter (where custo > 0), 'YYYY-MM-DD') as ultimo,
                    coalesce(sum(custo) filter (where dia between $1::date and $2::date), 0)::float8 as ga, coalesce(sum(custo) filter (where dia between $3::date and $4::date), 0)::float8 as gb
               from analytics.ads_campanha_dia group by 1 having max(dia) filter (where custo > 0) is not null`,
            [c.A.de, c.A.ate, c.B.de, c.B.ate],
          ),
    ]);
    const inicioParou = somaDias(c.A.de, -1); // gastava até o dia antes da semana de referência ou depois
    const fimParou = somaDias(c.hoje, -2); // e não gasta há 2 dias ou mais (o dado de hoje ainda está chegando)
    type L = { situacao: string; item: string; campanha: string; status: string; ultimo: string; gb: number; ga: number; leads: number | null };
    const todos: L[] = [
      ...meta.rows.map((r: Row): L & { primeiro: string } => ({ situacao: '', item: r.anuncio ?? `#${r.id}`, campanha: `Meta Ads · ${r.campanha ?? ''}`, status: STATUS_ROTULO[r.status] ?? r.status ?? '—', ultimo: r.ultimo, primeiro: r.primeiro, gb: n(r.gb), ga: n(r.ga), leads: n(r.la) })),
      ...google.rows.map((r: Row): L & { primeiro: string } => ({ situacao: '', item: `Campanha: ${r.campanha || `#${r.id}`}`, campanha: 'Google Ads', status: STATUS_ROTULO[r.status] ?? r.status ?? '—', ultimo: r.ultimo, primeiro: r.primeiro, gb: n(r.gb), ga: n(r.ga), leads: null })),
    ] as Array<L & { primeiro: string }>;
    const classificados: L[] = [];
    for (const x of todos as Array<L & { primeiro: string }>) {
      if (x.ga + x.gb < 30) continue;
      if (x.ultimo >= inicioParou && x.ultimo <= fimParou) classificados.push({ ...x, situacao: 'Parou de gastar' });
      else if (x.primeiro >= c.A.de) classificados.push({ ...x, situacao: 'Novo' });
    }
    classificados.sort((x, y) => (x.situacao === y.situacao ? y.ga + y.gb - (x.ga + x.gb) : x.situacao === 'Parou de gastar' ? -1 : 1));
    const pararam = classificados.filter((x) => x.situacao === 'Parou de gastar');
    const novos = classificados.filter((x) => x.situacao === 'Novo');
    return {
      grafico: { tipo: 'barras', formato: 'brl', itens: pararam.slice(0, 12).map((x) => ({ rotulo: `${x.campanha === 'Google Ads' ? 'Google Ads' : 'Meta'} · ${x.item}`, valor: x.ga + x.gb, detalhe: `${x.status} · último gasto em ${dm(x.ultimo)} · semana anterior ${fmtv('brl', x.gb)}, semana ${fmtv('brl', x.ga)}` })) },
      tabela: {
        colunas: [col('situacao', 'Situação'), col('item', 'Anúncio ou campanha'), col('campanha', 'Campanha'), col('status', 'Status hoje'), col('ultimo', 'Último dia com gasto'), col('gb', 'Gasto semana anterior', 'brl'), col('ga', 'Gasto semana', 'brl'), col('leads', 'Leads (Meta) na semana', 'int')],
        linhas: classificados.slice(0, 60).map((x) => ({ ...x, ultimo: dm(x.ultimo) })),
      },
      avisos: [
        AVISO_PERIODO(c),
        `${pararam.length} item(ns) pararam de gastar (${fmtv('brl', pararam.reduce((s, x) => s + x.gb, 0))} gastos na semana anterior) e ${novos.length} entraram (${fmtv('brl', novos.reduce((s, x) => s + x.ga, 0))} gastos na semana).`,
      ],
    };
  },
};

/* ---------- 5 e 6. CPL e conversão: as 8 últimas semanas ---------- */
const cplSemanas: BiAnalise = {
  id: 'deb-cpl',
  pagina: 'debriefing',
  titulo: 'Debriefing: CPL semana a semana',
  pergunta: 'O custo por lead está subindo ou caindo, na mídia paga e em cada plataforma, nas últimas 8 semanas?',
  como_ler: 'CPL = investimento ÷ leads (do Pipedrive, por data de criação) de cada plataforma; "Mídia paga" soma Google Ads e Meta Ads. Semanas completas (segunda a domingo). O Google Ads usa o custo do GA4, que chega com cerca de 1 dia de atraso.',
  largura: 'cheia',
  async rodar(db, f): Promise<BiResultado> {
    const c = await contexto(db, f);
    const semanas = [...c.semanas].reverse(); // da mais antiga para a mais recente
    const por = (q: CanalId | 'pagos') => semanas.map((j) => metricasDe(c.dados, q, j));
    const pagos = por('pagos'); const meta = por('meta'); const google = por('google');
    const v = (m: Metricas) => m.cpl ?? 0;
    return {
      grafico: {
        tipo: 'colunas', categorias: semanas.map((j) => j.de), formato: 'brl',
        series: [{ id: 'pagos', nome: 'Mídia paga', slot: 0, valores: pagos.map(v) }, { id: 'meta', nome: 'Meta Ads', slot: 2, valores: meta.map(v) }, { id: 'google', nome: 'Google Ads', slot: 1, valores: google.map(v) }],
      },
      tabela: {
        colunas: [col('semana', 'Semana'), col('invest', 'Investimento', 'brl'), col('leads', 'Leads (mídia paga)', 'int'), col('cpl', 'CPL mídia paga', 'brl2'), col('cplMeta', 'CPL Meta', 'brl2'), col('cplGoogle', 'CPL Google', 'brl2')],
        linhas: semanas.map((j, i) => ({ semana: nomeSemana(j), invest: pagos[i]!.invest, leads: pagos[i]!.leads, cpl: pagos[i]!.cpl, cplMeta: meta[i]!.cpl, cplGoogle: google[i]!.cpl })),
      },
      avisos: [AVISO_PERIODO(c), 'O gráfico mostra semanas sem CPL (sem gasto ou sem leads) como zero; a tabela traz em branco.'],
    };
  },
};
const conversaoSemanas: BiAnalise = {
  id: 'deb-conversao',
  pagina: 'debriefing',
  titulo: 'Debriefing: taxas de conversão semana a semana',
  pergunta: 'As taxas de conversão do funil (clique até lead, lead até MQL, MQL até Reunião Agendada) estão melhorando ou piorando?',
  como_ler: '"Clique → lead" é de mídia paga (leads do Pipedrive ÷ cliques no link de Google Ads e Meta Ads). "% MQL" é MQL ÷ leads criados na semana. "Reunião Agendada ÷ MQL" compara os fluxos da mesma semana (Reuniões Agendadas ÷ MQL criados), então uma semana pode passar de 100% quando reuniões de leads antigos entram: leia a tendência, não o valor absoluto. Os últimos dias têm % MQL inflado: lead aberto conta como MQL até ser desqualificado.',
  largura: 'cheia',
  async rodar(db, f): Promise<BiResultado> {
    const c = await contexto(db, f);
    const semanas = [...c.semanas].reverse();
    const tot = semanas.map((j) => metricasDe(c.dados, 'total', j));
    const pagos = semanas.map((j) => metricasDe(c.dados, 'pagos', j));
    const rm = (m: Metricas) => (m.mql > 0 ? m.reunioes / m.mql : null);
    return {
      grafico: {
        tipo: 'colunas', categorias: semanas.map((j) => j.de), formato: 'pct',
        series: [
          { id: 'clique', nome: 'Clique → lead (mídia paga)', slot: 1, valores: pagos.map((m) => m.txLead ?? 0) },
          { id: 'mql', nome: '% MQL', slot: 2, valores: tot.map((m) => m.pctMql ?? 0) },
          { id: 'reuniao', nome: 'Reunião Agendada ÷ MQL (fluxo)', slot: 3, valores: tot.map((m) => rm(m) ?? 0) },
        ],
      },
      tabela: {
        colunas: [col('semana', 'Semana'), col('cliques', 'Cliques (mídia paga)', 'int'), col('leads', 'Leads', 'int'), col('clique', 'Clique → lead', 'pct'), col('mql', 'MQL', 'int'), col('pctMql', '% MQL', 'pct'), col('reunioes', 'Reuniões Agendadas', 'int'), col('reuniaoMql', 'Reunião Agendada ÷ MQL', 'pct')],
        linhas: semanas.map((j, i) => ({ semana: nomeSemana(j), cliques: pagos[i]!.cliques, leads: tot[i]!.leads, clique: pagos[i]!.txLead, mql: tot[i]!.mql, pctMql: tot[i]!.pctMql, reunioes: tot[i]!.reunioes, reuniaoMql: rm(tot[i]!) })),
      },
      avisos: [AVISO_PERIODO(c)],
    };
  },
};

/** A ordem é a da página: resumo, o que caiu, o que mudou, o que foi pausado, CPL e conversão. */
export const ANALISES_DEBRIEFING: BiAnalise[] = [resumo, quedas, mudou, pausados, cplSemanas, conversaoSemanas];
