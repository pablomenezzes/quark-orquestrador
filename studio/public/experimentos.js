/* Experimentos de growth: cadastro, documentação e monitoramento num lugar só (planilha e kanban sobre os mesmos dados). O resultado, o gasto e a
   linha de base chegam sozinhos do servidor (studio/lib/experimentos.ts), que lê as mesmas visões de analytics do Monitor. A página só lê e grava
   /api/experimentos; nunca manda SQL. A documentação (editor + relatório) vive em experimentos-doc.js. */
import { $, esc, nf, nf0, brl0, dm, dmy, api, fmtM, paraTela, doCampo, STATUS_ROTULO, AVALIACAO_ROTULO, DESFECHO_ROTULO, ESTADO_ROTULO, ESTADO_CLS, PRODUTO_ROTULO } from './experimentos-comum.js';
import { abrirDocumentacao } from './experimentos-doc.js';

const guardado = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* armazenamento indisponível: segue sem lembrar */ } return null; };
const S = {
  dados: null, vista: guardado('exp.vista') === 'kanban' ? 'kanban' : 'planilha', filtro: 'ativos', tipo: '', produto: '', busca: '',
  ficha: null, rascunho: null, pend: {}, enviando: false, opcoes: null, campFicha: [],
};
const COLUNAS_KANBAN = ['backlog', 'planejado', 'rodando', 'bloqueado', 'concluido', 'cancelado'];
const paginaTexto = (host, caminho) => (caminho ? `${host ?? ''}${caminho}` : '');
const MODOS = { todos: 'Todos os critérios ao mesmo tempo (E)', qualquer: 'Qualquer um dos critérios (OU)', campanha_so_investimento: 'Campanha só para o investimento; negócios pela página e pelo identificador' };
const campanhaItem = (c) => (typeof c === 'string' ? c : c.id ? `${c.nome ?? 'Campanha'} (${c.id})` : (c.nome ?? ''));
/** Várias campanhas: os resultados somam. Na célula da planilha ficam separadas por ";". */
const campanhasTexto = (e) => (e.campanhas ?? []).map(campanhaItem).join('; ');
const temEscopo = (e) => !!(e.paginaCaminho || e.campanhas?.length || e.identificadorConversao);
const escopoRotulos = (e) => [e.paginaCaminho ? `Página ${paginaTexto(e.paginaHost, e.paginaCaminho)}` : '', e.campanhas?.length ? `${e.campanhas.length === 1 ? 'Campanha' : 'Campanhas (somadas)'} ${e.campanhas.map(campanhaItem).join(', ')}` : '', e.identificadorConversao ? `Identificador ${e.identificadorConversao}` : ''].filter(Boolean);
/** Páginas do Analytics, campanhas da Meta e identificadores do Pipedrive para escolher; tudo também pode ser digitado à mão. */
async function carregarOpcoes() {
  try { S.opcoes = await api('/api/experimentos/opcoes'); } catch { S.opcoes = null; }
  const o = S.opcoes;
  $('#dl-escopo').innerHTML = o
    ? `<datalist id="dl-paginas">${o.paginas.map((p) => `<option value="${esc(p.host + p.caminho)}" label="${esc(nf0.format(p.visualizacoes))} visualizações em 90 dias"></option>`).join('')}</datalist>
       <datalist id="dl-campanhas">${o.campanhas.map((c) => `<option value="${esc(`${c.nome} (${c.id})`)}" label="gasto ${esc(brl0.format(c.gasto))}"></option>`).join('')}</datalist>
       <datalist id="dl-ident">${o.identificadores.map((i) => `<option value="${esc(i.evento)}" label="${esc(nf0.format(i.negocios))} negócios"></option>`).join('')}</datalist>`
    : '';
}
const mdef = (id) => S.dados.metricas.find((m) => m.id === id) ?? null;
const exp = (id) => S.dados.experimentos.find((x) => x.id === Number(id));
const acompanhavel = (e) => !!(e.metrica && e.meta != null && e.inicio && e.fim);
const metricaDe = (e) => S.pend[e.id] ?? e.metrica;
const tipoNome = (id) => S.dados.tipos.find((t) => t.id === id)?.nome ?? id;
const mostrarErro = (msg) => { $('#aviso').innerHTML = msg ? `<div class="erro-m" role="alert">${esc(msg)}</div>` : ''; };
const hojeIso = () => S.dados?.hoje ?? new Date().toISOString().slice(0, 10);
const somaDias = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);

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
  carregarOpcoes();
  $('#et-dados').textContent = `Dados completos até ontem · ${dmy(S.dados.hoje)}`;
  if ($('#f-tipo-lista').options.length < 2) $('#f-tipo-lista').insertAdjacentHTML('beforeend', S.dados.tipos.map((t) => `<option value="${esc(t.id)}">${esc(t.nome)}</option>`).join(''));
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

