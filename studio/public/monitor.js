/* Monitor diário e Canais (QuarkRH), em lógica de FUNIL: investimento -> impressões -> cliques ou visitas -> lead (e, depois do lead, MQL, reunião,
   ganho e MRR). Só lê /api/monitor; nunca manda SQL. Períodos, canais e razões vêm do servidor (studio/lib/monitor.ts). */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = new Intl.NumberFormat('pt-BR');
const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brl0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const brl2 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (f, v) => (v == null ? '—' : f === 'int' ? nf.format(Math.round(v)) : f === 'pct' ? `${nf2.format(v * 100)}%` : f === 'pct1' ? `${nf1.format(v * 100)}%` : f === 'brl' ? brl0.format(v) : brl2.format(v));

/** Métricas do funil e do resultado. `bom` diz o que é bom (CPM e CPL subindo são ruins); null = neutro (investimento). */
const L = {
  invest: { id: 'invest', rot: 'Investimento', f: 'brl', bom: null },
  cpm: { id: 'cpm', rot: 'CPM', f: 'brl2', bom: false, nota: 'custo por mil impressões' },
  impressoes: { id: 'impressoes', rot: 'Impressões', f: 'int', bom: true },
  ctr: { id: 'ctr', rot: 'CTR', f: 'pct', bom: true, nota: 'cliques no link ÷ impressões' },
  cpc: { id: 'cpc', rot: 'CPC', f: 'brl2', bom: false, nota: 'investimento ÷ cliques' },
  trafego: { id: 'trafego', rot: 'Cliques e visitas', f: 'int', bom: true, nota: 'pagos: cliques no link · Social e Orgânico: sessões no site' },
  txLead: { id: 'txLead', rot: 'Taxa até o lead', f: 'pct', bom: true, nota: 'leads ÷ cliques ou visitas' },
  leads: { id: 'leads', rot: 'Leads', f: 'int', bom: true },
  cpl: { id: 'cpl', rot: 'CPL', f: 'brl2', bom: false, nota: 'investimento ÷ leads' },
  pctMql: { id: 'pctMql', rot: '% MQL', f: 'pct1', bom: true, pp: true },
  mql: { id: 'mql', rot: 'MQL', f: 'int', bom: true },
  reunioes: { id: 'reunioes', rot: 'Reuniões agendadas', f: 'int', bom: true, nota: 'entraram na etapa' },
  ganhos: { id: 'ganhos', rot: 'Ganhos', f: 'int', bom: true },
  mrr: { id: 'mrr', rot: 'MRR novo', f: 'brl', bom: true },
  cac: { id: 'cac', rot: 'CAC de mídia', f: 'brl2', bom: false, nota: 'investimento ÷ ganhos' },
};
/** Os degraus do funil, do investimento ao lead, e a razão que os liga ao degrau anterior. */
const ETAPAS = [
  { ...L.invest },
  { ...L.impressoes, liga: L.cpm },
  { ...L.trafego, liga: L.ctr, extra: L.cpc },
  { ...L.leads, liga: L.txLead },
];
const POS_LEAD = [L.mql, L.reunioes, L.ganhos, L.mrr];
const PERIODOS = [
  ['dia', 'Hoje', 'ontem'],
  ['semana', 'Esta semana', 'semana anterior'],
  ['mes', 'Este mês', 'mês anterior'],
];
const CANAIS_ORDEM = ['google', 'meta', 'social', 'organico'];
const COR_CANAL = { google: 'var(--m-azul)', meta: 'var(--m-turquesa)', social: 'var(--m-verde)', organico: 'var(--m-neutro)' };
const NOME_CANAL = { google: 'Google Ads', meta: 'Meta Ads', social: 'Social', organico: 'Orgânico' };
const dm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const intervalo = (j) => (j.de === j.ate ? dm(j.de) : `${dm(j.de)} a ${dm(j.ate)}`);

const guardado = (() => { try { return JSON.parse(localStorage.getItem('monitor.estado') ?? '{}'); } catch { return {}; } })();
const S = { dados: null, painel: location.hash.replace('#', '') === 'canais' ? 'canais' : 'monitor', produto: '', matriz: guardado.matriz ?? 'mes', carregando: false };
const guardar = () => { try { localStorage.setItem('monitor.estado', JSON.stringify({ matriz: S.matriz })); } catch { /* sem armazenamento: tudo bem */ } };

