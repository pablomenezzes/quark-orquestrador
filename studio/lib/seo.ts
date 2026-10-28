/**
 * SEO (pedido do Pablo, 2026-10-28): casa Search Console (cliques, impressões, posição), GA4 (sessões orgânicas por landing page) e Pipedrive (leads, MQL,
 * ganhos e valor dos negócios de fonte Orgânico, pela URL de conversão) por MARCA (rh ou clinic) e por página, e deriva as ações recomendadas que a página
 * /seo transforma em experimentos. SÓ LEITURA, só sobre as visões de `analytics` (papel orq_panel); o navegador escolhe marca e período, nunca manda SQL.
 *
 * Limites conhecidos (a página mostra o aviso): as consultas do Search Console são guardadas AGREGADAS POR MÊS e só com 10+ impressões no mês, então a divisão
 * branded/não branded e as oportunidades por consulta vêm de meses inteiros; o Pipedrive só liga o negócio à página quando o campo "URL de Conversão" está
 * preenchido; indexação, Core Web Vitals e intenção de busca dependem de fontes ainda não conectadas (PageSpeed / URL Inspection) e voltam nulos.
 */
import type pg from 'pg';

type Db = Pick<pg.Pool, 'query'>;

export const SEO_MARCAS = ['rh', 'clinic'] as const;
export type SeoMarca = (typeof SEO_MARCAS)[number];
export const FONTE_ORGANICO = 'Marketing [Orgânico]';
/** Consulta que contém um destes termos é "de marca" (branded). Os dois produtos usam o nome Quark. */
export const TERMOS_MARCA: Record<SeoMarca, string[]> = { rh: ['quark'], clinic: ['quark'] };
const TZ = 'America/Sao_Paulo';

export class SeoInvalido extends Error {
  constructor(msg: string) { super(msg); this.name = 'SeoInvalido'; }
}

export interface SeoFiltros { marca: SeoMarca; de: string; ate: string }
export interface Par { atual: number | null; anterior: number | null }
export interface SeoAcao {
  id: string; prioridade: 'P0' | 'P1' | 'P2'; tipo: string; impacto: string; titulo: string; desc: string; sinal: string;
  host: string; pagina: string; metrica: string; meta: number | null; hipotese: string; esperado: string; ice: [number, number, number];
}
export interface SeoPagina {
  host: string; pagina: string; impressoes: number; cliques: number; posicao: number | null;
  sessoes: number; leads: number; mql: number; ganhos: number; pipeline: number;
}
export interface SeoConsulta { consulta: string; pagina: string; host: string; impressoes: number; cliques: number; posicao: number; potencial: number }
export interface SeoDados {
  marca: SeoMarca;
  periodo: { de: string; ate: string; anteriorDe: string; anteriorAte: string; ultimoDiaGsc: string | null };
  fontes: Array<{ id: string; nome: string; estado: 'ok' | 'sem_dados'; ate: string | null }>;
  kpis: { cliques: Par; impressoes: Par; ctr: Par; posicao: Par; cliquesNaoBranded: Par; sessoes: Par; leads: Par; mql: Par; ganhos: Par; pipeline: Par; sessaoParaLead: Par };
  funil: { sessoes: number; leads: number; mql: number; ganhos: number };
  serie: Array<{ mes: string; naoBranded: number; branded: number }>;
  paginas: SeoPagina[];
  consultas: SeoConsulta[];
  acoes: SeoAcao[];
  tecnico: null;
  geradoEm: string;
}

export interface SeoRepo { dados(f: SeoFiltros): Promise<SeoDados> }

/* ---------- datas e normalização ---------- */
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const dia = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const somaDias = (s: string, n: number) => iso(new Date(dia(s).getTime() + n * 86_400_000));
const inicioMes = (s: string) => `${s.slice(0, 7)}-01`;