/* ---------- progresso de um experimento (ficha e cards) ---------- */
function progressoCompleto(e) {
  const p = e.progresso;
  const m = mdef(e.metrica);
  const canal = S.dados.canais.find((c) => c.id === e.canal);
  const cal = S.dados.calibracao.find((c) => c.metrica === e.metrica);
  if (!acompanhavel(e)) return '<p class="aviso-m">Sem acompanhamento automático. Escolha a <b>métrica chave</b> com a meta e defina o início e o fim para o Studio calcular o resultado sozinho.</p>';
  const ehSoma = m?.tipo === 'soma';
  const numeros = `<div class="nums">
      <div>Atual<b>${esc(fmtM(m, p.atual))}</b></div>
      <div>Previsto até hoje<b>${esc(fmtM(m, p.esperado))}</b></div>
      <div>Meta${ehSoma ? ' no período' : ''}<b>${esc(fmtM(m, e.meta))}</b></div>
      <div>${p.projecao != null ? 'Projeção no fim' : 'Linha de base'}<b>${esc(fmtM(m, p.projecao != null ? p.projecao : p.linhaBase))}</b></div>
    </div>`;
  const barras = `<div class="barras">
      ${barra('Prazo', p.decorrido, `${p.diasCompletos} de ${p.totalDias} dias completos`, null, false)}
      ${barra('Meta', p.atingimento, p.atingimento == null ? 'sem dados' : `${nf0.format(p.atingimento * 100)}% do caminho`, p.decorrido, true)}
      ${e.investimento ? barra('Investimento', p.usoOrcamento, `${brl0.format(p.gasto)} de ${brl0.format(e.investimento)}`, p.decorrido, p.orcamentoAdiantado) : `<div class="nota">Gasto real no período: ${esc(brl0.format(p.gasto))} (sem investimento previsto)</div>`}
    </div>`;
  const base = p.linhaBase == null ? 'Sem linha de base: não havia dado no período anterior.' : `Linha de base ${p.linhaBaseAuto ? `automática (${p.totalDias} dias antes do início)` : 'combinada'}: ${fmtM(m, p.linhaBase)}.`;
  const hist = cal && e.status !== 'concluido' ? `<p class="nota">Histórico com ${esc(m.rotulo)}: ${cal.atingiu} de ${cal.total} ${cal.total === 1 ? 'concluído atingiu' : 'concluídos atingiram'} a meta${cal.confiancaMedia != null ? `; a confiança média que tinham era ${nf.format(cal.confiancaMedia)}` : ''}.</p>` : '';
  const aviso = p.orcamentoAdiantado ? '<div class="aviso-m">Gasto adiantado em relação ao prazo: confira se o investimento chega até a data final.</div>' : '';
  const semVerba = canal && !canal.pago ? '<p class="nota">Canal sem verba: não há investimento para medir.</p>' : '';
  return `${aviso}${numeros}${barras}${grafico(e)}<p class="nota">${esc(base)} Dados completos até ${esc(dm(p.dadosAte))}. Tracejado: previsto. Laranja: real. Pontilhado turquesa: meta.</p>${semVerba}${hist}`;
}

const chipEstado = (e) => `<span class="estado ${ESTADO_CLS[e.progresso.estado] ?? ''}">${esc(ESTADO_ROTULO[e.progresso.estado])}</span>`;
const chipResultado = (e) => {
  const a = e.avaliacao ? `<span class="estado ${e.avaliacao === 'sucesso' ? 'bom' : e.avaliacao === 'falha' ? 'ruim' : 'atencao'}" title="Avaliação de quem conduziu">${esc(AVALIACAO_ROTULO[e.avaliacao])}</span>` : '';
  const d = e.desfecho ? `<span class="estado ${e.desfecho === 'atingiu' ? 'bom' : e.desfecho === 'parcial' ? 'atencao' : 'ruim'}" title="Calculado pela meta">${esc(DESFECHO_ROTULO[e.desfecho])}</span>` : '';
  return a + d;
};

/* ---------- filtros ---------- */
function visiveis() {
  const q = S.busca.trim().toLowerCase();
  const porStatus = {
    ativos: (e) => e.status !== 'cancelado', rodando: (e) => e.status === 'rodando', backlog: (e) => e.status === 'backlog' || e.status === 'planejado',
    concluido: (e) => e.status === 'concluido', cancelado: (e) => e.status === 'cancelado', todos: () => true,
  }[S.filtro];
  return S.dados.experimentos.filter((e) => porStatus(e) && (!S.tipo || e.tipo === S.tipo) && (!S.produto || e.produto === S.produto)
    && (!q || [e.titulo, e.responsavel, e.areaImpacto, e.hipotese].some((t) => (t ?? '').toLowerCase().includes(q))));
}

/* ---------- planilha ---------- */
const optsHtml = (lista, atual) => lista.map(([k, t]) => `<option value="${esc(k)}" ${k === atual ? 'selected' : ''}>${esc(t)}</option>`).join('');
const OPT_STATUS = Object.entries(STATUS_ROTULO);
const OPT_AVAL = [['', '—'], ...Object.entries(AVALIACAO_ROTULO)];
const OPT_PROD = Object.entries(PRODUTO_ROTULO);

function canaisPara(e) {
  const m = mdef(metricaDe(e));
  return S.dados.canais.filter((c) => c.pago || !m?.precisaVerba);
}
const tdTxt = (campo, valor, { tipo = 'text', cls = '', extra = '' } = {}) => `<td class="${cls}"><input data-campo="${campo}" type="${tipo}" value="${esc(valor ?? '')}" ${extra}></td>`;
const tdSel = (campo, opcoes, atual, extra = '') => `<td><select data-campo="${campo}" ${extra}>${opcoes}</select></td>`;

