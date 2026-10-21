/* Monitor diário e Canais (QuarkRH). Só lê /api/monitor; nunca manda SQL. Cálculos de período e de canal vêm do servidor (studio/lib/monitor.ts). */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = new Intl.NumberFormat('pt-BR');
const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const brl0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const brl2 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (f, v) => (v == null ? '—' : f === 'int' ? nf.format(v) : f === 'pct' ? `${nf1.format(v * 100)}%` : f === 'brl' ? brl0.format(v) : brl2.format(v));

const L = {
  mrr: { id: 'mrr', rot: 'MRR novo', f: 'brl', nota: 'soma do valor dos ganhos' },
  ganhos: { id: 'ganhos', rot: 'Ganhos', f: 'int' },
  cac: { id: 'cac', rot: 'CAC de mídia', f: 'brl2', nota: 'investimento ÷ ganhos' },
  leads: { id: 'leads', rot: 'Leads', f: 'int' },
  pctMql: { id: 'pctMql', rot: '% MQL', f: 'pct', pp: true },
  cpl: { id: 'cpl', rot: 'CPL de mídia paga', f: 'brl2', nota: 'investimento ÷ leads' },
  mql: { id: 'mql', rot: 'MQL', f: 'int' },
  reunioes: { id: 'reunioes', rot: 'Reuniões agendadas', f: 'int', nota: 'entraram na etapa' },
  invest: { id: 'invest', rot: 'Investimento', f: 'brl' },
};
const N1 = [L.mrr, L.ganhos, L.cac, L.leads, L.pctMql, L.cpl];
const N2 = [L.mql, L.reunioes, L.invest];
const POR_CANAL = [L.invest, L.leads, L.mql, L.reunioes, L.ganhos, L.mrr, L.cpl, L.cac];
const BOM = { leads: true, mql: true, reunioes: true, ganhos: true, mrr: true, pctMql: true, cpl: false, cac: false, invest: null };
const PERIODOS = [
  ['dia', 'Hoje', 'ontem'],
  ['semana', 'Esta semana', 'semana anterior'],
  ['mes', 'Este mês', 'mês anterior'],
];
const COR_CANAL = { google: 'var(--m-azul)', meta: 'var(--m-turquesa)', social: 'var(--m-verde)', organico: 'var(--m-neutro)' };
const dm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const intervalo = (j) => (j.de === j.ate ? dm(j.de) : `${dm(j.de)} a ${dm(j.ate)}`);

const S = { dados: null, painel: location.hash.replace('#', '') === 'canais' ? 'canais' : 'monitor', produto: '', carregando: false };

/** Delta contra o período anterior; a cor diz se foi bom ou ruim (CAC subindo é ruim), nunca só se subiu. */
function delta(l, atual, ant) {
  if (atual == null || ant == null) return '<span class="delta">—</span>';
  if (l.pp) {
    const d = (atual - ant) * 100;
    if (Math.abs(d) < 0.05) return '<span class="delta">= 0 p.p.</span>';
    return `<span class="delta ${classe(l, d)}" title="Diferença em pontos percentuais">${d > 0 ? '▲' : '▼'} ${nf1.format(Math.abs(d))} p.p.</span>`;
  }
  if (ant === 0) return atual === 0 ? '<span class="delta">=</span>' : '<span class="delta" title="Sem base no período anterior">novo</span>';
  const p = atual / ant - 1;
  if (Math.abs(p) < 0.0005) return '<span class="delta">= 0%</span>';
  const abs = atual - ant;
  return `<span class="delta ${classe(l, p)}" title="${esc(`${abs > 0 ? '+' : '−'}${fmt(l.f, Math.abs(abs))} contra o período anterior`)}">${p > 0 ? '▲' : '▼'} ${nf1.format(Math.abs(p) * 100)}%</span>`;
}
function classe(l, sinal) {
  const bom = BOM[l.id];
  if (bom == null || sinal === 0) return '';
  return (sinal > 0) === bom ? 'bom' : 'ruim';
}
/** Canal sem verba (Social, Orgânico): investimento, CPL e CAC "não se aplicam" (nunca zero). */
const semVerba = (l, canal) => canal && !canal.pago && (l.id === 'cpl' || l.id === 'cac' || l.id === 'invest');
const valor = (l, v, canal) => (semVerba(l, canal) ? '<span class="na">não se aplica</span>' : v == null ? '<span class="na">—</span>' : esc(fmt(l.f, v)));

