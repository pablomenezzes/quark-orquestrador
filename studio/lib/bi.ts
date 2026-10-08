import type pg from 'pg';

/**
 * BI do Data Hub: catálogo de análises, organizado em páginas (Visão geral, Safra, Canais, Qualidade).
 *
 * Cada análise é um bloco independente do array BI_ANALISES. Para acrescentar uma nova, basta acrescentar um bloco: o catálogo,
 * os filtros, a tela, a tabela e a exportação para CSV vêm de graça. Regras:
 *  - SÓ LEITURA, e só sobre as visões de `analytics` (nunca raw nem crm); o navegador nunca manda SQL, só escolhe a análise e os filtros;
 *  - os filtros são validados no servidor e entram no SQL sempre como parâmetros;
 *  - o período filtra a DATA DE CRIAÇÃO do negócio (fuso de São Paulo); cada análise diz o que mede;
 *  - ganho, perdido e aberto vêm do Status do negócio (D-36); MQL e "conta como lead" vêm das regras do Painel;
 *  - "inválido" = lead perdido por um motivo que a regra do Painel tira do MQL (hoje: Lead Invalido, Cliente em Busca de Suporte,
 *    Contato Inexistente, Oportunidade Duplicada); "em branco" = campo do Pipedrive não preenchido.
 */
export const BI_PRODUTOS = ['rh', 'clinic'] as const;
export type BiProduto = (typeof BI_PRODUTOS)[number];

/** Seleção inicial ("fixada") dos filtros de Fonte e Tipo do Lead, pelo NOME da opção no Pipedrive. Edite aqui para mudar o padrão. */
export const PADRAO_FONTES = ['Marketing [Google ADS]', 'Marketing [Meta ADS]', 'Marketing [Orgânico]', 'Marketing [Social]'];
export const PADRAO_TIPOS = ['Marketing'];

export const BI_PAGINAS = [
  { id: 'geral', rotulo: 'Visão geral' },
  { id: 'safra', rotulo: 'Safra' },
  { id: 'canais', rotulo: 'Canais' },
  { id: 'qualidade', rotulo: 'Qualidade' },
] as const;
export type BiPagina = (typeof BI_PAGINAS)[number]['id'];

/** `fontes` e `tipos`: IDs das opções do Pipedrive (texto de dígitos) e/ou 'branco' (campo não preenchido). Ausente = sem filtro. */
export type BiFiltros = { de: string; ate: string; produto?: BiProduto; pipeline_id?: number; fontes?: string[]; tipos?: string[] };

export type Coluna = { id: string; rotulo: string; tipo: 'texto' | 'int' | 'pct' | 'brl' | 'dias' };
export type Tabela = { colunas: Coluna[]; linhas: Array<Record<string, string | number | null>> };
export type Grafico =
  | { tipo: 'kpis'; itens: Array<{ id: string; rotulo: string; valor: number | null; formato: 'int' | 'pct' | 'brl'; dica?: string }> }
  /** `slot`: cor fixa da série (1 a 4 = paleta categórica; 0 = neutro, para "outras"). A cor segue a entidade, nunca a posição. */
  | { tipo: 'colunas'; categorias: string[]; series: Array<{ id: string; nome: string; slot: number; valores: number[] }>; formato?: 'int' | 'pct' }
  | { tipo: 'barras'; itens: Array<{ rotulo: string; valor: number; detalhe?: string }>; formato: 'int' | 'dias' | 'pct'; ordinal?: boolean }
  /** Mapa de calor. `escala`: a cor é relativa ao maior valor de cada coluna ('coluna'), de cada linha ('linha') ou da matriz toda ('global', padrão). */
  | { tipo: 'matriz'; colunas: string[]; linhas: Array<{ rotulo: string; valores: Array<number | null>; detalhe?: string }>; formato: 'pct'; escala?: 'coluna' | 'linha' | 'global' }
  /**
   * Funis lado a lado: uma coluna por fonte (ou "Total"), as mesmas etapas em todas. `valores[i]` = negócios que chegaram na etapa i;
   * `passos[i]` = dos que chegaram na etapa i-1, que parte chegou na i (nunca passa de 100%; null onde não há base).
   */
  | { tipo: 'funis'; etapas: string[]; colunas: Array<{ id: string; nome: string; slot: number; total?: boolean; leads: number; valores: number[]; passos: Array<number | null> }> }
  | { tipo: 'tabela' };
export type BiResultado = { grafico: Grafico; tabela: Tabela; avisos: string[] };

export type BiAnalise = {
  id: string;
  pagina: BiPagina;
  titulo: string;
  /** A pergunta de negócio que a análise responde, em uma frase. */
  pergunta: string;
  /** Como ler/o que mede (aparece em "Como ler"). */
  como_ler: string;
  largura: 'cheia' | 'meia';
  rodar(db: Pick<pg.Pool, 'query'>, f: BiFiltros): Promise<BiResultado>;
};

type Db = Pick<pg.Pool, 'query'>;
type Row = Record<string, any>;
const TZ = `'America/Sao_Paulo'`;
/** Valores que dizem "não sei": "Desconhecido"/"Unknown" no Canal de origem RD; no UTM Source, modelos de link não preenchidos ({{...}}), undefined, unknown, null. */
const CANAL_DESCONHECIDO = `'(desconhec|unknown)'`;
const UTM_INVALIDO = `'^(\\{\\{.*\\}\\}|undefined|unknown|null)$'`;

/** Nome da fonte; opção que o Pipedrive não oferece mais aparece pelo ID; em branco = "(sem fonte)". */
const FONTE = `coalesce(d.fonte, d.fonte_id, '(sem fonte)')`;

/** `(col = any($n) or col is null)` conforme a lista tenha IDs e/ou 'branco'. */
function listaSql(col: string, vals: string[], params: unknown[]): string {
  const ids = vals.filter((v) => v !== 'branco');
  const partes: string[] = [];
  if (ids.length) {
    params.push(ids);
    partes.push(`${col} = any($${params.length}::text[])`);
  }
  if (vals.includes('branco')) partes.push(`${col} is null`);
  return `(${partes.join(' or ')})`;
}

/** Cláusulas de filtro para a visão analytics.negocios_bi (alias `a`; também serve o alias `d`). Empurra os parâmetros. */
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
  if (f.fontes?.length) out.push(listaSql(`${a}.fonte_id`, f.fontes, params));
  if (f.tipos?.length) out.push(listaSql(`${a}.tipo_id`, f.tipos, params));
  return out;
}

const n = (v: unknown): number => (v == null ? 0 : Number(v));
const razao = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const c = (id: string, rotulo: string, tipo: Coluna['tipo'] = 'texto'): Coluna => ({ id, rotulo, tipo });
const q = async (db: Db, sql: string, params: unknown[]): Promise<Row[]> => (await db.query(sql, params)).rows;

/** Avisa quando o histórico de etapas de algum ano do período ainda não foi todo lido (os marcos ficam incompletos). */
async function avisoHistorico(db: Db, f: BiFiltros): Promise<string[]> {
  const r = await q(db, `select ano_criacao, pendentes from analytics.historico_progresso where ano_criacao between $1::int and $2::int and pendentes > 0 order by ano_criacao`, [Number(f.de.slice(0, 4)), Number(f.ate.slice(0, 4))]);
  return r.map((x) => `Histórico de etapas de ${x.ano_criacao}: ${x.pendentes} negócios ainda sem leitura; o que depende de etapas (chegou em…, tempo por etapa) está incompleto para eles.`);
}

/**
 * Subconsulta dos marcos para os negócios da CTE `b`. "Chegou em X" significa "chegou em X OU EM UMA ETAPA POSTERIOR": muitos negócios
 * pulam etapas (vão de Qualificação direto para Agendado), e quem chegou em reunião ou proposta passou, na prática, pelo SQL.
 * Assim o funil só diminui e as taxas de passo fazem sentido. Ordem dos marcos: sql < reunião < proposta.
 */