function linha(e) {
  const novo = e.id === 'novo';
  const efetiva = metricaDe(e);
  const m = mdef(efetiva);
  const pend = S.pend[e.id] && e.meta == null;
  const p = e.progresso;
  const gasto = !novo && acompanhavel(e) ? brl0.format(p.gasto) : '—';
  const acomp = novo ? '' : `${chipEstado(e)}${acompanhavel(e) && p.atual != null ? `<div class="nota">${esc(fmtM(m, p.atual))} de ${esc(fmtM(m, e.meta))}</div>` : ''}`;
  const doc = novo ? '' : `<button type="button" class="btn-mini ${e.temDocumentacao ? 'doc-ok' : ''}" data-acao="doc" title="Editor de documentação com relatório diário, semanal e geral">Documentação</button>`;
  const acoes = novo
    ? '<div class="linha-acoes"><button type="button" class="btn-p" data-acao="add-linha">Adicionar</button><button type="button" class="btn-mini" data-acao="desc-linha">Descartar</button></div>'
    : `<div class="linha-acoes"><button type="button" class="btn-mini" data-acao="abrir">Abrir</button>${doc}</div>`;
  const ice = e.iceScore == null ? '—' : nf.format(e.iceScore);
  return `<tr data-id="${e.id}" class="${novo ? 'rascunho' : ''} ${e.status === 'cancelado' ? 'cancelado' : ''}">
    <td class="col-tit"><input data-campo="titulo" value="${esc(e.titulo)}" maxlength="160" aria-label="Título" ${novo ? 'placeholder="Título do novo experimento ou ideia"' : ''}></td>
    ${tdSel('tipo', optsHtml(S.dados.tipos.map((t) => [t.id, t.nome]), e.tipo), e.tipo)}
    ${tdSel('status', optsHtml(OPT_STATUS, e.status), e.status)}
    ${tdTxt('responsavel', e.responsavel, { extra: 'maxlength="120"' })}
    ${tdTxt('areaImpacto', e.areaImpacto, { extra: 'maxlength="80"' })}
    ${tdSel('produto', optsHtml(OPT_PROD, e.produto), e.produto)}
    ${tdSel('canal', optsHtml(canaisPara(e).map((c) => [c.id, c.nome]), e.canal), e.canal, temEscopo(e) ? 'disabled title="Com página, campanha ou identificador, o resultado é o da fatia e o canal não é usado"' : '')}
    ${tdTxt('paginaDestino', e.paginaDestino ?? paginaTexto(e.paginaHost, e.paginaCaminho), { extra: 'list="dl-paginas" maxlength="300" placeholder="escolha ou digite" aria-label="Página de destino"' })}
    ${tdTxt('campanhas', e.campanhasTexto ?? campanhasTexto(e), { extra: 'maxlength="2000" placeholder="várias: separe com ;" title="Campanhas da Meta, separadas por ponto e vírgula; os resultados somam. Para escolher da lista, use Abrir." aria-label="Campanhas da Meta"' })}
    ${tdTxt('identificadorConversao', e.identificadorConversao, { extra: 'list="dl-ident" maxlength="200" placeholder="escolha ou digite" aria-label="Identificador de conversão"' })}
    ${tdSel('metrica', `<option value="">— sem métrica —</option>${optsHtml(S.dados.metricas.map((x) => [x.id, x.rotulo]), efetiva)}`, efetiva)}
    <td class="num"><input data-campo="meta" inputmode="decimal" class="${pend ? 'pend' : ''}" value="${esc(paraTela(m, e.meta))}" ${efetiva ? '' : 'disabled'} placeholder="${pend ? 'informe a meta' : ''}" aria-label="Meta"></td>
    ${tdTxt('resultadoEsperado', e.resultadoEsperado, { extra: 'maxlength="2000" title="Resultado esperado"' })}
    <td class="num"><input data-campo="investimento" inputmode="decimal" value="${esc(paraTela(null, e.investimento))}" aria-label="Investimento previsto"></td>
    <td class="num">${esc(gasto)}</td>
    ${tdTxt('inicio', e.inicio, { tipo: 'date' })}${tdTxt('fim', e.fim, { tipo: 'date' })}
    ${['iceImpacto', 'iceConfianca', 'iceFacilidade'].map((c) => tdTxt(c, e[c], { tipo: 'number', cls: 'ice', extra: 'min="1" max="10" step="1"' })).join('')}
    <td class="num">${esc(ice)}</td>
    ${tdSel('avaliacao', optsHtml(OPT_AVAL, e.avaliacao ?? ''), e.avaliacao ?? '')}
    <td>${acomp}</td>
    <td>${acoes}</td>
  </tr>`;
}

function planilha(lista) {
  const cab = ['Título', 'Tipo', 'Status', 'Responsável', 'Área de impacto', 'Produto', 'Canal', 'Página de destino', 'Campanhas (Meta, somam)', 'Identificador de conversão', 'Métrica chave', 'Meta', 'Resultado esperado', 'Investimento previsto (R$)', 'Gasto real', 'Início', 'Fim', 'I', 'C', 'E', 'ICE', 'Avaliação', 'Acompanhamento', ''];
  const th = cab.map((c, i) => `<th class="${i === 0 ? 'col-tit' : ''}" ${c === 'I' ? 'title="ICE: impacto"' : c === 'C' ? 'title="ICE: confiança"' : c === 'E' ? 'title="ICE: facilidade"' : ''}>${esc(c)}</th>`).join('');
  return `<div class="barra-ctl"><button type="button" class="btn-s" id="nova-linha">+ Nova linha</button><span class="nota">Edite direto nas células: cada alteração é salva ao sair do campo. Meta e investimento em R$ (percentuais em %).</span></div>
    <div class="plan-wrap"><table class="plan"><thead><tr>${th}</tr></thead><tbody>${S.rascunho ? linha(S.rascunho) : ''}${lista.map(linha).join('')}</tbody></table>
    ${lista.length || S.rascunho ? '' : '<div class="vazio">Nenhum experimento neste filtro.</div>'}</div>`;
}

