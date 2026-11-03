/**
 * Scorecard do BI: lê /api/scorecard (semanal sábado a sexta, ou mensal) e desenha indicadores em linhas, períodos em colunas.
 * "Adicionar métrica" escolhe uma coluna de uma visão do banco (ou a razão entre duas métricas) por NOME; o servidor confere tudo.
 */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ler = (k) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } };
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } };

const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const FMT = {
  int: (v) => nf0.format(Math.round(v)),
  pct: (v) => `${nf2.format(v * 100)}%`,
  brl: (v) => `R$ ${nf0.format(Math.round(v))}`,
  brl2: (v) => `R$ ${nf2.format(v)}`,
  dec: (v) => nf2.format(v),
};
const fmt = (f, v) => (v == null || Number.isNaN(v) ? '<span class="nd">—</span>' : (FMT[f] ?? FMT.dec)(v));

const E = { produto: ler('sc.produto') ?? 'rh', visao: ler('sc.visao') ?? 'semana', n: ler('sc.n') ?? 12, dados: null, cat: null, admin: true, aba: 'coluna' };
if (!['rh', 'clinic'].includes(E.produto)) E.produto = 'rh';
if (!['semana', 'mes'].includes(E.visao)) E.visao = 'semana';

async function api(rota, opt = {}) {
  const r = await fetch(`/api/scorecard${rota}`, { headers: { accept: 'application/json', ...(opt.body ? { 'content-type': 'application/json' } : {}) }, ...opt, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || j.error || `Erro ${r.status}`);
  return j;
}

function opcoesN() {
  const lista = E.visao === 'semana' ? [8, 12, 26, 52] : [6, 12, 24];
  if (!lista.includes(E.n)) E.n = E.visao === 'semana' ? 12 : 12;
  $('#f-n').innerHTML = lista.map((n) => `<option value="${n}"${n === E.n ? ' selected' : ''}>Últimos ${n} ${E.visao === 'semana' ? 'semanas' : 'meses'}</option>`).join('');
}
function marcaControles() {
  $('#f-produto').value = E.produto;
  $('#v-semana').setAttribute('aria-pressed', String(E.visao === 'semana'));
  $('#v-mes').setAttribute('aria-pressed', String(E.visao === 'mes'));
  opcoesN();
}

let seq = 0;
async function carregar() {
  const mine = ++seq;
  $('#status').textContent = 'Carregando…';
  $('#avisos').innerHTML = '';
  try {
    const d = await api(`?produto=${E.produto}&visao=${E.visao}&n=${E.n}`);
    if (mine !== seq) return;
    E.dados = d;
    $('#status').textContent = `Atualizado às ${new Date(d.geradoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (e) {
    if (mine !== seq) return;
    E.dados = null;
    $('#status').textContent = '';
    $('#avisos').innerHTML = `<div class="banner danger" role="alert">${esc(e.message)}</div>`;
  }
  desenhar();
}

function desenhar() {
  const d = E.dados;
  const tab = $('#tab');
  if (!d) { tab.innerHTML = ''; return; }
  $('#avisos').innerHTML = d.avisos.map((a) => `<div class="banner warn aviso">${esc(a)}</div>`).join('');
  const cab = d.periodos.map((p) => `<th class="${p.parcial ? 'parcial' : ''}" title="${p.parcial ? 'Em andamento' : ''}">${esc(p.rotulo)}${p.parcial ? '<small>em andamento</small>' : `<small>${E.visao === 'semana' ? 'sáb a sex' : ''}</small>`}</th>`).join('');
  let corpo = '';
  let grupo = '';
  for (const l of d.linhas) {
    if (l.grupo !== grupo) { grupo = l.grupo; corpo += `<tr class="grupo"><td colspan="${d.periodos.length + 1}">${esc(grupo)}</td></tr>`; }
    const x = l.custom ? ` <button class="x" data-del="${esc(l.id)}" title="Remover esta métrica" aria-label="Remover ${esc(l.rotulo)}">×</button>` : '';
    corpo += `<tr class="${l.custom ? 'custom' : ''}"><td class="ind" title="${esc(l.dica ?? l.rotulo)}">${esc(l.rotulo)}${x}</td>${l.valores.map((v, i) => `<td class="num${d.periodos[i].parcial ? ' parcial' : ''}">${fmt(l.fmt, v)}</td>`).join('')}</tr>`;
  }
  tab.innerHTML = `<thead><tr><th class="ind">Indicador</th>${cab}</tr></thead><tbody>${corpo}</tbody>`;
}

/* ---------- CSV ---------- */
function csv() {
  const d = E.dados;
  if (!d) return;
  const num = (f, v) => (v == null ? '' : f === 'pct' ? String(Math.round(v * 10000) / 100).replace('.', ',') : String(Math.round(v * 100) / 100).replace('.', ','));
  const cel = (s) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const linhas = [['Grupo', 'Indicador', ...d.periodos.map((p) => `${p.rotulo}${p.parcial ? ' (em andamento)' : ''}`)].map(cel).join(';'), ...d.linhas.map((l) => [l.grupo, l.rotulo, ...l.valores.map((v) => num(l.fmt, v))].map(cel).join(';'))];
  const blob = new Blob([`﻿# Scorecard ${d.produto} · ${d.visao === 'semana' ? 'semanas de sábado a sexta' : 'meses'} · célula vazia = sem base para calcular; percentuais em % (sem o símbolo)\r\n${linhas.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `scorecard-${d.produto}-${d.visao}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- adicionar métrica ---------- */
const dlg = $('#dlg');
async function abrirDialogo() {
  $('#dlg-erro').hidden = true;
  if (!E.cat) { try { E.cat = await api('/catalogo'); } catch (e) { $('#avisos').innerHTML = `<div class="banner danger">${esc(e.message)}</div>`; return; } }
  const visoes = Object.keys(E.cat.visoes).filter((v) => E.cat.visoes[v].colunas.some((c) => c.tipo === 'data')).sort();
  $('#c-visao').innerHTML = visoes.map((v) => `<option>${esc(v)}</option>`).join('');
  colunasDaVisao();
  const todas = [...E.cat.padrao, ...E.cat.personalizadas.filter((m) => m.tipo === 'coluna')];
  const opt = todas.map((m) => `<option value="${esc(m.id)}">${esc(m.rotulo)}</option>`).join('');
  $('#r-a').innerHTML = opt; $('#r-b').innerHTML = opt;
  dlg.showModal();
}
function colunasDaVisao() {
  const v = E.cat.visoes[$('#c-visao').value];
  $('#c-data').innerHTML = v.colunas.filter((c) => c.tipo === 'data').map((c) => `<option>${esc(c.nome)}</option>`).join('');
  $('#c-valor').innerHTML = v.colunas.filter((c) => c.tipo === 'numero').map((c) => `<option>${esc(c.nome)}</option>`).join('');
  $('#c-prod').disabled = !v.temProduto;
  $('#c-prod').checked = v.temProduto;
}
function trocaAba(a) {
  E.aba = a;
  $('#t-coluna').setAttribute('aria-pressed', String(a === 'coluna'));
  $('#t-razao').setAttribute('aria-pressed', String(a === 'razao'));
  $('#f-coluna').hidden = a !== 'coluna';
  $('#f-razao').hidden = a !== 'razao';
}
async function adicionar() {
  const corpo = E.aba === 'coluna'
    ? { tipo: 'coluna', rotulo: $('#c-rotulo').value, visao: $('#c-visao').value, colData: $('#c-data').value, colValor: $('#c-agg').value === 'contagem' ? null : $('#c-valor').value, agg: $('#c-agg').value, fmt: $('#c-fmt').value, porProduto: $('#c-prod').checked }
    : { tipo: 'razao', rotulo: $('#r-rotulo').value, a: $('#r-a').value, b: $('#r-b').value, fmt: $('#r-fmt').value };
  try {
    await api('/metricas', { method: 'POST', body: corpo });
    dlg.close();
    E.cat = null;
    await carregar();
  } catch (e) {
    $('#dlg-erro').textContent = e.message;
    $('#dlg-erro').hidden = false;
  }
}

/* ---------- eventos ---------- */
$('#f-produto').addEventListener('change', (e) => { E.produto = e.target.value; guardar('sc.produto', E.produto); carregar(); });
$('#v-semana').addEventListener('click', () => { E.visao = 'semana'; guardar('sc.visao', E.visao); marcaControles(); carregar(); });
$('#v-mes').addEventListener('click', () => { E.visao = 'mes'; guardar('sc.visao', E.visao); marcaControles(); carregar(); });
$('#f-n').addEventListener('change', (e) => { E.n = Number(e.target.value); guardar('sc.n', E.n); carregar(); });
$('#b-add').addEventListener('click', abrirDialogo);
$('#b-csv').addEventListener('click', csv);
$('#d-cancel').addEventListener('click', () => dlg.close());
$('#d-ok').addEventListener('click', adicionar);
$('#t-coluna').addEventListener('click', () => trocaAba('coluna'));
$('#t-razao').addEventListener('click', () => trocaAba('razao'));
$('#c-visao').addEventListener('change', colunasDaVisao);
$('#c-agg').addEventListener('change', () => { $('#c-valor').disabled = $('#c-agg').value === 'contagem'; });
$('#tab').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del]');
  if (!b || !confirm('Remover esta métrica do Scorecard?')) return;
  try { await api(`/metricas/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE', body: {} }); E.cat = null; await carregar(); } catch (err) { alert(err.message); }
});

marcaControles();
carregar();
