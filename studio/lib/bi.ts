import type pg from 'pg';

/**
 * BI do Data Hub: catálogo de análises.
 *
 * Cada análise é um bloco independente do array BI_ANALISES. Para acrescentar uma nova, basta acrescentar um bloco: o catálogo,
 * os filtros, a tela, a tabela e a exportação para CSV vêm de graça. Regras:
 *  - SÓ LEITURA, e só sobre as visões de `analytics` (nunca raw nem crm); o navegador nunca manda SQL, só escolhe a análise e os filtros;
 *  - os filtros são validados no servidor e entram no SQL sempre como parâmetros;
 *  - o período filtra a DATA DE CRIAÇÃO do negócio (fuso de São Paulo); cada análise diz o que mede;
 *  - ganho, perdido e aberto vêm do Status do negócio (D-36); MQL e "conta como lead" vêm das regras do Painel.
 */
export const BI_PRODUTOS = ['rh', 'clinic'] as const;
export type BiProduto = (typeof BI_PRODUTOS)[number];

export type BiFiltros = { de: string; ate: string; produto?: BiProduto; pipeline_id?: number };

export type Coluna = { id: string; rotulo: string; tipo: 'texto' | 'int' | 'pct' | 'brl' | 'dias' };
export type Tabela = { colunas: Coluna[]; linhas: Array<Record<string, string | number | null>> };
export type Grafico =
  | { tipo: 'kpis'; itens: Array<{ id: string; rotulo: string; valor: number | null; formato: 'int' | 'pct' | 'brl'; dica?: string }> }
  | { tipo: 'colunas'; categorias: string[]; series: Array<{ id: string; nome: string; valores: number[] }> }
  | { tipo: 'barras'; itens: Array<{ rotulo: string; valor: number; detalhe?: string }>; formato: 'int' | 'dias' | 'pct'; ordinal?: boolean }
  | { tipo: 'tabela' };
export type BiResultado = { grafico: Grafico; tabela: Tabela; avisos: string[] };

export type BiAnalise = {
  id: string;
  titulo: string;
  /** A pergunta de negócio que a análise responde, em uma frase. */
  pergunta: string;
  /** Como ler/o que mede (aparece como nota pequena sob o título). */
  como_ler: string;
  largura: 'cheia' | 'meia';
  rodar(db: Pick<pg.Pool, 'query'>, f: BiFiltros): Promise<BiResultado>;
};

type Db = Pick<pg.Pool, 'query'>;
const TZ = `'America/Sao_Paulo'`;

/** Cláusulas de filtro para uma visão com as colunas criado_em, produto e pipeline_id (alias `a`). Empurra os parâmetros. */
function filtroSql(f: BiFiltros, a: string, params: unknown[]): string[] {
  params.push(f.de, f.ate);
  const out = [
    `${a}.criado_em >= (($${params.length - 1})::date)::timestamp at time zone ${TZ}`,
    `${a}.criado_em < (($${params.length})::date + 1)::timestamp at time zone ${TZ}`,
  ];
  if (f.produto) {
    params.push(f.produto);
    out.push(`${a}.produto = $${params.length}`);
  }
  if (f.pipeline_id != null) {
    params.push(f.pipeline_id);
    out.push(`${a}.pipeline_id = $${params.length}`);
  }
  return out;
}

const n = (v: unknown): number => (v == null ? 0 : Number(v));
const razao = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** Avisa quando o histórico de etapas de algum ano do período ainda não foi todo lido (os marcos ficam incompletos). */
async function avisoHistorico(db: Db, f: BiFiltros): Promise<string[]> {
  const r = await db.query(
    `select ano_criacao, pendentes from analytics.historico_progresso where ano_criacao between $1::int and $2::int and pendentes > 0 order by ano_criacao`,
    [Number(f.de.slice(0, 4)), Number(f.ate.slice(0, 4))],
  );
  return r.rows.map((x: { ano_criacao: number; pendentes: number }) => `Histórico de etapas de ${x.ano_criacao}: ${x.pendentes} negócios ainda sem leitura; o que depende de etapas (chegou em…, tempo por etapa) está incompleto para eles.`);
}

