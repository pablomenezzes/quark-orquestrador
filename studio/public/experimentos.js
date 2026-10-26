/* Experimentos de growth. Cadastro simples; o resultado, o gasto e a linha de base chegam sozinhos do servidor (studio/lib/experimentos.ts),
   que lê as mesmas visões de analytics do Monitor. A página só lê e grava /api/experimentos; nunca manda SQL. */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const brl0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const brl2 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const FORMATOS = { int: (v) => nf0.format(v), brl: (v) => brl0.format(v), brl2: (v) => brl2.format(v), pct: (v) => `${nf.format(v * 100)}%` };
const dm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const dmy = (d) => `${dm(d)}/${d.slice(0, 4)}`;
const STATUS_ROTULO = { planejado: 'Planejado', rodando: 'Rodando', concluido: 'Concluído', cancelado: 'Cancelado' };
const DESFECHO_ROTULO = { atingiu: 'Atingiu a meta', parcial: 'Atingiu em parte', nao_atingiu: 'Não atingiu' };
const ESTADO_ROTULO = { cancelado: 'Cancelado', nao_iniciou: 'Ainda não começou', cedo: 'Poucos dias de dados', sem_dados: 'Sem dados no período', atingida: 'Meta atingida', em_linha: 'Em linha', atencao: 'Atenção', fora: 'Abaixo do previsto' };
const ESTADO_CLS = { atingida: 'bom', em_linha: 'bom', atencao: 'atencao', fora: 'ruim' };

const S = { dados: null, filtro: 'ativos', editando: null, aberto: false, enviando: false };
const mdef = (id) => S.dados.metricas.find((m) => m.id === id);
const fmtM = (m, v) => (v == null || !m ? '—' : FORMATOS[m.formato](v));
/** Percentuais são digitados em % (12 = 12%) e guardados como fração (0,12). */
const paraTela = (m, v) => (v == null ? '' : String(m?.formato === 'pct' ? Math.round(v * 1e6) / 1e4 : v).replace('.', ','));
const doCampo = (m, s) => {
  const t = String(s ?? '').trim();
  if (t === '') return null;
  const n = Number(t.replace(/\./g, '').replace(',', '.'));
  if (!isFinite(n)) return NaN;
  return m?.formato === 'pct' ? n / 100 : n;
};

async function api(path, init) {
  const r = await fetch(path, init && { ...init, headers: { 'content-type': 'application/json' } });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.detail || corpo.error || `erro ${r.status}`);
  return corpo;
}
const mostrarErro = (msg) => { $('#aviso').innerHTML = msg ? `<div class="erro-m" role="alert">${esc(msg)}</div>` : ''; };

async function carregar() {
  $('#lista').classList.add('carregando');
  try {
    S.dados = await api('/api/experimentos');
    mostrarErro('');
  } catch (e) {
    mostrarErro(`Não foi possível carregar os experimentos: ${e.message}`);
    $('#veredito').textContent = '';
    $('#lista').classList.remove('carregando');
    return;
  }
  $('#et-dados').textContent = `Dados completos até ontem · ${dmy(S.dados.hoje)}`;
  desenhar();
  $('#lista').classList.remove('carregando');
}

