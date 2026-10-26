/* Documentação de um experimento: editor de texto (editável, salvo no banco, exportável em PDF pelo diálogo de impressão do navegador) com um
   relatório visual que consolida os dados diários, semanais e gerais. Os blocos de dados (data-auto) são regenerados a partir de
   /api/experimentos/:id/relatorio e não são digitados; o resto do texto é livre. Os gráficos são SVG com cores fixas da marca, para o PDF sair igual. */
import { $, esc, nf, nf0, brl0, brl2, FORMATOS, dm, dmy, api, fmtM, paraTela, STATUS_ROTULO, ESTADO_ROTULO, PRODUTO_ROTULO } from './experimentos-comum.js';

const COR = { laranja: '#EA8C0C', turquesa: '#39B4B6', verde: '#98BF12', azul: '#00ABE4', ink: '#212529', ink2: '#55595e', muted: '#8a8d91', linha: '#e6e7e8' };

/* ---------- gráficos (SVG autônomo) ---------- */
const rotulosVisiveis = (n) => { const passo = Math.max(1, Math.ceil(n / 10)); return (k) => k % passo === 0 || k === n - 1; };
const legenda = (series) => `<p class="leg">${series.map((s) => `<span><i style="background:${s.cor}"></i>${esc(s.nome)}</span>`).join('')}</p>`;

function escala(valores, zero) {
  const v = valores.filter((x) => x != null);
  let lo = v.length ? Math.min(...v) : 0, hi = v.length ? Math.max(...v) : 1;
  if (zero) lo = Math.min(0, lo);
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.08;
  return { lo: zero && lo === 0 ? 0 : lo - pad, hi: hi + pad };
}
function eixoY(W, ml, mr, mt, H, mb, lo, hi, fmt) {
  const y = (v) => mt + (1 - (v - lo) / (hi - lo)) * (H - mt - mb);
  const ticks = [lo, (lo + hi) / 2, hi];
  return { y, grade: ticks.map((t) => `<line x1="${ml}" x2="${W - mr}" y1="${y(t)}" y2="${y(t)}" stroke="${COR.linha}"/><text x="${ml - 6}" y="${y(t) + 4}" text-anchor="end" fill="${COR.muted}" font-size="11">${esc(fmt(t))}</text>`).join('') };
}

/** Barras agrupadas: uma barra por série em cada rótulo. */
export function barrasSvg({ rotulos, series, fmt, titulo }) {
  const W = 680, H = 210, ml = 52, mr = 10, mt = 12, mb = 28, n = rotulos.length;
  if (!n) return '';
  const { lo, hi } = escala(series.flatMap((s) => s.valores), true);
  const { y, grade } = eixoY(W, ml, mr, mt, H, mb, lo, hi, fmt);
  const grupo = (W - ml - mr) / n, larg = Math.max(2, Math.min(34, (grupo * 0.8) / series.length)), vis = rotulosVisiveis(n);
  const barras = rotulos.map((r, k) => series.map((s, j) => {
    const v = s.valores[k];
    if (v == null) return '';
    const x = ml + grupo * k + (grupo - larg * series.length) / 2 + larg * j, y0 = y(Math.max(lo, 0)), y1 = y(v);
    return `<rect x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${(larg - 1).toFixed(1)}" height="${Math.max(1, Math.abs(y0 - y1)).toFixed(1)}" fill="${s.cor}" rx="2"><title>${esc(`${s.nome} · ${r}: ${fmt(v)}`)}</title></rect>`;
  }).join('')).join('');
  const eixoX = rotulos.map((r, k) => (vis(k) ? `<text x="${(ml + grupo * k + grupo / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="${COR.muted}" font-size="11">${esc(r)}</text>` : '')).join('');
  return `<figure class="graf"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(titulo)}" style="width:100%;height:auto;font-family:inherit">${grade}${barras}${eixoX}</svg>${legenda(series)}</figure>`;
}

