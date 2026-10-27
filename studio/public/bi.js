const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const nf = new Intl.NumberFormat('pt-BR');
const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const COR = (slot) => `var(--series-${slot})`; // 0 = neutro ("outras"), 1 a 4 = paleta categórica; a cor segue a entidade, nunca a posição

function fmt(tipo, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (tipo === 'int') return nf.format(v);
  if (tipo === 'pct') return `${nf1.format(v * 100)}%`;
  if (tipo === 'brl') return brl.format(v);
  if (tipo === 'brl2') return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v); // custos unitários (CPL, CAC...)
  if (tipo === 'dec') return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  if (tipo === 'dias') return `${nf1.format(v)} d`;
  return String(v);
}

/* comparações: diferença com sinal (nas taxas, em pontos percentuais) e variação relativa */
const sinal = (v) => (v > 0 ? '+' : v < 0 ? '−' : '');
const seta = (v) => (v > 0 ? '▲' : v < 0 ? '▼' : '=');
const pctVar = (v) => (v == null ? '—' : `${sinal(v)}${nf1.format(Math.abs(v) * 100)}%`);
function fmtAbs(tipo, v) {
  if (v == null) return '—';
  if (tipo === 'pct') return `${sinal(v)}${nf1.format(Math.abs(v) * 100)} p.p.`;
  return `${sinal(v)}${fmt(tipo, Math.abs(v))}`;
}

/* fila: no máximo 3 consultas ao mesmo tempo (a página Meta dispara 12 análises; juntas estouravam o limite de 30 s do banco) */
const MAX_SIMULTANEAS = 3;
let emAndamento = 0;
const espera = [];
const liberar = () => { emAndamento--; const prox = espera.shift(); if (prox) prox(); };
async function api(path) {
  if (emAndamento >= MAX_SIMULTANEAS) await new Promise((ok) => espera.push(ok));
  emAndamento++;
  try {
    const res = await fetch(path, { headers: { accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.detail || data.error || res.statusText), { status: res.status });
    return data;
  } finally { liberar(); }
}

/* ---------- estado e filtros ---------- */
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hoje = new Date();
const PRESETS = {
  ano: ['Este ano', () => [`${hoje.getFullYear()}-01-01`, iso(hoje)]],
  ano_passado: ['Ano passado', () => [`${hoje.getFullYear() - 1}-01-01`, `${hoje.getFullYear() - 1}-12-31`]],
  d90: ['Últimos 90 dias', () => [iso(new Date(hoje.getTime() - 89 * 86400000)), iso(hoje)]],
  d30: ['Últimos 30 dias', () => [iso(new Date(hoje.getTime() - 29 * 86400000)), iso(hoje)]],
  tudo: ['Tudo (desde o primeiro negócio)', () => [S.catalogo?.primeiro_negocio ?? '2019-01-01', iso(hoje)]],
  custom: ['Personalizado…', null],
};

const S = { catalogo: null, pagina: 'geral', filtros: { periodo: 'ano', de: '', ate: '', produto: '', pipeline: '' }, padrao: {}, modo: {}, aberto: null };
/* Campanhas da Meta fora do cálculo: filtro TEMPORÁRIO (vale só nesta aba do navegador, até limpar), por isso fica em sessionStorage e não em localStorage */
const sessao = {
  ler: (k) => { try { return JSON.parse(sessionStorage.getItem(k) ?? 'null'); } catch { return null; } },
  guardar: (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento: o filtro vale até recarregar */ } },
};
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento: tudo bem */ } };
const ler = (k) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } };
Object.assign(S.filtros, ler('bi.filtros') ?? {});
S.padrao = ler('bi.padrao') ?? {};
/** Linhas de referência dos gráficos de colunas: caixas liga/desliga e a série a que valem ('' = a primeira; 'todas'). Lembrado neste navegador. */
S.linhas = { mes_anterior: true, ano_anterior: true, serie: '', ...(ler('bi.linhas') ?? {}) };
if (!PRESETS[S.filtros.periodo]) S.filtros.periodo = 'ano';
S.excluir = (sessao.ler('bi.excluirCampanhas') ?? []).filter((id) => /^\d{1,20}$/.test(String(id))).map(String);
S.campNomes = sessao.ler('bi.campNomes') ?? {};
S.campLista = null;
S.campBusca = '';
S.campChave = '';

function intervalo() {
  const f = S.filtros;
  return f.periodo === 'custom' ? [f.de, f.ate] : PRESETS[f.periodo][1]();
}

/** Seleção atual de Fonte ou Tipo: o que o usuário escolheu, senão a seleção fixa (a salva por ele, senão a do servidor). */
function padraoIds(campo) {
  const ops = S.catalogo[campo];
  const salvo = S.padrao[campo];
  if (Array.isArray(salvo)) return salvo.filter((id) => id === 'branco' || ops.some((o) => o.id === id));
  return ops.filter((o) => o.padrao).map((o) => o.id);
}
const sel = (campo) => (Array.isArray(S.filtros[campo]) ? S.filtros[campo] : padraoIds(campo));
const todasSel = (campo) => { const s = sel(campo); return s.includes('branco') && S.catalogo[campo].every((o) => s.includes(o.id)); };
const curto = (nome) => String(nome).replace(/^Marketing \[(.*)\]$/, '$1');

function resumoSel(campo) {
  const s = sel(campo);
  if (!s.length || todasSel(campo)) return 'Todas';
  const nomes = s.map((id) => (id === 'branco' ? '(em branco)' : curto(S.catalogo[campo].find((o) => o.id === id)?.nome ?? id)));
  return nomes.length <= 3 ? nomes.join(', ') : `${nomes.slice(0, 2).join(', ')} +${nomes.length - 2}`;
}

function queryFiltros() {
  const [de, ate] = intervalo();
  const p = new URLSearchParams({ de, ate });
  if (S.filtros.produto) p.set('produto', S.filtros.produto);
  if (S.filtros.pipeline) p.set('pipeline', S.filtros.pipeline);
  if (S.excluir.length) p.set('excluir_campanhas', S.excluir.join(','));
  for (const [campo, param] of [['fontes', 'fonte'], ['tipos', 'tipo']]) {
    const s = sel(campo);
    if (s.length && !todasSel(campo)) p.set(param, s.join(','));
  }
  return p.toString();
}

