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

async function api(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.detail || data.error || res.statusText), { status: res.status });
  return data;
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
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento: tudo bem */ } };
const ler = (k) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } };
Object.assign(S.filtros, ler('bi.filtros') ?? {});
S.padrao = ler('bi.padrao') ?? {};
if (!PRESETS[S.filtros.periodo]) S.filtros.periodo = 'ano';

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
  for (const [campo, param] of [['fontes', 'fonte'], ['tipos', 'tipo']]) {
    const s = sel(campo);
    if (s.length && !todasSel(campo)) p.set(param, s.join(','));
  }
  return p.toString();
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
  pintarMs('fontes');
  pintarMs('tipos');
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

function colunas(g) {
  const W = 960, H = 300, L = 50, R = 8, T = 10, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const n = g.categorias.length;
  if (!n) return '<p class="muted">Nada para mostrar neste filtro.</p>';
  const f = g.formato ?? 'int';
  const maxV = niceMax(Math.max(...g.series.flatMap((s) => s.valores), 1e-9));
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
  return `
    <div class="legenda">${g.series.map((s) => `<span><i style="background:${COR(s.slot)}"></i>${esc(s.nome)}</span>`).join('')}</div>
    <svg class="col" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(g.categorias.map((c, ci) => `${rotuloMes(c)}: ${g.series.map((s) => `${s.nome} ${fmt(f, s.valores[ci])}`).join(', ')}`).join('; '))}">
      ${ticks.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${esc(fmt(f, t))}</text>`).join('')}
      <line class="eixo" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>
      ${barrasSvg}
      ${g.categorias.map((c, ci) => (ci % passo === 0 ? `<text x="${L + band * ci + band / 2}" y="${H - 8}" text-anchor="middle">${rotuloMes(c)}</text>` : '')).join('')}
      ${hits}
    </svg>`;
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
  const vis = modo === 'tabela' || grafico.tipo === 'tabela' ? tabela(t) : grafico.tipo === 'kpis' ? tiles(grafico) : grafico.tipo === 'colunas' ? colunas(grafico) : grafico.tipo === 'matriz' ? matriz(grafico) : grafico.tipo === 'funis' ? funis(grafico) : barras(grafico);
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
  // seletores de Fonte e Tipo
  const ms = t.closest?.('[data-ms]');
  if (ms) {
    S.aberto = S.aberto === ms.dataset.ms ? null : ms.dataset.ms;
    pintarMs('fontes');
    pintarMs('tipos');
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
  }
  // cards: Gráfico/Tabela e CSV
  const card = t.closest?.('.bi-card');
  const a = card && S.catalogo.analises.find((x) => `card-${x.id}` === card.id);
  if (!a) return;
  const m = t.closest('[data-modo]');
  if (m) {
    S.modo[a.id] = m.dataset.modo;
    pintarCard(a);
  }
  if (t.closest('[data-csv]') && RES.get(chaveDe(a))?.resultado) csv(a, RES.get(chaveDe(a)).resultado);
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && S.aberto) {
    S.aberto = null;
    pintarMs('fontes');
    pintarMs('tipos');
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
  const hit = ev.target.closest('.hit');
  if (hit && g.tipo === 'colunas') {
    const ci = Number(hit.dataset.c);
    const f = g.formato ?? 'int';
    return mostrarTip(ev, `<b class="t">${rotuloMes(g.categorias[ci])}</b>${g.series.map((s) => `<div class="lin"><i style="background:${COR(s.slot)}"></i>${esc(s.nome)}: <b>${esc(fmt(f, s.valores[ci]))}</b></div>`).join('')}`);
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
