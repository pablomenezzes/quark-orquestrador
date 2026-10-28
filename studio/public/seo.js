/**
 * Página SEO: visão executiva, páginas, oportunidades e técnico. Por enquanto TUDO é dado de exemplo (constante DADOS); a próxima etapa é trocar
 * DADOS por uma chamada a /api/seo (Search Console + GA4 + Pipedrive + PageSpeed). Cada ação recomendada tem o gatilho "Gerar experimento":
 * guarda o rascunho em sessionStorage ('exp.prefill') e abre /experimentos?novo=1, que abre o cadastro já preenchido.
 */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = new Intl.NumberFormat('pt-BR');
const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const pct = (v, d = 1) => `${new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v * 100)}%`;

/** Cada produto tem o seu site e o seu Search Console (marca rh e clinic em mkt.gsc_*). */
const HOSTS = { rh: 'quarkrh.com.br', clinic: 'quarkclinic.com.br' };
const DADOS = {
  fontes: [
    { nome: 'Search Console QuarkRH', estado: 'parcial', nota: 'sync pronto; falta dar acesso e preencher GSC_SITE_URL' },
    { nome: 'Search Console QuarkClinic', estado: 'parcial', nota: 'sync pronto; falta dar acesso e preencher GSC_SITE_URL_CLINIC' },
    { nome: 'Google Analytics 4', estado: 'ok', nota: 'já sincroniza no Data Hub' },
    { nome: 'Pipedrive (leads, MQL, pipeline)', estado: 'ok', nota: 'já sincroniza no Data Hub' },
    { nome: 'PageSpeed / CrUX', estado: 'falta' },
  ],
  kpis: [
    { n: 'MQLs orgânicos', v: '75', d: 0.103, fonte: 'Pipedrive' },
    { n: 'Pipeline originado por SEO', v: brl.format(322000), d: 0.126, fonte: 'Pipedrive' },
    { n: 'Cliques não branded', v: nf.format(17050), d: 0.046, fonte: 'GSC' },
    { n: 'Conversão sessão → lead', v: pct(0.025, 2), d: 0.0013, pp: true, fonte: 'GA4 + Pipedrive' },
    { n: 'Sessões orgânicas', v: nf.format(24500), d: 0.021, fonte: 'GA4' },
    { n: 'Keywords estratégicas no Top 10', v: '199', d: 0.047, fonte: 'GSC' },
    { n: 'URLs boas em Core Web Vitals', v: '76%', d: -0.06, pp: true, fonte: 'CrUX' },
    { n: 'Indexação de URLs estratégicas', v: '97,4%', d: -0.008, pp: true, fonte: 'GSC' },
  ],
  meses: ['Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out'],
  naoBranded: [12900, 13600, 14500, 15500, 16300, 17050],
  branded: [6900, 7100, 7300, 7600, 8300, 8350],
  funil: [['Sessões', 24500], ['Leads', 612], ['MQLs', 75], ['SQLs', 34]],
  intencoes: [
    { n: 'Comercial / transacional', s: 7500, l: 320, mql: 46, p: 212000, dx: ['bom', 'Mais eficiente'] },
    { n: 'Informacional', s: 12800, l: 180, mql: 17, p: 64000, dx: ['atencao', 'Nutrir melhor'] },
    { n: 'Navegacional', s: 4200, l: 112, mql: 12, p: 46000, dx: ['', 'Estável'] },
  ],
  paginas: [
    { url: '/gestao-de-pessoas', cluster: 'Gestão de pessoas', intencao: 'Informacional', imp: 122000, cliques: 5300, pos: 3.9, sessoes: 5400, leads: 110, mql: 9, pipeline: 18000, lcp: 2.1, inp: 180, cwv: 'bom' },
    { url: '/software-rh', cluster: 'Software de RH', intencao: 'Comercial', imp: 42500, cliques: 1120, pos: 5.4, sessoes: 3400, leads: 125, mql: 23, pipeline: 96000, lcp: 2.6, inp: 260, cwv: 'ruim' },
    { url: '/controle-de-ponto', cluster: 'Controle de ponto', intencao: 'Comercial', imp: 35600, cliques: 980, pos: 7.1, sessoes: 2850, leads: 93, mql: 14, pipeline: 61000, lcp: 2.3, inp: 230, cwv: 'atencao' },
    { url: '/blog/indicadores-rh', cluster: 'Indicadores de RH', intencao: 'Informacional', imp: 40000, cliques: 1450, pos: 6.5, sessoes: 2450, leads: 45, mql: 5, pipeline: 9000, lcp: 1.9, inp: 150, cwv: 'bom' },
    { url: '/diagnostico-maturidade', cluster: 'Diagnóstico de maturidade', intencao: 'Conversão', imp: 8200, cliques: 640, pos: 4.2, sessoes: 1150, leads: 105, mql: 17, pipeline: 52000, lcp: 2.2, inp: 190, cwv: 'bom' },
    { url: '/departamento-pessoal', cluster: 'Departamento pessoal', intencao: 'Comercial', imp: 31500, cliques: 870, pos: 8.2, sessoes: 1320, leads: 28, mql: 4, pipeline: 14000, lcp: 3.1, inp: 310, cwv: 'ruim' },
  ],
  consultas: [
    { q: 'software para gestão de rh', intencao: 'Comercial', imp: 42500, cliques: 1120, pos: 5.4, pagina: '/software-rh' },
    { q: 'sistema de ponto eletrônico', intencao: 'Comercial', imp: 35600, cliques: 980, pos: 7.1, pagina: '/controle-de-ponto' },
    { q: 'software de departamento pessoal', intencao: 'Comercial', imp: 31500, cliques: 870, pos: 8.2, pagina: '/departamento-pessoal' },
    { q: 'indicadores de rh', intencao: 'Informacional', imp: 40000, cliques: 1450, pos: 6.5, pagina: '/blog/indicadores-rh' },
    { q: 'gestão de pessoas', intencao: 'Informacional', imp: 122000, cliques: 5300, pos: 3.9, pagina: '/gestao-de-pessoas' },
  ],
  acoes: [
    {
      id: 'ctr-bofu', prioridade: 'P1', tipo: 'Título e snippet', impacto: 'OPORTUNIDADE · AQUISIÇÃO', titulo: 'Ganhar CTR em buscas comerciais (posições 4 a 10)',
      desc: 'As 3 consultas comerciais com mais impressões estão entre as posições 5 e 8 com CTR abaixo de 3%. Testar title e meta description em /software-rh.',
      pagina: '/software-rh', metrica: 'leads', meta: 140, hipotese: 'Reescrever title e meta description de /software-rh com benefício e prova social aumenta o CTR em consultas comerciais e, com a mesma posição, os leads orgânicos da página.',
      esperado: '+12% de leads orgânicos na página em 30 dias (de 125 para 140).', ice: [7, 7, 9], sinal: 'GSC: 42,5 mil impressões, CTR 2,6%, posição 5,4',
    },
    {
      id: 'cta-info', prioridade: 'P2', tipo: 'CRO em conteúdo', impacto: 'ALTO IMPACTO · RECEITA', titulo: 'CTA contextual no conteúdo informacional de maior tráfego',
      desc: '/gestao-de-pessoas lidera o tráfego (5,4 mil sessões) mas converte 2,0%, contra 4,3% das páginas comerciais.',
      pagina: '/gestao-de-pessoas', metrica: 'leads', meta: 150, hipotese: 'Um CTA no meio do texto para o diagnóstico de maturidade, em vez de só o rodapé, aumenta a conversão sessão → lead da página.',
      esperado: 'Conversão de 2,0% para 2,8% (cerca de 150 leads por mês).', ice: [8, 6, 8], sinal: 'GA4 + Pipedrive: 5.400 sessões, 110 leads, 9 MQLs',
    },
    {
      id: 'inp-bofu', prioridade: 'P1', tipo: 'Performance', impacto: 'ALTA PRIORIDADE · EXPERIÊNCIA', titulo: 'Reduzir INP nas páginas comerciais',
      desc: '/software-rh e /departamento-pessoal têm INP acima de 250 ms no celular. É o que mais puxa as URLs boas em CWV para baixo.',
      pagina: '/software-rh', metrica: 'txLead', meta: 0.04, hipotese: 'Adiar scripts de terceiros e reduzir o JavaScript da página melhora o INP para menos de 200 ms e a taxa de conversão no celular.',
      esperado: 'INP p75 ≤ 200 ms e taxa até o lead de 3,7% para 4,0%.', ice: [6, 7, 5], sinal: 'PageSpeed: INP 260 ms, LCP 2,6 s',
    },
    {
      id: 'form-diag', prioridade: 'P2', tipo: 'Teste de formulário', impacto: 'OPORTUNIDADE · CONVERSÃO', titulo: 'Testar formulário curto no diagnóstico de maturidade',
      desc: 'A página tem a melhor conversão (9,1%) e posição média 4,2. Reduzir campos pode elevar os MQLs sem mexer em tráfego.',
      pagina: '/diagnostico-maturidade', metrica: 'mql', meta: 22, hipotese: 'Retirar dois campos do formulário aumenta o envio sem derrubar a qualificação (% MQL).',
      esperado: 'MQLs da página de 17 para 22 por mês, mantendo o % MQL.', ice: [7, 6, 9], sinal: 'GA4 + Pipedrive: 1.150 sessões, 105 leads, 17 MQLs',
    },
    {
      id: 'links-dp', prioridade: 'P2', tipo: 'Conteúdo e links internos', impacto: 'OPORTUNIDADE · AQUISIÇÃO', titulo: 'Subir /departamento-pessoal da posição 8 para o Top 5',
      desc: 'Boa demanda (31,5 mil impressões) e posição 8,2. Reforçar conteúdo e links internos a partir dos artigos de apoio.',
      pagina: '/departamento-pessoal', metrica: 'leads', meta: 45, hipotese: 'Links internos contextuais e uma seção de comparação elevam a posição média e os cliques da página.',
      esperado: 'Posição média abaixo de 6 e 45 leads por mês (hoje 28).', ice: [6, 5, 7], sinal: 'GSC: 31,5 mil impressões, posição 8,2',
    },
    {
      id: 'indexacao', prioridade: 'P0', tipo: 'Técnico', impacto: 'ALTO IMPACTO · BASE TÉCNICA', titulo: 'Recuperar 13 URLs estratégicas fora do índice',
      desc: '7 com canonical inconsistente, 4 com noindex não intencional e 2 soft 404. Corrigir antes de qualquer outro teste.',
      pagina: '', metrica: '', meta: null, hipotese: 'Corrigir canonical, noindex e soft 404 nas 13 URLs devolve cobertura comercial e sobe as sessões orgânicas.',
      esperado: 'Indexação das URLs estratégicas de 97,4% para 100%.', ice: [8, 8, 6], sinal: 'GSC: 487 de 500 URLs indexadas',
    },
  ],
  indexacao: { ok: 487, total: 500, motivos: [['Canonical inconsistente', 7], ['noindex não intencional', 4], ['Soft 404', 2]] },
  cwv: { bomPct: 0.76, vitais: [['LCP', '2,2 s', 'bom', 'meta ≤ 2,5 s'], ['INP', '240 ms', 'atencao', 'meta ≤ 200 ms'], ['CLS', '0,08', 'bom', 'meta ≤ 0,1']] },
  auditoria: [['URLs comerciais com INP inadequado', 18], ['Problemas críticos de rastreamento', 0], ['Links internos quebrados (amostra)', 6]],
  integracoes: [
    ['Google Search Console', 'Cliques, impressões, CTR, posição por consulta e por página; cobertura de indexação. Precisa da API do Search Console (conta de serviço com acesso à propriedade) e de um sync diário, como o do GA4.'],
    ['PageSpeed / CrUX', 'LCP, INP e CLS por URL (campo e laboratório). Precisa de uma chave da PageSpeed Insights API e da lista de URLs estratégicas para consultar.'],
    ['GA4 por landing page', 'Sessões e conversões do canal Organic Search por página de entrada. O sync do GA4 já existe: falta confirmar se traz a dimensão de landing page.'],
    ['Pipedrive por página', 'Leads, MQLs e pipeline por página de entrada. Depende do campo “URL de Conversão” (e UTMs) preenchido nos negócios: o Experimentos já filtra por ele.'],
    ['Classificação de intenção e marca', 'Lista de termos da marca (para separar branded) e regra de intenção por página ou cluster. Pode ser uma tabela simples no banco, editável aqui.'],
    ['Rank tracking (opcional)', 'Posição das keywords estratégicas fora do que o GSC mostra. Só se quiserem monitorar termos sem impressão ainda.'],
  ],
};