/* ---------- campanhas da Meta fora do CPL ---------- */
const campResumo = () => (S.excluir.length ? `${S.excluir.length} removida${S.excluir.length > 1 ? 's' : ''}` : 'Nenhuma');
const campVisiveis = () => { const t = S.campBusca.trim().toLowerCase(); return (S.campLista ?? []).filter((c) => !t || c.nome.toLowerCase().includes(t)); };
function listaCamp() {
  if (S.campLista == null) return '<p class="muted">Carregando as campanhas…</p>';
  const v = campVisiveis();
  const fora = S.excluir.filter((id) => !S.campLista.some((c) => c.id === id));
  const linhas = v.map((c) => `<label class="ms-op"><input type="checkbox" data-camp-op value="${esc(c.id)}" ${S.excluir.includes(c.id) ? 'checked' : ''}> <span>${esc(c.nome)}</span><span class="pad">${esc(brl.format(c.gasto))}</span></label>`).join('');
  const vazio = `<p class="muted">Nenhuma campanha com gasto neste período e produto${S.campBusca ? ' que combine com a busca' : ''}.</p>`;
  const sobras = fora.length ? `<p class="muted">+ ${fora.length} fora do cálculo sem gasto neste período: ${fora.map((id) => esc(S.campNomes[id] ?? `#${id}`)).join('; ')}</p>` : '';
  return `${linhas || vazio}${sobras}`;
}
function pintarCamp() {
  const el = $('#ms-camp');
  if (!el) return;
  const aberto = S.aberto === 'camp';
  el.innerHTML = `<button type="button" class="ms-btn ${S.excluir.length ? 'ativo' : ''}" data-camp-toggle aria-haspopup="true" aria-expanded="${aberto}" title="Campanhas da Meta que ficam fora do investimento e dos negócios (temporário)">${esc(campResumo())} ▾</button>${aberto ? `<div class="ms-pop camp-pop" role="group" aria-label="Campanhas da Meta fora do CPL">
      <p class="muted">Marque as campanhas que <b>não</b> devem entrar no cálculo (topo de funil, experimentos...). Saem o investimento delas e os negócios ligados a elas, em todas as páginas. Vale só nesta aba do navegador, até você limpar.</p>
      <input id="camp-busca" type="search" placeholder="Buscar pelo nome (ex.: topo, experimento)" value="${esc(S.campBusca)}" aria-label="Buscar campanha">
      <div class="ms-acoes"><button type="button" data-camp-acao="marcar">Marcar as filtradas</button><button type="button" data-camp-acao="desmarcar">Desmarcar as filtradas</button><button type="button" data-camp-acao="limpar">Limpar tudo</button></div>
      <div id="camp-lista">${listaCamp()}</div></div>` : ''}`;
}
/** Busca as campanhas com gasto no período e produto atuais (uma vez por combinação) e redesenha só a lista. */
async function carregarCampanhas() {
  const [de, ate] = intervalo();
  const chave = `${de}|${ate}|${S.filtros.produto}`;
  if (S.campChave === chave && S.campLista) return;
  S.campChave = chave;
  S.campLista = null;
  $('#camp-lista') && ($('#camp-lista').innerHTML = listaCamp());
  try {
    const p = new URLSearchParams({ de, ate });
    if (S.filtros.produto) p.set('produto', S.filtros.produto);
    S.campLista = await api(`/api/bi/campanhas?${p}`);
    for (const c of S.campLista) S.campNomes[c.id] = c.nome;
    sessao.guardar('bi.campNomes', S.campNomes);
  } catch { S.campLista = []; S.campChave = ''; }
  $('#camp-lista') && ($('#camp-lista').innerHTML = listaCamp());
}
function excluirMudou() {
  sessao.guardar('bi.excluirCampanhas', S.excluir);
  const b = $('#ms-camp .ms-btn');
  if (b) { b.textContent = `${campResumo()} ▾`; b.classList.toggle('ativo', S.excluir.length > 0); }
  pintarStatus();
  clearTimeout(filtrosMudaram.t);
  filtrosMudaram.t = setTimeout(carregarPagina, 400); // espera o clique seguinte antes de consultar
}

function pintarMs(campo) {
  const el = $(`#ms-${campo}`);
  const aberto = S.aberto === campo;
  const s = sel(campo);
  const ops = S.catalogo[campo];
  el.innerHTML = `<button type="button" class="ms-btn" data-ms="${campo}" aria-haspopup="true" aria-expanded="${aberto}" title="${esc(resumoSel(campo))}">${esc(resumoSel(campo))} ▾</button>${
    aberto
      ? `<div class="ms-pop" role="group" aria-label="${campo === 'fontes' ? 'Fonte do Lead' : 'Tipo do Lead'}">
          <div class="ms-acoes"><button type="button" data-ms-acao="padrao" data-campo="${campo}">Padrão</button><button type="button" data-ms-acao="todas" data-campo="${campo}">Todas</button><button type="button" data-ms-acao="fixar" data-campo="${campo}" title="Passa a ser o padrão deste navegador">Fixar seleção atual</button><span class="muted" id="ms-msg-${campo}" style="font-size:11.5px"></span></div>
          ${ops.map((o) => `<label class="ms-op"><input type="checkbox" data-ms-op="${campo}" value="${esc(o.id)}" ${s.includes(o.id) ? 'checked' : ''}> ${esc(o.nome)}${padraoIds(campo).includes(o.id) ? '<span class="pad">padrão</span>' : ''}</label>`).join('')}
          <label class="ms-op"><input type="checkbox" data-ms-op="${campo}" value="branco" ${s.includes('branco') ? 'checked' : ''}> (em branco: campo não preenchido)</label>
        </div>`
      : ''
  }`;
}