const canal = (id) => S.dados.canais.find((c) => c.id === id);
/** Canal sem verba (Social, Orgânico): investimento, impressões, CPM, CTR, CPC, CPL e CAC não se aplicam (nunca zero). */
const naoSeAplica = (l, c) => c && !c.pago && ['invest', 'impressoes', 'cpm', 'ctr', 'cpc', 'cpl', 'cac'].includes(l.id);
const valor = (l, v, c) => (naoSeAplica(l, c) ? '<span class="na">não se aplica</span>' : v == null ? '<span class="na">—</span>' : esc(fmt(l.f, v)));

/** Delta contra o período anterior; a cor diz se foi bom ou ruim (CPL subindo é ruim), nunca só se subiu. */
function delta(l, atual, ant) {
  if (atual == null || ant == null) return '<span class="delta">—</span>';
  const cls = (sinal) => (l.bom == null || sinal === 0 ? '' : (sinal > 0) === l.bom ? 'bom' : 'ruim');
  if (l.pp) {
    const d = (atual - ant) * 100;
    if (Math.abs(d) < 0.05) return '<span class="delta">= 0 p.p.</span>';
    return `<span class="delta ${cls(d)}" title="Diferença em pontos percentuais">${d > 0 ? '▲' : '▼'} ${nf1.format(Math.abs(d))} p.p.</span>`;
  }
  if (ant === 0) return atual === 0 ? '<span class="delta">=</span>' : '<span class="delta" title="Sem base no período anterior">novo</span>';
  const p = atual / ant - 1;
  if (Math.abs(p) < 0.0005) return '<span class="delta">= 0%</span>';
  const abs = atual - ant;
  return `<span class="delta ${cls(p)}" title="${esc(`${abs > 0 ? '+' : '−'}${fmt(l.f, Math.abs(abs))} contra o período anterior`)}">${p > 0 ? '▲' : '▼'} ${nf1.format(Math.abs(p) * 100)}%</span>`;
}

/** No dia, investimento, impressões e tráfego só existem por dia: hoje (parcial) contra ontem (inteiro) não é comparação justa, então vira "parcial" em vez de uma queda enganosa. */
const SO_POR_DIA = ['invest', 'impressoes', 'trafego'];
function deltaPer(l, p, periodo) {
  if (periodo === 'dia' && SO_POR_DIA.includes(l.id)) return '<span class="delta" title="Hoje ainda em andamento: o investimento e o tráfego só existem por dia, e ontem entra inteiro">parcial</span>';
  return delta(l, p.atual[l.id], p.anterior[l.id]);
}

/* ---------- composição por canal (as fontes consolidadas) ---------- */
/** Barra 100% empilhada: de que canais vem o degrau (só canais a que o degrau se aplica). */
function composicao(campo, periodo) {
  const partes = CANAIS_ORDEM.map((id) => ({ id, v: Number(canal(id).periodos[periodo].atual[campo] ?? 0) })).filter((p) => p.v > 0 && !naoSeAplica({ id: campo }, canal(p.id)));
  const t = partes.reduce((s, p) => s + p.v, 0);
  if (t <= 0) return '<div class="comp vazia" aria-hidden="true"></div>';
  const txt = partes.map((p) => `${NOME_CANAL[p.id]} ${nf1.format((p.v / t) * 100)}%`).join(' · ');
  return `<div class="comp" role="img" aria-label="${esc(`Composição por canal: ${txt}`)}" title="${esc(txt)}">${partes.map((p) => `<i style="width:${(p.v / t) * 100}%;background:${COR_CANAL[p.id]}"></i>`).join('')}</div>`;
}
const legendaCanais = () => `<div class="leg-c" aria-label="Canais">${CANAIS_ORDEM.map((id) => `<span><i style="background:${COR_CANAL[id]}"></i>${NOME_CANAL[id]}</span>`).join('')}</div>`;