const S = { produto: 'rh', aba: 'exec', busca: '', intencao: '', ordem: { col: 'pipeline', dir: -1 } };

/* ---------- gatilho: gerar experimento a partir da ação ---------- */
function rascunhoExperimento(a) {
  const nome = a.pagina ? `${a.titulo} (${a.pagina})` : a.titulo;
  return {
    titulo: nome.slice(0, 160), tipo: 'experimento', areaImpacto: 'SEO', produto: S.produto, canal: 'organico', status: 'backlog',
    hipotese: a.hipotese, resultadoEsperado: a.esperado, metrica: a.metrica || '', meta: a.meta, ice: a.ice,
    paginaDestino: a.pagina ? `${HOSTS[S.produto]}${a.pagina}` : '', origem: `SEO · ${a.sinal}`,
  };
}
function gerarExperimento(id) {
  const a = DADOS.acoes.find((x) => x.id === id);
  if (!a) return;
  try { sessionStorage.setItem('exp.prefill', JSON.stringify(rascunhoExperimento(a))); } catch { /* sem armazenamento: abre o cadastro vazio */ }
  location.assign('/experimentos?novo=1');
}

/* ---------- componentes ---------- */
function delta(k) {
  const bom = k.d >= 0;
  const txt = k.pp ? `${k.d > 0 ? '+' : k.d < 0 ? '−' : ''}${nf1.format(Math.abs(k.d) * 100)} p.p.` : `${k.d > 0 ? '+' : '−'}${nf1.format(Math.abs(k.d) * 100)}%`;
  return `<b class="${bom ? 'bom' : 'ruim'}">${bom ? '▲' : '▼'} ${txt}</b> vs. período anterior`;
}
function kpis() {
  return `<div class="kpis">${DADOS.kpis.map((k) => `<div class="kpi"><div class="n"><span>${esc(k.n)}</span><em>${esc(k.fonte)}</em></div><div class="v">${esc(k.v)}</div><div class="d">${delta(k)}</div></div>`).join('')}</div>`;
}
function linhas() {
  const W = 640, H = 200, p = { l: 40, r: 12, t: 14, b: 26 }, ymax = 20000;
  const x = (i) => p.l + (i * (W - p.l - p.r)) / 5, y = (v) => H - p.b - (v / ymax) * (H - p.b - p.t);
  let s = `<svg class="lin" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cliques orgânicos branded e não branded nos últimos seis meses">`;
  for (const v of [0, 5000, 10000, 15000, 20000]) s += `<line x1="${p.l}" y1="${y(v)}" x2="${W - p.r}" y2="${y(v)}" stroke="var(--s-grid)"/><text x="${p.l - 8}" y="${y(v) + 4}" text-anchor="end">${v ? `${v / 1000} mil` : '0'}</text>`;
  DADOS.meses.forEach((m, i) => { s += `<text x="${x(i)}" y="${H - 7}" text-anchor="middle">${m}</text>`; });
  for (const [dados, cor] of [[DADOS.naoBranded, 'var(--s-a)'], [DADOS.branded, 'var(--s-b)']]) {
    const pts = dados.map((v, i) => `${x(i)},${y(v)}`);
    s += `<polyline points="${pts.join(' ')}" fill="none" stroke="${cor}" stroke-width="2.5" stroke-linejoin="round"/>`;
    dados.forEach((v, i) => { s += `<circle cx="${x(i)}" cy="${y(v)}" r="${i === 5 ? 4.5 : 3}" fill="var(--s-surface)" stroke="${cor}" stroke-width="2"><title>${DADOS.meses[i]}: ${nf.format(v)}</title></circle>`; });
  }
  return `${s}</svg>`;
}
function funil() {
  const max = DADOS.funil[0][1];
  return `<div class="funil">${DADOS.funil.map(([n, v], i) => `<div class="passo"><span>${n}</span><span><i class="fill" style="display:block;width:${Math.max(2, (v / max) * 100)}%;opacity:${1 - i * 0.18}"></i></span><span class="n">${nf.format(v)}</span></div>`).join('')}</div>
    <p class="nota">Sessão → lead ${pct(612 / 24500, 2)} · lead → MQL ${pct(75 / 612)} · MQL → SQL ${pct(34 / 75)}</p>`;
}
function cartaoAcao(a, compacto) {
  return `<div class="acao"><div class="rod"><span class="pill ${a.prioridade === 'P0' ? 'ruim' : a.prioridade === 'P1' ? 'atencao' : ''}">${a.prioridade}</span><span class="pill">${esc(a.tipo)}</span></div>
    <strong>${esc(a.titulo)}</strong><p>${esc(a.desc)}</p>${compacto ? '' : `<p class="dica-cvr">Sinal: ${esc(a.sinal)}</p>`}
    <span class="imp">${esc(a.impacto)}</span>
    <div class="rod"><button type="button" class="btn small primary" data-gerar="${esc(a.id)}" title="Abre o cadastro de Experimentos já preenchido com esta ação">Gerar experimento</button>${a.pagina ? `<span class="muted mono">${esc(a.pagina)}</span>` : ''}</div></div>`;
}