function pintarStatus() {
  const [de, ate] = intervalo();
  const per = de && ate ? `${de.split('-').reverse().join('/')} a ${ate.split('-').reverse().join('/')}` : '';
  $('#f-status').textContent = S.excluir.length ? `${per} · ${S.excluir.length} campanha${S.excluir.length > 1 ? 's' : ''} da Meta fora` : per;
}
function pintarFiltros() {
  $('#f-periodo').innerHTML = Object.entries(PRESETS).map(([k, [l]]) => `<option value="${k}" ${k === S.filtros.periodo ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const custom = S.filtros.periodo === 'custom';
  $('#f-de-l').hidden = !custom;
  $('#f-ate-l').hidden = !custom;
  if (custom) {
    $('#f-de').value = S.filtros.de;
    $('#f-ate').value = S.filtros.ate;
  }
  $('#f-produto').value = S.filtros.produto;
  const pipes = (S.catalogo?.pipelines ?? []).filter((p) => !S.filtros.produto || p.produto === S.filtros.produto);
  $('#f-pipeline').innerHTML = `<option value="">Todos</option>${pipes.map((p) => `<option value="${p.pipeline_id}" ${String(p.pipeline_id) === String(S.filtros.pipeline) ? 'selected' : ''}>${esc(p.pipeline)}</option>`).join('')}`;
  const [de, ate] = intervalo();
  pintarStatus();
  pintarMs('fontes');
  pintarMs('tipos');
  pintarCamp();
}

/* ---------- tooltip ---------- */
const tip = $('#tip');
function mostrarTip(ev, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const x = Math.min(ev.clientX + 14, window.innerWidth - w - 8);
  const y = ev.clientY + 16 + h > window.innerHeight ? ev.clientY - h - 12 : ev.clientY + 16;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const esconderTip = () => (tip.hidden = true);

/* ---------- gráficos ---------- */
/** Legenda pequena do card: o número do período comparado, a diferença absoluta e a variação em %. */
function comparacoes(i) {
  if (!i.comp?.length) return '';
  return `<div class="cmp">${i.comp
    .map((c) => `<div title="${esc(`${c.rotulo}: ${c.periodo}`)}"><span class="seta" aria-hidden="true">${c.abs == null ? '·' : seta(c.abs)}</span> vs ${esc(c.rotulo)}: ${esc(fmt(i.formato, c.valor))} · ${esc(fmtAbs(i.formato, c.abs))} (${esc(pctVar(c.pct))})</div>`)
    .join('')}</div>`;
}
function tiles(g) {
  return `<div class="tiles">${g.itens.map((i) => `<div class="tile"><div class="v">${esc(fmt(i.formato, i.valor))}</div><div class="l">${esc(i.rotulo)}</div>${i.dica ? `<div class="d">${esc(i.dica)}</div>` : ''}${comparacoes(i)}</div>`).join('')}</div>`;
}

function barras(g) {
  const max = Math.max(...g.itens.map((i) => i.valor), 1e-9);
  if (!g.itens.length) return '<p class="muted">Nada para mostrar neste filtro.</p>';
  const corDe = (idx) => (g.ordinal ? `var(--seq-${Math.min(idx + 1, 6)})` : 'var(--series-1)');
  return `<div class="barras" role="img" aria-label="${esc(g.itens.map((i) => `${i.rotulo}: ${fmt(g.formato, i.valor)}`).join('; '))}">${g.itens
    .map(
      (i, idx) => `<div class="barra" data-i="${idx}"><div class="rot">${esc(i.rotulo)}</div><div class="trilho"><div style="flex:1;min-width:0"><div class="fill" style="width:${(i.valor / max) * 100}%;background:${corDe(idx)}"></div></div><div class="val">${esc(fmt(g.formato, i.valor))}</div></div></div>`,
    )
    .join('')}</div>`;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const pot = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * pot) return m * pot;
  return 10 * pot;
}
const rotuloMes = (c) => { const p = c.split('-'); if (p.length === 3) return `${p[2]}/${p[1]}`; return `${MESES[Number(p[1]) - 1]}/${p[0].slice(2)}`; };

/** A série a que as linhas valem: a escolhida, senão a primeira ('todas' = todas). */
function seriesDasLinhas(g) {
  const s = S.linhas.serie;
  return s === 'todas' || g.series.some((x) => x.id === s) ? s : g.series[0].id;
}
/** Linhas de referência ligadas, com as séries a que se aplicam. */
function linhasVisiveis(g) {
  const sel = seriesDasLinhas(g);
  const series = sel === 'todas' ? g.series : g.series.filter((s) => s.id === sel);
  return (g.linhas ?? []).filter((l) => S.linhas[l.id] !== false).map((l) => ({ l, series }));
}

function colunas(g) {
  const W = 960, H = 300, L = 50, R = 8, T = 10, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const n = g.categorias.length;
  if (!n) return '<p class="muted">Nada para mostrar neste filtro.</p>';
  const f = g.formato ?? 'int';
  // a escala considera as linhas de referência (ligadas ou não), para as colunas não "pularem" ao ligar ou desligar uma linha
  const todosRef = (g.linhas ?? []).flatMap((l) => Object.values(l.valores).flat());
  const maxV = niceMax(Math.max(...g.series.flatMap((s) => s.valores), ...todosRef, 1e-9));
  const y = (v) => T + ih - (v / maxV) * ih;
  const band = iw / n;
  const k = g.series.length;
  const bw = Math.min(24, Math.max(3, (band * 0.78 - 2 * (k - 1)) / k));
  const grupo = bw * k + 2 * (k - 1);
  const ticks = [0, 1, 2, 3, 4].map((i) => (maxV / 4) * i);
  const topo = (x, yy, w, h) => { const r = Math.min(4, w / 2, h); return h <= 0 ? '' : `M${x},${yy + h}L${x},${yy + r}Q${x},${yy} ${x + r},${yy}L${x + w - r},${yy}Q${x + w},${yy} ${x + w},${yy + r}L${x + w},${yy + h}Z`; };
  const passo = Math.max(1, Math.ceil(n / 14));
  const barrasSvg = g.categorias.map((c, ci) => {
    const x0 = L + band * ci + (band - grupo) / 2;
    return g.series.map((s, si) => `<path d="${topo(x0 + si * (bw + 2), y(s.valores[ci]), bw, (s.valores[ci] / maxV) * ih)}" fill="${COR(s.slot)}"/>`).join('');
  }).join('');
  const hits = g.categorias.map((c, ci) => `<rect class="hit" data-c="${ci}" x="${L + band * ci}" y="${T}" width="${band}" height="${ih}" fill="transparent"/>`).join('');
  // linhas de referência: cheia = mês anterior, tracejada = ano anterior; a cor é a da série (a cor segue a entidade) e o estilo da linha é o que as distingue
  const lv = linhasVisiveis(g);
  const linhasSvg = lv.map(({ l, series }) => series.map((s) => {
    const v = l.valores[s.id];
    if (!v) return '';
    const pts = v.map((val, ci) => [L + band * ci + band / 2, y(val)]);
    return `<g class="ref ref-${l.id}"><polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${COR(s.slot)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" ${l.tracejada ? 'stroke-dasharray="6 4"' : ''}/>${pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="2.8" fill="${COR(s.slot)}" stroke="var(--viz-surface, var(--surface, #fff))" stroke-width="1.5"/>`).join('')}</g>`;
  }).join('')).join('');
  const controles = g.linhas?.length
    ? `<div class="ref-ctl" role="group" aria-label="Linhas de referência">${g.linhas
        .map((l) => `<label><input type="checkbox" data-linha="${l.id}" ${S.linhas[l.id] !== false ? 'checked' : ''}> <svg width="26" height="8" aria-hidden="true"><line x1="1" y1="4" x2="25" y2="4" stroke="var(--viz-ink-2)" stroke-width="2" ${l.tracejada ? 'stroke-dasharray="5 3"' : ''}/></svg> ${esc(l.nome)}</label>`)
        .join('')}<label>linhas de: <select data-linha-serie>${[...g.series.map((s) => [s.id, s.nome]), ['todas', 'todas as séries']].map(([v, nome]) => `<option value="${esc(v)}" ${seriesDasLinhas(g) === v ? 'selected' : ''}>${esc(nome)}</option>`).join('')}</select></label></div>`
    : '';
  return `
    <div class="legenda">${g.series.map((s) => `<span><i style="background:${COR(s.slot)}"></i>${esc(s.nome)}</span>`).join('')}</div>
    ${controles}
    <svg class="col" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(g.categorias.map((c, ci) => `${rotuloMes(c)}: ${g.series.map((s) => `${s.nome} ${fmt(f, s.valores[ci])}`).join(', ')}`).join('; '))}">
      ${ticks.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${esc(fmt(f, t))}</text>`).join('')}
      <line class="eixo" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>
      ${barrasSvg}
      ${linhasSvg}
      ${g.categorias.map((c, ci) => (ci % passo === 0 ? `<text x="${L + band * ci + band / 2}" y="${H - 8}" text-anchor="middle">${rotuloMes(c)}</text>` : '')).join('')}
      ${hits}
    </svg>`;
}

/* ---------- série no tempo (Meta Ads): dia, semana, mês ou trimestre; um gráfico por métrica, cada um com a sua escala ---------- */
const GRANS = [['dia', 'Diário'], ['semana', 'Semanal'], ['mes', 'Mensal'], ['trimestre', 'Trimestral']];
const COMP = ['gasto', 'impressoes', 'cliques_link', 'visitas', 'leads_meta', 'leads'];
const div = (a, b) => (b > 0 ? a / b : null);
/** Cada métrica sai das SOMAS do balde (dia, semana...), nunca de média de taxas. */
const SERIE_MET = [
  { id: 'invest', rot: 'Investimento', f: 'brl', calc: (s) => s.gasto },
  { id: 'cpl', rot: 'CPL (Pipedrive)', f: 'brl2', calc: (s) => div(s.gasto, s.leads), dica: 'Investimento ÷ negócios Meta ADS criados no período' },
  { id: 'cpl_meta', rot: 'CPL (Meta)', f: 'brl2', calc: (s) => div(s.gasto, s.leads_meta), dica: 'Investimento ÷ leads que a Meta atribui' },
  { id: 'cpm', rot: 'CPM', f: 'brl2', calc: (s) => (s.impressoes > 0 ? (s.gasto / s.impressoes) * 1000 : null), dica: 'Investimento ÷ impressões × 1000' },
  { id: 'cpc', rot: 'CPC (link)', f: 'brl2', calc: (s) => div(s.gasto, s.cliques_link), dica: 'Investimento ÷ cliques no link' },
  { id: 'ctr', rot: 'CTR (link)', f: 'pct', calc: (s) => div(s.cliques_link, s.impressoes), dica: 'Cliques no link ÷ impressões' },
  { id: 'connect', rot: 'Connect Rate', f: 'pct', calc: (s) => div(s.visitas, s.cliques_link), dica: 'Visitas à página ÷ cliques no link' },
  { id: 'impressoes', rot: 'Impressões', f: 'int', calc: (s) => s.impressoes },
  { id: 'cliques_link', rot: 'Cliques no link', f: 'int', calc: (s) => s.cliques_link },
  { id: 'leads_meta', rot: 'Leads (Meta)', f: 'int', calc: (s) => s.leads_meta },
  { id: 'leads', rot: 'Leads (Pipedrive)', f: 'int', calc: (s) => s.leads },
];
S.serie = { gran: 'semana', metricas: ['invest', 'cpl'], ...(ler('bi.serie') ?? {}) };
if (!GRANS.some(([k]) => k === S.serie.gran)) S.serie.gran = 'semana';
S.serie.metricas = (S.serie.metricas ?? []).filter((m) => SERIE_MET.some((x) => x.id === m));
const SERIE_VIS = {}; // card -> { baldes, gran, mets }: o que está na tela (a dica ao passar o mouse lê daqui)
const somaDias = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
const dm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const dmy = (d) => `${dm(d)}/${d.slice(0, 4)}`;

/** [chave, início, fim] do balde a que o dia pertence (semana começa na segunda-feira; trimestre de calendário). */
function baldeDe(d, gran) {
  if (gran === 'dia') return [d, d, d];
  if (gran === 'semana') {
    const seg = somaDias(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
    return [seg, seg, somaDias(seg, 6)];
  }
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
  if (gran === 'mes') return [d.slice(0, 7), `${d.slice(0, 7)}-01`, new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)];
  const q = Math.floor((m - 1) / 3);
  return [`${y}-T${q + 1}`, `${y}-${String(q * 3 + 1).padStart(2, '0')}-01`, new Date(Date.UTC(y, q * 3 + 3, 0)).toISOString().slice(0, 10)];
}
const rotBalde = (b, gran) => (gran === 'mes' ? rotuloMes(b.chave) : gran === 'trimestre' ? `${b.chave.slice(5)}/${b.chave.slice(2, 4)}` : dm(b.ini));
const titBalde = (b, gran) => (gran === 'dia' ? dmy(b.ini) : gran === 'semana' ? `Semana de ${dm(b.ini)} a ${dmy(b.fim)}` : gran === 'mes' ? rotuloMes(b.chave) : `${b.chave.slice(5)} de ${b.chave.slice(0, 4)}`);

/** Soma os dias em baldes, em todo o calendário do primeiro ao último dia com dados (dia sem registro entra como zero). */
function serieAgregar(pontos, gran) {
  if (!pontos.length) return [];
  const mapa = new Map(pontos.map((p) => [p.dia, p]));
  const primeiro = pontos[0].dia, ultimo = pontos[pontos.length - 1].dia;
  const out = [], idx = new Map();
  for (let d = primeiro; d <= ultimo; d = somaDias(d, 1)) {
    const [chave, ini, fim] = baldeDe(d, gran);
    let b = idx.get(chave);
    if (!b) {
      b = { chave, ini, fim, parcial: ini < primeiro || fim > ultimo, ...Object.fromEntries(COMP.map((k) => [k, 0])) };
      idx.set(chave, b);
      out.push(b);
    }
    const p = mapa.get(d);
    if (p) for (const k of COMP) b[k] += p[k];
  }
  return out;
}

function serieGrafico(m, baldes, gran) {
  const W = 960, H = 190, L = 58, R = 10, T = 12, B = 26;
  const iw = W - L - R, ih = H - T - B, n = baldes.length;
  const vals = baldes.map((b) => m.calc(b));
  const maxV = niceMax(Math.max(...vals.filter((v) => v != null), 1e-9));
  const band = iw / n;
  const x = (i) => L + band * (i + 0.5);
  const y = (v) => T + ih - (v / maxV) * ih;
  const ticks = [0, 1, 2, 3, 4].map((i) => (maxV / 4) * i);
  // segmentos contínuos (valor ausente quebra a linha); o que toca um período parcial vai tracejado
  let tracos = '';
  for (let i = 0; i < n - 1; i++) {
    if (vals[i] == null || vals[i + 1] == null) continue;
    const tr = baldes[i].parcial || baldes[i + 1].parcial;
    tracos += `<line x1="${x(i)}" y1="${y(vals[i])}" x2="${x(i + 1)}" y2="${y(vals[i + 1])}" stroke="var(--series-1)" stroke-width="2" stroke-linecap="round" ${tr ? 'stroke-dasharray="5 4"' : ''}/>`;
  }
  const marcas = n <= 45 ? vals.map((v, i) => (v == null ? '' : `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="${baldes[i].parcial ? 'var(--viz-surface)' : 'var(--series-1)'}" stroke="var(--series-1)" stroke-width="2"/>`)).join('') : '';
  const passo = Math.max(1, Math.ceil(n / 14));
  const hits = baldes.map((b, i) => `<rect class="hit sx" data-m="${m.id}" data-i="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${ih}" fill="transparent"/>`).join('');
  const total = m.calc(Object.fromEntries(COMP.map((k) => [k, baldes.reduce((s, b) => s + b[k], 0)])));
  return `<div class="sm"><div class="sm-t"><b>${esc(m.rot)}</b><span>no período: <b>${esc(fmt(m.f, total))}</b></span></div>
    <svg class="col" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${m.rot}: ${baldes.map((b, i) => `${titBalde(b, gran)} ${fmt(m.f, vals[i])}`).join('; ')}`)}">
      ${ticks.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${esc(fmt(m.f, t))}</text>`).join('')}
      <line class="eixo" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>
      ${tracos}${marcas}
      ${baldes.map((b, i) => (i % passo === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(rotBalde(b, gran))}</text>` : '')).join('')}
      ${hits}
    </svg></div>`;
}

function serie(g, a) {
  const st = S.serie;
  const baldes = serieAgregar(g.pontos, st.gran);
  const mets = SERIE_MET.filter((m) => st.metricas.includes(m.id));
  SERIE_VIS[a.id] = { baldes, gran: st.gran, mets };
  const ctl = `<div class="serie-ctl"><div class="seg" role="group" aria-label="Granularidade">${GRANS.map(([k, l]) => `<button type="button" data-gran="${k}" aria-pressed="${st.gran === k}">${l}</button>`).join('')}</div>
    <div class="chips" role="group" aria-label="Métricas">${SERIE_MET.map((m) => `<label title="${esc(m.dica ?? '')}"><input type="checkbox" data-met="${m.id}" ${st.metricas.includes(m.id) ? 'checked' : ''}> ${esc(m.rot)}</label>`).join('')}</div></div>`;
  if (!baldes.length) return `${ctl}<p class="muted">Nada para mostrar neste filtro.</p>`;
  const aviso = baldes.some((b) => b.parcial) ? '<p class="nota-serie">Linha tracejada e marcador vazado = período parcial (o filtro corta a semana, o mês ou o trimestre, ou ele ainda está em andamento).</p>' : '';
  return `${ctl}${mets.length ? mets.map((m) => serieGrafico(m, baldes, st.gran)).join('') : '<p class="muted">Marque ao menos uma métrica.</p>'}${aviso}`;
}

/** Mapa de calor: sequencial de uma cor só; o valor vai escrito na célula (não depende só da cor). */
function matriz(g) {
  if (!g.linhas.length) return '<p class="muted">Nada para mostrar neste filtro.</p>';
  const todos = g.linhas.flatMap((l) => l.valores).filter((v) => v != null);
  const maxGlobal = Math.max(...todos, 1e-9);
  const maxCol = g.colunas.map((_, ci) => Math.max(...g.linhas.map((l) => l.valores[ci] ?? 0), 1e-9));
  const maxLinha = g.linhas.map((l) => Math.max(...l.valores.map((v) => v ?? 0), 1e-9));
  const cel = (v, ci, li) => {
    if (v == null) return '<td class="cel vazia">—</td>';
    const base = g.escala === 'coluna' ? maxCol[ci] : g.escala === 'linha' ? maxLinha[li] : maxGlobal;
    const r = Math.min(1, v / base);
    return `<td class="cel" style="background:color-mix(in srgb, var(--series-1) ${Math.round(10 + 52 * r)}%, transparent)">${esc(fmt('pct', v))}</td>`;
  };
  return `<div class="matriz-wrap"><table class="mz"><thead><tr><th class="rot"></th>${g.colunas.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${
    g.linhas.map((l, li) => `<tr><td class="rot">${esc(l.rotulo)}${l.detalhe ? `<small>${esc(l.detalhe)}</small>` : ''}</td>${l.valores.map((v, ci) => cel(v, ci, li)).join('')}</tr>`).join('')
  }</tbody></table></div>`;
}

/**
 * Funis lado a lado: uma coluna por fonte, etapas alinhadas em linhas. A barra é a % dos leads da própria fonte que chegou na etapa
 * (a dos leads é sempre cheia), na cor fixa da fonte; o número e o passo (conversão da etapa anterior) vão escritos.
 */
function funis(g) {
  if (!g.colunas.length) return '<p class="muted">Nada para mostrar neste filtro.</p>';
  const ncol = g.colunas.length;
  const cab = g.colunas.map((k) => `<div class="fz-cab ${k.total ? 'total' : ''}"><i style="background:${k.total ? 'var(--viz-ink-2)' : COR(k.slot)}"></i><b>${esc(k.nome.replace(/^Marketing \[(.*)\]$/, '$1'))}</b><span>${nf.format(k.leads)} leads</span></div>`).join('');
  const linhas = g.etapas.map((etapa, i) => {
    const cels = g.colunas.map((k, ci) => {
      const v = k.valores[i];
      const pctLeads = k.leads > 0 ? v / k.leads : 0;
      const passo = i > 0 && k.passos[i] != null ? `<div class="fz-passo" title="Dos que chegaram na etapa anterior, quantos chegaram nesta">passo ${esc(fmt('pct', k.passos[i]))}</div>` : i > 0 ? '<div class="fz-passo">passo —</div>' : '';
      return `<div class="fz-cel" data-fz="${i}:${ci}">${passo}<div class="fz-linha"><div class="fz-bar" style="width:${Math.max(pctLeads * 100, v > 0 ? 1.5 : 0.4)}%;background:${k.total ? 'var(--viz-ink-2)' : COR(k.slot)}"></div></div><div class="fz-num"><b>${nf.format(v)}</b> <span>${esc(fmt('pct', pctLeads))} dos leads</span></div></div>`;
    }).join('');
    return `<div class="fz-rot">${esc(etapa)}</div>${cels}`;
  }).join('');
  return `<div class="funis-wrap"><div class="funis" style="grid-template-columns:minmax(120px,150px) repeat(${ncol}, minmax(150px,1fr))"><div></div>${cab}${linhas}</div></div>`;
}

function tabela(t) {
  const num = (tp) => tp !== 'texto';
  return `<div class="tabela-wrap"><table class="t"><thead><tr>${t.colunas.map((c) => `<th class="${num(c.tipo) ? 'num' : ''}">${esc(c.rotulo)}</th>`).join('')}</tr></thead><tbody>${
    t.linhas.map((l) => `<tr>${t.colunas.map((c) => `<td class="${num(c.tipo) ? 'num' : ''}">${esc(fmt(c.tipo, l[c.id]))}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${t.colunas.length}" class="muted">Nada para mostrar neste filtro.</td></tr>`
  }</tbody></table></div>`;
}

function csv(a, r) {
  const cel = (c, v) => {
    let s = v == null ? '' : c.tipo === 'pct' ? `${nf1.format(v * 100)}%` : typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    if (/[;"\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const linhas = [r.tabela.colunas.map((c) => c.rotulo).join(';'), ...r.tabela.linhas.map((l) => r.tabela.colunas.map((c) => cel(c, l[c.id])).join(';'))];
  const blob = new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: `bi-${a.id}-${iso(new Date())}.csv` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- cards ---------- */
const RES = new Map(); // `${filtros}|${id}` -> { resultado | erro } (cada combinação de filtros tem o seu; respostas antigas nunca aparecem)
const chaveDe = (a) => `${queryFiltros()}|${a.id}`;
const analisesDaPagina = () => S.catalogo.analises.filter((a) => a.pagina === S.pagina);

function corpo(a) {
  const r = RES.get(chaveDe(a));
  if (!r) return '<p class="muted">Carregando…</p>';
  if (r.erro) return `<div class="erro">Não consegui carregar esta análise: ${esc(r.erro)}</div>`;
  const { grafico, tabela: t, avisos } = r.resultado;
  const modo = S.modo[a.id] ?? 'grafico';
  const av = avisos.map((m) => `<div class="aviso">${esc(m)}</div>`).join('');
  const vis = modo === 'tabela' || grafico.tipo === 'tabela' ? tabela(t) : grafico.tipo === 'kpis' ? tiles(grafico) : grafico.tipo === 'colunas' ? colunas(grafico) : grafico.tipo === 'serie' ? serie(grafico, a) : grafico.tipo === 'matriz' ? matriz(grafico) : grafico.tipo === 'funis' ? funis(grafico) : barras(grafico);
  return `${vis}${av}`;
}

function pintarCard(a) {
  const el = $(`#card-${a.id}`);
  if (!el) return;
  const r = RES.get(chaveDe(a));
  const modo = S.modo[a.id] ?? 'grafico';
  const temGrafico = r?.resultado && !['tabela', 'kpis'].includes(r.resultado.grafico.tipo);
  el.innerHTML = `
    <div class="bi-head"><h2>${esc(a.titulo)}</h2>
      <div class="bi-tools">
        ${temGrafico ? `<button data-modo="grafico" aria-pressed="${modo === 'grafico'}">${r.resultado.grafico.tipo === 'matriz' ? 'Mapa' : 'Gráfico'}</button>` : ''}
        ${r?.resultado ? `<button data-modo="tabela" aria-pressed="${modo === 'tabela'}">Tabela</button><button data-csv="1" title="Baixar como planilha (CSV)">CSV</button>` : ''}
      </div></div>
    <p class="bi-pergunta">${esc(a.pergunta)}</p>
    <div class="bi-corpo">${corpo(a)}</div>
    <details class="como"><summary>Como ler</summary><p>${esc(a.como_ler)}</p></details>`;
}

function montarPagina() {
  $('#abas').innerHTML = S.catalogo.paginas.map((p) => `<button class="aba" role="tab" data-pagina="${p.id}" aria-selected="${p.id === S.pagina}">${esc(p.rotulo)}</button>`).join('');
  $('#grade').innerHTML = analisesDaPagina().map((a) => `<section class="bi-card ${a.largura === 'cheia' ? 'cheia' : ''}" id="card-${a.id}"></section>`).join('');
  carregarPagina();
}

function carregarPagina() {
  const [de, ate] = intervalo();
  if (!de || !ate || de > ate) {
    $('#f-status').textContent = 'Confira as datas do período.';
    return;
  }
  const qs = queryFiltros();
  for (const a of analisesDaPagina()) {
    const chave = `${qs}|${a.id}`;
    if (RES.has(chave)) {
      pintarCard(a);
      continue;
    }
    pintarCard(a);
    api(`/api/bi/analise/${a.id}?${qs}`)
      .then((resultado) => RES.set(chave, { resultado }))
      .catch((e) => RES.set(chave, { erro: e.message }))
      .finally(() => { if (queryFiltros() === qs && a.pagina === S.pagina) pintarCard(a); });
  }
}

function filtrosMudaram() {
  guardar('bi.filtros', S.filtros);
  pintarFiltros();
  carregarPagina();
}

/* ---------- eventos ---------- */
document.addEventListener('change', (ev) => {
  const t = ev.target;
  // caixas das linhas de referência (mês anterior, ano anterior) e a série a que valem
  if (t.dataset?.linha || t.hasAttribute?.('data-linha-serie')) {
    if (t.dataset.linha) S.linhas[t.dataset.linha] = t.checked;
    else S.linhas.serie = t.value;
    guardar('bi.linhas', S.linhas);
    const card = t.closest('.bi-card');
    const a = card && S.catalogo.analises.find((x) => `card-${x.id}` === card.id);
    if (a) pintarCard(a);
    return;
  }
  // série no tempo: métricas escolhidas
  if (t.dataset?.met) {
    const s = new Set(S.serie.metricas);
    t.checked ? s.add(t.dataset.met) : s.delete(t.dataset.met);
    S.serie.metricas = SERIE_MET.filter((m) => s.has(m.id)).map((m) => m.id);
    guardar('bi.serie', S.serie);
    const card = t.closest('.bi-card');
    const a = card && S.catalogo.analises.find((x) => `card-${x.id}` === card.id);
    if (a) pintarCard(a);
    return;
  }
  if (t.dataset && 'campOp' in t.dataset) {
    const s = new Set(S.excluir);
    t.checked ? s.add(t.value) : s.delete(t.value);
    S.excluir = [...s];
    excluirMudou();
    return;
  }
  if (t.dataset?.msOp) {
    const campo = t.dataset.msOp;
    const s = new Set(sel(campo));
    t.checked ? s.add(t.value) : s.delete(t.value);
    S.filtros[campo] = [...s];
    $(`#ms-${campo} .ms-btn`).textContent = `${resumoSel(campo)} ▾`;
    clearTimeout(filtrosMudaram.t);
    filtrosMudaram.t = setTimeout(() => { guardar('bi.filtros', S.filtros); carregarPagina(); }, 400); // espera o clique seguinte antes de consultar
    return;
  }
  const id = t.id;
  if (id === 'f-periodo') {
    S.filtros.periodo = t.value;
    if (S.filtros.periodo === 'custom' && !S.filtros.de) [S.filtros.de, S.filtros.ate] = PRESETS.ano[1]();
  } else if (id === 'f-de') S.filtros.de = t.value;
  else if (id === 'f-ate') S.filtros.ate = t.value;
  else if (id === 'f-produto') {
    S.filtros.produto = t.value;
    S.filtros.pipeline = '';
  } else if (id === 'f-pipeline') S.filtros.pipeline = t.value;
  else return;
  filtrosMudaram();
});

document.addEventListener('click', (ev) => {
  const t = ev.target;
  // abas
  const aba = t.closest?.('[data-pagina].aba');
  if (aba) {
    S.pagina = aba.dataset.pagina;
    history.replaceState(null, '', `#${S.pagina}`);
    S.aberto = null;
    pintarFiltros();
    montarPagina();
    return;
  }
  // campanhas da Meta fora do CPL
  const cTog = t.closest?.('[data-camp-toggle]');
  if (cTog) {
    S.aberto = S.aberto === 'camp' ? null : 'camp';
    pintarMs('fontes');
    pintarMs('tipos');
    pintarCamp();
    if (S.aberto === 'camp') carregarCampanhas();
    return;
  }
  const cAc = t.closest?.('[data-camp-acao]');
  if (cAc) {
    const acao = cAc.dataset.campAcao;
    const visiveis = campVisiveis().map((c) => c.id);
    if (acao === 'limpar') S.excluir = [];
    else if (acao === 'marcar') S.excluir = [...new Set([...S.excluir, ...visiveis])];
    else if (acao === 'desmarcar') S.excluir = S.excluir.filter((id) => !visiveis.includes(id));
    $('#camp-lista') && ($('#camp-lista').innerHTML = listaCamp());
    excluirMudou();
    return;
  }
  // seletores de Fonte e Tipo
  const ms = t.closest?.('[data-ms]');
  if (ms) {
    S.aberto = S.aberto === ms.dataset.ms ? null : ms.dataset.ms;
    pintarMs('fontes');
    pintarMs('tipos');
    pintarCamp();
    return;
  }
  const acao = t.closest?.('[data-ms-acao]');
  if (acao) {
    const campo = acao.dataset.campo;
    const ops = S.catalogo[campo];
    if (acao.dataset.msAcao === 'padrao') S.filtros[campo] = undefined;
    if (acao.dataset.msAcao === 'todas') S.filtros[campo] = [...ops.map((o) => o.id), 'branco'];
    if (acao.dataset.msAcao === 'fixar') {
      S.padrao[campo] = [...sel(campo)];
      guardar('bi.padrao', S.padrao);
      S.filtros[campo] = undefined;
      filtrosMudaram();
      S.aberto = campo;
      pintarMs(campo);
      const m = $(`#ms-msg-${campo}`);
      if (m) m.textContent = 'fixado como padrão';
      return;
    }
    S.aberto = campo;
    filtrosMudaram();
    return;
  }
  if (S.aberto && !t.closest?.('.ms')) {
    S.aberto = null;
    pintarMs('fontes');
    pintarMs('tipos');
    pintarCamp();
  }
  // cards: Gráfico/Tabela e CSV
  const card = t.closest?.('.bi-card');
  const a = card && S.catalogo.analises.find((x) => `card-${x.id}` === card.id);
  if (!a) return;
  const gr = t.closest('[data-gran]');
  if (gr) {
    S.serie.gran = gr.dataset.gran;
    guardar('bi.serie', S.serie);
    pintarCard(a);
    return;
  }
  const m = t.closest('[data-modo]');
  if (m) {
    S.modo[a.id] = m.dataset.modo;
    pintarCard(a);
  }
  if (t.closest('[data-csv]') && RES.get(chaveDe(a))?.resultado) csv(a, RES.get(chaveDe(a)).resultado);
});

document.addEventListener('input', (ev) => {
  if (ev.target.id !== 'camp-busca') return;
  S.campBusca = ev.target.value;
  $('#camp-lista') && ($('#camp-lista').innerHTML = listaCamp());
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && S.aberto) {
    S.aberto = null;
    pintarMs('fontes');
    pintarMs('tipos');
    pintarCamp();
  }
});

document.addEventListener('mousemove', (ev) => {
  const card = ev.target.closest?.('.bi-card');
  const a = card && S.catalogo?.analises.find((x) => `card-${x.id}` === card.id);
  const r = a && RES.get(chaveDe(a))?.resultado;
  if (!r) return esconderTip();
  const g = r.grafico;
  const barra = ev.target.closest('.barra');
  if (barra && g.tipo === 'barras') {
    const i = g.itens[Number(barra.dataset.i)];
    return mostrarTip(ev, `<b class="t">${esc(i.rotulo)}</b>${esc(fmt(g.formato, i.valor))}${i.detalhe ? `<br><span style="color:var(--viz-muted)">${esc(i.detalhe)}</span>` : ''}`);
  }
  const fz = ev.target.closest('.fz-cel');
  if (fz && g.tipo === 'funis') {
    const [i, ci] = fz.dataset.fz.split(':').map(Number);
    const k = g.colunas[ci];
    const v = k.valores[i];
    return mostrarTip(ev, `<b class="t">${esc(k.nome)} › ${esc(g.etapas[i])}</b>${nf.format(v)} negócios (${esc(fmt('pct', k.leads > 0 ? v / k.leads : 0))} dos ${nf.format(k.leads)} leads)${i > 0 ? `<br><span style="color:var(--viz-muted)">Dos que chegaram em "${esc(g.etapas[i - 1])}": ${esc(fmt('pct', k.passos[i]))} chegaram aqui</span>` : ''}`);
  }
  const sx = ev.target.closest('.sx');
  if (sx && g.tipo === 'serie' && SERIE_VIS[a.id]) {
    const { baldes, gran, mets } = SERIE_VIS[a.id];
    const b = baldes[Number(sx.dataset.i)];
    const m = mets.find((x) => x.id === sx.dataset.m);
    if (!b || !m) return esconderTip();
    // além da métrica pontada, as outras escolhidas no mesmo ponto
    return mostrarTip(ev, `<b class="t">${esc(titBalde(b, gran))}${b.parcial ? ' <span style="color:var(--viz-muted);font-weight:400">(parcial)</span>' : ''}</b>${mets.map((x) => `<div class="lin" ${x.id === m.id ? 'style="font-weight:700"' : ''}>${esc(x.rot)}: ${esc(fmt(x.f, x.calc(b)))}</div>`).join('')}`);
  }
  const hit = ev.target.closest('.hit');
  if (hit && g.tipo === 'colunas') {
    const ci = Number(hit.dataset.c);
    const f = g.formato ?? 'int';
    // com linhas de referência ligadas, cada série mostra também o valor do mês anterior e do ano anterior
    const lv = linhasVisiveis(g);
    const refDe = (s) => lv.filter(({ series }) => series.includes(s)).map(({ l }) => `${l.id === 'mes_anterior' ? 'mês ant.' : 'ano ant.'}: ${fmt(f, l.valores[s.id]?.[ci])}`);
    return mostrarTip(ev, `<b class="t">${rotuloMes(g.categorias[ci])}</b>${g.series.map((s) => `<div class="lin"><i style="background:${COR(s.slot)}"></i>${esc(s.nome)}: <b>${esc(fmt(f, s.valores[ci]))}</b>${refDe(s).length ? ` <span style="color:var(--viz-muted)">(${esc(refDe(s).join(' · '))})</span>` : ''}</div>`).join('')}`);
  }
  esconderTip();
});
document.addEventListener('mouseleave', esconderTip);

/* ---------- início ---------- */
async function iniciar() {
  try {
    S.catalogo = await api('/api/bi/catalogo');
  } catch (e) {
    $('#aviso').innerHTML = `<div class="banner ${e.status === 503 ? 'warn' : 'danger'}" style="margin-bottom:12px">${e.status === 503 ? '<strong>O BI ainda não está ligado ao banco.</strong> ' : 'Não consegui carregar: '}${esc(e.message)}</div>`;
    return;
  }
  const h = location.hash.replace('#', '');
  if (S.catalogo.paginas.some((p) => p.id === h)) S.pagina = h;
  pintarFiltros();
  montarPagina();
}
iniciar();