/** Linhas: uma por série; valor nulo interrompe o traço. */
export function linhasSvg({ rotulos, series, fmt, titulo, zero }) {
  const W = 680, H = 210, ml = 52, mr = 14, mt = 12, mb = 28, n = rotulos.length;
  if (!n) return '';
  const { lo, hi } = escala(series.flatMap((s) => s.valores), zero);
  const { y, grade } = eixoY(W, ml, mr, mt, H, mb, lo, hi, fmt);
  const x = (k) => ml + (n <= 1 ? (W - ml - mr) / 2 : (k / (n - 1)) * (W - ml - mr));
  const vis = rotulosVisiveis(n);
  const tracos = series.map((s) => {
    let d = '';
    s.valores.forEach((v, k) => { d += v == null ? '' : `${d && s.valores[k - 1] != null ? 'L' : 'M'}${x(k).toFixed(1)},${y(v).toFixed(1)}`; });
    const pontos = n <= 40 ? s.valores.map((v, k) => (v == null ? '' : `<circle cx="${x(k).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${s.cor}"><title>${esc(`${s.nome} · ${rotulos[k]}: ${fmt(v)}`)}</title></circle>`)).join('') : '';
    return `<path d="${d}" fill="none" stroke="${s.cor}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" ${s.tracejado ? 'stroke-dasharray="6 5"' : ''}/>${s.tracejado ? '' : pontos}`;
  }).join('');
  const eixoX = rotulos.map((r, k) => (vis(k) ? `<text x="${x(k).toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="${COR.muted}" font-size="11">${esc(r)}</text>` : '')).join('');
  return `<figure class="graf"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(titulo)}" style="width:100%;height:auto;font-family:inherit">${grade}${tracos}${eixoX}</svg>${legenda(series)}</figure>`;
}

