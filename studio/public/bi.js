const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const nf = new Intl.NumberFormat('pt-BR');
const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function fmt(tipo, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (tipo === 'int') return nf.format(v);
  if (tipo === 'pct') return `${nf1.format(v * 100)}%`;
  if (tipo === 'brl') return brl.format(v);
  if (tipo === 'dias') return `${nf1.format(v)} d`;
  return String(v);
}

async function api(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.detail || data.error || res.statusText), { status: res.status });
  return data;
}

/* ---------- filtros ---------- */
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

const S = { catalogo: null, filtros: { periodo: 'ano', de: '', ate: '', produto: '', pipeline: '' }, modo: {}, seq: 0 };
try {
  Object.assign(S.filtros, JSON.parse(localStorage.getItem('bi.filtros') ?? '{}'));
} catch {
  /* sem armazenamento: usa o padrão */
}
if (!PRESETS[S.filtros.periodo]) S.filtros.periodo = 'ano';

function intervalo() {
  const f = S.filtros;
  if (f.periodo === 'custom') return [f.de, f.ate];
  return PRESETS[f.periodo][1]();
}

function salvarFiltros() {
  try {
    localStorage.setItem('bi.filtros', JSON.stringify(S.filtros));
  } catch {
    /* sem armazenamento: tudo bem */
  }
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
  $('#f-status').textContent = de && ate ? `${de.split('-').reverse().join('/')} a ${ate.split('-').reverse().join('/')}` : '';
}

function queryFiltros() {
  const [de, ate] = intervalo();
  const p = new URLSearchParams({ de, ate });
  if (S.filtros.produto) p.set('produto', S.filtros.produto);
  if (S.filtros.pipeline) p.set('pipeline', S.filtros.pipeline);
  return p.toString();
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
function tiles(g) {
  return `<div class="tiles">${g.itens.map((i) => `<div class="tile"><div class="v">${esc(fmt(i.formato, i.valor))}</div><div class="l">${esc(i.rotulo)}</div>${i.dica ? `<div class="d">${esc(i.dica)}</div>` : ''}</div>`).join('')}</div>`;
}

function barras(g) {
  const max = Math.max(...g.itens.map((i) => i.valor), 1);
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

function colunas(g) {
  const W = 960, H = 300, L = 46, R = 8, T = 10, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const n = g.categorias.length;
  if (!n) return '<p class="muted">Nada para mostrar neste filtro.</p>';
  const cores = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];
  const maxV = niceMax(Math.max(...g.series.flatMap((s) => s.valores), 1));
  const y = (v) => T + ih - (v / maxV) * ih;
  const band = iw / n;
  const k = g.series.length;
  const bw = Math.min(24, Math.max(3, (band * 0.78 - 2 * (k - 1)) / k));
  const grupo = bw * k + 2 * (k - 1);
  const ticks = [0, 1, 2, 3, 4].map((i) => (maxV / 4) * i);
  const rotulo = (c) => { const [a, m] = c.split('-'); return `${MESES[Number(m) - 1]}/${a.slice(2)}`; };
  const topo = (x, yy, w, h) => { const r = Math.min(4, w / 2, h); return h <= 0 ? '' : `M${x},${yy + h}L${x},${yy + r}Q${x},${yy} ${x + r},${yy}L${x + w - r},${yy}Q${x + w},${yy} ${x + w},${yy + r}L${x + w},${yy + h}Z`; };
  const passo = n > 14 ? 2 : 1;
  const barrasSvg = g.categorias.map((c, ci) => {
    const x0 = L + band * ci + (band - grupo) / 2;
    return g.series.map((s, si) => {
      const v = s.valores[ci];
      const h = (v / maxV) * ih;
      return `<path d="${topo(x0 + si * (bw + 2), y(v), bw, h)}" fill="${cores[si]}"/>`;
    }).join('');
  }).join('');
  const hits = g.categorias.map((c, ci) => `<rect class="hit" data-c="${ci}" x="${L + band * ci}" y="${T}" width="${band}" height="${ih}" fill="transparent"/>`).join('');
  return `
    <div class="legenda">${g.series.map((s, si) => `<span><i style="background:${cores[si]}"></i>${esc(s.nome)}</span>`).join('')}</div>
    <svg class="col" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(g.categorias.map((c, ci) => `${rotulo(c)}: ${g.series.map((s) => `${s.nome} ${s.valores[ci]}`).join(', ')}`).join('; '))}">
      ${ticks.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${nf.format(t)}</text>`).join('')}
      <line class="eixo" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>
      ${barrasSvg}
      ${g.categorias.map((c, ci) => (ci % passo === 0 ? `<text x="${L + band * ci + band / 2}" y="${H - 8}" text-anchor="middle">${rotulo(c)}</text>` : '')).join('')}
      ${hits}
    </svg>`;
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
const RES = new Map(); // id -> { resultado | erro, seq }

function corpo(a) {
  const r = RES.get(a.id);
  if (!r) return '<p class="muted">Carregando…</p>';
  if (r.erro) return `<div class="erro">Não consegui carregar esta análise: ${esc(r.erro)}</div>`;
  const { grafico, tabela: t, avisos } = r.resultado;
  const modo = S.modo[a.id] ?? 'grafico';
  const av = avisos.map((m) => `<div class="aviso">${esc(m)}</div>`).join('');
  const vis = modo === 'tabela' || grafico.tipo === 'tabela' ? tabela(t) : grafico.tipo === 'kpis' ? tiles(grafico) : grafico.tipo === 'colunas' ? colunas(grafico) : barras(grafico);
  return `${vis}${av}`;
}

function pintarCard(a) {
  const el = $(`#card-${a.id}`);
  if (!el) return;
  const r = RES.get(a.id);
  const modo = S.modo[a.id] ?? 'grafico';
  const temGrafico = r?.resultado && r.resultado.grafico.tipo !== 'tabela' && r.resultado.grafico.tipo !== 'kpis';
  el.innerHTML = `
    <div class="bi-head"><h2>${esc(a.titulo)}</h2>
      <div class="bi-tools">
        ${temGrafico ? `<button data-modo="grafico" aria-pressed="${modo === 'grafico'}">Gráfico</button>` : ''}
        ${r?.resultado ? `<button data-modo="tabela" aria-pressed="${modo === 'tabela'}">Tabela</button><button data-csv="1" title="Baixar como planilha (CSV)">CSV</button>` : ''}
      </div></div>
    <p class="bi-pergunta">${esc(a.pergunta)}</p>
    <div class="bi-corpo">${corpo(a)}</div>
    <details class="como"><summary>Como ler</summary><p>${esc(a.como_ler)}</p></details>`;
}