/* ---------- gráfico: previsto (tracejado) contra o real ---------- */
function grafico(e) {
  const p = e.progresso;
  const m = mdef(e.metrica);
  if (!p.trajetoria || !m) return '';
  const W = 560, H = 170, ml = 58, mr = 10, mt = 10, mb = 22;
  const n = p.totalDias;
  const reais = p.serie.map((s) => s.real).filter((v) => v != null);
  const ys = [p.trajetoria.v0, p.trajetoria.v1, e.meta, ...reais];
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  if (m.tipo === 'soma' && lo > 0) lo = 0;
  const x = (k) => ml + (n <= 1 ? 0 : (k / (n - 1)) * (W - ml - mr));
  const y = (v) => mt + (1 - (v - lo) / (hi - lo)) * (H - mt - mb);
  const ticks = [lo + pad * (m.tipo === 'soma' && lo === 0 ? 0 : 1), (lo + hi) / 2, hi - pad];
  const real = p.serie.map((s, k) => (s.real == null ? null : [x(k), y(s.real)])).filter(Boolean);
  const poli = real.length > 1 ? `<polyline points="${real.map((q) => q.join(',')).join(' ')}" fill="none" stroke="var(--m-laranja)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` : '';
  const ult = real.length ? `<circle cx="${real[real.length - 1][0]}" cy="${real[real.length - 1][1]}" r="4" fill="var(--m-laranja)" stroke="var(--m-card)" stroke-width="2"><title>${esc(`${dm(p.dadosAte)}: ${fmtM(m, p.atual)}`)}</title></circle>` : '';
  const hoje = p.diasCompletos > 0 && p.diasCompletos < n ? `<line x1="${x(p.diasCompletos - 1)}" x2="${x(p.diasCompletos - 1)}" y1="${mt}" y2="${H - mb}" stroke="var(--m-line)" stroke-width="1"/>` : '';
  return `<svg class="gr" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`Previsto contra realizado de ${m.rotulo}`)}">
    ${ticks.map((t) => `<g><line class="grid" x1="${ml}" x2="${W - mr}" y1="${y(t)}" y2="${y(t)}"/><text x="${ml - 6}" y="${y(t) + 4}" text-anchor="end">${esc(fmtM(m, t))}</text></g>`).join('')}
    <line x1="${ml}" x2="${W - mr}" y1="${y(e.meta)}" y2="${y(e.meta)}" stroke="var(--m-turquesa)" stroke-width="1.5" stroke-dasharray="2 4"/>
    <line x1="${x(0)}" y1="${y(p.trajetoria.v0)}" x2="${x(n - 1)}" y2="${y(p.trajetoria.v1)}" stroke="var(--m-ink2)" stroke-width="1.5" stroke-dasharray="6 5"/>
    ${hoje}${poli}${ult}
    <text x="${ml}" y="${H - 6}">${esc(dm(e.inicio))}</text><text x="${W - mr}" y="${H - 6}" text-anchor="end">${esc(dm(e.fim))}</text>
  </svg>`;
}

const barra = (rotulo, valor, detalhe, marca, destaque) => {
  const pct = valor == null ? 0 : Math.max(0, Math.min(1, valor)) * 100;
  return `<div class="barra"><div class="rot"><span>${esc(rotulo)}</span><span>${esc(detalhe)}</span></div><div class="trilho"><div class="cheio ${destaque ? 'destaque' : ''}" style="width:${pct}%"></div>${marca == null ? '' : `<div class="marca-p" style="left:${Math.max(0, Math.min(1, marca)) * 100}%" title="Previsto para hoje"></div>`}</div></div>`;
};