/* ---------- kanban ---------- */
function card(e) {
  const m = mdef(e.metrica);
  const p = e.progresso;
  const ice = e.iceScore == null ? '' : `<span class="tag ice" title="Média de impacto ${e.iceImpacto}, confiança ${e.iceConfianca} e facilidade ${e.iceFacilidade}">ICE ${nf.format(e.iceScore)}</span>`;
  const barras = acompanhavel(e) && e.status !== 'backlog' ? `<div class="barras">${barra('Prazo', p.decorrido, `${p.diasCompletos}/${p.totalDias} dias`, null, false)}${barra('Meta', p.atingimento, p.atingimento == null ? 'sem dados' : `${nf0.format(p.atingimento * 100)}%`, p.decorrido, true)}</div>` : '';
  return `<article class="card-k" draggable="true" data-id="${e.id}">
    <h3>${esc(e.titulo)}</h3>
    <div class="tags"><span class="tag">${esc(tipoNome(e.tipo))}</span><span class="tag">${esc(PRODUTO_ROTULO[e.produto])}</span>${e.areaImpacto ? `<span class="tag">${esc(e.areaImpacto)}</span>` : ''}${ice}</div>
    ${e.responsavel ? `<p class="mini">${esc(e.responsavel)}</p>` : ''}
    ${m ? `<p class="mini">${esc(m.rotulo)}: meta ${esc(fmtM(m, e.meta))}${e.inicio && e.fim ? ` · ${esc(dm(e.inicio))} a ${esc(dm(e.fim))}` : ''}</p>` : ''}
    ${temEscopo(e) ? `<div class="tags">${escopoRotulos(e).map((t) => `<span class="tag escopo">${esc(t)}</span>`).join('')}</div>` : ''}
    ${e.investimento ? `<p class="mini">Investimento previsto ${esc(brl0.format(e.investimento))}</p>` : ''}
    ${barras}
    <div class="tags">${acompanhavel(e) ? chipEstado(e) : ''}${chipResultado(e)}<button type="button" class="btn-mini ${e.temDocumentacao ? 'doc-ok' : ''}" data-acao="doc">Documentação</button></div>
  </article>`;
}
function kanban(lista) {
  const mostrarCancelados = S.filtro === 'cancelado' || S.filtro === 'todos';
  const cols = COLUNAS_KANBAN.filter((s) => s !== 'cancelado' || mostrarCancelados);
  return `<div class="kanban">${cols.map((s) => {
    const cards = lista.filter((e) => e.status === s);
    return `<section class="col-k" data-status="${s}" aria-label="${esc(STATUS_ROTULO[s])}">
      <h2><span>${esc(STATUS_ROTULO[s])} <span class="qtd">${cards.length}</span></span></h2>
      ${cards.map(card).join('')}
      <div class="novo-slot"><button type="button" class="add" data-acao="novo-card">+ Novo card</button></div>
    </section>`;
  }).join('')}</div>`;
}

function desenhar() {
  const todos = S.dados.experimentos;
  const lista = visiveis();
  const rod = todos.filter((e) => e.status === 'rodando' && acompanhavel(e));
  const cont = (est) => rod.filter((e) => est.includes(e.progresso.estado)).length;
  const nRod = todos.filter((e) => e.status === 'rodando').length;
  $('#veredito').textContent = todos.length
    ? `${todos.length} ${todos.length === 1 ? 'item' : 'itens'} na lista, ${nRod} ${nRod === 1 ? 'rodando' : 'rodando'}${rod.length ? `: ${cont(['em_linha', 'atingida'])} em linha, ${cont(['atencao'])} em atenção, ${cont(['fora'])} abaixo do previsto${cont(['cedo', 'sem_dados', 'nao_iniciou']) ? ` e ${cont(['cedo', 'sem_dados', 'nao_iniciou'])} ainda sem leitura` : ''}` : ''}.`
    : 'Nenhum experimento ainda. Use "Novo experimento" ou "+ Nova linha": só o título é obrigatório.';
  $('#v-planilha').setAttribute('aria-pressed', String(S.vista === 'planilha'));
  $('#v-kanban').setAttribute('aria-pressed', String(S.vista === 'kanban'));
  const alvo = $('#lista');
  const rolagem = ['.plan-wrap', '.kanban'].map((q) => { const el = $(q, alvo); return el ? [q, el.scrollTop, el.scrollLeft] : null; }).filter(Boolean);
  alvo.innerHTML = S.vista === 'planilha' ? planilha(lista) : kanban(lista);
  for (const [q, t, l] of rolagem) { const el = $(q, alvo); if (el) { el.scrollTop = t; el.scrollLeft = l; } }
  if (S.ficha != null) fichaDesenhar();
}

/* ---------- edição de células e cards ---------- */
function converter(campo, el, e) {
  const v = el.value;
  if (campo === 'iceImpacto' || campo === 'iceConfianca' || campo === 'iceFacilidade') return v === '' ? null : Number(v);
  if (campo === 'meta' || campo === 'linhaBase') { const n = doCampo(mdef(metricaDe(e)), v); if (Number.isNaN(n)) throw new Error('Digite um número (ex.: 1.250,50).'); return n; }
  if (campo === 'investimento') { const n = doCampo(null, v); if (Number.isNaN(n)) throw new Error('Digite um número (ex.: 1.250,50).'); return n; }
  if (campo === 'campanhas') return v.split(';').map((t) => t.trim()).filter(Boolean);
  if (campo === 'titulo') { if (!v.trim()) throw new Error('O título não pode ficar vazio.'); return v.trim(); }
  if (campo === 'tipo' || campo === 'status' || campo === 'produto' || campo === 'canal') return v;
  return v.trim() === '' ? null : v.trim();
}
function trocar(novo) {
  const i = S.dados.experimentos.findIndex((x) => x.id === novo.id);
  if (i >= 0) S.dados.experimentos[i] = novo; else S.dados.experimentos.unshift(novo);
}
async function atualizarExp(id, corpo) {
  try {
    trocar(await api(`/api/experimentos/${id}`, { method: 'PUT', body: JSON.stringify(corpo) }));
    delete S.pend[id];
    mostrarErro('');
    return true;
  } catch (err) {
    mostrarErro(err.message);
    return false;
  } finally { desenhar(); }
}