/* ---------- painel 1: funil consolidado, um por período ---------- */
function funilPeriodo(c, [id, titulo, contra]) {
  const j = S.dados.janelas[id];
  const p = c.periodos[id];
  const sub = id === 'dia'
    ? `${intervalo(j.atual)} até ${S.dados.hora} · contra ontem até ${S.dados.hora} (investimento e tráfego: ontem inteiro)`
    : `${intervalo(j.atual)} · contra ${intervalo(j.anterior)} (${j.atual.dias} ${j.atual.dias === 1 ? 'dia' : 'dias'} cada)`;
  const degrau = (e, i) => {
    const liga = e.liga ? `<div class="liga"><span class="seta" aria-hidden="true">↓</span><span class="lrot">${esc(e.liga.rot)}</span><b>${valor(e.liga, p.atual[e.liga.id], c)}</b>${delta(e.liga, p.atual[e.liga.id], p.anterior[e.liga.id])}<span class="lant">${esc(contra)}: ${esc(fmt(e.liga.f, p.anterior[e.liga.id]))}</span></div>` : '';
    const extra = e.extra ? `<span class="xtra">${esc(e.extra.rot)} <b>${valor(e.extra, p.atual[e.extra.id], c)}</b></span>` : '';
    return `${liga}<div class="degrau" style="--larg:${[100, 88, 76, 64][i]}%"><div class="dcab"><span class="drot">${esc(e.rot)}${e.nota ? `<small>${esc(e.nota)}</small>` : ''}</span><span class="dval">${valor(e, p.atual[e.id], c)}</span><span class="ddel">${deltaPer(e, p, id)}</span></div>
      <div class="dant">${esc(contra)}: ${esc(p.anterior[e.id] == null ? '—' : fmt(e.f, p.anterior[e.id]))} ${extra}</div>${composicao(e.id === 'trafego' ? 'trafego' : e.id, id)}</div>`;
  };
  const cpl = `<div class="liga fim"><span class="seta" aria-hidden="true">=</span><span class="lrot">CPL (investimento ÷ leads)</span><b>${valor(L.cpl, p.atual.cpl, c)}</b>${delta(L.cpl, p.atual.cpl, p.anterior.cpl)}<span class="lant">${esc(contra)}: ${esc(fmt('brl2', p.anterior.cpl))}</span></div>`;
  const pos = POS_LEAD.map((l) => `<div class="pl"><span>${esc(l.rot)}</span><b>${valor(l, p.atual[l.id], c)}</b>${delta(l, p.atual[l.id], p.anterior[l.id])}</div>`).join('');
  const extraPos = `<div class="pl"><span>% MQL</span><b>${valor(L.pctMql, p.atual.pctMql, c)}</b>${delta(L.pctMql, p.atual.pctMql, p.anterior.pctMql)}</div><div class="pl"><span>CAC de mídia</span><b>${valor(L.cac, p.atual.cac, c)}</b>${delta(L.cac, p.atual.cac, p.anterior.cac)}</div>`;
  return `<article class="cartao funil ${id === 'mes' ? 'destaque' : ''}"><h2>${esc(titulo)} contra ${esc(contra)}</h2><p class="sub">${esc(sub)}</p>
    ${ETAPAS.map(degrau).join('')}${cpl}
    <h3 class="depois">Depois do lead</h3><div class="pos">${pos}${extraPos}</div></article>`;
}

/* ---------- matriz: o funil de cada canal lado a lado ---------- */
function matrizCanais() {
  const id = S.matriz;
  const colunas = [L.invest, L.impressoes, L.trafego, L.leads, L.cpl, L.mql, L.reunioes, L.ganhos, L.mrr];
  const abas = PERIODOS.map(([k, t]) => `<button type="button" data-matriz="${k}" aria-pressed="${S.matriz === k}">${esc(t)}</button>`).join('');
  const linha = (c, destaque) => `<tr class="${destaque ? 'tot' : ''}"><th scope="row"><span class="ponto" style="background:${COR_CANAL[c.id] ?? 'var(--m-laranja)'}"></span>${esc(c.nome)}</th>${colunas.map((l) => {
    const p = c.periodos[id];
    return `<td><b>${valor(l, p.atual[l.id], c)}</b>${p.atual[l.id] == null || naoSeAplica(l, c) ? '' : deltaPer(l, p, id)}</td>`;
  }).join('')}</tr>`;
  return `<section class="cartao" style="margin-top:14px"><div class="cab-matriz"><div><h2>O funil de cada canal</h2><p class="sub">investimento → impressões → cliques ou visitas → leads, e o que vem depois do lead; deltas contra o período anterior</p></div><div class="seg-m" role="group" aria-label="Período">${abas}</div></div>
    <div class="rolagem"><table class="mz"><thead><tr><th></th>${colunas.map((l) => `<th title="${esc(l.nota ?? '')}">${esc(l.id === 'trafego' ? 'Cliques / visitas' : l.rot)}</th>`).join('')}</tr></thead>
    <tbody>${linha(canal('total'), true)}${CANAIS_ORDEM.map((cid) => linha(canal(cid), false)).join('')}</tbody></table></div>
    <p class="nota">Cliques e visitas: cliques no link no Meta Ads e no Google Ads; sessões do site (GA4, com 1 dia de atraso) no Social e no Orgânico. O total soma os dois tipos. Social e Orgânico não têm verba.</p></section>`;
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
  const t = canal('total');
  const s = t.serie;
  const g1 = barras('leads', 'Leads e MQL por dia', 'últimos 30 dias, total dos 4 canais (por data de criação)', s.dias, [{ nome: 'Leads', valores: s.leads, cor: 'var(--m-neutro)', larga: true }, { nome: 'MQL', valores: s.mql, cor: 'var(--m-laranja)', larga: false }], 'int');
  const g2 = barras('invest', 'Investimento por dia', 'últimos 30 dias: Meta Ads e Google Ads (Google chega com cerca de 1 dia de atraso)', s.dias, [{ nome: 'Investimento', valores: s.invest, cor: 'var(--m-laranja)', larga: true }], 'brl');
  return `${legendaCanais()}<div class="tres">${PERIODOS.map((p) => funilPeriodo(t, p)).join('')}</div>${matrizCanais()}<div class="graficos">${g1}${g2}</div>`;
}