/* ---------- cartão de um experimento ---------- */
function cartao(e) {
  const p = e.progresso;
  const m = mdef(e.metrica);
  const canal = S.dados.canais.find((c) => c.id === e.canal);
  const cal = S.dados.calibracao.find((c) => c.metrica === e.metrica);
  const estado = p.estado;
  const ehSoma = m?.tipo === 'soma';
  const ice = e.iceScore == null ? '' : `<span class="tag ice" title="Média de impacto ${e.iceImpacto}, confiança ${e.iceConfianca} e facilidade ${e.iceFacilidade}">ICE ${nf.format(e.iceScore)}</span>`;
  const desfecho = e.desfecho ? `<span class="estado ${e.desfecho === 'atingiu' ? 'bom' : e.desfecho === 'parcial' ? 'atencao' : 'ruim'}">${esc(DESFECHO_ROTULO[e.desfecho])}</span>` : '';
  const opcoes = Object.entries(STATUS_ROTULO).map(([k, v]) => `<option value="${k}" ${e.status === k ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const numeros = `<div class="nums">
      <div>Atual<b>${esc(fmtM(m, p.atual))}</b></div>
      <div>Previsto até hoje<b>${esc(fmtM(m, p.esperado))}</b></div>
      <div>Meta${ehSoma ? ' no período' : ''}<b>${esc(fmtM(m, e.meta))}</b></div>
      <div>${p.projecao != null ? 'Projeção no fim' : 'Linha de base'}<b>${esc(fmtM(m, p.projecao != null ? p.projecao : p.linhaBase))}</b></div>
    </div>`;
  const barras = `<div class="barras">
      ${barra('Prazo', p.decorrido, `${p.diasCompletos} de ${p.totalDias} dias completos`, null, false)}
      ${barra('Meta', p.atingimento, p.atingimento == null ? 'sem dados' : `${nf0.format(p.atingimento * 100)}% do caminho`, p.decorrido, true)}
      ${e.orcamento ? barra('Orçamento', p.usoOrcamento, `${brl0.format(p.gasto)} de ${brl0.format(e.orcamento)}`, p.decorrido, p.orcamentoAdiantado) : `<div class="nota">Gasto no período: ${esc(brl0.format(p.gasto))} (sem orçamento definido)</div>`}
    </div>`;
  const base = p.linhaBase == null
    ? 'Sem linha de base: não havia dado no período anterior.'
    : `Linha de base ${p.linhaBaseAuto ? `automática (${p.totalDias} dias antes do início)` : 'combinada'}: ${fmtM(m, p.linhaBase)}.`;
  const hist = cal && e.status !== 'concluido'
    ? `<p class="nota">Histórico com ${esc(m.rotulo)}: ${cal.atingiu} de ${cal.total} ${cal.total === 1 ? 'concluído atingiu' : 'concluídos atingiram'} a meta${cal.confiancaMedia != null ? `; a confiança média que tinham era ${nf.format(cal.confiancaMedia)}` : ''}.</p>` : '';
  const aviso = p.orcamentoAdiantado ? '<div class="aviso-m">Gasto adiantado em relação ao prazo: confira se o orçamento chega até a data final.</div>' : '';
  const semVerba = canal && !canal.pago ? '<p class="nota">Canal sem verba: não há investimento para medir.</p>' : '';
  return `<article class="cartao" data-id="${e.id}">
    <div class="ex-cab"><h2>${esc(e.titulo)}</h2><span class="estado ${ESTADO_CLS[estado] ?? ''}">${esc(ESTADO_ROTULO[estado])}</span>${desfecho}</div>
    <div class="tags"><span class="tag">${e.produto === 'rh' ? 'QuarkRH' : 'QuarkClinic'}</span><span class="tag">${esc(canal?.nome ?? e.canal)}</span><span class="tag">${esc(m?.rotulo ?? e.metrica)}</span><span class="tag">${esc(dm(e.inicio))} a ${esc(dm(e.fim))}</span>${ice}</div>
    ${e.hipotese ? `<p class="sub">${esc(e.hipotese)}</p>` : ''}
    ${aviso}${numeros}${barras}${grafico(e)}
    <p class="nota">${esc(base)} Dados completos até ${esc(dm(p.dadosAte))}. Tracejado: previsto. Laranja: real. Pontilhado turquesa: meta.</p>${semVerba}${hist}
    ${e.aprendizado ? `<p class="nota"><b>Aprendizado:</b> ${esc(e.aprendizado)}</p>` : ''}
    <div class="acoes-ex"><label>Status <select data-acao="status">${opcoes}</select></label><button type="button" class="btn-s" data-acao="editar">Editar</button></div>
  </article>`;
}

function desenhar() {
  const d = S.dados;
  const todos = d.experimentos;
  const visiveis = todos.filter((e) => ({ ativos: e.status === 'planejado' || e.status === 'rodando', rodando: e.status === 'rodando', concluido: e.status === 'concluido', cancelado: e.status === 'cancelado', todos: true })[S.filtro]);
  const rod = todos.filter((e) => e.status === 'rodando');
  const cont = (est) => rod.filter((e) => est.includes(e.progresso.estado)).length;
  $('#veredito').textContent = rod.length
    ? `${rod.length} ${rod.length === 1 ? 'experimento rodando' : 'experimentos rodando'}: ${cont(['em_linha', 'atingida'])} em linha, ${cont(['atencao'])} em atenção, ${cont(['fora'])} abaixo do previsto${cont(['cedo', 'sem_dados', 'nao_iniciou']) ? ` e ${cont(['cedo', 'sem_dados', 'nao_iniciou'])} ainda sem leitura` : ''}.`
    : todos.length ? 'Nenhum experimento rodando agora.' : 'Nenhum experimento ainda. Clique em "Novo experimento": depois do cadastro, o acompanhamento é automático.';
  $('#lista').innerHTML = visiveis.length ? visiveis.map(cartao).join('') : `<div class="vazio" style="grid-column:1/-1">${todos.length ? 'Nenhum experimento neste filtro.' : ''}</div>`;
  if (S.aberto) formulario();
}

/* ---------- cadastro e edição ---------- */
const hojeIso = () => S.dados?.hoje ?? new Date().toISOString().slice(0, 10);
const somaDias = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);

function formulario() {
  const f = $('#formulario');
  const e = S.editando ? S.dados.experimentos.find((x) => x.id === S.editando) : null;
  const v = {
    titulo: e?.titulo ?? '', hipotese: e?.hipotese ?? '', produto: e?.produto ?? 'rh', canal: e?.canal ?? 'total', metrica: e?.metrica ?? 'leads',
    meta: e?.meta, linhaBase: e?.linhaBase, orcamento: e?.orcamento, inicio: e?.inicio ?? hojeIso(), fim: e?.fim ?? somaDias(hojeIso(), 29),
    ice: [e?.iceImpacto, e?.iceConfianca, e?.iceFacilidade], aprendizado: e?.aprendizado ?? '',
  };
  const atual = f.dataset.montado === String(S.editando ?? 'novo') ? lerFormulario(true) : null;
  if (atual) Object.assign(v, atual);
  const m = mdef(v.metrica);
  const canais = S.dados.canais.filter((c) => c.pago || !m?.precisaVerba);
  if (!canais.some((c) => c.id === v.canal)) v.canal = 'total';
  const sel = (id, opts, val) => `<select id="${id}">${opts.map(([k, t]) => `<option value="${esc(k)}" ${k === val ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  const unidade = m?.formato === 'pct' ? ' (em %)' : m?.formato === 'int' ? '' : ' (em R$)';
  f.dataset.montado = String(S.editando ?? 'novo');
  f.hidden = false;
  f.innerHTML = `<h2>${e ? `Editar experimento ${e.id}` : 'Novo experimento'}</h2>
    <p class="sub">${esc(m ? `${m.rotulo}: ${m.nota}. ` : '')}${m?.tipo === 'soma' ? 'A meta é o total a atingir no período.' : 'A meta é o valor a atingir; a trajetória parte da linha de base.'}</p>
    <div class="grade">
      <label class="largo">Título<input id="f-titulo" maxlength="160" value="${esc(v.titulo)}" placeholder="Ex.: Campanha de diagnóstico para baixar o CPL"></label>
      <label>Produto${sel('f-produto', [['rh', 'QuarkRH'], ['clinic', 'QuarkClinic']], v.produto)}</label>
      <label>Canal${sel('f-canal', canais.map((c) => [c.id, c.nome]), v.canal)}</label>
      <label class="todo">Hipótese<textarea id="f-hipotese" rows="2" maxlength="2000" placeholder="Se fizermos X, esperamos Y, porque Z.">${esc(v.hipotese)}</textarea></label>
      <label class="largo">Métrica foco${sel('f-metrica', S.dados.metricas.map((x) => [x.id, x.rotulo]), v.metrica)}</label>
      <label>Meta${esc(unidade)}<input id="f-meta" inputmode="decimal" value="${esc(typeof v.meta === 'string' ? v.meta : paraTela(m, v.meta))}"></label>
      <label>Orçamento (R$, opcional)<input id="f-orcamento" inputmode="decimal" value="${esc(typeof v.orcamento === 'string' ? v.orcamento : paraTela(null, v.orcamento))}"></label>
      <label>Início<input id="f-inicio" type="date" value="${esc(v.inicio)}"></label>
      <label>Fim previsto<input id="f-fim" type="date" value="${esc(v.fim)}"></label>
      <label>Linha de base${esc(unidade)} (opcional)<input id="f-base" inputmode="decimal" value="${esc(typeof v.linhaBase === 'string' ? v.linhaBase : paraTela(m, v.linhaBase))}" placeholder="automática"><span class="dica">Vazio: o mesmo número de dias antes do início.</span></label>
      <label>ICE: impacto (1 a 10)<input id="f-ice0" type="number" min="1" max="10" step="1" value="${esc(v.ice[0] ?? '')}"></label>
      <label>ICE: confiança (1 a 10)<input id="f-ice1" type="number" min="1" max="10" step="1" value="${esc(v.ice[1] ?? '')}"></label>
      <label>ICE: facilidade (1 a 10)<input id="f-ice2" type="number" min="1" max="10" step="1" value="${esc(v.ice[2] ?? '')}"></label>
      ${e ? `<label class="todo">Aprendizado<textarea id="f-aprendizado" rows="2" maxlength="4000" placeholder="O que ficou claro com este teste?">${esc(v.aprendizado)}</textarea></label>` : ''}
    </div>
    <div class="acoes"><button type="button" class="btn-p" id="f-salvar">${e ? 'Salvar alterações' : 'Criar experimento'}</button><button type="button" class="btn-s" id="f-cancelar">Cancelar</button><span class="dica" id="f-msg" role="status"></span></div>`;
  $('#f-metrica').addEventListener('change', () => formulario());
  $('#f-produto').addEventListener('change', () => formulario());
  $('#f-salvar').addEventListener('click', salvar);
  $('#f-cancelar').addEventListener('click', fechar);
}

/** Lê o formulário como está (texto cru nos números, para não perder o que se digitou ao trocar de métrica). */
function lerFormulario(cru) {
  const g = (id) => $(`#${id}`)?.value ?? '';
  const out = { titulo: g('f-titulo'), hipotese: g('f-hipotese'), produto: g('f-produto'), canal: g('f-canal'), metrica: g('f-metrica'), inicio: g('f-inicio'), fim: g('f-fim'), aprendizado: g('f-aprendizado'), ice: [g('f-ice0'), g('f-ice1'), g('f-ice2')].map((x) => (x === '' ? null : x)) };
  if (cru) return { ...out, meta: g('f-meta'), orcamento: g('f-orcamento'), linhaBase: g('f-base') };
  const m = mdef(out.metrica);
  return { ...out, meta: doCampo(m, g('f-meta')), orcamento: doCampo(null, g('f-orcamento')), linhaBase: doCampo(m, g('f-base')) };
}

async function salvar() {
  if (S.enviando) return;
  const msg = $('#f-msg');
  const v = lerFormulario(false);
  if (!v.titulo.trim()) { msg.textContent = 'Dê um título ao experimento.'; return; }
  if (v.meta == null || Number.isNaN(v.meta)) { msg.textContent = 'Informe a meta (um número).'; return; }
  if (Number.isNaN(v.orcamento) || Number.isNaN(v.linhaBase)) { msg.textContent = 'Orçamento e linha de base devem ser números.'; return; }
  const corpo = {
    titulo: v.titulo, hipotese: v.hipotese || null, produto: v.produto, canal: v.canal, metrica: v.metrica, meta: v.meta, linhaBase: v.linhaBase, orcamento: v.orcamento,
    inicio: v.inicio, fim: v.fim, iceImpacto: v.ice[0] == null ? null : Number(v.ice[0]), iceConfianca: v.ice[1] == null ? null : Number(v.ice[1]), iceFacilidade: v.ice[2] == null ? null : Number(v.ice[2]),
    ...(S.editando ? { aprendizado: v.aprendizado || null } : {}),
  };
  S.enviando = true; $('#f-salvar').disabled = true; msg.textContent = 'Salvando…';
  try {
    await api(S.editando ? `/api/experimentos/${S.editando}` : '/api/experimentos', { method: S.editando ? 'PUT' : 'POST', body: JSON.stringify(corpo) });
    fechar();
    await carregar();
  } catch (e) {
    msg.textContent = e.message;
    $('#f-salvar').disabled = false;
  } finally { S.enviando = false; }
}

function fechar() { S.aberto = false; S.editando = null; const f = $('#formulario'); f.hidden = true; f.innerHTML = ''; delete f.dataset.montado; }
function abrir(id) { S.editando = id ?? null; S.aberto = true; const f = $('#formulario'); delete f.dataset.montado; formulario(); f.scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#f-titulo').focus(); }

$('#novo').addEventListener('click', () => abrir(null));
$('#atualizar').addEventListener('click', carregar);
$('#filtro').addEventListener('change', (ev) => { S.filtro = ev.target.value; if (S.dados) desenhar(); });
$('#lista').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-acao="editar"]');
  if (b) abrir(Number(b.closest('[data-id]').dataset.id));
});
$('#lista').addEventListener('change', async (ev) => {
  const s = ev.target.closest('[data-acao="status"]');
  if (!s) return;
  const id = Number(s.closest('[data-id]').dataset.id);
  s.disabled = true;
  try {
    await api(`/api/experimentos/${id}`, { method: 'PUT', body: JSON.stringify({ status: s.value }) });
    await carregar();
  } catch (e) {
    mostrarErro(e.message);
    s.disabled = false;
  }
});

carregar();