async function editarCelula(el) {
  const tr = el.closest('[data-id]');
  const id = tr.dataset.id, campo = el.dataset.campo;
  const e = id === 'novo' ? S.rascunho : exp(id);
  let valor;
  try { valor = converter(campo, el, e); } catch (err) { mostrarErro(err.message); return desenhar(); }
  mostrarErro('');
  if (id === 'novo') {
    S.rascunho[campo] = valor;
    if (campo === 'metrica') { if (valor == null) S.rascunho.meta = null; desenhar(); }
    return;
  }
  let corpo = { [campo]: valor };
  if (campo === 'metrica') {
    if (valor == null) delete S.pend[id];
    else if (e.meta == null) { S.pend[id] = valor; return desenhar(); } // espera a meta para gravar métrica e meta juntas
  }
  if (campo === 'meta' && valor != null) {
    if (S.pend[id]) corpo = { metrica: S.pend[id], meta: valor };
    else if (!e.metrica) { mostrarErro('Escolha a métrica chave antes de informar a meta.'); return desenhar(); }
  }
  await atualizarExp(id, corpo);
}

function novaLinha() {
  S.vista = 'planilha'; guardado('exp.vista', 'planilha');
  S.rascunho = { id: 'novo', titulo: '', tipo: 'experimento', status: 'backlog', produto: 'rh', canal: 'total', metrica: null, meta: null, responsavel: null, areaImpacto: null, resultadoEsperado: null, investimento: null, inicio: null, fim: null, paginaDestino: null, campanhas: [], identificadorConversao: null, iceImpacto: null, iceConfianca: null, iceFacilidade: null, iceScore: null, avaliacao: null, progresso: { estado: 'sem_metrica' } };
  desenhar();
  $('tr.rascunho input[data-campo="titulo"]')?.focus();
}
async function adicionarLinha() {
  const d = S.rascunho;
  if (!d || S.enviando) return;
  if (!d.titulo.trim()) { mostrarErro('Dê um título à nova linha.'); $('tr.rascunho input[data-campo="titulo"]')?.focus(); return; }
  const campos = ['titulo', 'tipo', 'status', 'produto', 'canal', 'responsavel', 'areaImpacto', 'resultadoEsperado', 'metrica', 'meta', 'investimento', 'inicio', 'fim', 'paginaDestino', 'campanhas', 'identificadorConversao', 'iceImpacto', 'iceConfianca', 'iceFacilidade', 'avaliacao'];
  const corpo = Object.fromEntries(campos.filter((k) => d[k] != null && d[k] !== '' && !(Array.isArray(d[k]) && !d[k].length)).map((k) => [k, d[k]]));
  S.enviando = true;
  try {
    await api('/api/experimentos', { method: 'POST', body: JSON.stringify(corpo) });
    S.rascunho = null;
    mostrarErro('');
    await carregar();
  } catch (err) { mostrarErro(err.message); } finally { S.enviando = false; }
}

/* ---------- ficha (painel lateral): todos os campos + progresso ---------- */
function abrirFicha(id) { S.ficha = id; delete $('#ficha').dataset.montado; fichaDesenhar(); $('#ficha').hidden = false; $('#ficha').scrollTop = 0; $('#f-titulo')?.focus(); }
function fecharFicha() { S.ficha = null; const f = $('#ficha'); f.hidden = true; f.innerHTML = ''; delete f.dataset.montado; }