/* ---------- painel 2: cada canal separado, funil do topo ao lead ---------- */
function linhasCanal(c) {
  const rot = (l) => (l.id === 'trafego' ? (c.pago ? 'Cliques no link' : 'Sessões no site (GA4)') : l.rot);
  const seq = [
    [L.invest, 0], [L.cpm, 1], [L.impressoes, 0], [L.ctr, 1], [L.trafego, 0], [L.cpc, 1], [L.txLead, 1], [L.leads, 0], [L.cpl, 1],
    [L.mql, 0], [L.reunioes, 0], [L.ganhos, 0], [L.mrr, 0], [L.cac, 1],
  ];
  return seq.map(([l, razao]) => `<tr class="${razao ? 'razao' : ''}"><td>${razao ? '<span class="seta" aria-hidden="true">↳</span> ' : ''}${esc(rot(l))}</td>${PERIODOS.map(([id]) => {
    const p = c.periodos[id];
    return `<td><b>${valor(l, p.atual[l.id], c)}</b>${p.atual[l.id] == null || naoSeAplica(l, c) ? '' : deltaPer(l, p, id)}</td>`;
  }).join('')}</tr>`).join('');
}
function painelCanais() {
  const cards = CANAIS_ORDEM.map((cid) => {
    const c = canal(cid);
    const cab = PERIODOS.map(([, titulo]) => `<th>${esc(titulo.replace('Esta ', '').replace('Este ', ''))}</th>`).join('');
    const s = c.serie;
    const grafico = barras(`c-${c.id}`, 'Leads e MQL por dia', 'últimos 30 dias', s.dias, [{ nome: 'Leads', valores: s.leads, cor: 'var(--m-neutro)', larga: true }, { nome: 'MQL', valores: s.mql, cor: 'var(--m-laranja)', larga: false }], 'int').replace('class="cartao"', 'class="cartao" style="border:0;padding:8px 0 0;background:none"');
    return `<article class="cartao"><div class="canal-cab"><i style="background:${COR_CANAL[c.id]}"></i><h2>${esc(c.nome)}</h2></div>
      <table class="cn"><thead><tr><th></th>${cab}</tr></thead><tbody>${linhasCanal(c)}</tbody></table>
      ${c.pago ? '' : '<p class="nota">Sem verba direta: investimento, impressões, CPL e CAC não se aplicam; o topo do funil são as sessões do site.</p>'}
      ${grafico}</article>`;
  }).join('');
  const j = S.dados.janelas;
  return `<p class="nota" style="margin:0 0 10px">Hoje (${dm(j.dia.atual.de)}) contra ontem até ${esc(S.dados.hora)}; semana (${intervalo(j.semana.atual)}) contra ${intervalo(j.semana.anterior)}; mês (${intervalo(j.mes.atual)}) contra ${intervalo(j.mes.anterior)}. Cada canal é a Fonte do Lead do negócio; as linhas com ↳ são as razões entre os degraus.</p>
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
    $('#aviso').innerHTML = S.produto === 'clinic' ? '<div class="aviso-m">QuarkClinic: o investimento do Google Ads vem do site do QuarkRH e não entra aqui; só o Meta Ads da conta da Clinic e as sessões do site da Clínica.</div>' : '';
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
  const m = ev.target.closest?.('[data-matriz]');
  if (m) { S.matriz = m.dataset.matriz; guardar(); if (S.dados) desenhar(); return; }
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