export const BI_ANALISES: BiAnalise[] = [
  {
    id: 'visao-geral',
    titulo: 'Visão geral',
    pergunta: 'Como estão os negócios criados no período?',
    como_ler: 'Negócios criados no período e o que aconteceu com eles até hoje. Leads e MQL seguem as regras do Painel (status que contam como lead; motivos de perda que tiram do MQL). Taxa de ganho = ganhos ÷ (ganhos + perdidos), sem contar os abertos.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const r = (
        await db.query(
          `select count(*) filter (where d.conta_como_lead)::int as leads,
                  count(*) filter (where d.is_mql)::int as mql,
                  count(*) filter (where d.status = 'won')::int as ganhos,
                  count(*) filter (where d.status = 'lost')::int as perdidos,
                  count(*) filter (where d.status = 'open')::int as abertos,
                  coalesce(sum(d.valor) filter (where d.status = 'won'), 0)::float8 as valor_ganho
             from analytics.deals d where ${w.join(' and ')}`,
          p,
        )
      ).rows[0];
      const leads = n(r.leads), mql = n(r.mql), ganhos = n(r.ganhos), perdidos = n(r.perdidos), abertos = n(r.abertos);
      const itens = [
        { id: 'leads', rotulo: 'Leads', valor: leads, formato: 'int' as const, dica: 'Negócios que contam como lead' },
        { id: 'mql', rotulo: 'MQL', valor: mql, formato: 'int' as const, dica: 'Contam como lead e não foram perdidos por motivo que tira do MQL' },
        { id: 'pct_mql', rotulo: '% MQL', valor: razao(mql, leads), formato: 'pct' as const, dica: 'MQL ÷ leads' },
        { id: 'ganhos', rotulo: 'Ganhos', valor: ganhos, formato: 'int' as const, dica: 'Status ganho' },
        { id: 'taxa_ganho', rotulo: 'Taxa de ganho', valor: razao(ganhos, ganhos + perdidos), formato: 'pct' as const, dica: 'Ganhos ÷ (ganhos + perdidos)' },
        { id: 'valor_ganho', rotulo: 'Valor ganho', valor: n(r.valor_ganho), formato: 'brl' as const, dica: 'Soma do valor dos negócios ganhos' },
        { id: 'abertos', rotulo: 'Em aberto', valor: abertos, formato: 'int' as const },
        { id: 'perdidos', rotulo: 'Perdidos', valor: perdidos, formato: 'int' as const },
      ];
      return {
        grafico: { tipo: 'kpis', itens },
        tabela: { colunas: [{ id: 'indicador', rotulo: 'Indicador', tipo: 'texto' }, { id: 'valor', rotulo: 'Valor', tipo: 'texto' }], linhas: itens.map((i) => ({ indicador: i.rotulo, valor: i.valor == null ? '—' : i.formato === 'pct' ? `${(i.valor * 100).toFixed(1)}%` : i.formato === 'brl' ? `R$ ${i.valor.toFixed(2)}` : String(i.valor) })) },
        avisos: [],
      };
    },
  },
  {
    id: 'por-mes',
    titulo: 'Leads, MQL e ganhos por mês de criação',
    pergunta: 'Como a entrada de leads evolui e quanto vira ganho?',
    como_ler: 'Cada mês agrupa os negócios CRIADOS naquele mês e mostra o que aconteceu com eles até hoje (um ganho de hoje conta no mês em que o negócio nasceu). Meses recentes ainda têm negócios abertos.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = (
        await db.query(
          `select to_char(date_trunc('month', d.criado_em at time zone ${TZ}), 'YYYY-MM') as mes,
                  count(*) filter (where d.conta_como_lead)::int as leads,
                  count(*) filter (where d.is_mql)::int as mql,
                  count(*) filter (where d.status = 'won')::int as ganhos,
                  count(*) filter (where d.status = 'lost')::int as perdidos
             from analytics.deals d where ${w.join(' and ')} group by 1 order by 1`,
          p,
        )
      ).rows;
      return {
        grafico: {
          tipo: 'colunas',
          categorias: rows.map((r: { mes: string }) => r.mes),
          series: [
            { id: 'leads', nome: 'Leads', valores: rows.map((r: { leads: number }) => n(r.leads)) },
            { id: 'mql', nome: 'MQL', valores: rows.map((r: { mql: number }) => n(r.mql)) },
            { id: 'ganhos', nome: 'Ganhos', valores: rows.map((r: { ganhos: number }) => n(r.ganhos)) },
          ],
        },
        tabela: {
          colunas: [
            { id: 'mes', rotulo: 'Mês de criação', tipo: 'texto' }, { id: 'leads', rotulo: 'Leads', tipo: 'int' }, { id: 'mql', rotulo: 'MQL', tipo: 'int' },
            { id: 'ganhos', rotulo: 'Ganhos', tipo: 'int' }, { id: 'perdidos', rotulo: 'Perdidos', tipo: 'int' }, { id: 'taxa', rotulo: 'Taxa de ganho', tipo: 'pct' },
          ],
          linhas: rows.map((r: any) => ({ mes: r.mes, leads: n(r.leads), mql: n(r.mql), ganhos: n(r.ganhos), perdidos: n(r.perdidos), taxa: razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos)) })),
        },
        avisos: [],
      };
    },
  },
  {
    id: 'funil',
    titulo: 'Funil: até onde os negócios chegaram',
    pergunta: 'Quantos negócios chegam em cada marco do funil?',
    como_ler: 'Negócios criados no período. "Chegou em SQL, reunião, proposta" vem do histórico de etapas (primeira vez que passou por uma etapa marcada na Configuração do Painel de Dados); ganhos vêm do Status, nunca da etapa. Um ganho dado em Proposta conta como ganho e também como "chegou em proposta".',
    largura: 'meia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const r = (
        await db.query(
          `with base as (select d.deal_id, d.conta_como_lead, d.is_mql, d.status from analytics.deals d where ${w.join(' and ')}),
                m as (select deal_id, bool_or(marco = 'sql') as sql, bool_or(marco = 'reuniao') as reuniao, bool_or(marco = 'proposta') as proposta
                        from analytics.negocios_marcos where deal_id in (select deal_id from base) group by deal_id)
           select count(*) filter (where b.conta_como_lead)::int as leads, count(*) filter (where b.is_mql)::int as mql,
                  count(*) filter (where m.sql)::int as sql, count(*) filter (where m.reuniao)::int as reuniao, count(*) filter (where m.proposta)::int as proposta,
                  count(*) filter (where b.status = 'won')::int as ganhos
             from base b left join m on m.deal_id = b.deal_id`,
          p,
        )
      ).rows[0];
      const etapas = [
        { rotulo: 'Leads', valor: n(r.leads) }, { rotulo: 'MQL', valor: n(r.mql) }, { rotulo: 'Chegou em SQL', valor: n(r.sql) },
        { rotulo: 'Chegou em reunião', valor: n(r.reuniao) }, { rotulo: 'Chegou em proposta', valor: n(r.proposta) }, { rotulo: 'Ganhos', valor: n(r.ganhos) },
      ];
      const avisos = await avisoHistorico(db, f);
      if (n(r.sql) + n(r.reuniao) + n(r.proposta) === 0) avisos.unshift('Nenhuma etapa foi marcada como SQL, reunião ou proposta (ou ainda não há histórico lido): marque as etapas na aba Configuração do Painel de Dados.');
      const base = etapas[0]!.valor;
      return {
        grafico: { tipo: 'barras', formato: 'int', ordinal: true, itens: etapas.map((e) => ({ ...e, detalhe: base > 0 ? `${((e.valor / base) * 100).toFixed(1)}% dos leads` : undefined })) },
        tabela: { colunas: [{ id: 'etapa', rotulo: 'Marco', tipo: 'texto' }, { id: 'qtd', rotulo: 'Negócios', tipo: 'int' }, { id: 'pct', rotulo: '% dos leads', tipo: 'pct' }], linhas: etapas.map((e) => ({ etapa: e.rotulo, qtd: e.valor, pct: razao(e.valor, base) })) },
        avisos,
      };
    },
  },
  {
    id: 'motivos-perda',
    titulo: 'Principais motivos de perda',
    pergunta: 'Por que estamos perdendo negócios?',
    como_ler: 'Negócios perdidos entre os criados no período, por motivo (nome e ID). "Tira do MQL" marca os motivos que a regra do Painel exclui do MQL.',
    largura: 'meia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = (
        await db.query(
          `select coalesce(d.motivo_perda, '(sem motivo informado)') as motivo, d.motivo_perda_id as id, count(*)::int as qtd,
                  bool_or(coalesce(m.exclui_mql, false)) as tira_do_mql
             from analytics.deals d left join analytics.motivos_perda m on m.reason_id = d.motivo_perda_id
            where d.status = 'lost' and ${w.join(' and ')}
            group by 1, 2 order by qtd desc limit 12`,
          p,
        )
      ).rows;
      const total = rows.reduce((s: number, r: { qtd: number }) => s + n(r.qtd), 0);
      return {
        grafico: { tipo: 'barras', formato: 'int', itens: rows.map((r: any) => ({ rotulo: `${r.motivo}${r.id != null ? ` #${r.id}` : ''}`, valor: n(r.qtd), detalhe: `${total > 0 ? ((n(r.qtd) / total) * 100).toFixed(1) : '0'}%${r.tira_do_mql ? ' · tira do MQL' : ''}` })) },
        tabela: {
          colunas: [{ id: 'motivo', rotulo: 'Motivo', tipo: 'texto' }, { id: 'id', rotulo: 'ID', tipo: 'texto' }, { id: 'qtd', rotulo: 'Perdidos', tipo: 'int' }, { id: 'pct', rotulo: '% do mostrado', tipo: 'pct' }, { id: 'mql', rotulo: 'Tira do MQL', tipo: 'texto' }],
          linhas: rows.map((r: any) => ({ motivo: r.motivo, id: r.id == null ? null : String(r.id), qtd: n(r.qtd), pct: razao(n(r.qtd), total), mql: r.tira_do_mql ? 'sim' : 'não' })),
        },
        avisos: rows.length === 12 ? ['Mostra os 12 motivos mais frequentes.'] : [],
      };
    },
  },
  {
    id: 'origem',
    titulo: 'Leads e conversão por origem (Fonte do Lead)',
    pergunta: 'De onde vêm os leads e quais origens mais viram ganho?',
    como_ler: 'Usa o campo "Fonte do Lead" do Pipedrive (nome da opção e ID). Taxa de ganho = ganhos ÷ (ganhos + perdidos) dentro de cada origem. Origens com poucos negócios fecham poucos ganhos, então olhe a taxa junto do volume.',
    largura: 'meia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = (
        await db.query(
          `select coalesce(o.valor_legivel, o.valor::text, '(sem origem)') as origem, o.valor::text as id, count(*)::int as leads,
                  count(*) filter (where d.is_mql)::int as mql, count(*) filter (where d.status = 'won')::int as ganhos, count(*) filter (where d.status = 'lost')::int as perdidos
             from analytics.deals d
             left join lateral (select c.valor, c.valor_legivel from analytics.deal_campos c where c.deal_id = d.deal_id and c.nome_pipedrive = 'Fonte do Lead' limit 1) o on true
            where d.conta_como_lead and ${w.join(' and ')}
            group by 1, 2 order by leads desc limit 12`,
          p,
        )
      ).rows;
      return {
        grafico: { tipo: 'barras', formato: 'int', itens: rows.map((r: any) => ({ rotulo: r.origem, valor: n(r.leads), detalhe: `${n(r.ganhos)} ganhos · ${razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos)) == null ? '—' : `${(razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos))! * 100).toFixed(1)}%`}` })) },
        tabela: {
          colunas: [{ id: 'origem', rotulo: 'Origem', tipo: 'texto' }, { id: 'id', rotulo: 'ID da opção', tipo: 'texto' }, { id: 'leads', rotulo: 'Leads', tipo: 'int' }, { id: 'mql', rotulo: 'MQL', tipo: 'int' }, { id: 'ganhos', rotulo: 'Ganhos', tipo: 'int' }, { id: 'perdidos', rotulo: 'Perdidos', tipo: 'int' }, { id: 'taxa', rotulo: 'Taxa de ganho', tipo: 'pct' }],
          linhas: rows.map((r: any) => ({ origem: r.origem, id: r.id, leads: n(r.leads), mql: n(r.mql), ganhos: n(r.ganhos), perdidos: n(r.perdidos), taxa: razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos)) })),
        },
        avisos: rows.length === 12 ? ['Mostra as 12 origens com mais leads.'] : [],
      };
    },
  },
  {
    id: 'tempo-etapas',
    titulo: 'Tempo em cada etapa',
    pergunta: 'Onde os negócios ficam parados?',
    como_ler: 'Mediana de dias que os negócios criados no período ficaram em cada etapa, considerando só as passagens já concluídas (o negócio saiu da etapa). A mediana não se distorce por poucos casos muito longos. Mostra as 15 etapas com mais passagens.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'h', p);
      const rows = (
        await db.query(
          `select h.pipeline, h.etapa, pe.pipeline_ordem, pe.etapa_ordem, count(*)::int as passagens,
                  round((percentile_cont(0.5) within group (order by h.horas_na_etapa) / 24)::numeric, 1)::float8 as mediana_dias,
                  round((avg(h.horas_na_etapa) / 24)::numeric, 1)::float8 as media_dias
             from analytics.historico_etapas h join analytics.pipelines_etapas pe on pe.stage_id = h.stage_id
            where not h.etapa_atual and h.horas_na_etapa is not null and not h.is_deleted and ${w.join(' and ')}
            group by h.pipeline, h.etapa, pe.pipeline_ordem, pe.etapa_ordem
           having count(*) >= 5 order by passagens desc limit 15`,
          p,
        )
      ).rows.sort((a: any, b: any) => n(a.pipeline_ordem) - n(b.pipeline_ordem) || n(a.etapa_ordem) - n(b.etapa_ordem));
      return {
        grafico: { tipo: 'barras', formato: 'dias', itens: rows.map((r: any) => ({ rotulo: `${r.pipeline} › ${r.etapa}`, valor: n(r.mediana_dias), detalhe: `${n(r.passagens)} passagens · média ${n(r.media_dias)} d` })) },
        tabela: {
          colunas: [{ id: 'pipeline', rotulo: 'Pipeline', tipo: 'texto' }, { id: 'etapa', rotulo: 'Etapa', tipo: 'texto' }, { id: 'passagens', rotulo: 'Passagens', tipo: 'int' }, { id: 'mediana', rotulo: 'Mediana', tipo: 'dias' }, { id: 'media', rotulo: 'Média', tipo: 'dias' }],
          linhas: rows.map((r: any) => ({ pipeline: r.pipeline, etapa: r.etapa, passagens: n(r.passagens), mediana: n(r.mediana_dias), media: n(r.media_dias) })),
        },
        avisos: await avisoHistorico(db, f),
      };
    },
  },
  {
    id: 'por-responsavel',
    titulo: 'Desempenho por responsável',
    pergunta: 'Quem está fechando mais?',
    como_ler: 'Negócios criados no período, por responsável atual no Pipedrive. Compare a taxa de ganho junto do volume: quem recebe leads de qualidade diferente não é comparável só pela taxa.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = (
        await db.query(
          `select coalesce(d.responsavel, '(sem responsável)') as responsavel, d.owner_id as id, count(*) filter (where d.conta_como_lead)::int as leads,
                  count(*) filter (where d.status = 'won')::int as ganhos, count(*) filter (where d.status = 'lost')::int as perdidos, count(*) filter (where d.status = 'open')::int as abertos,
                  coalesce(sum(d.valor) filter (where d.status = 'won'), 0)::float8 as valor_ganho
             from analytics.deals d where ${w.join(' and ')}
            group by 1, 2 order by ganhos desc, leads desc limit 20`,
          p,
        )
      ).rows;
      return {
        grafico: { tipo: 'barras', formato: 'int', itens: rows.filter((r: any) => n(r.ganhos) > 0).map((r: any) => ({ rotulo: r.responsavel, valor: n(r.ganhos), detalhe: `${n(r.leads)} leads · ${razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos)) == null ? '—' : `${(razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos))! * 100).toFixed(1)}%`}` })) },
        tabela: {
          colunas: [{ id: 'responsavel', rotulo: 'Responsável', tipo: 'texto' }, { id: 'id', rotulo: 'ID', tipo: 'texto' }, { id: 'leads', rotulo: 'Leads', tipo: 'int' }, { id: 'ganhos', rotulo: 'Ganhos', tipo: 'int' }, { id: 'perdidos', rotulo: 'Perdidos', tipo: 'int' }, { id: 'abertos', rotulo: 'Abertos', tipo: 'int' }, { id: 'taxa', rotulo: 'Taxa de ganho', tipo: 'pct' }, { id: 'valor', rotulo: 'Valor ganho', tipo: 'brl' }],
          linhas: rows.map((r: any) => ({ responsavel: r.responsavel, id: r.id == null ? null : String(r.id), leads: n(r.leads), ganhos: n(r.ganhos), perdidos: n(r.perdidos), abertos: n(r.abertos), taxa: razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos)), valor: n(r.valor_ganho) })),
        },
        avisos: rows.length === 20 ? ['Mostra os 20 responsáveis com mais ganhos.'] : [],
      };
    },
  },
];