const MARCOS_CTE = `m as (select deal_id, bool_or(marco in ('sql', 'reuniao', 'proposta')) as sql, bool_or(marco in ('reuniao', 'proposta')) as reuniao, bool_or(marco = 'proposta') as proposta
                          from analytics.negocios_marcos where deal_id in (select deal_id from b) group by deal_id)`;
const SEM_MARCOS = 'Nenhuma etapa foi marcada como SQL, reunião ou proposta (ou ainda não há histórico lido): marque as etapas na aba Configuração do Painel de Dados.';

/** Linhas por safra (mês de criação): base das análises de safra. */
async function safras(db: Db, f: BiFiltros) {
  const p: unknown[] = [];
  const w = filtroSql(f, 'd', p);
  return q(
    db,
    `with b as (select d.deal_id, to_char(date_trunc('month', d.criado_em at time zone ${TZ}), 'YYYY-MM') as safra, d.conta_como_lead, d.is_mql, d.status, d.valor, d.criado_em, d.fechado_em
                  from analytics.negocios_bi d where ${w.join(' and ')}),
          ${MARCOS_CTE}
     select b.safra,
            count(*) filter (where b.conta_como_lead)::int as leads, count(*) filter (where b.is_mql)::int as mql,
            count(*) filter (where m.sql)::int as sql, count(*) filter (where m.reuniao)::int as reuniao, count(*) filter (where m.proposta)::int as proposta,
            count(*) filter (where b.status = 'won')::int as ganhos, count(*) filter (where b.status = 'lost')::int as perdidos, count(*) filter (where b.status = 'open')::int as abertos,
            coalesce(sum(b.valor) filter (where b.status = 'won'), 0)::float8 as valor_ganho,
            (percentile_cont(0.5) within group (order by extract(epoch from b.fechado_em - b.criado_em) / 86400.0) filter (where b.status = 'won' and b.fechado_em is not null))::float8 as ciclo_dias
       from b left join m on m.deal_id = b.deal_id group by 1 order by 1`,
    p,
  );
}

/** Cor fixa por fonte (a cor segue a entidade, nunca a posição): Google ADS 1, Meta ADS 2, Orgânico 3, Social 4; demais 0 (neutro). */
const SLOT_FONTE: Record<string, number> = { 'Marketing [Google ADS]': 1, 'Marketing [Meta ADS]': 2, 'Marketing [Orgânico]': 3, 'Marketing [Social]': 4 };
const slotDe = (fonte: string) => SLOT_FONTE[fonte] ?? 0;
const ETAPAS_FUNIL = ['Leads', 'MQL', 'Chegou em SQL', 'Chegou em reunião', 'Chegou em proposta', 'Ganhos'];
const PASSOS = ['Lead → MQL', 'MQL → SQL', 'SQL → reunião', 'Reunião → proposta', 'Proposta → ganho'];

/**
 * Funil completo por fonte. Cada negócio que conta como lead tem 6 marcas (lead, MQL, chegou em SQL, reunião, proposta, ganho).
 * Os passos são CONDICIONAIS ("dos que chegaram em A, quantos chegaram em B"), por isso nunca passam de 100%, mesmo quando um ganho
 * foi dado antes de alguma etapa (o ganho vem do Status, não da etapa).
 */
async function funisPorFonte(db: Db, f: BiFiltros, maxFontes = 6) {
  const p: unknown[] = [];
  const w = filtroSql(f, 'd', p);
  const rows = await q(
    db,
    `with b as (select d.deal_id, ${FONTE} as fonte, d.fonte_id, d.is_mql, d.status from analytics.negocios_bi d where d.conta_como_lead and ${w.join(' and ')}), ${MARCOS_CTE},
          x as (select b.fonte, b.fonte_id, b.is_mql as mql, coalesce(m.sql, false) as sql, coalesce(m.reuniao, false) as reuniao, coalesce(m.proposta, false) as proposta, (b.status = 'won') as ganho
                  from b left join m on m.deal_id = b.deal_id)
     select grouping(x.fonte) as e_total, x.fonte, x.fonte_id, count(*)::int as leads,
            count(*) filter (where mql)::int as mql, count(*) filter (where sql)::int as sql, count(*) filter (where reuniao)::int as reuniao,
            count(*) filter (where proposta)::int as proposta, count(*) filter (where ganho)::int as ganho,
            count(*) filter (where mql and sql)::int as mql_sql, count(*) filter (where sql and reuniao)::int as sql_reuniao,
            count(*) filter (where reuniao and proposta)::int as reuniao_proposta, count(*) filter (where proposta and ganho)::int as proposta_ganho
       from x group by grouping sets ((x.fonte, x.fonte_id), ()) order by e_total, leads desc`,
    p,
  );
  const coluna = (r: Row, total: boolean) => ({
    id: total ? 'total' : String(r.fonte_id ?? 'branco'),
    nome: total ? 'Total das fontes do filtro' : (r.fonte as string),
    slot: total ? 0 : slotDe(r.fonte),
    total,
    leads: n(r.leads),
    valores: [n(r.leads), n(r.mql), n(r.sql), n(r.reuniao), n(r.proposta), n(r.ganho)],
    passos: [null, razao(n(r.mql), n(r.leads)), razao(n(r.mql_sql), n(r.mql)), razao(n(r.sql_reuniao), n(r.sql)), razao(n(r.reuniao_proposta), n(r.reuniao)), razao(n(r.proposta_ganho), n(r.proposta))] as Array<number | null>,
  });
  const fontes = rows.filter((r) => n(r.e_total) === 0).slice(0, maxFontes).map((r) => coluna(r, false));
  const total = rows.find((r) => n(r.e_total) === 1);
  // sem nenhum lead no filtro o agrupamento ainda devolve uma linha de total zerada: nesse caso não há funil para mostrar
  const colunas = total && n(total.leads) > 0 ? [...fontes, coluna(total, true)] : [];
  const mostradas = rows.filter((r) => n(r.e_total) === 0).length;
  const avisos = await avisoHistorico(db, f);
  if (colunas.length && colunas.every((x) => x.valores[2]! + x.valores[3]! + x.valores[4]! === 0)) avisos.unshift(SEM_MARCOS);
  if (mostradas > maxFontes) avisos.push(`Mostra as ${maxFontes} fontes com mais leads (de ${mostradas}); o total considera todas.`);
  return { colunas, avisos };
}

