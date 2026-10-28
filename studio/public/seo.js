/**
 * Página SEO: lê /api/seo (Search Console + GA4 + Pipedrive por marca) e mostra visão executiva, páginas, oportunidades e técnico.
 * Cada ação recomendada tem o gatilho "Gerar experimento": guarda o rascunho em sessionStorage ('exp.prefill') e abre /experimentos?novo=1,
 * que abre o cadastro já preenchido. Indexação, Core Web Vitals e intenção de busca ainda não têm fonte (PageSpeed / URL Inspection): a aba Técnico avisa.
 */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = new Intl.NumberFormat('pt-BR');
const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const pct = (v, d = 1) => (v == null ? '—' : `${new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v * 100)}%`);
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const dmy = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—');

const ler = (k) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } };
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento: tudo bem */ } };

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hoje = new Date();
const PERIODOS = {
  d30: ['Últimos 30 dias', () => [iso(new Date(hoje.getTime() - 29 * 86400000)), iso(hoje)]],
  d90: ['Últimos 90 dias', () => [iso(new Date(hoje.getTime() - 89 * 86400000)), iso(hoje)]],
  ano: ['Este ano', () => [`${hoje.getFullYear()}-01-01`, iso(hoje)]],
};
const HOSTS = { rh: 'quarkrh.com.br', clinic: 'quarkclinic.com.br' };
const S = { produto: ler('seo.produto') ?? 'rh', periodo: ler('seo.periodo') ?? 'd30', aba: 'exec', dados: null, erro: '', carregando: false, busca: '', ordem: { col: 'pipeline', dir: -1 } };
if (!HOSTS[S.produto]) S.produto = 'rh';
if (!PERIODOS[S.periodo]) S.periodo = 'd30';