export type BiCatalogoItem = Pick<BiAnalise, 'id' | 'titulo' | 'pergunta' | 'como_ler' | 'largura'>;

export interface BiRepo {
  catalogo(): BiCatalogoItem[];
  opcoes(): Promise<{ pipelines: Array<{ pipeline_id: number; pipeline: string; produto: string | null }>; produtos: readonly string[]; primeiro_negocio: string | null }>;
  rodar(id: string, f: BiFiltros): Promise<BiResultado>;
}

export class BiNotFound extends Error {
  constructor(what: string) {
    super(`${what} não encontrada`);
    this.name = 'BiNotFound';
  }
}

export class PgBiRepo implements BiRepo {
  constructor(private readonly pool: Db) {}

  catalogo(): BiCatalogoItem[] {
    return BI_ANALISES.map(({ id, titulo, pergunta, como_ler, largura }) => ({ id, titulo, pergunta, como_ler, largura }));
  }

  async opcoes() {
    const p = await this.pool.query(`select distinct pipeline_id, pipeline, produto, pipeline_ordem from analytics.pipelines_etapas order by pipeline_ordem nulls last, pipeline_id`);
    const d = await this.pool.query(`select to_char(min(criado_em at time zone ${TZ}), 'YYYY-MM-DD') as primeiro from analytics.deals`);
    return {
      pipelines: p.rows.map((x: any) => ({ pipeline_id: Number(x.pipeline_id), pipeline: x.pipeline, produto: x.produto })),
      produtos: BI_PRODUTOS,
      primeiro_negocio: d.rows[0]?.primeiro ?? null,
    };
  }

  async rodar(id: string, f: BiFiltros): Promise<BiResultado> {
    const a = BI_ANALISES.find((x) => x.id === id);
    if (!a) throw new BiNotFound('análise');
    return a.rodar(this.pool, f);
  }
}