export function validarFiltros(q: { marca?: string | null; de?: string | null; ate?: string | null }): SeoFiltros {
  const marca = q.marca ?? 'rh';
  if (!(SEO_MARCAS as readonly string[]).includes(marca)) throw new SeoInvalido('Produto desconhecido: use rh ou clinic.');
  const de = q.de ?? '', ate = q.ate ?? '';
  if (!DATA.test(de) || !DATA.test(ate) || Number.isNaN(dia(de).getTime()) || Number.isNaN(dia(ate).getTime())) throw new SeoInvalido('Informe o período como AAAA-MM-DD.');
  if (de > ate) throw new SeoInvalido('A data inicial vem depois da final.');
  if ((dia(ate).getTime() - dia(de).getTime()) / 86_400_000 > 400) throw new SeoInvalido('Período longo demais (máximo de 400 dias).');
  return { marca: marca as SeoMarca, de, ate };
}

/** Mesma normalização do Pipedrive e do GA4 (mkt.caminho_url): minúsculas, sem query, sem barra final; raiz = "/". */
export const caminhoNormal = (p: string): string => {
  const s = p.toLowerCase().trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  return s === '' ? '/' : s;
};
export const hostNormal = (h: string | null): string => (h ?? '').toLowerCase().replace(/^www\./, '');

/** CTR esperado por posição (curva média de mercado, arredondada): serve só para ordenar oportunidades, não é meta. */
export function ctrEsperado(pos: number): number {
  const t = [0.28, 0.15, 0.10, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.018, 0.012, 0.01, 0.009, 0.008, 0.007];
  const i = Math.max(1, Math.round(pos));
  return t[i - 1] ?? 0.005;
}