function fichaDesenhar() {
  const f = $('#ficha');
  const e = S.ficha === 'novo' ? null : exp(S.ficha);
  if (S.ficha !== 'novo' && !e) return fecharFicha();
  const v = {
    titulo: e?.titulo ?? '', tipo: e?.tipo ?? 'experimento', status: e?.status ?? 'backlog', responsavel: e?.responsavel ?? '', areaImpacto: e?.areaImpacto ?? '',
    hipotese: e?.hipotese ?? '', resultadoEsperado: e?.resultadoEsperado ?? '', produto: e?.produto ?? 'rh', canal: e?.canal ?? 'total', metrica: e?.metrica ?? '',
    meta: e?.meta, linhaBase: e?.linhaBase, investimento: e?.investimento, inicio: e?.inicio ?? '', fim: e?.fim ?? '', avaliacao: e?.avaliacao ?? '',
    paginaDestino: e ? paginaTexto(e.paginaHost, e.paginaCaminho) : '', identificadorConversao: e?.identificadorConversao ?? '', escopoModo: e?.escopoModo ?? 'todos',
    ice: [e?.iceImpacto, e?.iceConfianca, e?.iceFacilidade], evidencias: e?.evidencias ?? '', aprendizado: e?.aprendizado ?? '',
  };
  const chave = String(S.ficha);
  if (f.dataset.montado !== chave) S.campFicha = (e?.campanhas ?? []).map(campanhaItem); // campanhas escolhidas: ficam em memória enquanto a ficha está aberta
  if (f.dataset.montado === chave) Object.assign(v, lerFicha(true)); // preserva o que se digitou ao trocar de métrica
  const m = mdef(v.metrica);
  const comEscopo = !!(v.paginaDestino?.trim() || S.campFicha.length || v.identificadorConversao?.trim());
  const canais = comEscopo ? S.dados.canais : S.dados.canais.filter((c) => c.pago || !m?.precisaVerba);
  if (!canais.some((c) => c.id === v.canal)) v.canal = 'total';
  const sel = (id, opts, val) => `<select id="${id}">${optsHtml(opts, val)}</select>`;
  const unidade = m?.formato === 'pct' ? ' (em %)' : m?.formato === 'int' || !m ? '' : ' (em R$)';
  const txt = (x, fmt) => (typeof x === 'string' ? x : paraTela(fmt, x));
  f.dataset.montado = chave;
  f.innerHTML = `<button type="button" class="btn-s" id="fx" style="float:right">Fechar</button>
    <h2 style="margin:0 0 4px">${e ? esc(e.titulo) : 'Novo experimento'}</h2>
    ${e ? `<div class="tags">${chipEstado(e)}${chipResultado(e)}</div><div class="acoes-ex"><button type="button" class="btn-p" id="fx-doc">Documentação</button><span class="nota">Editor de texto com relatório diário, semanal e geral; exporta em PDF.</span></div>` : ''}
    ${e && temEscopo(e) ? `<div class="tags">${escopoRotulos(e).map((t) => `<span class="tag escopo">${esc(t)}</span>`).join('')}</div>` : ''}
    ${e ? `<div class="cartao">${progressoCompleto(e)}</div>` : ''}
    <section class="cartao form-ex"><h2>${e ? 'Dados do experimento' : 'Cadastro'}</h2>
      <p class="sub">${esc(m ? `${m.rotulo}: ${m.nota}. ` : '')}${m ? (m.tipo === 'soma' ? 'A meta é o total a atingir no período.' : 'A meta é o valor a atingir; a trajetória parte da linha de base.') : 'Sem métrica chave, o experimento fica só documentado (sem acompanhamento automático).'}</p>
      <div class="grade">
        <label class="largo">Título<input id="f-titulo" maxlength="160" value="${esc(v.titulo)}" placeholder="Ex.: Campanha de diagnóstico para baixar o CPL"></label>
        <label>Tipo${sel('f-tipo', S.dados.tipos.map((t) => [t.id, t.nome]), v.tipo)}</label>
        <label>Status${sel('f-status', OPT_STATUS, v.status)}</label>
        <label>Responsável<input id="f-responsavel" maxlength="120" value="${esc(v.responsavel)}"></label>
        <label>Área de impacto<input id="f-area" maxlength="80" value="${esc(v.areaImpacto)}" placeholder="Anúncio, CRO, Dados..."></label>
        <label>Produto${sel('f-produto', OPT_PROD, v.produto)}</label>
        <label>Canal${comEscopo ? `<select id="f-canal" disabled title="Com escopo, o canal não é usado">${optsHtml(canais.map((c) => [c.id, c.nome]), v.canal)}</select>` : sel('f-canal', canais.map((c) => [c.id, c.nome]), v.canal)}</label>
        <div class="todo escopo-bloco" style="grid-column:1/-1"><p class="sub" style="margin:4px 0 0"><b>Escopo (opcional).</b> Amarre o teste a uma fatia: escolha da lista (vem das contas reais) ou digite. Com mais de um, vale o conjunto: o negócio precisa bater com todos. O resultado real da métrica chave passa a ser só o dessa fatia. Custo (CPL, CAC...) exige campanha.</p></div>
        <label class="largo">Como combinar os critérios para contar os negócios<select id="f-modo">${optsHtml(Object.entries(MODOS), v.escopoModo)}</select><span class="dica">Se a campanha traz menos negócios que o identificador ou a página (a ligação com a Meta exige UTM), use "Campanha só para o investimento".</span></label>
        <label class="largo">Página de destino (Analytics)<input id="f-pagina" list="dl-paginas" maxlength="300" value="${esc(v.paginaDestino)}" placeholder="quarkrh.com.br/diagnostico ou /diagnostico"></label>
        <label>Identificador de conversão (Pipedrive)<input id="f-ident" list="dl-ident" maxlength="200" value="${esc(v.identificadorConversao)}" placeholder="ex.: o identificador do RD"></label>
        <div class="todo" style="grid-column:1/-1"><label>Campanhas (Meta Ads): escolha uma ou mais; os resultados somam<input id="f-camp-add" list="dl-campanhas" maxlength="200" placeholder="escolha pelo nome da lista (ou digite o nome ou o ID) e tecle Enter"></label>
          <div class="tags" id="f-camp-chips" style="margin-top:8px">${S.campFicha.map((c, i) => `<span class="tag escopo">${esc(c)} <button type="button" class="btn-mini" data-rm="${i}" aria-label="Remover ${esc(c)}">×</button></span>`).join('') || '<span class="dica">Nenhuma campanha escolhida.</span>'}</div></div>
        <label class="todo">Hipótese<textarea id="f-hipotese" rows="2" maxlength="2000" placeholder="Se fizermos X, esperamos Y, porque Z.">${esc(v.hipotese)}</textarea></label>
        <label class="todo">Resultado esperado<textarea id="f-esperado" rows="2" maxlength="2000" placeholder="Que resultado esperamos? Ex.: CPL abaixo de R$ 35 sem perder a taxa de agendamento.">${esc(v.resultadoEsperado)}</textarea></label>
        <label class="largo">Métrica chave<select id="f-metrica"><option value="">— sem métrica (sem acompanhamento) —</option>${optsHtml(S.dados.metricas.map((x) => [x.id, x.rotulo]), v.metrica)}</select></label>
        <label>Meta${esc(unidade)}<input id="f-meta" inputmode="decimal" value="${esc(txt(v.meta, m))}" ${m ? '' : 'disabled'}></label>
        <label>Investimento previsto (R$)<input id="f-invest" inputmode="decimal" value="${esc(txt(v.investimento, null))}"></label>
        <label>Início<input id="f-inicio" type="date" value="${esc(v.inicio)}"></label>
        <label>Fim previsto<input id="f-fim" type="date" value="${esc(v.fim)}"></label>
        <label>Linha de base${esc(unidade)} (opcional)<input id="f-base" inputmode="decimal" value="${esc(txt(v.linhaBase, m))}" placeholder="automática" ${m ? '' : 'disabled'}><span class="dica">Vazio: o mesmo número de dias antes do início.</span></label>
        <label>ICE: impacto (1 a 10)<input id="f-ice0" type="number" min="1" max="10" step="1" value="${esc(v.ice[0] ?? '')}"></label>
        <label>ICE: confiança (1 a 10)<input id="f-ice1" type="number" min="1" max="10" step="1" value="${esc(v.ice[1] ?? '')}"></label>
        <label>ICE: facilidade (1 a 10)<input id="f-ice2" type="number" min="1" max="10" step="1" value="${esc(v.ice[2] ?? '')}"></label>
        <label>Avaliação${sel('f-avaliacao', OPT_AVAL, v.avaliacao)}</label>
        <label class="todo">Evidências, justificativas e links<textarea id="f-evid" rows="2" maxlength="4000">${esc(v.evidencias)}</textarea></label>
        <label class="todo">Aprendizados<textarea id="f-aprend" rows="3" maxlength="4000" placeholder="O que ficou claro com este teste?">${esc(v.aprendizado)}</textarea></label>
      </div>
      <div class="acoes"><button type="button" class="btn-p" id="f-salvar">${e ? 'Salvar alterações' : 'Criar experimento'}</button><button type="button" class="btn-s" id="f-cancelar">Cancelar</button><span class="dica" id="f-msg" role="status"></span></div>
    </section>`;
  $('#f-metrica').addEventListener('change', () => fichaDesenhar());
  for (const id of ['f-pagina', 'f-ident']) $(`#${id}`).addEventListener('change', () => fichaDesenhar());
  const juntar = () => { const inp = $('#f-camp-add'); const t = inp.value.trim(); if (!t) return false; inp.value = ''; if (!S.campFicha.includes(t)) S.campFicha.push(t); fichaDesenhar(); $('#f-camp-add').focus(); return true; };
  $('#f-camp-add').addEventListener('change', juntar);
  $('#f-camp-add').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); juntar(); } });
  $('#f-camp-chips').addEventListener('click', (ev) => { const b = ev.target.closest('[data-rm]'); if (b) { S.campFicha.splice(Number(b.dataset.rm), 1); fichaDesenhar(); } });
  $('#f-produto').addEventListener('change', () => fichaDesenhar());
  $('#f-salvar').addEventListener('click', salvarFicha);
  $('#f-cancelar').addEventListener('click', fecharFicha);
  $('#fx').addEventListener('click', fecharFicha);
  $('#fx-doc')?.addEventListener('click', () => abrirDocumentacao(e.id, { aoFechar: carregar }));
}