/* ---------- blocos de dados ---------- */
const num = (v) => (v == null ? '—' : nf0.format(v));
const delta = (atual, antes, melhor) => {
  if (atual == null || antes == null || antes === 0) return '';
  const pct = (atual - antes) / Math.abs(antes);
  const bom = melhor === 'descer' ? pct < 0 : melhor === 'subir' ? pct > 0 : null;
  return `<span class="delta ${bom == null ? '' : bom ? 'bom' : 'ruim'}">${pct >= 0 ? '+' : ''}${nf.format(pct * 100)}%</span>`;
};
const tabela = (cab, linhas) => `<table class="rel-tab"><thead><tr>${cab.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${linhas.map((l) => `<tr>${l.map((c, i) => `<td${i === 0 ? '' : ' class="n"'}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const periodo = (l) => (l.de === l.ate ? dm(l.de) : `${dm(l.de)} a ${dm(l.ate)}`);

/** Rótulos do escopo (página, campanha e identificador) do experimento, como aparecem no cadastro. */
function rotuloEscopo(e) {
  const camp = e.campanhaId ? `${e.campanhaNome ?? 'Campanha'} (${e.campanhaId})` : e.campanhaNome;
  return [e.paginaCaminho ? `Página ${e.paginaHost ?? ''}${e.paginaCaminho}` : '', camp ? `Campanha ${camp}` : '', e.identificadorConversao ? `Identificador ${e.identificadorConversao}` : ''].filter(Boolean);
}
function ctx(R) {
  const e = R.experimento, p = e.progresso, rel = R.relatorio;
  const m = R.metricas.find((x) => x.id === e.metrica) || null;
  return { e, p, rel, m, atualizado: `Dados completos até ${dmy(rel.dadosAte)} · gerado em ${dmy(R.hoje)}` };
}
const semPeriodo = (titulo) => `<h2>${esc(titulo)}</h2><p class="nota">Defina início e fim do experimento para gerar este relatório. Só entram dias completos (até ontem).</p>`;

function blocoKpis(R) {
  const { e, p, rel, m, atualizado } = ctx(R);
  const g = rel.geral, b = rel.base;
  if (!g) return `<h2>Resumo do resultado</h2><p class="nota">${e.inicio ? 'O primeiro dia completo ainda não fechou.' : 'Defina início e fim do experimento para gerar o relatório.'}</p>`;
  const k = (rot, val, sub) => `<div class="kpi"><span>${esc(rot)}</span><b>${val}</b><small>${sub || ''}</small></div>`;
  const hero = m
    ? `<div class="kpi hero"><span><i class="real">REAL</i>${esc(m.rotulo)} · métrica chave</span><b>${esc(fmtM(m, p.atual))}</b>
        <small>Meta ${esc(fmtM(m, e.meta))} · previsto até aqui ${esc(fmtM(m, p.esperado))} · atingimento ${p.atingimento == null ? '—' : nf0.format(p.atingimento * 100) + '%'} <span class="estado ${p.estado}">${esc(ESTADO_ROTULO[p.estado])}</span>${p.projecao != null ? ` · projeção no fim ${esc(fmtM(m, p.projecao))}` : ''}</small></div>`
    : '<div class="kpi hero"><span>Métrica chave</span><b>—</b><small>Não definida: escolha uma no cadastro para acompanhar o resultado real contra a meta.</small></div>';
  const escopo = rotuloEscopo(e);
  // o período anterior tem o tamanho do experimento inteiro e o "durante" só os dias fechados: compara médias por dia
  const dia = (l, campo) => (l ? l[campo] / Math.max(1, l.dias) : null);
  const por = (campo, melhor) => delta(dia(g, campo), dia(b, campo), melhor);
  const antes = (campo) => (b ? `antes: ${nf.format(dia(b, campo))}/dia` : 'antes: —');
  return `<h2>Resumo do resultado</h2><p class="nota">${esc(atualizado)} · ${g.dias} ${g.dias === 1 ? 'dia completo' : 'dias completos'} de ${p.totalDias}. Variações comparam a média por dia com a do período anterior ao teste.</p>
    <div class="kpis">${hero}${escopo.length ? `<div class="escopo-doc" style="grid-column:1/-1">${escopo.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      ${k('Leads', num(g.leads), `${por('leads', 'subir')} ${antes('leads')}`)}
      ${k('MQL', num(g.mql), `${por('mql', 'subir')} ${antes('mql')}`)}
      ${k('Reuniões', num(g.reunioes), `${por('reunioes', 'subir')} ${antes('reunioes')}`)}
      ${k('Ganhos', num(g.ganhos), `${por('ganhos', 'subir')} ${antes('ganhos')}`)}
      ${k('MRR novo', brl0.format(g.mrr), `${por('mrr', 'subir')} antes: ${b ? brl0.format(dia(b, 'mrr')) : '—'}/dia`)}
      ${k('Investimento (gasto real)', brl0.format(g.invest), e.investimento ? `previsto ${brl0.format(e.investimento)} · ${p.usoOrcamento == null ? '' : nf0.format(p.usoOrcamento * 100) + '% usado'}` : 'sem investimento previsto')}
      ${k('CPL', g.cpl == null ? '—' : brl2.format(g.cpl), `${delta(g.cpl, b?.cpl, 'descer')} antes: ${b?.cpl == null ? '—' : brl2.format(b.cpl)}`)}
    </div>`;
}

function blocoGeral(R) {
  const { rel, atualizado } = ctx(R);
  const g = rel.geral, b = rel.base;
  if (!g || !b) return semPeriodo('Visão geral: antes e durante o teste');
  const dias = (l) => Math.max(1, l.dias);
  const itens = [
    ['Leads por dia', g.leads / dias(g), b.leads / dias(b), (v) => nf.format(v), 'subir'],
    ['MQL por dia', g.mql / dias(g), b.mql / dias(b), (v) => nf.format(v), 'subir'],
    ['Reuniões por dia', g.reunioes / dias(g), b.reunioes / dias(b), (v) => nf.format(v), 'subir'],
    ['Ganhos por dia', g.ganhos / dias(g), b.ganhos / dias(b), (v) => nf.format(v), 'subir'],
    ['Investimento por dia', g.invest / dias(g), b.invest / dias(b), (v) => brl0.format(v), null],
    ['CPL', g.cpl, b.cpl, (v) => brl2.format(v), 'descer'],
  ];
  const tile = ([rot, durante, antes, f, melhor]) => {
    const mx = Math.max(durante ?? 0, antes ?? 0) || 1;
    const bar = (v, cor) => `<div class="par"><div class="trilho"><div style="width:${v == null ? 0 : Math.max(2, (v / mx) * 100)}%;background:${cor}"></div></div></div>`;
    return `<div class="comp"><span>${esc(rot)}</span>
      <div class="lin"><em>Antes</em>${bar(antes, COR.muted)}<b>${antes == null ? '—' : esc(f(antes))}</b></div>
      <div class="lin"><em>Durante</em>${bar(durante, COR.laranja)}<b>${durante == null ? '—' : esc(f(durante))}</b></div>
      <small>${delta(durante, antes, melhor)}</small></div>`;
  };
  return `<h2>Visão geral: antes e durante o teste</h2>
    <p class="nota">${esc(atualizado)}. "Antes" é o mesmo número de dias imediatamente anterior ao início (${periodo(b)}); "Durante" vai de ${periodo(g)}. Médias por dia para comparar períodos de tamanhos diferentes.</p>
    <div class="comps">${itens.map(tile).join('')}</div>`;
}

function colunasDados(m) {
  const base = ['Leads', 'MQL', 'Reuniões', 'Ganhos', 'Invest.', 'CPL'];
  return m && !['leads', 'mql', 'reunioes', 'ganhos', 'cpl'].includes(m.id) ? [...base, m.rotulo] : base;
}
const linhaTab = (l, m, rot) => [esc(rot), num(l.leads), num(l.mql), num(l.reunioes), num(l.ganhos), brl0.format(l.invest), l.cpl == null ? '—' : brl2.format(l.cpl), ...(m && !['leads', 'mql', 'reunioes', 'ganhos', 'cpl'].includes(m.id) ? [esc(fmtM(m, l.valor))] : [])];

function blocoDiario(R) {
  const { e, p, rel, m, atualizado } = ctx(R);
  if (!rel.diario.length) return semPeriodo('Visão diária');
  const rotulos = rel.diario.map((l) => dm(l.de));
  const chave = m ? { nome: m.rotulo, f: (v) => FORMATOS[m.formato](v), vals: rel.diario.map((l) => l.valor), soma: m.tipo === 'soma' } : { nome: 'Leads', f: nf0.format, vals: rel.diario.map((l) => l.leads), soma: true };
  const grafDia = chave.soma
    ? barrasSvg({ rotulos, series: [{ nome: `${chave.nome} real por dia`, cor: COR.laranja, valores: chave.vals }], fmt: chave.f, titulo: `${chave.nome} real por dia` })
    : linhasSvg({ rotulos, series: [{ nome: `${chave.nome} do dia`, cor: COR.laranja, valores: chave.vals }], fmt: chave.f, titulo: `${chave.nome} por dia` });
  const traj = m && p.serie.length
    ? linhasSvg({ rotulos: p.serie.map((s) => dm(s.dia)), series: [{ nome: m.tipo === 'soma' ? 'Acumulado real' : 'Real no período até o dia', cor: COR.laranja, valores: p.serie.map((s) => s.real) }, { nome: 'Previsto até a meta', cor: COR.ink2, tracejado: true, valores: p.serie.map((s) => s.esperado) }], fmt: (v) => FORMATOS[m.formato](v), titulo: 'Real contra previsto', zero: m.tipo === 'soma' })
    : '';
  return `<h2>Visão diária</h2><p class="nota">${esc(atualizado)}.</p>
    <h3>${esc(chave.nome)} real por dia</h3>${grafDia}
    ${traj ? `<h3>Real contra previsto${m.tipo === 'soma' ? ' (acumulado)' : ''}</h3>${traj}` : ''}
    <h3>Dia a dia</h3>${tabela(['Dia', ...colunasDados(m)], rel.diario.map((l) => linhaTab(l, m, dm(l.de))))}`;
}

function blocoSemanal(R) {
  const { rel, m, atualizado } = ctx(R);
  if (!rel.semanal.length) return semPeriodo('Visão semanal');
  const rotulos = rel.semanal.map((l, k) => `S${k + 1}`);
  const serie = (nome, cor, campo) => ({ nome, cor, valores: rel.semanal.map((l) => l[campo]) });
  const chave = m ? barrasSvg({ rotulos, series: [{ nome: `${m.rotulo} real da semana`, cor: COR.laranja, valores: rel.semanal.map((l) => l.valor) }], fmt: (v) => FORMATOS[m.formato](v), titulo: `${m.rotulo} por semana` }) : '';
  return `<h2>Visão semanal</h2><p class="nota">${esc(atualizado)}. Semanas de segunda a domingo; a primeira e a última podem ter menos dias.</p>
    ${chave ? `<h3>${esc(m.rotulo)} real por semana</h3>${chave}` : ''}
    <h3>Funil por semana</h3>${barrasSvg({ rotulos, series: [serie('Leads', COR.laranja, 'leads'), serie('MQL', COR.turquesa, 'mql'), serie('Reuniões', COR.verde, 'reunioes'), serie('Ganhos', COR.azul, 'ganhos')], fmt: (v) => nf0.format(v), titulo: 'Funil por semana' })}
    <h3>Semana a semana</h3>${tabela(['Semana', 'Período', ...colunasDados(m)], rel.semanal.map((l, k) => { const [, ...resto] = linhaTab(l, m, ''); return [`S${k + 1}`, `${esc(periodo(l))} (${l.dias}d)`, ...resto]; }))}`;
}

const BLOCOS = { kpis: blocoKpis, geral: blocoGeral, diario: blocoDiario, semanal: blocoSemanal };
const bloco = (id, R) => `<section class="rel-auto" data-auto="${id}" contenteditable="false">${BLOCOS[id](R)}</section>`;
const ordemBlocos = ['kpis', 'geral', 'diario', 'semanal'];

/** Refaz os blocos de dados que já estão no texto; se não houver nenhum (apagados), recoloca todos no fim. */
export function atualizarBlocos(papel, R) {
  const achados = papel.querySelectorAll('[data-auto]');
  if (!achados.length) { papel.insertAdjacentHTML('beforeend', ordemBlocos.map((id) => bloco(id, R)).join('')); return; }
  achados.forEach((el) => { const f = BLOCOS[el.dataset.auto]; if (f) el.innerHTML = f(R); });
}

/* ---------- modelo inicial ---------- */
const par = (txt, vazio) => `<p>${txt ? esc(txt).replace(/\n/g, '<br>') : esc(vazio)}</p>`;
export function modeloInicial(R) {
  const { e, m } = ctx(R);
  const canal = R.canais.find((c) => c.id === e.canal)?.nome ?? e.canal;
  const tipo = (R.tipos || []).find((t) => t.id === e.tipo)?.nome ?? e.tipo;
  const periodoTxt = e.inicio && e.fim ? `${dmy(e.inicio)} a ${dmy(e.fim)}` : 'período a definir';
  const meta = m ? `${m.rotulo}: meta ${fmtM(m, e.meta)}${e.linhaBase != null ? `, linha de base combinada ${fmtM(m, e.linhaBase)}` : ', linha de base automática (os dias imediatamente antes do início)'}. ${m.nota}.` : '';
  const invest = e.investimento != null ? `Previsto: ${brl0.format(e.investimento)}. O gasto real aparece no resumo abaixo, vindo sozinho do Monitor.` : '';
  return `<h1>${esc(e.titulo)}</h1>
    <p class="meta-doc">${esc([tipo, STATUS_ROTULO[e.status], e.responsavel, PRODUTO_ROTULO[e.produto], canal, periodoTxt].filter(Boolean).join(' · '))}</p>
    <h2>Contexto</h2>
    <h3>Hipótese</h3>${par(e.hipotese, 'Se fizermos X, esperamos Y, porque Z.')}
    <h3>Resultado esperado</h3>${par(e.resultadoEsperado, 'Que resultado esperamos e em quanto tempo.')}
    <h3>Métrica chave</h3>${par(meta, 'Qual número decide se o teste deu certo (escolha no cadastro para acompanhar a meta sozinho).')}
    <h3>Investimento</h3>${par(invest, 'Quanto será investido (mídia, ferramentas, horas).')}
    ${rotuloEscopo(e).length ? `<h3>Escopo</h3><p>${esc(rotuloEscopo(e).join(' · '))}. Os números do relatório são só os dessa fatia: o negócio precisa bater com todos os itens do escopo.</p>` : ''}
    <h3>Evidências e referências</h3>${par(e.evidencias, 'Links, benchmarks e dados que sustentam a hipótese.')}
    <h2>Resultados</h2>
    ${ordemBlocos.map((id) => bloco(id, R)).join('')}
    <h2>Análise</h2><p>O que aconteceu e o que explica o resultado. Lembre que os dados mostram coincidência no tempo, não causa: orçamento, público e fila de SDRs mudam ao mesmo tempo.</p>
    <h2>Aprendizados</h2>${par(e.aprendizado, 'O que ficou claro com este teste?')}
    <h2>Próximos passos</h2><ul><li>Escalar, repetir com ajuste ou encerrar? Quem faz o quê e até quando.</li></ul>`;
}

/* ---------- segurança do HTML editado ---------- */
export function limpar(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,link,meta,base,form,style').forEach((n) => n.remove());
  doc.body.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) {
      if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
    }
  });
  return doc.body.innerHTML;
}