const par = (atual: number | null, anterior: number | null): Par => ({ atual, anterior });
const razao = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/* ---------- ações recomendadas ---------- */
/** Regras simples e explicáveis (cada ação mostra o número que a originou). Cabe ao experimento confirmar a hipótese. */
export function gerarAcoes(paginas: SeoPagina[], consultas: SeoConsulta[]): SeoAcao[] {
  const out: SeoAcao[] = [];
  const nf = new Intl.NumberFormat('pt-BR');
  const pct = (v: number) => `${new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v * 100)}%`;
  const usadas = new Set<string>();

  // 1) CTR abaixo do esperado em consultas nas posições 4 a 10
  for (const c of consultas.filter((x) => x.posicao >= 3.5 && x.posicao <= 10.5 && x.potencial >= 15).slice(0, 3)) {
    const chave = `ctr:${c.host}${c.pagina}`;
    if (usadas.has(chave)) continue;
    usadas.add(chave);
    const alvo = Math.round(c.cliques + c.potencial * 0.5);
    out.push({
      id: `ctr-${c.host}${c.pagina}`.slice(0, 90), prioridade: 'P1', tipo: 'Título e snippet', impacto: 'OPORTUNIDADE · AQUISIÇÃO',
      titulo: `Ganhar CTR em “${c.consulta}”`,
      desc: `Posição ${c.posicao.toFixed(1).replace('.', ',')} com CTR de ${pct(c.cliques / c.impressoes)}, abaixo do esperado para a posição. Testar title e meta description da página.`,
      sinal: `GSC: ${nf.format(c.impressoes)} impressões, ${nf.format(c.cliques)} cliques, posição ${c.posicao.toFixed(1).replace('.', ',')}`,
      host: c.host, pagina: c.pagina, metrica: 'leads', meta: null,
      hipotese: `Reescrever o title e a meta description de ${c.pagina} para a consulta “${c.consulta}” (benefício e prova social) aumenta o CTR e os cliques orgânicos, mantendo a posição.`,
      esperado: `De ${nf.format(c.cliques)} para cerca de ${nf.format(alvo)} cliques por mês na consulta.`, ice: [7, 7, 9],
    });
  }

  // 2) muito tráfego e pouca conversão
  const comTrafego = paginas.filter((p) => p.sessoes >= 300);
  const cvrs = comTrafego.map((p) => p.leads / p.sessoes).sort((a, b) => a - b);
  const mediana = cvrs.length ? cvrs[Math.floor(cvrs.length / 2)]! : 0;
  for (const p of comTrafego.filter((x) => x.leads / x.sessoes < mediana * 0.6).sort((a, b) => b.sessoes - a.sessoes).slice(0, 2)) {
    const cvr = p.leads / p.sessoes;
    const alvoLeads = Math.round(p.sessoes * Math.max(mediana * 0.8, cvr * 1.3));
    out.push({
      id: `cta-${p.host}${p.pagina}`.slice(0, 90), prioridade: 'P2', tipo: 'CRO em conteúdo', impacto: 'ALTO IMPACTO · RECEITA',
      titulo: `Converter melhor o tráfego de ${p.pagina}`,
      desc: `${nf.format(p.sessoes)} sessões orgânicas e conversão de ${pct(cvr)}, contra mediana de ${pct(mediana)} nas páginas com tráfego.`,
      sinal: `GA4 + Pipedrive: ${nf.format(p.sessoes)} sessões, ${p.leads} leads, ${p.mql} MQLs`,
      host: p.host, pagina: p.pagina, metrica: 'leads', meta: alvoLeads,
      hipotese: `Um CTA contextual no meio do texto de ${p.pagina}, em vez de só no rodapé, aumenta a conversão sessão → lead da página.`,
      esperado: `De ${p.leads} para cerca de ${alvoLeads} leads no período, com o mesmo tráfego.`, ice: [8, 6, 8],
    });
  }

  // 3) muita demanda, posição média fora do Top 5
  for (const p of paginas.filter((x) => x.impressoes >= 3000 && x.posicao != null && x.posicao >= 6 && x.posicao <= 15).sort((a, b) => b.impressoes - a.impressoes).slice(0, 2)) {
    out.push({
      id: `pos-${p.host}${p.pagina}`.slice(0, 90), prioridade: 'P2', tipo: 'Conteúdo e links internos', impacto: 'OPORTUNIDADE · AQUISIÇÃO',
      titulo: `Subir ${p.pagina} para o Top 5`,
      desc: `${nf.format(p.impressoes)} impressões com posição média ${p.posicao!.toFixed(1).replace('.', ',')}. Reforçar conteúdo e links internos.`,
      sinal: `GSC: ${nf.format(p.impressoes)} impressões, ${nf.format(p.cliques)} cliques, posição ${p.posicao!.toFixed(1).replace('.', ',')}`,
      host: p.host, pagina: p.pagina, metrica: 'leads', meta: null,
      hipotese: `Links internos contextuais e uma seção de comparação em ${p.pagina} elevam a posição média e os cliques da página.`,
      esperado: 'Posição média abaixo de 5 e aumento dos cliques orgânicos da página.', ice: [6, 5, 7],
    });
  }

  // 4) página que converte bem mas recebe pouco: amplificar
  const bem = paginas.filter((p) => p.sessoes >= 40 && p.sessoes < 300 && p.leads / p.sessoes >= Math.max(mediana * 1.5, 0.05) && p.impressoes >= 500).sort((a, b) => b.leads / b.sessoes - a.leads / a.sessoes).slice(0, 1);
  for (const p of bem) {
    out.push({
      id: `amp-${p.host}${p.pagina}`.slice(0, 90), prioridade: 'P2', tipo: 'Amplificar o que converte', impacto: 'OPORTUNIDADE · CONVERSÃO',
      titulo: `Dar mais tráfego a ${p.pagina}`,
      desc: `Converte ${pct(p.leads / p.sessoes)} (acima da mediana de ${pct(mediana)}) mas recebe só ${nf.format(p.sessoes)} sessões. Mais links internos e variações de título.`,
      sinal: `GA4 + Pipedrive: ${nf.format(p.sessoes)} sessões, ${p.leads} leads`,
      host: p.host, pagina: p.pagina, metrica: 'leads', meta: Math.round(p.leads * 1.5),
      hipotese: `Mais links internos e chamadas para ${p.pagina} nas páginas de maior tráfego aumentam as sessões orgânicas dela e, com a mesma conversão, os leads.`,
      esperado: `Cerca de ${Math.round(p.leads * 1.5)} leads no período (hoje ${p.leads}).`, ice: [7, 6, 8],
    });
  }
  return out;
}

/* ---------- repositório ---------- */
export class PgSeoRepo implements SeoRepo {
  private readonly cache = new Map<string, { ate: number; valor: Promise<SeoDados> }>();
  constructor(private readonly db: Db) {}