const TOKEN = {}; // id -> número da última consulta; respostas de filtros antigos são ignoradas

function recarregarTudo() {
  pintarFiltros();
  salvarFiltros();
  const [de, ate] = intervalo();
  if (!de || !ate || de > ate) {
    $('#f-status').textContent = 'Confira as datas do período.';
    return;
  }
  S.catalogo.analises.forEach((a) => RES.set(a.id, null));
  S.catalogo.analises.forEach(pintarCard);
  // as análises são independentes: cada uma aparece assim que chega
  const qs = queryFiltros();
  for (const a of S.catalogo.analises) {
    const meu = (TOKEN[a.id] = ++S.seq);
    api(`/api/bi/analise/${a.id}?${qs}`)
      .then((resultado) => TOKEN[a.id] === meu && (RES.set(a.id, { resultado }), pintarCard(a)))
      .catch((e) => TOKEN[a.id] === meu && (RES.set(a.id, { erro: e.message }), pintarCard(a)));
  }
}

/* ---------- eventos ---------- */
document.addEventListener('change', (ev) => {
  const id = ev.target.id;
  if (id === 'f-periodo') {
    S.filtros.periodo = ev.target.value;
    if (S.filtros.periodo === 'custom' && !S.filtros.de) [S.filtros.de, S.filtros.ate] = PRESETS.ano[1]();
  } else if (id === 'f-de') S.filtros.de = ev.target.value;
  else if (id === 'f-ate') S.filtros.ate = ev.target.value;
  else if (id === 'f-produto') {
    S.filtros.produto = ev.target.value;
    S.filtros.pipeline = '';
  } else if (id === 'f-pipeline') S.filtros.pipeline = ev.target.value;
  else return;
  recarregarTudo();
});

document.addEventListener('click', (ev) => {
  const card = ev.target.closest?.('.bi-card');
  if (!card) return;
  const a = S.catalogo?.analises.find((x) => `card-${x.id}` === card.id);
  if (!a) return;
  const m = ev.target.closest('[data-modo]');
  if (m) {
    S.modo[a.id] = m.dataset.modo;
    pintarCard(a);
  }
  if (ev.target.closest('[data-csv]') && RES.get(a.id)?.resultado) csv(a, RES.get(a.id).resultado);
});

document.addEventListener('mousemove', (ev) => {
  const card = ev.target.closest?.('.bi-card');
  const a = card && S.catalogo?.analises.find((x) => `card-${x.id}` === card.id);
  const r = a && RES.get(a.id)?.resultado;
  if (!r) return esconderTip();
  const g = r.grafico;
  const barra = ev.target.closest('.barra');
  if (barra && g.tipo === 'barras') {
    const i = g.itens[Number(barra.dataset.i)];
    return mostrarTip(ev, `<b>${esc(i.rotulo)}</b>${esc(fmt(g.formato, i.valor))}${i.detalhe ? `<br><span style="color:var(--viz-muted)">${esc(i.detalhe)}</span>` : ''}`);
  }
  const hit = ev.target.closest('.hit');
  if (hit && g.tipo === 'colunas') {
    const ci = Number(hit.dataset.c);
    const cores = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];
    const [ano, mes] = g.categorias[ci].split('-');
    return mostrarTip(ev, `<b>${MESES[Number(mes) - 1]}/${ano}</b>${g.series.map((s, si) => `<div class="lin"><i style="background:${cores[si]}"></i>${esc(s.nome)}: <b style="display:inline;margin:0">${nf.format(s.valores[ci])}</b></div>`).join('')}`);
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
  $('#grade').innerHTML = S.catalogo.analises.map((a) => `<section class="bi-card ${a.largura === 'cheia' ? 'cheia' : ''}" id="card-${a.id}"></section>`).join('');
  recarregarTudo();
}
iniciar();