/** Lê o formulário. `cru`: texto como está nos números, para não perder o digitado ao trocar de métrica. */
function lerFicha(cru) {
  const g = (id) => $(`#${id}`)?.value ?? '';
  const out = {
    titulo: g('f-titulo'), tipo: g('f-tipo'), status: g('f-status'), responsavel: g('f-responsavel'), areaImpacto: g('f-area'), hipotese: g('f-hipotese'), resultadoEsperado: g('f-esperado'),
    produto: g('f-produto'), canal: g('f-canal'), metrica: g('f-metrica'), inicio: g('f-inicio'), fim: g('f-fim'), avaliacao: g('f-avaliacao'), escopoModo: g('f-modo') || 'todos', paginaDestino: g('f-pagina'), identificadorConversao: g('f-ident'), evidencias: g('f-evid'), aprendizado: g('f-aprend'),
    ice: [g('f-ice0'), g('f-ice1'), g('f-ice2')].map((x) => (x === '' ? null : x)),
  };
  if (cru) return { ...out, meta: g('f-meta'), investimento: g('f-invest'), linhaBase: g('f-base') };
  const m = mdef(out.metrica);
  return { ...out, meta: doCampo(m, g('f-meta')), investimento: doCampo(null, g('f-invest')), linhaBase: doCampo(m, g('f-base')) };
}