/* ---------- painel 1: Monitor diário (total dos 4 canais) ---------- */
function cartaoPeriodo(c, [id, titulo, contra]) {
  const j = S.dados.janelas[id];
  const p = c.periodos[id];
  const sub = id === 'dia'
    ? `${intervalo(j.atual)} até ${S.dados.hora} · contra ontem até ${S.dados.hora} (custos: ontem inteiro)`
    : `${intervalo(j.atual)} · contra ${intervalo(j.anterior)} (${j.atual.dias} ${j.atual.dias === 1 ? 'dia' : 'dias'} cada)`;
  const linha = (l, cls) => `<tr class="${cls}"><td class="rot">${esc(l.rot)}${l.nota ? `<small>${esc(l.nota)}</small>` : ''}</td><td class="val">${valor(l, p.atual[l.id], c)}<div class="ant">${esc(contra)}: ${esc(p.anterior[l.id] == null ? '—' : fmt(l.f, p.anterior[l.id]))}</div></td><td class="dl">${delta(l, p.atual[l.id], p.anterior[l.id])}</td></tr>`;
  return `<article class="cartao ${id === 'mes' ? 'destaque' : ''}"><h2>${esc(titulo)} contra ${esc(contra)}</h2><p class="sub">${esc(sub)}</p>
    <table class="kp"><tbody>${N1.map((l) => linha(l, 'n1')).join('')}${N2.map((l) => linha(l, 'n2')).join('')}</tbody></table></article>`;
}