/* ---------- dados ---------- */
let seq = 0;
async function carregar() {
  const mine = ++seq;
  S.carregando = true; S.erro = '';
  desenhar();
  const [de, ate] = PERIODOS[S.periodo][1]();
  try {
    const r = await fetch(`/api/seo?marca=${S.produto}&de=${de}&ate=${ate}`, { headers: { accept: 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (mine !== seq) return; // o usuário já trocou o filtro
    if (!r.ok) throw new Error(j.detail || j.error || `erro ${r.status}`);
    S.dados = j;
  } catch (e) {
    if (mine !== seq) return;
    S.erro = e.message; S.dados = null;
  }
  S.carregando = false;
  desenhar();
}

/* ---------- gatilho: gerar experimento a partir da ação ---------- */
function rascunhoExperimento(a) {
  const nome = a.pagina ? `${a.titulo} (${a.pagina})` : a.titulo;
  return {
    titulo: nome.slice(0, 160), tipo: 'experimento', areaImpacto: 'SEO', produto: S.produto, canal: 'organico', status: 'backlog',
    hipotese: a.hipotese, resultadoEsperado: a.esperado, metrica: a.metrica || '', meta: a.meta, ice: a.ice,
    paginaDestino: a.pagina ? `${a.host || HOSTS[S.produto]}${a.pagina}` : '', origem: `SEO · ${a.sinal}`,
  };
}
function gerarExperimento(id) {
  const a = S.dados?.acoes.find((x) => x.id === id);
  if (!a) return;
  try { sessionStorage.setItem('exp.prefill', JSON.stringify(rascunhoExperimento(a))); } catch { /* sem armazenamento: abre o cadastro vazio */ }
  location.assign('/experimentos?novo=1');
}

/* ---------- componentes ---------- */
function delta(par, { tipo = 'rel', menorMelhor = false } = {}) {
  if (!par || par.atual == null || par.anterior == null || (tipo === 'rel' && par.anterior === 0)) return '<span class="muted">sem comparação</span>';
  const dif = tipo === 'pp' ? par.atual - par.anterior : (par.atual - par.anterior) / par.anterior;
  if (dif === 0) return '<b>=</b> vs. período anterior';
  const bom = menorMelhor ? dif < 0 : dif > 0;
  const txt = tipo === 'pp' ? `${nf1.format(Math.abs(dif) * 100)} p.p.` : `${nf1.format(Math.abs(dif) * 100)}%`;
  return `<b class="${bom ? 'bom' : 'ruim'}">${dif > 0 ? '▲ +' : '▼ −'}${txt}</b> vs. período anterior`;
}
function kpi(nome, fonte, valor, d, dica) {
  return `<div class="kpi" title="${esc(dica ?? '')}"><div class="n"><span>${esc(nome)}</span><em>${esc(fonte)}</em></div><div class="v">${valor}</div><div class="d">${d}</div></div>`;
}
function kpis() {
  const k = S.dados.kpis;
  return `<div class="kpis">
    ${kpi('Leads orgânicos', 'Pipedrive', nf.format(k.leads.atual), delta(k.leads), 'Negócios de fonte Orgânico criados no período que contam como lead')}
    ${kpi('MQLs orgânicos', 'Pipedrive', nf.format(k.mql.atual), delta(k.mql))}
    ${kpi('Valor dos negócios orgânicos', 'Pipedrive', brl.format(k.pipeline.atual), delta(k.pipeline), 'Soma do valor dos negócios orgânicos criados no período que contam como lead')}
    ${kpi('Ganhos orgânicos', 'Pipedrive', nf.format(k.ganhos.atual), delta(k.ganhos), 'Dos negócios orgânicos criados no período, quantos já estão ganhos')}
    ${kpi('Sessões orgânicas', 'GA4', nf.format(k.sessoes.atual), delta(k.sessoes))}
    ${kpi('Sessão → lead', 'GA4 + Pipedrive', pct(k.sessaoParaLead.atual, 2), delta(k.sessaoParaLead, { tipo: 'pp' }), 'Direcional: GA4 e Pipedrive têm metodologias diferentes')}
    ${kpi('Cliques no Google', 'GSC', nf.format(k.cliques.atual), delta(k.cliques))}
    ${kpi('Cliques não branded (estim.)', 'GSC', k.cliquesNaoBranded.atual == null ? '—' : nf.format(k.cliquesNaoBranded.atual), delta(k.cliquesNaoBranded), 'Cliques × participação de consultas sem a marca nos meses cobertos (as consultas são mensais)')}
  </div>
  <div class="stats4" style="margin-top:10px">
    <div class="mini">${kpi('Impressões', 'GSC', nf.format(k.impressoes.atual), delta(k.impressoes))}</div>
    <div class="mini">${kpi('CTR médio', 'GSC', pct(k.ctr.atual, 2), delta(k.ctr, { tipo: 'pp' }))}</div>
    <div class="mini">${kpi('Posição média', 'GSC', k.posicao.atual == null ? '—' : nf1.format(k.posicao.atual), delta(k.posicao, { menorMelhor: true }), 'Média ponderada pelas impressões; quanto menor, melhor')}</div>
    <div class="mini">${kpi('Páginas com dado', 'GSC + GA4', nf.format(S.dados.paginas.length), '<span class="muted">até 300 listadas</span>')}</div>
  </div>`;
}
function linhas() {
  const serie = S.dados.serie;
  if (!serie.length) return '<p class="vazio">Sem consultas carregadas para a série.</p>';
  const W = 640, H = 200, p = { l: 44, r: 12, t: 14, b: 26 };
  const max = Math.max(1, ...serie.map((m) => Math.max(m.naoBranded, m.branded)));
  const passo = 10 ** Math.floor(Math.log10(max));
  const ymax = Math.ceil(max / passo) * passo;
  const n = Math.max(1, serie.length - 1);
  const x = (i) => p.l + (i * (W - p.l - p.r)) / n, y = (v) => H - p.b - (v / ymax) * (H - p.b - p.t);
  let s = `<svg class="lin" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cliques orgânicos branded e não branded por mês">`;
  for (let i = 0; i <= 4; i++) { const v = (ymax / 4) * i; s += `<line x1="${p.l}" y1="${y(v)}" x2="${W - p.r}" y2="${y(v)}" stroke="var(--s-grid)"/><text x="${p.l - 8}" y="${y(v) + 4}" text-anchor="end">${v >= 1000 ? `${nf1.format(v / 1000)} mil` : nf.format(v)}</text>`; }
  serie.forEach((m, i) => { s += `<text x="${x(i)}" y="${H - 7}" text-anchor="middle">${MESES[Number(m.mes.slice(5, 7)) - 1]}</text>`; });
  for (const [campo, cor] of [['naoBranded', 'var(--s-a)'], ['branded', 'var(--s-b)']]) {
    s += `<polyline points="${serie.map((m, i) => `${x(i)},${y(m[campo])}`).join(' ')}" fill="none" stroke="${cor}" stroke-width="2.5" stroke-linejoin="round"/>`;
    serie.forEach((m, i) => { s += `<circle cx="${x(i)}" cy="${y(m[campo])}" r="${i === serie.length - 1 ? 4.5 : 3}" fill="var(--s-surface)" stroke="${cor}" stroke-width="2"><title>${m.mes.slice(0, 7)}: ${nf.format(m[campo])}</title></circle>`; });
  }
  return `${s}</svg>`;
}
function funil() {
  const f = S.dados.funil;
  const passos = [['Sessões', f.sessoes], ['Leads', f.leads], ['MQLs', f.mql], ['Ganhos', f.ganhos]];
  // a primeira etapa é de outra ordem de grandeza: as barras valem a partir dos leads e mostram a proporção em cada passo
  const max = Math.max(1, f.leads);
  return `<div class="funil">${passos.map(([nome, v], i) => `<div class="passo"><span>${nome}</span><span><i class="fill" style="display:block;width:${i === 0 ? 100 : Math.max(2, (v / max) * 100)}%;opacity:${1 - i * 0.18}"></i></span><span class="n">${nf.format(v)}</span></div>`).join('')}</div>
    <p class="nota">Sessão → lead ${pct(f.sessoes ? f.leads / f.sessoes : null, 2)} · lead → MQL ${pct(f.leads ? f.mql / f.leads : null)} · MQL → ganho ${pct(f.mql ? f.ganhos / f.mql : null)}. A barra de sessões é a escala própria; as demais seguem os leads.</p>`;
}
function cartaoAcao(a, compacto) {
  return `<div class="acao"><div class="rod"><span class="pill ${a.prioridade === 'P0' ? 'ruim' : a.prioridade === 'P1' ? 'atencao' : ''}">${a.prioridade}</span><span class="pill">${esc(a.tipo)}</span></div>
    <strong>${esc(a.titulo)}</strong><p>${esc(a.desc)}</p>${compacto ? '' : `<p class="dica-cvr">Sinal: ${esc(a.sinal)}</p><p class="dica-cvr">Hipótese: ${esc(a.hipotese)}</p>`}
    <span class="imp">${esc(a.impacto)}</span>
    <div class="rod"><button type="button" class="btn small primary" data-gerar="${esc(a.id)}" title="Abre o cadastro de Experimentos já preenchido com esta ação">Gerar experimento</button>${a.pagina ? `<span class="muted mono">${esc(a.pagina)}</span>` : ''}</div></div>`;
}
const semAcoes = '<p class="vazio">Nenhuma ação sugerida para este período e produto.</p>';

/* ---------- abas ---------- */
function abaExec() {
  const top = S.dados.acoes.slice(0, 3);
  return `<div class="secao"><h2>Indicadores essenciais</h2><span>${dmy(S.dados.periodo.de)} a ${dmy(S.dados.periodo.ate)} · comparado com ${dmy(S.dados.periodo.anteriorDe)} a ${dmy(S.dados.periodo.anteriorAte)}</span></div>${kpis()}
    <div class="par"><article class="card2"><span class="tag">GSC · consultas por mês</span><h3>Evolução de cliques orgânicos</h3><p class="sub">O crescimento vem de público novo ou da demanda pela marca?</p>
      <div class="legenda"><span><i style="background:var(--s-a)"></i>Não branded</span><span><i style="background:var(--s-b)"></i>Branded</span></div>${linhas()}
      <p class="nota">Só entram consultas com 10 ou mais impressões no mês; “branded” = consulta que contém “quark”. O último mês pode estar incompleto.</p></article>
    <article class="card2"><span class="tag">GA4 + Pipedrive</span><h3>Funil de aquisição orgânica</h3><p class="sub">Volume versus avanço para o comercial</p>${funil()}</article></div>
    <article class="card2" style="margin-top:12px"><h3>Fila prioritária · o que merece atenção agora</h3><p class="sub">Cada ação pode virar um experimento com hipótese, página e métrica já preenchidas.</p>${top.length ? `<div class="acoes">${top.map((a) => cartaoAcao(a, true)).join('')}</div>` : semAcoes}</article>`;
}
function ordenar(lista) {
  const { col, dir } = S.ordem;
  const v = (p) => (col === 'cvr' ? (p.sessoes ? p.leads / p.sessoes : -1) : col === 'url' ? p.pagina : (p[col] ?? -1));
  return [...lista].sort((a, b) => (typeof v(a) === 'string' ? dir * v(a).localeCompare(v(b)) : dir * (v(a) - v(b))));
}
function cab(col, rot, num) { const a = S.ordem.col === col; return `<th class="sc ${num ? 'num' : ''}" tabindex="0" data-ord="${col}" ${a ? `aria-sort="${S.ordem.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${rot}${a ? (S.ordem.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`; }
const acaoDaPagina = (p) => S.dados.acoes.find((a) => a.pagina === p.pagina && (!a.host || a.host === p.host));
function tabelaPaginas() {
  const q = S.busca.toLowerCase().trim();
  const lista = ordenar(S.dados.paginas.filter((p) => !q || `${p.host}${p.pagina}`.toLowerCase().includes(q)));
  const corpo = lista.map((p) => {
    const a = acaoDaPagina(p);
    return `<tr><td><strong>${esc(p.pagina)}</strong><small>${esc(p.host)}</small></td>
      <td class="num">${nf.format(p.impressoes)}</td><td class="num">${nf.format(p.cliques)}</td><td class="num">${p.impressoes ? pct(p.cliques / p.impressoes, 2) : '—'}</td><td class="num">${p.posicao == null ? '—' : nf1.format(p.posicao)}</td>
      <td class="num">${nf.format(p.sessoes)}</td><td class="num">${nf.format(p.leads)}</td><td class="num">${p.sessoes ? pct(p.leads / p.sessoes, 2) : '—'}</td><td class="num">${nf.format(p.mql)}</td><td class="num">${nf.format(p.ganhos)}</td><td class="num">${brl.format(p.pipeline)}</td>
      <td>${a ? `<button type="button" class="btn small" data-gerar="${esc(a.id)}">Gerar experimento</button><small>${esc(a.tipo)}</small>` : '<span class="muted">—</span>'}</td></tr>`;
  }).join('');
  return `<div class="tabela-wrap"><table class="t" style="min-width:1100px"><thead><tr>${cab('url', 'Página')}${cab('impressoes', 'Impressões', 1)}${cab('cliques', 'Cliques', 1)}<th class="num">CTR</th>${cab('posicao', 'Posição', 1)}${cab('sessoes', 'Sessões', 1)}${cab('leads', 'Leads', 1)}${cab('cvr', 'CVR', 1)}${cab('mql', 'MQLs', 1)}${cab('ganhos', 'Ganhos', 1)}${cab('pipeline', 'Valor', 1)}<th>Ação recomendada</th></tr></thead>
    <tbody>${corpo || '<tr><td colspan="12" class="vazio">Nenhuma página para o filtro aplicado.</td></tr>'}</tbody></table></div>`;
}
function abaPaginas() {
  const ps = S.dados.paginas;
  const melhor = [...ps].sort((a, b) => b.pipeline - a.pipeline)[0];
  const gap = ps.filter((p) => p.sessoes >= 300).sort((a, b) => a.leads / a.sessoes - b.leads / b.sessoes)[0];
  const card = (nome, p, d) => `<div class="kpi"><div class="n"><span>${nome}</span></div><div class="v" style="font-size:18px;white-space:normal;overflow-wrap:anywhere">${p ? esc(p.pagina) : '—'}</div><div class="d">${p ? d(p) : 'sem dados'}</div></div>`;
  return `<div class="secao"><h2>Melhores páginas</h2><span>tráfego orgânico que vira lead, MQL e valor</span></div>
    <div class="stats4">
      ${card('Maior valor em negócios', melhor, (p) => `${brl.format(p.pipeline)} · ${p.mql} MQLs`)}
      ${card('Maior tráfego com baixa conversão', gap, (p) => `${nf.format(p.sessoes)} sessões · CVR ${pct(p.leads / p.sessoes, 2)}`)}
      <div class="kpi"><div class="n"><span>Páginas listadas</span></div><div class="v">${ps.length}</div><div class="d">Search Console + GA4 + Pipedrive</div></div>
      <div class="kpi"><div class="n"><span>Com ação sugerida</span></div><div class="v">${ps.filter((p) => acaoDaPagina(p)).length}</div><div class="d">prontas para virar experimento</div></div>
    </div>
    <article class="card2" style="margin-top:12px"><span class="tag">GSC + GA4 + Pipedrive</span><h3>Landing pages orgânicas</h3><p class="sub">Ordene por qualquer coluna. Leads, MQLs e valor ligam o negócio à página pelo campo “URL de Conversão” do Pipedrive (a página onde a conversão aconteceu, muitas vezes a de agradecimento).</p>
      <div class="busca"><input id="busca" type="search" placeholder="Buscar URL…" aria-label="Buscar página" value="${esc(S.busca)}"></div>
      <div id="tab-paginas">${tabelaPaginas()}</div></article>`;
}
function abaOportunidades() {
  const d = S.dados;
  return `<div class="secao"><h2>Oportunidades e testes</h2><span>${d.acoes.length} ações a partir dos dados do período</span></div>
    ${d.acoes.length ? `<div class="acoes">${d.acoes.map((a) => cartaoAcao(a, false)).join('')}</div>` : semAcoes}
    <article class="card2" style="margin-top:12px"><span class="tag">GSC · consultas (últimos meses inteiros)</span><h3>Consultas com maior potencial</h3><p class="sub">Muita impressão, posição entre 3 e 20 e CTR abaixo do esperado para a posição. “Potencial” = cliques a mais se o CTR chegasse ao esperado.</p>
      <div class="tabela-wrap"><table class="t" style="min-width:720px"><thead><tr><th>Consulta</th><th class="num">Impressões</th><th class="num">Cliques</th><th class="num">CTR</th><th class="num">Posição</th><th class="num">Potencial</th><th>Página</th></tr></thead><tbody>
      ${d.consultas.map((c) => `<tr><td><strong>${esc(c.consulta)}</strong></td><td class="num">${nf.format(c.impressoes)}</td><td class="num">${nf.format(c.cliques)}</td><td class="num">${pct(c.cliques / c.impressoes, 2)}</td><td class="num">${nf1.format(c.posicao)}</td><td class="num">+${nf.format(c.potencial)}</td><td class="mono">${esc(c.pagina)}</td></tr>`).join('') || '<tr><td colspan="7" class="vazio">Sem consultas com volume suficiente.</td></tr>'}</tbody></table></div>
      <p class="nota">CTR e posição não devem ser lidos sozinhos: considere dispositivo, recursos da SERP, anúncios e mudança no mix de consultas.</p></article>`;
}
function abaTecnico() {
  const falta = [
    ['Core Web Vitals (LCP, INP, CLS) por página', 'PageSpeed Insights / CrUX: precisa de uma chave da API e da lista de URLs estratégicas.'],
    ['Indexação e motivos de exclusão', 'Search Console URL Inspection (limite de 2.000 consultas por dia por propriedade) ou o relatório de cobertura.'],
    ['Intenção de busca por página', 'Uma classificação por página ou cluster (comercial, informacional, conversão) que podemos manter numa tabela editável.'],
  ];
  return `<div class="secao"><h2>Indexação, Core Web Vitals e saúde técnica</h2><span>ainda sem fonte conectada</span></div>
    <div class="falta">${falta.map(([t, d]) => `<div class="item"><b>${esc(t)}</b>${esc(d)}</div>`).join('')}</div>
    <p class="nota">Enquanto essas fontes não entram, esta aba não mostra números: nada aqui é estimado ou de exemplo.</p>`;
}
const ABAS = { exec: abaExec, paginas: abaPaginas, oportunidades: abaOportunidades, tecnico: abaTecnico };

function fontesHtml() {
  if (!S.dados) return '<b>Fontes de dados</b><span class="muted">carregando…</span>';
  return `<b>Fontes de dados</b>${S.dados.fontes.map((f) => `<span class="fonte ${f.estado === 'ok' ? 'ok' : ''}" title="${f.ate ? `dados até ${dmy(f.ate)}` : 'não conectada'}"><i></i>${esc(f.nome)} · ${f.estado === 'ok' ? `até ${dmy(f.ate)}` : 'a conectar'}</span>`).join('')}`;
}

function desenhar() {
  for (const b of document.querySelectorAll('.aba')) b.setAttribute('aria-selected', String(b.dataset.aba === S.aba));
  $('#fontes').innerHTML = fontesHtml();
  const c = $('#conteudo');
  if (S.erro) c.innerHTML = `<div class="erro-m card2" role="alert"><b>Não foi possível carregar o SEO.</b><p>${esc(S.erro)}</p><button type="button" class="btn small" id="tentar">Tentar de novo</button></div>`;
  else if (!S.dados) c.innerHTML = '<p class="vazio" role="status">Carregando dados do Search Console, GA4 e Pipedrive…</p>';
  else c.innerHTML = `<div style="${S.carregando ? 'opacity:.5' : ''}">${ABAS[S.aba]()}</div>`;
  try { history.replaceState(null, '', `#${S.aba}`); } catch { /* sem histórico: tudo bem */ }
}

/* ---------- filtros e eventos ---------- */
$('#f-periodo').innerHTML = Object.entries(PERIODOS).map(([k, [r]]) => `<option value="${k}">${r}</option>`).join('');
$('#f-periodo').value = S.periodo;
$('#f-produto').value = S.produto;
$('#f-periodo').addEventListener('change', (ev) => { S.periodo = ev.target.value; guardar('seo.periodo', S.periodo); carregar(); });
$('#f-produto').addEventListener('change', (ev) => { S.produto = ev.target.value; guardar('seo.produto', S.produto); carregar(); });
$('#abas').addEventListener('click', (ev) => { const b = ev.target.closest('[data-aba]'); if (b) { S.aba = b.dataset.aba; desenhar(); } });
$('#conteudo').addEventListener('click', (ev) => {
  if (ev.target.id === 'tentar') return carregar();
  const g = ev.target.closest('[data-gerar]');
  if (g) return gerarExperimento(g.dataset.gerar);
  const o = ev.target.closest('[data-ord]');
  if (o) { const col = o.dataset.ord; S.ordem = { col, dir: S.ordem.col === col ? -S.ordem.dir : (col === 'url' ? 1 : -1) }; $('#tab-paginas').innerHTML = tabelaPaginas(); }
});
$('#conteudo').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.matches('[data-ord]')) ev.target.click(); });
$('#conteudo').addEventListener('input', (ev) => { if (ev.target.id === 'busca') { S.busca = ev.target.value; $('#tab-paginas').innerHTML = tabelaPaginas(); } });

const inicial = location.hash.slice(1);
if (ABAS[inicial]) S.aba = inicial;
carregar();