async function salvarFicha() {
  if (S.enviando) return;
  const msg = $('#f-msg');
  const v = lerFicha(false);
  if (!v.titulo.trim()) { msg.textContent = 'Dê um título ao experimento.'; return; }
  if (Number.isNaN(v.meta) || Number.isNaN(v.investimento) || Number.isNaN(v.linhaBase)) { msg.textContent = 'Meta, investimento e linha de base devem ser números.'; return; }
  if (v.metrica && v.meta == null) { msg.textContent = 'Informe a meta da métrica chave (ou deixe a métrica em branco).'; return; }
  const nulo = (x) => (x === '' || x == null ? null : x);
  const corpo = {
    titulo: v.titulo, tipo: v.tipo, status: v.status, responsavel: nulo(v.responsavel), areaImpacto: nulo(v.areaImpacto), hipotese: nulo(v.hipotese), resultadoEsperado: nulo(v.resultadoEsperado),
    produto: v.produto, canal: v.canal, metrica: nulo(v.metrica), meta: v.metrica ? v.meta : null, linhaBase: v.metrica ? v.linhaBase : null, investimento: v.investimento,
    inicio: nulo(v.inicio), fim: nulo(v.fim), escopoModo: v.escopoModo || 'todos', paginaDestino: nulo(v.paginaDestino?.trim()), campanhas: [...S.campFicha, ...($('#f-camp-add')?.value.trim() ? [$('#f-camp-add').value.trim()] : [])], identificadorConversao: nulo(v.identificadorConversao?.trim()), avaliacao: nulo(v.avaliacao), evidencias: nulo(v.evidencias), aprendizado: nulo(v.aprendizado),
    iceImpacto: v.ice[0] == null ? null : Number(v.ice[0]), iceConfianca: v.ice[1] == null ? null : Number(v.ice[1]), iceFacilidade: v.ice[2] == null ? null : Number(v.ice[2]),
  };
  S.enviando = true; $('#f-salvar').disabled = true; msg.textContent = 'Salvando…';
  try {
    if (S.ficha === 'novo') {
      const criado = await api('/api/experimentos', { method: 'POST', body: JSON.stringify(corpo) });
      trocar(criado);
      S.ficha = criado.id;
    } else {
      trocar(await api(`/api/experimentos/${S.ficha}`, { method: 'PUT', body: JSON.stringify(corpo) }));
    }
    delete $('#ficha').dataset.montado;
    mostrarErro('');
    desenhar();
    await carregar(); // ordem e histórico (calibração) vêm do servidor
  } catch (e) {
    msg.textContent = e.message;
    $('#f-salvar').disabled = false;
  } finally { S.enviando = false; }
}

/* ---------- kanban: cartões novos e arrastar ---------- */
function novoCard(slot, status) {
  slot.innerHTML = '<div class="novo-card"><input maxlength="160" placeholder="Título do card" aria-label="Título do novo card"><button type="button" class="btn-p" data-acao="criar-card">Criar</button></div>';
  const inp = $('input', slot);
  inp.focus();
  const criar = async () => {
    const titulo = inp.value.trim();
    if (!titulo) return desenhar();
    try { trocar(await api('/api/experimentos', { method: 'POST', body: JSON.stringify({ titulo, status }) })); mostrarErro(''); } catch (err) { mostrarErro(err.message); }
    desenhar();
  };
  inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') criar(); if (ev.key === 'Escape') desenhar(); });
  $('[data-acao="criar-card"]', slot).addEventListener('click', criar);
}

/* ---------- eventos ---------- */
const lista = $('#lista');
$('#novo').addEventListener('click', () => abrirFicha('novo'));
$('#atualizar').addEventListener('click', carregar);
$('#filtro').addEventListener('change', (ev) => { S.filtro = ev.target.value; if (S.dados) desenhar(); });
$('#f-tipo-lista').addEventListener('change', (ev) => { S.tipo = ev.target.value; if (S.dados) desenhar(); });
$('#f-prod-lista').addEventListener('change', (ev) => { S.produto = ev.target.value; if (S.dados) desenhar(); });
$('#busca').addEventListener('input', (ev) => { S.busca = ev.target.value; if (S.dados) desenhar(); });
for (const [id, vista] of [['v-planilha', 'planilha'], ['v-kanban', 'kanban']]) $(`#${id}`).addEventListener('click', () => { S.vista = vista; guardado('exp.vista', vista); if (S.dados) desenhar(); });

lista.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-acao], #nova-linha');
  if (!b) {
    const c = ev.target.closest('.card-k');
    if (c) abrirFicha(Number(c.dataset.id));
    return;
  }
  const acao = b.id === 'nova-linha' ? 'nova-linha' : b.dataset.acao;
  const id = b.closest('[data-id]')?.dataset.id;
  if (acao === 'nova-linha') return novaLinha();
  if (acao === 'add-linha') return adicionarLinha();
  if (acao === 'desc-linha') { S.rascunho = null; return desenhar(); }
  if (acao === 'abrir') return abrirFicha(Number(id));
  if (acao === 'doc') return abrirDocumentacao(Number(id), { aoFechar: carregar });
  if (acao === 'novo-card') return novoCard(b.closest('.novo-slot'), b.closest('[data-status]').dataset.status);
});
lista.addEventListener('change', (ev) => { const el = ev.target.closest('[data-campo]'); if (el) editarCelula(el); });
lista.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.matches('tr.rascunho input[data-campo="titulo"]')) { ev.target.blur(); setTimeout(adicionarLinha, 0); }
});
lista.addEventListener('dragstart', (ev) => {
  const c = ev.target.closest?.('.card-k');
  if (!c) return;
  ev.dataTransfer.setData('text/plain', c.dataset.id);
  ev.dataTransfer.effectAllowed = 'move';
  c.classList.add('arrastando');
});
lista.addEventListener('dragend', () => { lista.querySelectorAll('.arrastando, .alvo').forEach((el) => el.classList.remove('arrastando', 'alvo')); });
lista.addEventListener('dragover', (ev) => { const col = ev.target.closest?.('.col-k'); if (col) { ev.preventDefault(); col.classList.add('alvo'); } });
lista.addEventListener('dragleave', (ev) => { ev.target.closest?.('.col-k')?.classList.remove('alvo'); });
lista.addEventListener('drop', async (ev) => {
  const col = ev.target.closest?.('.col-k');
  if (!col) return;
  ev.preventDefault();
  col.classList.remove('alvo');
  const id = Number(ev.dataTransfer.getData('text/plain'));
  const e = exp(id);
  if (e && e.status !== col.dataset.status) await atualizarExp(id, { status: col.dataset.status });
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && S.ficha != null && $('#doc').hidden) fecharFicha(); });

carregar();