/* ---------- abas ---------- */
function abaExec() {
  const top = [...DADOS.acoes].sort((x, y) => x.prioridade.localeCompare(y.prioridade)).slice(0, 3);
  return `<div class="secao"><h2>Indicadores essenciais</h2><span>8 métricas para decisão</span></div>${kpis()}
    <div class="par"><article class="card2"><span class="tag">GSC · 6 meses</span><h3>Evolução de cliques orgânicos</h3><p class="sub">O crescimento vem de público novo ou da demanda pela marca?</p>
      <div class="legenda"><span><i style="background:var(--s-a)"></i>Não branded</span><span><i style="background:var(--s-b)"></i>Branded</span></div>${linhas()}</article>
    <article class="card2"><span class="tag">GA4 + Pipedrive</span><h3>Funil de aquisição orgânica</h3><p class="sub">Volume versus avanço para o comercial</p>${funil()}</article></div>
    <article class="card2" style="margin-top:12px"><h3>Fila prioritária · o que merece atenção agora</h3><p class="sub">Cada ação pode virar um experimento com hipótese, meta e página já preenchidas.</p><div class="acoes">${top.map((a) => cartaoAcao(a, true)).join('')}</div></article>`;
}
function ordenar(lista) {
  const { col, dir } = S.ordem;
  return [...lista].sort((a, b) => {
    const va = col === 'cvr' ? a.leads / a.sessoes : a[col], vb = col === 'cvr' ? b.leads / b.sessoes : b[col];
    return typeof va === 'string' ? dir * va.localeCompare(vb) : dir * (va - vb);
  });
}
function cab(col, rot, num) { const a = S.ordem.col === col; return `<th class="sc ${num ? 'num' : ''}" tabindex="0" data-ord="${col}" ${a ? `aria-sort="${S.ordem.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${rot}${a ? (S.ordem.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`; }
function acaoDaPagina(url) { return DADOS.acoes.find((a) => a.pagina === url); }
function tabelaPaginas() {
  const q = S.busca.toLowerCase().trim();
  const lista = ordenar(DADOS.paginas.filter((p) => (!S.intencao || p.intencao === S.intencao) && (!q || `${p.url} ${p.cluster}`.toLowerCase().includes(q))));
  const linhasHtml = lista.map((p) => {
    const a = acaoDaPagina(p.url);
    return `<tr><td><strong>${esc(p.url)}</strong><small>${esc(p.cluster)}</small></td><td><span class="pill">${esc(p.intencao)}</span></td>
      <td class="num">${nf.format(p.imp)}</td><td class="num">${nf.format(p.cliques)}</td><td class="num">${pct(p.cliques / p.imp)}</td><td class="num">${nf1.format(p.pos)}</td>
      <td class="num">${nf.format(p.sessoes)}</td><td class="num">${p.leads}</td><td class="num">${pct(p.leads / p.sessoes, 2)}</td><td class="num">${p.mql}</td><td class="num">${brl.format(p.pipeline)}</td>
      <td><span class="pill ${p.cwv}">${p.cwv === 'bom' ? 'Bom' : p.cwv === 'atencao' ? 'Melhorar' : 'Ruim'}</span><small>LCP ${nf1.format(p.lcp)} s · INP ${p.inp} ms</small></td>
      <td>${a ? `<button type="button" class="btn small" data-gerar="${esc(a.id)}">Gerar experimento</button><small>${esc(a.tipo)}</small>` : '<span class="muted">—</span>'}</td></tr>`;
  }).join('');
  return `<div class="tabela-wrap"><table class="t" style="min-width:1100px"><thead><tr>${cab('url', 'Página')}${cab('intencao', 'Intenção')}${cab('imp', 'Impressões', 1)}${cab('cliques', 'Cliques', 1)}<th class="num">CTR</th>${cab('pos', 'Posição', 1)}${cab('sessoes', 'Sessões', 1)}${cab('leads', 'Leads', 1)}${cab('cvr', 'CVR', 1)}${cab('mql', 'MQLs', 1)}${cab('pipeline', 'Pipeline', 1)}<th>Velocidade</th><th>Ação recomendada</th></tr></thead>
    <tbody>${linhasHtml || '<tr><td colspan="13" class="vazio">Nenhuma página para o filtro aplicado.</td></tr>'}</tbody></table></div>`;
}
function abaPaginas() {
  const melhor = [...DADOS.paginas].sort((a, b) => b.pipeline - a.pipeline)[0];
  const gap = [...DADOS.paginas].filter((p) => p.sessoes > 2000).sort((a, b) => a.leads / a.sessoes - b.leads / b.sessoes)[0];
  return `<div class="secao"><h2>Melhores páginas</h2><span>tráfego orgânico que vira lead, MQL e pipeline</span></div>
    <div class="stats4">
      <div class="kpi"><div class="n"><span>Maior pipeline</span></div><div class="v" style="font-size:20px">${esc(melhor.url)}</div><div class="d">${brl.format(melhor.pipeline)} · ${melhor.mql} MQLs</div></div>
      <div class="kpi"><div class="n"><span>Maior tráfego com baixa conversão</span></div><div class="v" style="font-size:20px">${esc(gap.url)}</div><div class="d">${nf.format(gap.sessoes)} sessões · CVR ${pct(gap.leads / gap.sessoes, 2)}</div></div>
      <div class="kpi"><div class="n"><span>Páginas monitoradas</span></div><div class="v">${DADOS.paginas.length}</div><div class="d">landing pages orgânicas</div></div>
      <div class="kpi"><div class="n"><span>Com ação sugerida</span></div><div class="v">${DADOS.paginas.filter((p) => acaoDaPagina(p.url)).length}</div><div class="d">prontas para virar experimento</div></div>
    </div>
    <article class="card2" style="margin-top:12px"><span class="tag">GSC + GA4 + Pipedrive + PageSpeed</span><h3>Landing pages orgânicas</h3><p class="sub">Ordene por qualquer coluna. A velocidade vem do PageSpeed; os leads, do Pipedrive.</p>
      <div class="busca"><input id="busca" type="search" placeholder="Buscar URL ou cluster…" aria-label="Buscar página ou cluster" value="${esc(S.busca)}">
      <select id="f-int" aria-label="Filtrar intenção"><option value="">Todas as intenções</option>${['Comercial', 'Informacional', 'Conversão'].map((i) => `<option ${S.intencao === i ? 'selected' : ''}>${i}</option>`).join('')}</select></div>
      <div id="tab-paginas">${tabelaPaginas()}</div></article>
    <article class="card2" style="margin-top:12px"><span class="tag">GA4 + Pipedrive</span><h3>Desempenho por intenção de busca</h3><p class="sub">O crescimento está em intenção comercial ou em consumo informacional?</p>
      <div class="tabela-wrap"><table class="t" style="min-width:640px"><thead><tr><th>Intenção</th><th class="num">Sessões</th><th class="num">Leads</th><th class="num">CVR</th><th class="num">MQLs</th><th class="num">Pipeline</th><th>Diagnóstico</th></tr></thead><tbody>
      ${DADOS.intencoes.map((i) => `<tr><td><strong>${i.n}</strong></td><td class="num">${nf.format(i.s)}</td><td class="num">${i.l}</td><td class="num">${pct(i.l / i.s, 2)}</td><td class="num">${i.mql}</td><td class="num">${brl.format(i.p)}</td><td><span class="pill ${i.dx[0]}">${i.dx[1]}</span></td></tr>`).join('')}</tbody></table></div></article>`;
}
function abaOportunidades() {
  const ordem = { P0: 0, P1: 1, P2: 2 };
  const acoes = [...DADOS.acoes].sort((a, b) => ordem[a.prioridade] - ordem[b.prioridade]);
  return `<div class="secao"><h2>Oportunidades e testes</h2><span>${acoes.length} ações com hipótese e meta sugeridas</span></div>
    <div class="acoes">${acoes.map((a) => cartaoAcao(a, false)).join('')}</div>
    <article class="card2" style="margin-top:12px"><span class="tag">GSC · consultas</span><h3>Consultas com maior potencial</h3><p class="sub">Muita impressão, posição fora do Top 3 e CTR abaixo do esperado para a posição.</p>
      <div class="tabela-wrap"><table class="t" style="min-width:680px"><thead><tr><th>Consulta</th><th>Intenção</th><th class="num">Impressões</th><th class="num">Cliques</th><th class="num">CTR</th><th class="num">Posição</th><th>Página</th></tr></thead><tbody>
      ${DADOS.consultas.map((c) => `<tr><td><strong>${esc(c.q)}</strong></td><td><span class="pill">${c.intencao}</span></td><td class="num">${nf.format(c.imp)}</td><td class="num">${nf.format(c.cliques)}</td><td class="num">${pct(c.cliques / c.imp, 2)}</td><td class="num">${nf1.format(c.pos)}</td><td class="mono">${esc(c.pagina)}</td></tr>`).join('')}</tbody></table></div>
      <p class="nota">CTR e posição não devem ser lidos sozinhos: considere dispositivo, recursos da SERP, anúncios e mudança no mix de consultas.</p></article>`;
}
function abaTecnico() {
  const ix = DADOS.indexacao, cw = DADOS.cwv;
  return `<div class="secao"><h2>Indexação, Core Web Vitals e saúde técnica</h2><span>riscos à capacidade de crescimento</span></div>
    <div class="tec3">
      <article class="card2"><span class="tag">GSC</span><h3>Indexação estratégica</h3><div class="v">${ix.ok} <span class="muted" style="font-size:15px;font-weight:400">/ ${ix.total}</span></div><div class="sub">${pct(ix.ok / ix.total)} indexadas · ${ix.total - ix.ok} com pendência</div><div class="trilho"><i style="width:${(ix.ok / ix.total) * 100}%"></i></div><p class="nota">Valide as páginas uma a uma: nem toda exclusão é problema.</p></article>
      <article class="card2"><span class="tag">CrUX</span><h3>URLs boas em CWV (celular)</h3><div class="v" style="color:var(--s-d)">${pct(cw.bomPct, 0)}</div><div class="sub">−6 p.p. vs. período anterior</div><div class="trilho amb"><i style="width:${cw.bomPct * 100}%"></i></div><p class="nota">Universo de URLs com dados suficientes no relatório de campo.</p></article>
      <article class="card2"><span class="tag">PageSpeed · p75</span><h3>Core Web Vitals</h3>${cw.vitais.map(([n, v, e, m]) => `<div class="linha"><span>${n} <small class="muted">${m}</small></span><span class="pill ${e}">${v}</span></div>`).join('')}</article>
    </div>
    <div class="quad" style="margin-top:12px"><article class="card2"><span class="tag">GSC</span><h3>Motivos de exclusão a revisar</h3><p class="sub">13 URLs estratégicas pendentes</p>${ix.motivos.map(([n, v]) => `<div class="linha"><span>${n}</span><strong>${v} URLs</strong></div>`).join('')}</article>
    <article class="card2"><h3>Sinais para auditoria</h3><p class="sub">Escopo priorizado por potencial de negócio</p>${DADOS.auditoria.map(([n, v]) => `<div class="linha"><span>${n}</span><strong>${v}</strong></div>`).join('')}</article></div>`;
}

const ABAS = { exec: abaExec, paginas: abaPaginas, oportunidades: abaOportunidades, tecnico: abaTecnico };

function fontesHtml() {
  const rot = { ok: 'conectada', falta: 'a conectar', parcial: 'parcial' };
  return `<b>Fontes de dados</b>${DADOS.fontes.map((f) => `<span class="fonte ${f.estado}" title="${esc(f.nota ?? '')}"><i></i>${esc(f.nome)} · ${rot[f.estado]}</span>`).join('')}
    <details style="flex-basis:100%"><summary class="muted" style="cursor:pointer">O que falta integrar</summary><div class="falta" style="margin-top:8px">${DADOS.integracoes.map(([t, d]) => `<div class="item"><b>${esc(t)}</b>${esc(d)}</div>`).join('')}</div></details>`;
}

function desenhar() {
  $('#conteudo').innerHTML = ABAS[S.aba]();
  for (const b of document.querySelectorAll('.aba')) b.setAttribute('aria-selected', String(b.dataset.aba === S.aba));
  try { history.replaceState(null, '', `#${S.aba}`); } catch { /* sem histórico: tudo bem */ }
}

$('#fontes').innerHTML = fontesHtml();
$('#f-produto').value = S.produto;
$('#f-produto').addEventListener('change', (ev) => { S.produto = ev.target.value || 'rh'; desenhar(); });
$('#abas').addEventListener('click', (ev) => { const b = ev.target.closest('[data-aba]'); if (b) { S.aba = b.dataset.aba; desenhar(); } });
$('#conteudo').addEventListener('click', (ev) => {
  const g = ev.target.closest('[data-gerar]');
  if (g) return gerarExperimento(g.dataset.gerar);
  const o = ev.target.closest('[data-ord]');
  if (o) { const col = o.dataset.ord; S.ordem = { col, dir: S.ordem.col === col ? -S.ordem.dir : (col === 'url' || col === 'intencao' ? 1 : -1) }; $('#tab-paginas').innerHTML = tabelaPaginas(); }
});
$('#conteudo').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.matches('[data-ord]')) ev.target.click(); });
$('#conteudo').addEventListener('input', (ev) => { if (ev.target.id === 'busca') { S.busca = ev.target.value; $('#tab-paginas').innerHTML = tabelaPaginas(); } });
$('#conteudo').addEventListener('change', (ev) => { if (ev.target.id === 'f-int') { S.intencao = ev.target.value; $('#tab-paginas').innerHTML = tabelaPaginas(); } });

const inicial = location.hash.slice(1);
if (ABAS[inicial]) S.aba = inicial;
desenhar();