/* ---------- editor ---------- */
const BARRA = [
  ['bloco', 'Texto'], ['b', '<b>N</b>', 'bold', 'Negrito'], ['i', '<i>I</i>', 'italic', 'Itálico'], ['u', '<u>S</u>', 'underline', 'Sublinhado'],
  ['ul', '• Lista', 'insertUnorderedList', 'Lista'], ['ol', '1. Lista', 'insertOrderedList', 'Lista numerada'], ['quote', '“ Citação', 'quote', 'Citação'],
  ['link', 'Link', 'link', 'Inserir link'], ['tab', 'Tabela', 'tabela', 'Inserir tabela 3×3'], ['limpa', 'Limpar', 'removeFormat', 'Limpar formatação'],
  ['undo', '↶', 'undo', 'Desfazer'], ['redo', '↷', 'redo', 'Refazer'],
];

let aberto = null;
// um único aviso ao sair da página com texto ainda não salvo
window.addEventListener('beforeunload', (ev) => { if (aberto?.sujo()) { ev.preventDefault(); ev.returnValue = ''; } });

export async function abrirDocumentacao(id, { aoFechar } = {}) {
  const raiz = $('#doc');
  raiz.hidden = false;
  document.body.classList.add('doc-aberto');
  raiz.innerHTML = '<div class="doc-barra"><b>Documentação</b><span class="esq">Carregando…</span></div>';
  let R;
  try { R = await api(`/api/experimentos/${id}/relatorio`); } catch (err) {
    raiz.innerHTML = `<div class="doc-barra"><b>Documentação</b><button class="btn-s" id="doc-x" type="button">Fechar</button></div><div class="erro-m" role="alert">Não foi possível abrir: ${esc(err.message)}</div>`;
    $('#doc-x').addEventListener('click', () => fecharDoc(aoFechar));
    return;
  }
  const e = R.experimento;
  raiz.innerHTML = `<div class="doc-barra">
      <b class="doc-tit">${esc(e.titulo)}</b><span class="dica" id="doc-estado" role="status"></span>
      <span class="doc-acoes">
        <button type="button" class="btn-s" id="doc-atualizar" title="Refaz os gráficos e tabelas com os dados mais recentes, sem mexer no seu texto">Atualizar dados do relatório</button>
        <button type="button" class="btn-s" id="doc-salvar">Salvar</button>
        <button type="button" class="btn-p" id="doc-pdf" title="Abre a impressão: escolha Salvar como PDF">Exportar PDF</button>
        <button type="button" class="btn-s" id="doc-fechar">Fechar</button>
      </span>
    </div>
    <div class="doc-ferr" role="toolbar" aria-label="Formatação">
      <select id="doc-bloco" aria-label="Estilo do parágrafo"><option value="p">Parágrafo</option><option value="h1">Título 1</option><option value="h2">Título 2</option><option value="h3">Título 3</option></select>
      ${BARRA.slice(1).map(([k, rot, cmd, dica]) => `<button type="button" class="ferr" data-cmd="${cmd}" title="${esc(dica)}">${rot}</button>`).join('')}
    </div>
    <div class="doc-rolagem"><article id="doc-papel" class="papel" contenteditable="true" spellcheck="true"></article></div>`;
  const papel = $('#doc-papel');
  const estado = (t) => { $('#doc-estado').textContent = t; };
  papel.innerHTML = R.documentacao ? limpar(R.documentacao) : modeloInicial(R);
  let sujo = !R.documentacao; // o modelo recém-gerado ainda não foi gravado
  let timer = null, salvando = null;
  estado(sujo ? 'Modelo novo: ainda não salvo' : 'Salvo');
  aberto = { id, sujo: () => sujo };

  const salvar = async () => {
    clearTimeout(timer);
    if (salvando) await salvando;
    if (!sujo) return;
    estado('Salvando…');
    salvando = api(`/api/experimentos/${id}/documentacao`, { method: 'PUT', body: JSON.stringify({ html: limpar(papel.innerHTML) }) })
      .then(() => { sujo = false; estado(`Salvo às ${new Date().toTimeString().slice(0, 5)}`); })
      .catch((err) => estado(`Não salvou: ${err.message}`))
      .finally(() => { salvando = null; });
    await salvando;
  };
  const marcar = () => { sujo = true; estado('Alterado…'); clearTimeout(timer); timer = setTimeout(salvar, 2000); };
  papel.addEventListener('input', marcar);
  if (sujo) timer = setTimeout(salvar, 800); // grava o modelo para o próximo acesso (e marca o experimento como documentado)

  const ferr = $('.doc-ferr', raiz);
  ferr.addEventListener('mousedown', (ev) => { if (ev.target.closest('.ferr')) ev.preventDefault(); }); // mantém a seleção do texto
  ferr.addEventListener('click', (ev) => {
    const b = ev.target.closest('.ferr');
    if (!b) return;
    papel.focus();
    const cmd = b.dataset.cmd;
    if (cmd === 'quote') document.execCommand('formatBlock', false, 'blockquote');
    else if (cmd === 'link') { const u = prompt('Endereço do link (https://...)'); if (u && /^(https?:|mailto:)/i.test(u.trim())) document.execCommand('createLink', false, u.trim()); }
    else if (cmd === 'tabela') document.execCommand('insertHTML', false, `<table class="rel-tab"><tbody>${'<tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>'.repeat(3)}</tbody></table><p><br></p>`);
    else document.execCommand(cmd, false);
    marcar();
  });
  $('#doc-bloco').addEventListener('change', (ev) => { papel.focus(); document.execCommand('formatBlock', false, ev.target.value === 'p' ? 'p' : ev.target.value); ev.target.value = 'p'; marcar(); });

  $('#doc-atualizar').addEventListener('click', async () => {
    estado('Atualizando dados…');
    try { R = await api(`/api/experimentos/${id}/relatorio`); atualizarBlocos(papel, R); marcar(); estado('Dados atualizados · salvando…'); }
    catch (err) { estado(`Não atualizou: ${err.message}`); }
  });
  $('#doc-salvar').addEventListener('click', salvar);
  $('#doc-pdf').addEventListener('click', async () => {
    await salvar();
    const antes = document.title;
    document.title = `Experimento ${id} - ${e.titulo}`;
    const volta = () => { document.title = antes; window.removeEventListener('afterprint', volta); };
    window.addEventListener('afterprint', volta);
    window.print();
  });
  $('#doc-fechar').addEventListener('click', async () => { await salvar(); fecharDoc(aoFechar); });
  raiz.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !ev.defaultPrevented) { ev.preventDefault(); $('#doc-fechar').click(); } });
  papel.focus();
}

function fecharDoc(aoFechar) {
  const raiz = $('#doc');
  raiz.hidden = true;
  raiz.innerHTML = '';
  document.body.classList.remove('doc-aberto');
  aberto = null;
  if (aoFechar) aoFechar();
}