export const BI_ANALISES: BiAnalise[] = [
  /* ===================== VISÃO GERAL ===================== */
  {
    id: 'visao-geral',
    pagina: 'geral',
    titulo: 'Visão geral',
    pergunta: 'Como estão os negócios criados no período?',
    como_ler: 'Negócios criados no período e o que aconteceu com eles até hoje. Leads e MQL seguem as regras do Painel (status que contam como lead; motivos de perda que tiram do MQL). Taxa de ganho = ganhos ÷ (ganhos + perdidos), sem contar os abertos.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const r = (
        await q(
          db,
          `select count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql,
                  count(*) filter (where d.status = 'won')::int as ganhos, count(*) filter (where d.status = 'lost')::int as perdidos, count(*) filter (where d.status = 'open')::int as abertos,
                  coalesce(sum(d.valor) filter (where d.status = 'won'), 0)::float8 as valor_ganho
             from analytics.negocios_bi d where ${w.join(' and ')}`,
          p,
        )
      )[0]!;
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
        tabela: { colunas: [c('indicador', 'Indicador'), c('valor', 'Valor')], linhas: itens.map((i) => ({ indicador: i.rotulo, valor: i.valor == null ? '—' : i.formato === 'pct' ? pct(i.valor) : i.formato === 'brl' ? `R$ ${i.valor.toFixed(2)}` : String(i.valor) })) },
        avisos: [],
      };
    },
  },
  {
    id: 'por-mes',
    pagina: 'geral',
    titulo: 'Leads, MQL e ganhos por mês de criação',
    pergunta: 'Como a entrada de leads evolui e quanto vira ganho?',
    como_ler: 'Cada mês agrupa os negócios CRIADOS naquele mês e mostra o que aconteceu com eles até hoje (um ganho de hoje conta no mês em que o negócio nasceu). Meses recentes ainda têm negócios abertos.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `select to_char(date_trunc('month', d.criado_em at time zone ${TZ}), 'YYYY-MM') as mes,
                count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql,
                count(*) filter (where d.status = 'won')::int as ganhos, count(*) filter (where d.status = 'lost')::int as perdidos
           from analytics.negocios_bi d where ${w.join(' and ')} group by 1 order by 1`,
        p,
      );
      return {
        grafico: {
          tipo: 'colunas',
          categorias: rows.map((r) => r.mes),
          series: [
            { id: 'leads', nome: 'Leads', slot: 1, valores: rows.map((r) => n(r.leads)) },
            { id: 'mql', nome: 'MQL', slot: 2, valores: rows.map((r) => n(r.mql)) },
            { id: 'ganhos', nome: 'Ganhos', slot: 3, valores: rows.map((r) => n(r.ganhos)) },
          ],
        },
        tabela: {
          colunas: [c('mes', 'Mês de criação'), c('leads', 'Leads', 'int'), c('mql', 'MQL', 'int'), c('ganhos', 'Ganhos', 'int'), c('perdidos', 'Perdidos', 'int'), c('taxa', 'Taxa de ganho', 'pct')],
          linhas: rows.map((r) => ({ mes: r.mes, leads: n(r.leads), mql: n(r.mql), ganhos: n(r.ganhos), perdidos: n(r.perdidos), taxa: razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos)) })),
        },
        avisos: [],
      };
    },
  },
  {
    id: 'funil',
    pagina: 'geral',
    titulo: 'Funil: até onde os negócios chegaram',
    pergunta: 'Quantos negócios chegam em cada marco do funil?',
    como_ler: 'Negócios criados no período. "Chegou em SQL, reunião, proposta" vem do histórico de etapas (passou por uma etapa marcada na Configuração do Painel de Dados) e significa "chegou ali ou além": quem foi direto para reunião conta também como SQL. Ganhos vêm do Status, nunca da etapa. Um ganho dado em Proposta conta como ganho e também como "chegou em proposta".',
    largura: 'meia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const r = (
        await q(
          db,
          `with b as (select d.deal_id, d.conta_como_lead, d.is_mql, d.status from analytics.negocios_bi d where ${w.join(' and ')}), ${MARCOS_CTE}
           select count(*) filter (where b.conta_como_lead)::int as leads, count(*) filter (where b.is_mql)::int as mql,
                  count(*) filter (where m.sql)::int as sql, count(*) filter (where m.reuniao)::int as reuniao, count(*) filter (where m.proposta)::int as proposta,
                  count(*) filter (where b.status = 'won')::int as ganhos
             from b left join m on m.deal_id = b.deal_id`,
          p,
        )
      )[0]!;
      const etapas = [
        { rotulo: 'Leads', valor: n(r.leads) }, { rotulo: 'MQL', valor: n(r.mql) }, { rotulo: 'Chegou em SQL', valor: n(r.sql) },
        { rotulo: 'Chegou em reunião', valor: n(r.reuniao) }, { rotulo: 'Chegou em proposta', valor: n(r.proposta) }, { rotulo: 'Ganhos', valor: n(r.ganhos) },
      ];
      const avisos = await avisoHistorico(db, f);
      if (n(r.sql) + n(r.reuniao) + n(r.proposta) === 0) avisos.unshift(SEM_MARCOS);
      const base = etapas[0]!.valor;
      return {
        grafico: { tipo: 'barras', formato: 'int', ordinal: true, itens: etapas.map((e) => ({ ...e, detalhe: base > 0 ? `${((e.valor / base) * 100).toFixed(1)}% dos leads` : undefined })) },
        tabela: { colunas: [c('etapa', 'Marco'), c('qtd', 'Negócios', 'int'), c('pct', '% dos leads', 'pct')], linhas: etapas.map((e) => ({ etapa: e.rotulo, qtd: e.valor, pct: razao(e.valor, base) })) },
        avisos,
      };
    },
  },
  {
    id: 'motivos-perda',
    pagina: 'geral',
    titulo: 'Principais motivos de perda',
    pergunta: 'Por que estamos perdendo negócios?',
    como_ler: 'Negócios perdidos entre os criados no período, por motivo (nome e ID). "Tira do MQL" marca os motivos que a regra do Painel exclui do MQL.',
    largura: 'meia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `select coalesce(d.motivo_perda, '(sem motivo informado)') as motivo, d.motivo_perda_id as id, count(*)::int as qtd, bool_or(coalesce(m.exclui_mql, false)) as tira_do_mql
           from analytics.negocios_bi d left join analytics.motivos_perda m on m.reason_id = d.motivo_perda_id
          where d.status = 'lost' and ${w.join(' and ')} group by 1, 2 order by qtd desc limit 12`,
        p,
      );
      const total = rows.reduce((s, r) => s + n(r.qtd), 0);
      return {
        grafico: { tipo: 'barras', formato: 'int', itens: rows.map((r) => ({ rotulo: `${r.motivo}${r.id != null ? ` #${r.id}` : ''}`, valor: n(r.qtd), detalhe: `${total > 0 ? ((n(r.qtd) / total) * 100).toFixed(1) : '0'}%${r.tira_do_mql ? ' · tira do MQL' : ''}` })) },
        tabela: {
          colunas: [c('motivo', 'Motivo'), c('id', 'ID'), c('qtd', 'Perdidos', 'int'), c('pct', '% do mostrado', 'pct'), c('mql', 'Tira do MQL')],
          linhas: rows.map((r) => ({ motivo: r.motivo, id: r.id == null ? null : String(r.id), qtd: n(r.qtd), pct: razao(n(r.qtd), total), mql: r.tira_do_mql ? 'sim' : 'não' })),
        },
        avisos: rows.length === 12 ? ['Mostra os 12 motivos mais frequentes.'] : [],
      };
    },
  },
  {
    id: 'tempo-etapas',
    pagina: 'geral',
    titulo: 'Tempo em cada etapa',
    pergunta: 'Onde os negócios ficam parados?',
    como_ler: 'Mediana de dias que os negócios criados no período ficaram em cada etapa, considerando só as passagens já concluídas (o negócio saiu da etapa). A mediana não se distorce por poucos casos muito longos. Mostra as 15 etapas com mais passagens.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = (
        await q(
          db,
          `select h.pipeline, h.etapa, pe.pipeline_ordem, pe.etapa_ordem, count(*)::int as passagens,
                  round((percentile_cont(0.5) within group (order by h.horas_na_etapa) / 24)::numeric, 1)::float8 as mediana_dias,
                  round((avg(h.horas_na_etapa) / 24)::numeric, 1)::float8 as media_dias
             from analytics.historico_etapas h
             join analytics.pipelines_etapas pe on pe.stage_id = h.stage_id
             join analytics.negocios_bi d on d.deal_id = h.deal_id
            where not h.etapa_atual and h.horas_na_etapa is not null and not h.is_deleted and ${w.join(' and ')}
            group by h.pipeline, h.etapa, pe.pipeline_ordem, pe.etapa_ordem having count(*) >= 5 order by passagens desc limit 15`,
          p,
        )
      ).sort((a, b) => n(a.pipeline_ordem) - n(b.pipeline_ordem) || n(a.etapa_ordem) - n(b.etapa_ordem));
      return {
        grafico: { tipo: 'barras', formato: 'dias', itens: rows.map((r) => ({ rotulo: `${r.pipeline} › ${r.etapa}`, valor: n(r.mediana_dias), detalhe: `${n(r.passagens)} passagens · média ${n(r.media_dias)} d` })) },
        tabela: {
          colunas: [c('pipeline', 'Pipeline'), c('etapa', 'Etapa'), c('passagens', 'Passagens', 'int'), c('mediana', 'Mediana', 'dias'), c('media', 'Média', 'dias')],
          linhas: rows.map((r) => ({ pipeline: r.pipeline, etapa: r.etapa, passagens: n(r.passagens), mediana: n(r.mediana_dias), media: n(r.media_dias) })),
        },
        avisos: await avisoHistorico(db, f),
      };
    },
  },
  {
    id: 'por-responsavel',
    pagina: 'geral',
    titulo: 'Desempenho por responsável',
    pergunta: 'Quem está fechando mais?',
    como_ler: 'Negócios criados no período, por responsável atual no Pipedrive. Compare a taxa de ganho junto do volume: quem recebe leads de qualidade diferente não é comparável só pela taxa.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `select coalesce(d.responsavel, '(sem responsável)') as responsavel, d.owner_id as id, count(*) filter (where d.conta_como_lead)::int as leads,
                count(*) filter (where d.status = 'won')::int as ganhos, count(*) filter (where d.status = 'lost')::int as perdidos, count(*) filter (where d.status = 'open')::int as abertos,
                coalesce(sum(d.valor) filter (where d.status = 'won'), 0)::float8 as valor_ganho
           from analytics.negocios_bi d where ${w.join(' and ')} group by 1, 2 order by ganhos desc, leads desc limit 20`,
        p,
      );
      const taxa = (r: Row) => razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos));
      return {
        grafico: { tipo: 'barras', formato: 'int', itens: rows.filter((r) => n(r.ganhos) > 0).map((r) => ({ rotulo: r.responsavel, valor: n(r.ganhos), detalhe: `${n(r.leads)} leads · ${pct(taxa(r))}` })) },
        tabela: {
          colunas: [c('responsavel', 'Responsável'), c('id', 'ID'), c('leads', 'Leads', 'int'), c('ganhos', 'Ganhos', 'int'), c('perdidos', 'Perdidos', 'int'), c('abertos', 'Abertos', 'int'), c('taxa', 'Taxa de ganho', 'pct'), c('valor', 'Valor ganho', 'brl')],
          linhas: rows.map((r) => ({ responsavel: r.responsavel, id: r.id == null ? null : String(r.id), leads: n(r.leads), ganhos: n(r.ganhos), perdidos: n(r.perdidos), abertos: n(r.abertos), taxa: taxa(r), valor: n(r.valor_ganho) })),
        },
        avisos: rows.length === 20 ? ['Mostra os 20 responsáveis com mais ganhos.'] : [],
      };
    },
  },

  /* ===================== SAFRA ===================== */
  {
    id: 'safra-resumo',
    pagina: 'safra',
    titulo: 'Safras: resultado de cada mês de criação',
    pergunta: 'Como cada safra de leads performou, do lead ao ganho?',
    como_ler: 'Safra = mês em que o negócio foi criado. Cada linha mostra o que aconteceu com os negócios daquele mês até hoje: % que virou MQL, que chegou em SQL, reunião e proposta (pelo histórico de etapas), ganhos, taxa de ganho (ganhos ÷ ganhos + perdidos), valor ganho e ciclo de venda (mediana de dias da criação ao ganho). Safras recentes ainda têm muitos negócios abertos: compare safras de idade parecida.',
    largura: 'cheia',
    async rodar(db, f) {
      const rows = await safras(db, f);
      const avisos = await avisoHistorico(db, f);
      if (rows.length && rows.every((r) => n(r.sql) + n(r.reuniao) + n(r.proposta) === 0)) avisos.unshift(SEM_MARCOS);
      return {
        grafico: { tipo: 'tabela' },
        tabela: {
          colunas: [c('safra', 'Safra'), c('leads', 'Leads', 'int'), c('pmql', '% MQL', 'pct'), c('psql', '% chegou SQL', 'pct'), c('preun', '% chegou reunião', 'pct'), c('pprop', '% chegou proposta', 'pct'), c('ganhos', 'Ganhos', 'int'), c('perdidos', 'Perdidos', 'int'), c('abertos', 'Abertos', 'int'), c('taxa', 'Taxa de ganho', 'pct'), c('valor', 'Valor ganho', 'brl'), c('ciclo', 'Ciclo mediano', 'dias')],
          linhas: rows.map((r) => ({
            safra: r.safra, leads: n(r.leads), pmql: razao(n(r.mql), n(r.leads)), psql: razao(n(r.sql), n(r.leads)), preun: razao(n(r.reuniao), n(r.leads)), pprop: razao(n(r.proposta), n(r.leads)),
            ganhos: n(r.ganhos), perdidos: n(r.perdidos), abertos: n(r.abertos), taxa: razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos)), valor: n(r.valor_ganho), ciclo: r.ciclo_dias == null ? null : Math.round(Number(r.ciclo_dias) * 10) / 10,
          })),
        },
        avisos,
      };
    },
  },
  {
    id: 'safra-funil',
    pagina: 'safra',
    titulo: 'Funil por safra',
    pergunta: 'Que parte de cada safra chegou em cada marco?',
    como_ler: 'Percentual dos leads de cada safra que virou MQL, chegou em SQL, reunião e proposta e que foi ganho. Células mais escuras = maior percentual. Marcos de etapa dependem do histórico lido e das etapas marcadas na Configuração.',
    largura: 'cheia',
    async rodar(db, f) {
      const rows = await safras(db, f);
      const avisos = await avisoHistorico(db, f);
      if (rows.length && rows.every((r) => n(r.sql) + n(r.reuniao) + n(r.proposta) === 0)) avisos.unshift(SEM_MARCOS);
      const colunas = ['MQL', 'Chegou em SQL', 'Chegou em reunião', 'Chegou em proposta', 'Ganho'];
      const linhas = rows.map((r) => ({ rotulo: r.safra as string, detalhe: `${n(r.leads)} leads`, valores: [razao(n(r.mql), n(r.leads)), razao(n(r.sql), n(r.leads)), razao(n(r.reuniao), n(r.leads)), razao(n(r.proposta), n(r.leads)), razao(n(r.ganhos), n(r.leads))] }));
      return {
        grafico: { tipo: 'matriz', colunas, linhas, formato: 'pct', escala: 'coluna' },
        tabela: { colunas: [c('safra', 'Safra'), c('leads', 'Leads', 'int'), ...colunas.map((x, i) => c(`v${i}`, `% ${x}`, 'pct'))], linhas: linhas.map((l, i) => ({ safra: l.rotulo, leads: n(rows[i]!.leads), ...Object.fromEntries(l.valores.map((v, k) => [`v${k}`, v])) })) },
        avisos,
      };
    },
  },
  {
    id: 'safra-ganhos',
    pagina: 'safra',
    titulo: 'Ganhos acumulados ao longo do tempo (curva de safra)',
    pergunta: 'Quanto de cada safra vira ganho, e em quanto tempo?',
    como_ler: 'Cada linha é uma safra; cada coluna é o tempo desde a criação do negócio. A célula mostra a % dos leads da safra que já tinha sido GANHA até aquele prazo (acumulado). Células vazias = a safra ainda não tem essa idade, então não dá para comparar. Use para ver se uma safra recente está convertendo no mesmo ritmo das antigas.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const MAXM = 12;
      const rows = await q(
        db,
        `with b as (select to_char(date_trunc('month', d.criado_em at time zone ${TZ}), 'YYYY-MM') as safra, d.conta_como_lead, d.status, d.criado_em, d.fechado_em
                      from analytics.negocios_bi d where ${w.join(' and ')})
         select b.safra, m.m, count(*) filter (where b.conta_como_lead)::int as leads,
                count(*) filter (where b.status = 'won' and b.fechado_em is not null and floor(extract(epoch from b.fechado_em - b.criado_em) / 2629746.0) <= m.m)::int as ganhos_ate
           from b cross join generate_series(0, ${MAXM}) as m(m) group by b.safra, m.m order by b.safra, m.m`,
        p,
      );
      const hoje = new Date();
      const porSafra = new Map<string, { leads: number; ate: Array<number | null> }>();
      for (const r of rows) {
        const [a, mes] = String(r.safra).split('-').map(Number) as [number, number];
        // a coluna só vale quando TODOS os leads da safra já têm (m+1) meses de vida: fim da safra (1º dia do mês seguinte) + (m+1) meses
        const idadeOk = new Date(Date.UTC(a, mes + n(r.m) + 1, 1)) <= hoje;
        const s = porSafra.get(r.safra) ?? { leads: n(r.leads), ate: Array(MAXM + 1).fill(null) };
        s.ate[n(r.m)] = idadeOk && n(r.leads) > 0 ? n(r.ganhos_ate) / n(r.leads) : null;
        porSafra.set(r.safra, s);
      }
      const colunas = Array.from({ length: MAXM + 1 }, (_, i) => `até ${i + 1} ${i === 0 ? 'mês' : 'meses'}`);
      const linhas = [...porSafra.entries()].map(([safra, s]) => ({ rotulo: safra, detalhe: `${s.leads} leads`, valores: s.ate }));
      return {
        grafico: { tipo: 'matriz', colunas, linhas, formato: 'pct' },
        tabela: { colunas: [c('safra', 'Safra'), c('leads', 'Leads', 'int'), ...colunas.map((x, i) => c(`m${i}`, x, 'pct'))], linhas: linhas.map((l) => ({ safra: l.rotulo, leads: n(porSafra.get(l.rotulo)!.leads), ...Object.fromEntries(l.valores.map((v, k) => [`m${k}`, v])) })) },
        avisos: [],
      };
    },
  },

  /* ===================== CANAIS ===================== */
  {
    id: 'canais-funis',
    pagina: 'canais',
    titulo: 'Funis lado a lado: cada fonte, do lead ao ganho',
    pergunta: 'Em que etapa cada fonte perde força, comparando os funis inteiros?',
    como_ler: 'Uma coluna por fonte (as 6 com mais leads) e o total, com as mesmas etapas alinhadas: Leads, MQL, chegou em SQL, reunião, proposta e Ganhos. A barra mostra a parte dos leads da PRÓPRIA fonte que chegou na etapa (a barra dos leads é sempre cheia), então dá para comparar a forma dos funis mesmo com volumes muito diferentes; o número é a quantidade. Em cada etapa, "passo" = dos negócios que chegaram na etapa anterior, quantos chegaram nesta (nunca passa de 100%). Só entram negócios que contam como lead. "Chegou em SQL" inclui quem foi direto para reunião ou proposta (chegou em X ou além), porque muitos negócios pulam etapas. As etapas vêm do histórico e das marcações na Configuração do Painel de Dados; ganhos vêm do Status do negócio (um ganho pode ter pulado etapas).',
    largura: 'cheia',
    async rodar(db, f) {
      const { colunas, avisos } = await funisPorFonte(db, f);
      const linhas: Array<Record<string, string | number | null>> = ETAPAS_FUNIL.map((etapa, i) => {
        const l: Record<string, string | number | null> = { etapa };
        for (const k of colunas) {
          l[`${k.id}_qtd`] = k.valores[i]!;
          l[`${k.id}_pct`] = razao(k.valores[i]!, k.leads);
          l[`${k.id}_passo`] = k.passos[i] ?? null;
        }
        return l;
      });
      return {
        grafico: { tipo: 'funis', etapas: ETAPAS_FUNIL, colunas },
        tabela: {
          colunas: [c('etapa', 'Etapa'), ...colunas.flatMap((k) => [c(`${k.id}_qtd`, `${k.nome}: negócios`, 'int'), c(`${k.id}_pct`, `${k.nome}: % dos leads`, 'pct'), c(`${k.id}_passo`, `${k.nome}: passo`, 'pct')])],
          linhas,
        },
        avisos,
      };
    },
  },
  {
    id: 'canais-conversoes',
    pagina: 'canais',
    titulo: 'Taxas de conversão por fonte',
    pergunta: 'Que fonte converte melhor em cada passo do funil?',
    como_ler: 'Cada célula é a taxa de um passo: dos negócios que chegaram na etapa da esquerda, que % chegou na da direita. A cor compara as fontes DENTRO de cada linha (mais escuro = melhor naquela conversão). "Lead → ganho" é o resultado final: ganhos ÷ leads.',
    largura: 'cheia',
    async rodar(db, f) {
      const { colunas, avisos } = await funisPorFonte(db, f);
      const linhas = colunas.length ? PASSOS.map((rotulo, i) => ({ rotulo, valores: colunas.map((k) => k.passos[i + 1] ?? null) })) : [];
      if (colunas.length) linhas.push({ rotulo: 'Lead → ganho (resultado final)', valores: colunas.map((k) => razao(k.valores[5]!, k.leads)) });
      return {
        grafico: { tipo: 'matriz', colunas: colunas.map((k) => (k.total ? 'Total' : k.nome.replace(/^Marketing \[(.*)\]$/, '$1'))), linhas, formato: 'pct', escala: 'linha' },
        tabela: { colunas: [c('passo', 'Conversão'), ...colunas.map((k) => c(k.id, k.total ? 'Total' : k.nome, 'pct'))], linhas: linhas.map((l) => ({ passo: l.rotulo, ...Object.fromEntries(colunas.map((k, i) => [k.id, l.valores[i] ?? null])) })) },
        avisos,
      };
    },
  },
  {
    id: 'canais-resumo',
    pagina: 'canais',
    titulo: 'Canais: comparativo por fonte',
    pergunta: 'Que fontes trazem mais leads e quais convertem melhor?',
    como_ler: 'Fonte = campo "Fonte do Lead" do Pipedrive (nome e ID da opção). Para cada fonte: volume, participação, qualidade (% MQL e % inválidos), até onde chegou no funil (pelo histórico), ganhos, taxa de ganho (ganhos ÷ ganhos + perdidos), valor e ticket médio, e ciclo de venda (mediana de dias criação → ganho). O gráfico mostra o volume de leads.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `with b as (select d.deal_id, ${FONTE} as fonte, d.fonte_id, d.conta_como_lead, d.is_mql, d.status, d.valor, d.criado_em, d.fechado_em from analytics.negocios_bi d where ${w.join(' and ')}), ${MARCOS_CTE}
         select b.fonte, b.fonte_id, count(*) filter (where b.conta_como_lead)::int as leads, count(*) filter (where b.is_mql)::int as mql,
                count(*) filter (where b.conta_como_lead and not b.is_mql)::int as invalidos,
                count(*) filter (where m.sql)::int as sql, count(*) filter (where m.reuniao)::int as reuniao, count(*) filter (where m.proposta)::int as proposta,
                count(*) filter (where b.status = 'won')::int as ganhos, count(*) filter (where b.status = 'lost')::int as perdidos,
                coalesce(sum(b.valor) filter (where b.status = 'won'), 0)::float8 as valor_ganho,
                (percentile_cont(0.5) within group (order by extract(epoch from b.fechado_em - b.criado_em) / 86400.0) filter (where b.status = 'won' and b.fechado_em is not null))::float8 as ciclo_dias
           from b left join m on m.deal_id = b.deal_id group by 1, 2 order by leads desc limit 15`,
        p,
      );
      const total = rows.reduce((s, r) => s + n(r.leads), 0);
      const taxa = (r: Row) => razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos));
      const avisos = await avisoHistorico(db, f);
      if (rows.length === 15) avisos.push('Mostra as 15 fontes com mais leads.');
      return {
        grafico: { tipo: 'barras', formato: 'int', itens: rows.map((r) => ({ rotulo: r.fonte, valor: n(r.leads), detalhe: `${pct(razao(n(r.leads), total))} dos leads · ${pct(razao(n(r.mql), n(r.leads)))} MQL · ${n(r.ganhos)} ganhos (${pct(taxa(r))})` })) },
        tabela: {
          colunas: [c('fonte', 'Fonte'), c('id', 'ID'), c('leads', 'Leads', 'int'), c('part', '% dos leads', 'pct'), c('pmql', '% MQL', 'pct'), c('pinv', '% inválidos', 'pct'), c('psql', '% chegou SQL', 'pct'), c('preun', '% chegou reunião', 'pct'), c('pprop', '% chegou proposta', 'pct'), c('ganhos', 'Ganhos', 'int'), c('taxa', 'Taxa de ganho', 'pct'), c('valor', 'Valor ganho', 'brl'), c('ticket', 'Ticket médio', 'brl'), c('ciclo', 'Ciclo mediano', 'dias')],
          linhas: rows.map((r) => ({
            fonte: r.fonte, id: r.fonte_id, leads: n(r.leads), part: razao(n(r.leads), total), pmql: razao(n(r.mql), n(r.leads)), pinv: razao(n(r.invalidos), n(r.leads)),
            psql: razao(n(r.sql), n(r.leads)), preun: razao(n(r.reuniao), n(r.leads)), pprop: razao(n(r.proposta), n(r.leads)), ganhos: n(r.ganhos), taxa: taxa(r),
            valor: n(r.valor_ganho), ticket: razao(n(r.valor_ganho), n(r.ganhos)), ciclo: r.ciclo_dias == null ? null : Math.round(Number(r.ciclo_dias) * 10) / 10,
          })),
        },
        avisos,
      };
    },
  },
  {
    id: 'canais-por-mes',
    pagina: 'canais',
    titulo: 'Leads por fonte, mês a mês',
    pergunta: 'Como cada fonte evolui ao longo do tempo?',
    como_ler: 'Leads criados em cada mês, por fonte. Cada fonte tem sempre a mesma cor (Google ADS azul, Meta ADS laranja, Orgânico verde-água, Social amarelo); as demais fontes entram juntas em "Outras fontes" (cinza).',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `select to_char(date_trunc('month', d.criado_em at time zone ${TZ}), 'YYYY-MM') as mes, ${FONTE} as fonte, count(*) filter (where d.conta_como_lead)::int as leads
           from analytics.negocios_bi d where ${w.join(' and ')} group by 1, 2 order by 1`,
        p,
      );
      const meses = [...new Set(rows.map((r) => r.mes as string))].sort();
      const FIXAS: Array<[string, string, number]> = [['Marketing [Google ADS]', 'Google ADS', 1], ['Marketing [Meta ADS]', 'Meta ADS', 2], ['Marketing [Orgânico]', 'Orgânico', 3], ['Marketing [Social]', 'Social', 4]];
      const val = (pred: (fonte: string) => boolean) => meses.map((m) => rows.filter((r) => r.mes === m && pred(r.fonte)).reduce((s, r) => s + n(r.leads), 0));
      const series = FIXAS.map(([full, nome, slot]) => ({ id: full, nome, slot, valores: val((x) => x === full) })).filter((s) => s.valores.some((v) => v > 0));
      const outras = val((x) => !FIXAS.some(([full]) => full === x));
      if (outras.some((v) => v > 0)) series.push({ id: 'outras', nome: 'Outras fontes', slot: 0, valores: outras });
      return {
        grafico: { tipo: 'colunas', categorias: meses, series },
        tabela: { colunas: [c('mes', 'Mês de criação'), ...series.map((s) => c(s.id, s.nome, 'int'))], linhas: meses.map((m, i) => ({ mes: m, ...Object.fromEntries(series.map((s) => [s.id, s.valores[i]!])) })) },
        avisos: [],
      };
    },
  },
  {
    id: 'canais-rd',
    pagina: 'canais',
    titulo: 'Detalhe: Canal de origem RD',
    pergunta: 'Dentro das fontes selecionadas, de onde exatamente vêm os leads?',
    como_ler: 'Campo de texto "Canal de origem RD" (ex.: Busca orgânica | Google). Mostra os 12 canais com mais leads, com ganhos e taxa de ganho.',
    largura: 'meia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `select coalesce(d.canal_rd, '(em branco)') as canal, count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql,
                count(*) filter (where d.status = 'won')::int as ganhos, count(*) filter (where d.status = 'lost')::int as perdidos
           from analytics.negocios_bi d where ${w.join(' and ')} group by 1 order by leads desc limit 12`,
        p,
      );
      const taxa = (r: Row) => razao(n(r.ganhos), n(r.ganhos) + n(r.perdidos));
      return {
        grafico: { tipo: 'barras', formato: 'int', itens: rows.map((r) => ({ rotulo: r.canal, valor: n(r.leads), detalhe: `${n(r.ganhos)} ganhos · ${pct(taxa(r))}` })) },
        tabela: { colunas: [c('canal', 'Canal de origem RD'), c('leads', 'Leads', 'int'), c('mql', 'MQL', 'int'), c('ganhos', 'Ganhos', 'int'), c('perdidos', 'Perdidos', 'int'), c('taxa', 'Taxa de ganho', 'pct')], linhas: rows.map((r) => ({ canal: r.canal, leads: n(r.leads), mql: n(r.mql), ganhos: n(r.ganhos), perdidos: n(r.perdidos), taxa: taxa(r) })) },
        avisos: rows.length === 12 ? ['Mostra os 12 canais com mais leads.'] : [],
      };
    },
  },

  /* ===================== QUALIDADE ===================== */
  {
    id: 'qualidade-kpis',
    pagina: 'qualidade',
    titulo: 'Qualidade dos leads: indicadores',
    pergunta: 'Os leads que entram têm qualidade e estão bem preenchidos?',
    como_ler: '% MQL = leads que seguem a regra do MQL. Inválidos = leads perdidos por motivo que a regra do Painel tira do MQL (hoje: Lead Invalido, Cliente em Busca de Suporte, Contato Inexistente, Oportunidade Duplicada). "Sem …" = campo do Pipedrive em branco. A faixa depende do produto: RH usa "Faixa de Colaboradores"; Clínica usa "Faixa de profissionais da saúde".',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const r = (
        await q(
          db,
          `select count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql,
                  count(*) filter (where d.conta_como_lead and not d.is_mql)::int as invalidos, count(*) filter (where d.status = 'lost')::int as perdidos,
                  count(*) filter (where d.fonte_id is null)::int as sem_fonte, count(*) filter (where d.tipo_id is null)::int as sem_tipo,
                  count(*) filter (where d.produto = 'rh')::int as rh, count(*) filter (where d.produto = 'rh' and d.faixa_colab_id is null)::int as rh_sem_faixa,
                  count(*) filter (where d.produto = 'clinic')::int as clinic, count(*) filter (where d.produto = 'clinic' and d.faixa_saude_id is null)::int as clinic_sem_faixa,
                  count(*) filter (where d.sem_pessoa)::int as sem_pessoa, count(*) filter (where d.sem_organizacao)::int as sem_org, count(*)::int as total,
                  count(*) filter (where d.canal_rd ~* ${CANAL_DESCONHECIDO})::int as canal_desc,
                  count(*) filter (where d.utm_source is not null)::int as utm_preench, count(*) filter (where d.utm_source ~* ${UTM_INVALIDO})::int as utm_inv
             from analytics.negocios_bi d where ${w.join(' and ')}`,
          p,
        )
      )[0]!;
      const leads = n(r.leads), total = n(r.total);
      const itens = [
        { id: 'leads', rotulo: 'Leads', valor: leads, formato: 'int' as const },
        { id: 'pmql', rotulo: '% MQL', valor: razao(n(r.mql), leads), formato: 'pct' as const, dica: 'MQL ÷ leads' },
        { id: 'pinv', rotulo: '% inválidos', valor: razao(n(r.invalidos), leads), formato: 'pct' as const, dica: 'Perdidos por motivo que tira do MQL ÷ leads' },
        { id: 'pperd', rotulo: '% perdidos', valor: razao(n(r.perdidos), total), formato: 'pct' as const, dica: 'Todos os motivos ÷ negócios' },
        { id: 'psf', rotulo: '% sem fonte', valor: razao(n(r.sem_fonte), total), formato: 'pct' as const, dica: '"Fonte do Lead" em branco' },
        { id: 'pst', rotulo: '% sem tipo do lead', valor: razao(n(r.sem_tipo), total), formato: 'pct' as const, dica: '"Tipo do Lead" em branco' },
        { id: 'prh', rotulo: '% RH sem faixa de colaboradores', valor: razao(n(r.rh_sem_faixa), n(r.rh)), formato: 'pct' as const, dica: `${n(r.rh_sem_faixa)} de ${n(r.rh)} negócios de RH` },
        { id: 'pcl', rotulo: '% Clínica sem faixa de profissionais', valor: razao(n(r.clinic_sem_faixa), n(r.clinic)), formato: 'pct' as const, dica: `${n(r.clinic_sem_faixa)} de ${n(r.clinic)} negócios de Clínica` },
        { id: 'pcd', rotulo: '% com canal de origem "Desconhecido"', valor: razao(n(r.canal_desc), total), formato: 'pct' as const, dica: `${n(r.canal_desc)} negócios com "Desconhecido"/"Unknown" no Canal de origem RD` },
        { id: 'pui', rotulo: '% UTM Source inválido', valor: razao(n(r.utm_inv), n(r.utm_preench)), formato: 'pct' as const, dica: `${n(r.utm_inv)} de ${n(r.utm_preench)} com UTM preenchido: {{...}}, undefined ou unknown` },
        { id: 'ppe', rotulo: '% sem pessoa vinculada', valor: razao(n(r.sem_pessoa), total), formato: 'pct' as const },
        { id: 'por', rotulo: '% sem organização', valor: razao(n(r.sem_org), total), formato: 'pct' as const },
      ];
      return { grafico: { tipo: 'kpis', itens }, tabela: { colunas: [c('indicador', 'Indicador'), c('valor', 'Valor'), c('nota', 'Detalhe')], linhas: itens.map((i) => ({ indicador: i.rotulo, valor: i.formato === 'pct' ? pct(i.valor) : String(i.valor), nota: i.dica ?? '' })) }, avisos: [] };
    },
  },
  {
    id: 'qualidade-por-fonte',
    pagina: 'qualidade',
    titulo: 'Qualidade por fonte',
    pergunta: 'Que fontes trazem leads melhores e mais bem preenchidos?',
    como_ler: 'Para cada fonte: % MQL, % inválidos, % perdidos e % de dados em branco (tipo do lead; faixa de colaboradores nos negócios de RH; faixa de profissionais nos de Clínica). O gráfico ordena pelo volume e mostra o % MQL.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `select ${FONTE} as fonte, d.fonte_id as id, count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql,
                count(*) filter (where d.conta_como_lead and not d.is_mql)::int as invalidos, count(*) filter (where d.status = 'lost')::int as perdidos, count(*)::int as total,
                count(*) filter (where d.tipo_id is null)::int as sem_tipo,
                count(*) filter (where d.produto = 'rh')::int as rh, count(*) filter (where d.produto = 'rh' and d.faixa_colab_id is null)::int as rh_sem,
                count(*) filter (where d.produto = 'clinic')::int as cl, count(*) filter (where d.produto = 'clinic' and d.faixa_saude_id is null)::int as cl_sem
           from analytics.negocios_bi d where ${w.join(' and ')} group by 1, 2 order by leads desc limit 15`,
        p,
      );
      return {
        grafico: { tipo: 'barras', formato: 'pct', itens: rows.map((r) => ({ rotulo: r.fonte, valor: razao(n(r.mql), n(r.leads)) ?? 0, detalhe: `${n(r.leads)} leads · ${pct(razao(n(r.invalidos), n(r.leads)))} inválidos` })) },
        tabela: {
          colunas: [c('fonte', 'Fonte'), c('id', 'ID'), c('leads', 'Leads', 'int'), c('pmql', '% MQL', 'pct'), c('pinv', '% inválidos', 'pct'), c('pperd', '% perdidos', 'pct'), c('pst', '% sem tipo', 'pct'), c('prh', '% RH sem faixa', 'pct'), c('pcl', '% Clínica sem faixa', 'pct')],
          linhas: rows.map((r) => ({ fonte: r.fonte, id: r.id, leads: n(r.leads), pmql: razao(n(r.mql), n(r.leads)), pinv: razao(n(r.invalidos), n(r.leads)), pperd: razao(n(r.perdidos), n(r.total)), pst: razao(n(r.sem_tipo), n(r.total)), prh: razao(n(r.rh_sem), n(r.rh)), pcl: razao(n(r.cl_sem), n(r.cl)) })),
        },
        avisos: rows.length === 15 ? ['Mostra as 15 fontes com mais leads.'] : [],
      };
    },
  },
  {
    id: 'qualidade-por-mes',
    pagina: 'qualidade',
    titulo: 'Qualidade ao longo do tempo',
    pergunta: 'A qualidade dos leads está melhorando ou piorando?',
    como_ler: 'Por mês de criação: % MQL, % inválidos e % de leads com algum dado em branco (fonte, tipo do lead ou a faixa que cabe ao produto). Meses recentes ainda não tiveram tempo de o time classificar os leads perdidos.',
    largura: 'cheia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `select to_char(date_trunc('month', d.criado_em at time zone ${TZ}), 'YYYY-MM') as mes, count(*) filter (where d.conta_como_lead)::int as leads, count(*) filter (where d.is_mql)::int as mql,
                count(*) filter (where d.conta_como_lead and not d.is_mql)::int as invalidos, count(*)::int as total,
                count(*) filter (where d.fonte_id is null or d.tipo_id is null or (d.produto = 'rh' and d.faixa_colab_id is null) or (d.produto = 'clinic' and d.faixa_saude_id is null))::int as algum_branco
           from analytics.negocios_bi d where ${w.join(' and ')} group by 1 order by 1`,
        p,
      );
      const s = (fn: (r: Row) => number | null) => rows.map((r) => fn(r) ?? 0);
      return {
        grafico: {
          tipo: 'colunas', formato: 'pct', categorias: rows.map((r) => r.mes),
          series: [
            { id: 'mql', nome: '% MQL', slot: 1, valores: s((r) => razao(n(r.mql), n(r.leads))) },
            { id: 'inv', nome: '% inválidos', slot: 2, valores: s((r) => razao(n(r.invalidos), n(r.leads))) },
            { id: 'branco', nome: '% com algum dado em branco', slot: 3, valores: s((r) => razao(n(r.algum_branco), n(r.total))) },
          ],
        },
        tabela: {
          colunas: [c('mes', 'Mês de criação'), c('leads', 'Leads', 'int'), c('pmql', '% MQL', 'pct'), c('pinv', '% inválidos', 'pct'), c('pbr', '% com algum dado em branco', 'pct')],
          linhas: rows.map((r) => ({ mes: r.mes, leads: n(r.leads), pmql: razao(n(r.mql), n(r.leads)), pinv: razao(n(r.invalidos), n(r.leads)), pbr: razao(n(r.algum_branco), n(r.total)) })),
        },
        avisos: [],
      };
    },
  },
  {
    id: 'qualidade-invalidos',
    pagina: 'qualidade',
    titulo: 'Por que os leads são inválidos',
    pergunta: 'Quais motivos tiram leads do MQL?',
    como_ler: 'Leads perdidos por um motivo que a regra do Painel tira do MQL (nome e ID), com a % sobre todos os leads do filtro. A lista dos motivos é editável na aba Configuração do Painel de Dados.',
    largura: 'meia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const rows = await q(
        db,
        `select coalesce(d.motivo_perda, '(sem motivo informado)') as motivo, d.motivo_perda_id as id, count(*)::int as qtd,
                (select count(*)::int from analytics.negocios_bi d2 where d2.conta_como_lead and ${filtroSql(f, 'd2', p).join(' and ')}) as leads
           from analytics.negocios_bi d where d.conta_como_lead and not d.is_mql and ${w.join(' and ')} group by 1, 2 order by qtd desc limit 12`,
        p,
      );
      const leads = rows[0] ? n(rows[0].leads) : 0;
      return {
        grafico: { tipo: 'barras', formato: 'int', itens: rows.map((r) => ({ rotulo: `${r.motivo}${r.id != null ? ` #${r.id}` : ''}`, valor: n(r.qtd), detalhe: `${pct(razao(n(r.qtd), leads))} dos leads` })) },
        tabela: { colunas: [c('motivo', 'Motivo'), c('id', 'ID'), c('qtd', 'Leads inválidos', 'int'), c('pct', '% dos leads', 'pct')], linhas: rows.map((r) => ({ motivo: r.motivo, id: r.id == null ? null : String(r.id), qtd: n(r.qtd), pct: razao(n(r.qtd), leads) })) },
        avisos: [],
      };
    },
  },
  {
    id: 'qualidade-branco',
    pagina: 'qualidade',
    titulo: 'Dados em branco',
    pergunta: 'Quais campos estão mais vazios?',
    como_ler: '% de negócios com o campo em branco ou com valor "desconhecido". A faixa de colaboradores só conta negócios de RH e a faixa de profissionais da saúde só os de Clínica (cada produto tem a sua); negócios sem produto definido não entram nas faixas. "Desconhecido" no Canal de origem RD e valores como {{}}, {{GoogleAds}}, undefined ou unknown no UTM Source indicam link de campanha mal configurado.',
    largura: 'meia',
    async rodar(db, f) {
      const p: unknown[] = [];
      const w = filtroSql(f, 'd', p);
      const r = (
        await q(
          db,
          `select count(*)::int as total, count(*) filter (where d.fonte_id is null)::int as sem_fonte, count(*) filter (where d.tipo_id is null)::int as sem_tipo,
                  count(*) filter (where d.produto = 'rh')::int as rh, count(*) filter (where d.produto = 'rh' and d.faixa_colab_id is null)::int as rh_sem,
                  count(*) filter (where d.produto = 'clinic')::int as cl, count(*) filter (where d.produto = 'clinic' and d.faixa_saude_id is null)::int as cl_sem,
                  count(*) filter (where d.canal_rd is null)::int as sem_canal, count(*) filter (where d.utm_source is null)::int as sem_utm,
                  count(*) filter (where d.canal_rd ~* ${CANAL_DESCONHECIDO})::int as canal_desc,
                  count(*) filter (where d.utm_source is not null)::int as utm_preench, count(*) filter (where d.utm_source ~* ${UTM_INVALIDO})::int as utm_inv,
                  count(*) filter (where d.sem_pessoa)::int as sem_pessoa, count(*) filter (where d.sem_organizacao)::int as sem_org
             from analytics.negocios_bi d where ${w.join(' and ')}`,
          p,
        )
      )[0]!;
      const t = n(r.total);
      const linhas = [
        { campo: 'Fonte do Lead', sem: n(r.sem_fonte), base: t },
        { campo: 'Tipo do Lead', sem: n(r.sem_tipo), base: t },
        { campo: 'Faixa de Colaboradores (só RH)', sem: n(r.rh_sem), base: n(r.rh) },
        { campo: 'Faixa de profissionais da saúde (só Clínica)', sem: n(r.cl_sem), base: n(r.cl) },
        { campo: 'Canal de origem RD', sem: n(r.sem_canal), base: t },
        { campo: 'Canal de origem RD = "Desconhecido"', sem: n(r.canal_desc), base: t },
        { campo: 'UTM Source', sem: n(r.sem_utm), base: t },
        { campo: 'UTM Source inválido ({{...}}, undefined, unknown), entre os preenchidos', sem: n(r.utm_inv), base: n(r.utm_preench) },
        { campo: 'Pessoa vinculada', sem: n(r.sem_pessoa), base: t },
        { campo: 'Organização', sem: n(r.sem_org), base: t },
      ];
      return {
        grafico: { tipo: 'barras', formato: 'pct', itens: linhas.map((l) => ({ rotulo: l.campo, valor: razao(l.sem, l.base) ?? 0, detalhe: `${l.sem} de ${l.base}` })) },
        tabela: { colunas: [c('campo', 'Campo'), c('sem', 'Em branco', 'int'), c('base', 'Negócios considerados', 'int'), c('pct', '% em branco', 'pct')], linhas: linhas.map((l) => ({ campo: l.campo, sem: l.sem, base: l.base, pct: razao(l.sem, l.base) })) },
        avisos: [],
      };
    },
  },
];

export type BiCatalogoItem = Pick<BiAnalise, 'id' | 'pagina' | 'titulo' | 'pergunta' | 'como_ler' | 'largura'>;
export type BiOpcao = { id: string; nome: string; padrao: boolean };

export interface BiRepo {
  catalogo(): BiCatalogoItem[];
  opcoes(): Promise<{
    pipelines: Array<{ pipeline_id: number; pipeline: string; produto: string | null }>;
    produtos: readonly string[];
    primeiro_negocio: string | null;
    fontes: BiOpcao[];
    tipos: BiOpcao[];
    paginas: ReadonlyArray<{ id: string; rotulo: string }>;
  }>;
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
    return BI_ANALISES.map(({ id, pagina, titulo, pergunta, como_ler, largura }) => ({ id, pagina, titulo, pergunta, como_ler, largura }));
  }

  async opcoes() {
    const p = await this.pool.query(`select distinct pipeline_id, pipeline, produto, pipeline_ordem from analytics.pipelines_etapas order by pipeline_ordem nulls last, pipeline_id`);
    const d = await this.pool.query(`select to_char(min(criado_em at time zone ${TZ}), 'YYYY-MM-DD') as primeiro from analytics.deals`);
    const o = await this.pool.query(`select campo, opcao_id, opcao from analytics.campo_opcoes where campo in ('Fonte do Lead', 'Tipo do Lead') order by opcao`);
    const lista = (campo: string, padrao: string[]): BiOpcao[] => o.rows.filter((x: Row) => x.campo === campo).map((x: Row) => ({ id: String(x.opcao_id), nome: x.opcao, padrao: padrao.includes(x.opcao) }));
    return {
      pipelines: p.rows.map((x: Row) => ({ pipeline_id: Number(x.pipeline_id), pipeline: x.pipeline, produto: x.produto })),
      produtos: BI_PRODUTOS,
      primeiro_negocio: d.rows[0]?.primeiro ?? null,
      fontes: lista('Fonte do Lead', PADRAO_FONTES),
      tipos: lista('Tipo do Lead', PADRAO_TIPOS),
      paginas: BI_PAGINAS,
    };
  }

  async rodar(id: string, f: BiFiltros): Promise<BiResultado> {
    const a = BI_ANALISES.find((x) => x.id === id);
    if (!a) throw new BiNotFound('análise');
    return a.rodar(this.pool, f);
  }
}