/* ---------- gráficos de barras dos últimos 30 dias ---------- */
let TIPS = {};
function barras(chave, titulo, nota, dias, series, f) {
  const W = 620, H = 170, Lm = 46, R = 6, T = 8, B = 24;
  const iw = W - Lm - R, ih = H - T - B, n = dias.length;
  const max = Math.max(...series.flatMap((s) => s.valores), 1e-9);
  const pot = 10 ** Math.floor(Math.log10(max));
  const topo = [1, 2, 2.5, 5, 10].map((m) => m * pot).find((m) => m >= max) ?? max;
  const y = (v) => T + ih - (v / topo) * ih;
  const band = iw / n;
  const bw = (largura) => Math.max(2, band * largura);
  const svgBarras = dias.map((d, i) => series.map((s) => { const w = bw(s.larga ? 0.78 : 0.4); const x = Lm + band * i + (band - w) / 2; const h = (s.valores[i] / topo) * ih; return h > 0 ? `<rect x="${x}" y="${y(s.valores[i])}" width="${w}" height="${h}" rx="2" fill="${s.cor}"/>` : ''; }).join('')).join('');
  const ticks = [0, 1, 2, 3, 4].map((i) => (topo / 4) * i);
  TIPS[chave] = { dias, series, f };
  const hoje = S.dados.hoje;
  return `<article class="cartao"><h2>${esc(titulo)}</h2><p class="sub">${esc(nota)}</p>
    <div class="leg">${series.map((s) => `<span><i style="background:${s.cor}"></i>${esc(s.nome)}</span>`).join('')}</div>
    <svg class="gr" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${titulo}: ${dias.map((d, i) => `${dm(d)} ${series.map((s) => `${s.nome} ${fmt(f, s.valores[i])}`).join(', ')}`).join('; ')}`)}">
      ${ticks.map((t) => `<line class="grid" x1="${Lm}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${Lm - 6}" y="${y(t) + 4}" text-anchor="end">${esc(fmt(f, t))}</text>`).join('')}
      ${svgBarras}
      ${dias.map((d, i) => (i % 5 === 0 || d === hoje ? `<text x="${Lm + band * i + band / 2}" y="${H - 7}" text-anchor="middle">${dm(d)}</text>` : '')).join('')}
      ${dias.map((d, i) => `<rect class="hit" data-g="${chave}" data-i="${i}" x="${Lm + band * i}" y="${T}" width="${band}" height="${ih}" fill="transparent"/>`).join('')}
    </svg><p class="nota">O último dia (${dm(hoje)}) é parcial.</p></article>`;
}

function painelMonitor() {
  const t = S.dados.canais.find((c) => c.id === 'total');
  const s = t.serie;
  const g1 = barras('leads', 'Leads e MQL por dia', 'últimos 30 dias, total dos 4 canais (por data de criação)', s.dias, [{ nome: 'Leads', valores: s.leads, cor: 'var(--m-neutro)', larga: true }, { nome: 'MQL', valores: s.mql, cor: 'var(--m-laranja)', larga: false }], 'int');
  const g2 = barras('ganhos', 'Ganhos por dia', 'últimos 30 dias, total dos 4 canais (pela data do fechamento)', s.dias, [{ nome: 'Ganhos', valores: s.ganhos, cor: 'var(--m-laranja)', larga: true }], 'int');
  const g3 = barras('invest', 'Investimento por dia', 'últimos 30 dias: Meta Ads e Google Ads (Google chega com cerca de 1 dia de atraso)', s.dias, [{ nome: 'Investimento', valores: s.invest, cor: 'var(--m-laranja)', larga: true }], 'brl');
  return `<div class="tres">${PERIODOS.map((p) => cartaoPeriodo(t, p)).join('')}</div>
    <div class="graficos">${g1}${g2}${g3}</div>`;
}

/* ---------- painel 2: cada canal separado ---------- */
function painelCanais() {
  const cards = S.dados.canais.filter((c) => c.id !== 'total').map((c) => {
    const cab = PERIODOS.map(([id, titulo]) => `<th>${esc(titulo.replace('Esta ', '').replace('Este ', ''))}</th>`).join('');
    const linhas = POR_CANAL.map((l) => `<tr><td>${esc(l.rot)}</td>${PERIODOS.map(([id]) => {
      const p = c.periodos[id];
      return `<td><b>${valor(l, p.atual[l.id], c)}</b>${p.atual[l.id] == null || semVerba(l, c) ? '' : delta(l, p.atual[l.id], p.anterior[l.id])}</td>`;
    }).join('')}</tr>`).join('');
    const s = c.serie;
    const grafico = barras(`c-${c.id}`, 'Leads e MQL por dia', 'últimos 30 dias', s.dias, [{ nome: 'Leads', valores: s.leads, cor: 'var(--m-neutro)', larga: true }, { nome: 'MQL', valores: s.mql, cor: 'var(--m-laranja)', larga: false }], 'int').replace('class="cartao"', 'class="cartao" style="border:0;padding:8px 0 0;background:none"');
    return `<article class="cartao"><div class="canal-cab"><i style="background:${COR_CANAL[c.id]}"></i><h2>${esc(c.nome)}</h2></div>
      <table class="cn"><thead><tr><th></th>${cab}</tr></thead><tbody>${linhas}</tbody></table>
      ${c.pago ? '' : '<p class="nota">Sem verba direta: custo por lead e CAC não se aplicam.</p>'}
      ${grafico}</article>`;
  }).join('');
  const j = S.dados.janelas;
  return `<p class="nota" style="margin:0 0 10px">Hoje (${dm(j.dia.atual.de)}) contra ontem até ${esc(S.dados.hora)}; semana (${intervalo(j.semana.atual)}) contra ${intervalo(j.semana.anterior)}; mês (${intervalo(j.mes.atual)}) contra ${intervalo(j.mes.anterior)}. Cada canal é a Fonte do Lead do negócio.</p>
    <div class="quatro">${cards}</div>`;
}

/* ---------- cabeçalho: veredito ---------- */
function veredito() {
  const v = S.dados.veredito;
  const rot = Object.fromEntries(Object.values(L).map((l) => [l.id, l.rot]));
  const nomeP = { dia: 'hoje contra ontem', semana: 'na semana', mes: 'no mês' };
  const resumo = `Neste mês: <b>${nf.format(v.leads)}</b> leads, <b>${nf.format(v.ganhos)}</b> ganhos e MRR novo de <b>${esc(brl0.format(v.mrr))}</b>.`;
  if (!v.pior) return `${resumo} Nenhum indicador piorou mais de 5% em relação ao período anterior.`;
  const p = v.pior;
  return `${resumo} <span class="alerta">Maior piora: ${esc(rot[p.metrica])} ${p.pct > 0 ? 'subiu' : 'caiu'} ${nf1.format(Math.abs(p.pct) * 100)}% ${esc(nomeP[p.periodo])}.</span>`;
}

function desenhar() {
  const d = S.dados;
  $('#titulo').textContent = S.painel === 'canais' ? 'Canais, um a um' : 'Monitor diário';
  $('#et-dados').textContent = `Dados até ${d.hora} de ${dm(d.hoje)} · ${d.tz.replace('America/', '')}${S.produto ? ` · ${S.produto === 'rh' ? 'QuarkRH' : 'QuarkClinic'}` : ' · consolidado'}`;
  $('#veredito').innerHTML = veredito();
  TIPS = {};
  $('#painel').innerHTML = S.painel === 'canais' ? painelCanais() : painelMonitor();
  for (const b of document.querySelectorAll('[data-painel]')) b.setAttribute('aria-selected', String(b.dataset.painel === S.painel));
  $('#painel').classList.toggle('carregando', S.carregando);
}

async function carregar() {
  S.carregando = true;
  $('#painel').classList.add('carregando');
  try {
    const res = await fetch(`/api/monitor${S.produto ? `?produto=${S.produto}` : ''}`, { headers: { accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || data.error || res.statusText);
    S.dados = data;
    $('#aviso').innerHTML = S.produto === 'clinic' ? '<div class="aviso-m">QuarkClinic: o investimento do Google Ads vem do site do QuarkRH e não entra aqui; só o Meta Ads da conta da Clinic.</div>' : '';
    S.carregando = false;
    desenhar();
  } catch (e) {
    S.carregando = false;
    $('#painel').classList.remove('carregando');
    $('#aviso').innerHTML = `<div class="erro-m">Não consegui carregar o Monitor: ${esc(e.message)}${S.dados ? ' Mostrando o último resultado carregado.' : ''}</div>`;
    if (!S.dados) $('#veredito').innerHTML = '<span class="na">Sem dados no momento.</span>';
  }
}

/* ---------- eventos ---------- */
document.addEventListener('click', (ev) => {
  const b = ev.target.closest?.('[data-painel]');
  if (b) { S.painel = b.dataset.painel; history.replaceState(null, '', `#${S.painel}`); if (S.dados) desenhar(); return; }
  if (ev.target.closest?.('#atualizar')) carregar();
});
$('#produto').addEventListener('change', (ev) => { S.produto = ev.target.value; carregar(); });
const tip = $('#tip');
document.addEventListener('mousemove', (ev) => {
  const h = ev.target.closest?.('.hit');
  const g = h && TIPS[h.dataset.g];
  if (!g) { tip.hidden = true; return; }
  const i = Number(h.dataset.i);
  tip.innerHTML = `<b>${esc(dm(g.dias[i]))}</b>${g.series.map((s) => `<div><i style="display:inline-block;width:9px;height:9px;border-radius:3px;background:${s.cor};margin-right:6px"></i>${esc(s.nome)}: <b>${esc(fmt(g.f, s.valores[i]))}</b></div>`).join('')}`;
  tip.hidden = false;
  tip.style.left = `${Math.min(ev.clientX + 14, innerWidth - 240)}px`;
  tip.style.top = `${ev.clientY + 14}px`;
});
document.addEventListener('mouseleave', () => { tip.hidden = true; });
setInterval(() => { if (!document.hidden) carregar(); }, 5 * 60_000); // atualiza sozinho a cada 5 minutos
carregar();