  dados(f: SeoFiltros): Promise<SeoDados> {
    const chave = `${f.marca}|${f.de}|${f.ate}`;
    const agora = Date.now();
    const c = this.cache.get(chave);
    if (c && c.ate > agora) return c.valor;
    const valor = this.calcular(f);
    this.cache.set(chave, { ate: agora + 5 * 60_000, valor });
    valor.catch(() => { if (this.cache.get(chave)?.valor === valor) this.cache.delete(chave); }); // erro não fica guardado
    return valor;
  }

  private async calcular(f: SeoFiltros): Promise<SeoDados> {
    const q = async <T extends object>(sql: string, params: unknown[]): Promise<T[]> => (await this.db.query(sql, params)).rows as T[];
    const marca = f.marca;

    // o Search Console entrega o dado final com ~3 dias de atraso: o período termina no último dia que ele tem
    const [ult] = await q<{ d: string | null }>(`select max(dia)::text as d from analytics.gsc_pagina_dia where marca = $1`, [marca]);
    const ultimoGsc = ult?.d ?? null;
    const ate = ultimoGsc && ultimoGsc < f.ate ? ultimoGsc : f.ate;
    const de = f.de > ate ? ate : f.de;
    const dias = Math.round((dia(ate).getTime() - dia(de).getTime()) / 86_400_000) + 1;
    const antAte = somaDias(de, -1), antDe = somaDias(antAte, -(dias - 1));
    const termos = TERMOS_MARCA[marca].map((t) => `%${t.replace(/[%_\\]/g, '\\$&')}%`);
    const mesDe = [inicioMes(antDe), inicioMes(somaDias(inicioMes(ate), -150))].sort()[0]!; // a série mostra 6 meses; os períodos comparados podem precisar de mais

    // GSC: totais dos dois períodos
    const gscTot = await q<{ per: string; cl: string; im: string; px: string }>(
      `select case when dia between $2::date and $3::date then 'a' else 'b' end as per, sum(cliques) cl, sum(impressoes) im, sum(posicao * impressoes) px
         from analytics.gsc_pagina_dia where marca = $1 and dia between $4::date and $3::date group by 1`, [marca, de, ate, antDe]);
    const gs = (per: string) => { const r = gscTot.find((x) => x.per === per); return { cl: Number(r?.cl ?? 0), im: Number(r?.im ?? 0), px: Number(r?.px ?? 0) }; };
    const ga = gs('a'), gb = gs('b');

    // GSC: serie mensal branded x nao branded (consultas sao mensais) e participacao no periodo
    const meses = await q<{ mes: string; marcado: boolean; cl: string }>(
      `select dia::text as mes, (consulta ilike any ($2::text[])) as marcado, sum(cliques) cl
         from analytics.gsc_consulta_dia where marca = $1 and dia >= $3::date group by 1, 2 order by 1`, [marca, termos, mesDe]);
    const porMes = new Map<string, { n: number; b: number }>();
    for (const m of meses) { const x = porMes.get(m.mes) ?? { n: 0, b: 0 }; if (m.marcado) x.b += Number(m.cl); else x.n += Number(m.cl); porMes.set(m.mes, x); }
    const serie = [...porMes.entries()].map(([mes, v]) => ({ mes, naoBranded: v.n, branded: v.b })).slice(-6);
    const partNB = (de1: string, ate1: string): number | null => {
      let n = 0, t = 0;
      for (const [mes, v] of porMes) if (mes >= inicioMes(de1) && mes <= ate1) { n += v.n; t += v.n + v.b; }
      return t > 0 ? n / t : null;
    };
    const pa = partNB(de, ate), pb = partNB(antDe, antAte);

    // GA4: sessoes organicas da marca (total e por pagina)
    const sessTot = await q<{ per: string; s: string }>(
      `select case when s.dia between $2::date and $3::date then 'a' else 'b' end as per, sum(s.sessoes) s
         from analytics.site_sessoes_dia s join analytics.ga4_propriedades p on p.property_id = s.property_id
        where p.marca = $1 and s.midia = 'organic' and s.dia between $4::date and $3::date group by 1`, [marca, de, ate, antDe]);
    const sess = (per: string) => Number(sessTot.find((x) => x.per === per)?.s ?? 0);
    const sessPag = await q<{ host: string; caminho: string; s: string }>(
      `select s.host, s.caminho, sum(s.sessoes) s from analytics.site_sessoes_dia s join analytics.ga4_propriedades p on p.property_id = s.property_id
        where p.marca = $1 and s.midia = 'organic' and s.dia between $2::date and $3::date group by 1, 2`, [marca, de, ate]);
    const [ga4Ate] = await q<{ d: string | null }>(`select max(s.dia)::text d from analytics.site_sessoes_dia s join analytics.ga4_propriedades p on p.property_id = s.property_id where p.marca = $1`, [marca]);

    // Pipedrive: negocios de fonte Organico criados no periodo (coorte pela data de criacao, fuso de Sao Paulo)
    const neg = await q<{ per: string; leads: string; mql: string; ganhos: string; valor: string }>(
      `select case when (criado_em at time zone '${TZ}')::date between $3::date and $4::date then 'a' else 'b' end as per,
              count(*) filter (where conta_como_lead) leads, count(*) filter (where conta_como_lead and is_mql) mql,
              count(*) filter (where status = 'won') ganhos, coalesce(sum(valor) filter (where conta_como_lead), 0) valor
         from analytics.negocios_bi where produto = $1 and fonte = $2 and (criado_em at time zone '${TZ}')::date between $5::date and $4::date group by 1`, [marca, FONTE_ORGANICO, de, ate, antDe]);
    const nv = (per: string) => { const r = neg.find((x) => x.per === per); return { leads: Number(r?.leads ?? 0), mql: Number(r?.mql ?? 0), ganhos: Number(r?.ganhos ?? 0), valor: Number(r?.valor ?? 0) }; };
    const na = nv('a'), nb = nv('b');
    const [pdAte] = await q<{ d: string | null }>(`select max((criado_em at time zone '${TZ}')::date)::text d from analytics.negocios_bi where produto = $1 and fonte = $2`, [marca, FONTE_ORGANICO]);
    const negPag = await q<{ host: string; caminho: string; leads: string; mql: string; ganhos: string; valor: string }>(
      `select u.host_url as host, u.caminho_url as caminho, count(*) filter (where u.conta_como_lead) leads, count(*) filter (where u.conta_como_lead and u.is_mql) mql,
              count(*) filter (where u.status = 'won') ganhos, coalesce(sum(u.valor) filter (where u.conta_como_lead), 0) valor
         from analytics.negocios_url u join analytics.negocios_bi b on b.deal_id = u.deal_id
        where u.tem_url and u.url_valida and b.produto = $1 and b.fonte = $2 and (b.criado_em at time zone '${TZ}')::date between $3::date and $4::date group by 1, 2`, [marca, FONTE_ORGANICO, de, ate]);

    // GSC por pagina (as 1.500 com mais impressoes) e por consulta (3 ultimos meses inteiros ate o periodo)
    const gscPag = await q<{ host: string; pagina: string; cl: string; im: string; px: string }>(
      `select host, pagina, sum(cliques) cl, sum(impressoes) im, sum(posicao * impressoes) px from analytics.gsc_pagina_dia
        where marca = $1 and dia between $2::date and $3::date group by 1, 2 order by sum(impressoes) desc limit 1500`, [marca, de, ate]);
    const mesConsultaDe = inicioMes(somaDias(inicioMes(ate), -62));
    const cons = await q<{ consulta: string; host: string; pagina: string; im: string; cl: string; px: string }>(
      `select consulta, host, pagina, sum(impressoes) im, sum(cliques) cl, sum(posicao * impressoes) px from analytics.gsc_consulta_dia
        where marca = $1 and dia >= $2::date and dia <= $3::date and not (consulta ilike any ($4::text[]))
        group by 1, 2, 3 having sum(impressoes) >= 200 order by sum(impressoes) desc limit 600`, [marca, mesConsultaDe, ate, termos]);

    // junta tudo por (host sem www, caminho normalizado)
    const mapa = new Map<string, SeoPagina & { px: number }>();
    const pegar = (host: string, caminho: string) => {
      const h = hostNormal(host), c = caminhoNormal(caminho), k = `${h}|${c}`;
      let x = mapa.get(k);
      if (!x) { x = { host: h, pagina: c, impressoes: 0, cliques: 0, posicao: null, sessoes: 0, leads: 0, mql: 0, ganhos: 0, pipeline: 0, px: 0 }; mapa.set(k, x); }
      return x;
    };
    for (const r of gscPag) { const x = pegar(r.host, r.pagina); x.impressoes += Number(r.im); x.cliques += Number(r.cl); x.px += Number(r.px); }
    for (const r of sessPag) pegar(r.host, r.caminho).sessoes += Number(r.s);
    for (const r of negPag) { const x = pegar(r.host, r.caminho); x.leads += Number(r.leads); x.mql += Number(r.mql); x.ganhos += Number(r.ganhos); x.pipeline += Number(r.valor); }
    const paginas: SeoPagina[] = [...mapa.values()]
      .map(({ px, ...x }) => ({ ...x, posicao: x.impressoes > 0 ? px / x.impressoes : null }))
      .filter((x) => x.impressoes > 0 || x.sessoes > 0 || x.leads > 0)
      .sort((a, b) => b.pipeline - a.pipeline || b.leads - a.leads || b.sessoes - a.sessoes || b.cliques - a.cliques)
      .slice(0, 300);

    const consultas: SeoConsulta[] = cons.map((r) => {
      const im = Number(r.im), cl = Number(r.cl), pos = Number(r.px) / im;
      return { consulta: r.consulta, host: hostNormal(r.host), pagina: caminhoNormal(r.pagina), impressoes: im, cliques: cl, posicao: pos, potencial: Math.max(0, Math.round(im * ctrEsperado(pos) - cl)) };
    }).sort((a, b) => b.potencial - a.potencial);
    const consultasTop = consultas.filter((c) => c.posicao >= 3 && c.posicao <= 20).slice(0, 30);

    const ctr = (x: { cl: number; im: number }) => razao(x.cl, x.im);
    const posicao = (x: { px: number; im: number }) => razao(x.px, x.im);
    return {
      marca,
      periodo: { de, ate, anteriorDe: antDe, anteriorAte: antAte, ultimoDiaGsc: ultimoGsc },
      fontes: [
        { id: 'gsc', nome: `Search Console ${marca === 'rh' ? 'QuarkRH' : 'QuarkClinic'}`, estado: ultimoGsc ? 'ok' : 'sem_dados', ate: ultimoGsc },
        { id: 'ga4', nome: 'Google Analytics 4', estado: ga4Ate?.d ? 'ok' : 'sem_dados', ate: ga4Ate?.d ?? null },
        { id: 'pipedrive', nome: 'Pipedrive (negócios orgânicos)', estado: pdAte?.d ? 'ok' : 'sem_dados', ate: pdAte?.d ?? null },
        { id: 'pagespeed', nome: 'PageSpeed / CrUX', estado: 'sem_dados', ate: null },
      ],
      kpis: {
        cliques: par(ga.cl, gb.cl), impressoes: par(ga.im, gb.im), ctr: par(ctr(ga), ctr(gb)), posicao: par(posicao(ga), posicao(gb)),
        cliquesNaoBranded: par(pa == null ? null : Math.round(ga.cl * pa), pb == null ? null : Math.round(gb.cl * pb)),
        sessoes: par(sess('a'), sess('b')), leads: par(na.leads, nb.leads), mql: par(na.mql, nb.mql), ganhos: par(na.ganhos, nb.ganhos), pipeline: par(na.valor, nb.valor),
        sessaoParaLead: par(razao(na.leads, sess('a')), razao(nb.leads, sess('b'))),
      },
      funil: { sessoes: sess('a'), leads: na.leads, mql: na.mql, ganhos: na.ganhos },
      serie,
      paginas,
      consultas: consultasTop,
      acoes: gerarAcoes(paginas, consultasTop),
      tecnico: null,
      geradoEm: new Date().toISOString(),
    };
  }
}
