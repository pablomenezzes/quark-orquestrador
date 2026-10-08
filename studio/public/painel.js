const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PRODUTOS = [['', 'Não definido'], ['rh', 'RH (QuarkRH)'], ['clinic', 'Clínica (QuarkClinic)']];
// Ganho/perdido/aberto/excluído vêm do Status do negócio e MQL é regra pelo motivo de perda: nenhum dos dois é marco de etapa.
const MARCOS = [['', 'Nenhum'], ['sql', 'SQL'], ['reuniao', 'Reunião'], ['proposta', 'Proposta']];
const STATUS = [['open', 'Aberto'], ['won', 'Ganho'], ['lost', 'Perdido'], ['deleted', 'Excluído']];
const SIM_NAO = (v) => [['sim', 'Sim'], ['nao', 'Não']].map(([k, l]) => `<option value="${k}" ${(v ? 'sim' : 'nao') === k ? 'selected' : ''}>${l}</option>`).join('');
const ENTIDADES = [
  ['pipelines', 'Pipelines'], ['stages', 'Etapas'], ['users', 'Usuários'],
  ['deals', 'Negócios'], ['deals_archived', 'Negócios arquivados'], ['deals_deleted', 'Negócios excluídos'], ['deal_history', 'Histórico de etapas'],
  ['deal_fields', 'Campos de negócios'], ['person_fields', 'Campos de pessoas'], ['organization_fields', 'Campos de organizações'], ['activity_fields', 'Campos de atividades'],
];
const ENTIDADE_CAMPO = { deal: 'Negócios', person: 'Pessoas', organization: 'Organizações', activity: 'Atividades' };
const ALERTA_HORAS = 8;

const fmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const when = (v) => (v ? fmt.format(new Date(v)) : '—');
const ago = (v) => {
  if (!v) return 'nunca';
  const m = Math.round((Date.now() - new Date(v).getTime()) / 60000);
  if (m < 1) return 'agora há pouco';
  if (m < 60) return `há ${m} min`;
  if (m < 60 * 48) return `há ${Math.round(m / 60)} h`;
  return `há ${Math.round(m / 1440)} dias`;
};

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.detail || data.error || res.statusText), { status: res.status, data });
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 2200);
}

const S = { tab: 'saude', saude: null, config: null, motivos: null, statusCont: null, usuarios: null, campos: null, filtro: '', neg: { resumo: null, lista: null, ficha: null, progresso: null, funil: null, ano: 2026, f: { pipeline: '', status: '', mql: '', mes: '', q: '', pagina: 1 } } };

const nf = new Intl.NumberFormat('pt-BR');
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const STATUS_LABEL = Object.fromEntries(STATUS);
const dia = (v) => (v ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(v)) : '—');
const statusChip = (s) => `<span class="chip ${s === 'won' ? 'ok' : s === 'lost' ? 'danger' : s === 'deleted' ? 'warn' : ''}">${esc(STATUS_LABEL[s] ?? s ?? '—')}</span>`;

function negQuery() {
  const f = S.neg.f;
  const p = new URLSearchParams();
  for (const k of ['pipeline', 'status', 'mql', 'mes', 'q']) if (f[k]) p.set(k, f[k]);
  if (f.pagina > 1) p.set('pagina', String(f.pagina));
  return p.toString();
}

async function load(tab) {
  if (tab === 'negocios') {
    [S.neg.resumo, S.neg.lista, S.neg.progresso, S.neg.funil] = await Promise.all([
      api('/api/painel/negocios/resumo'), api(`/api/painel/negocios?${negQuery()}`), api('/api/painel/historico/progresso'), api(`/api/painel/funil?ano=${S.neg.ano}`),
    ]);
    S.saude = await api('/api/painel/saude');
  }
  if (tab === 'saude') S.saude = await api('/api/painel/saude');
  if (tab === 'config' || tab === 'explorar' || tab === 'conferencia') S.config = await api('/api/painel/config');
  if (tab === 'config' || tab === 'conferencia') {
    [S.motivos, S.statusCont] = await Promise.all([api('/api/painel/motivos-perda'), api('/api/painel/status-contagem')]);
  }
  if (tab === 'usuarios' || tab === 'conferencia') {
    [S.usuarios, S.campos] = await Promise.all([api('/api/painel/usuarios'), api('/api/painel/campos')]);
  }
}

/* ---------- Saúde ---------- */
function viewSaude() {
  const { entidades, jobs, erros, uso } = S.saude;
  const byEntity = new Map(entidades.map((e) => [e.entity, e]));
  const atrasadas = ENTIDADES.filter(([k]) => byEntity.get(k)?.atrasada).map(([, l]) => l);
  const nunca = ENTIDADES.filter(([k]) => !byEntity.has(k)).map(([, l]) => l);
  const alerta = atrasadas.length
    ? `<div class="banner danger" style="margin-bottom:12px"><strong>Atenção:</strong> sem atualização com sucesso há mais de ${ALERTA_HORAS} horas em: ${esc(atrasadas.join(', '))}.</div>`
    : '';
  const linhas = ENTIDADES.map(([k, label]) => {
    const e = byEntity.get(k);
    let chip = '<span class="chip">nunca sincronizada</span>';
    if (e) chip = e.atrasada ? '<span class="chip danger">atrasada</span>' : e.ultimo_status === 'ok' ? '<span class="chip ok">ok</span>' : e.ultimo_status === 'parcial' ? '<span class="chip warn">parcial</span>' : `<span class="chip danger">${esc(e.ultimo_status ?? '—')}</span>`;
    return `<tr><td>${esc(label)}</td><td>${chip}</td><td>${e ? esc(ago(e.ultimo_sucesso_em)) : '—'}</td><td class="muted">${e ? esc(when(e.ultimo_sucesso_em)) : ''}</td></tr>`;
  }).join('');
  const jobsHtml = jobs.length
    ? jobs.map((j) => `<tr><td>${esc(when(j.iniciou_em))}</td><td>${esc(j.entity)}</td><td>${esc(j.modo)} · ${esc(j.origem)}</td><td><span class="chip ${j.status === 'ok' ? 'ok' : j.status === 'parcial' ? 'warn' : j.status === 'rodando' ? '' : 'danger'}">${esc(j.status)}</span></td><td class="num">${j.lidos}</td><td class="num">${j.gravados}</td><td class="num">${j.atualizados}</td><td class="num">${j.ignorados}</td><td class="num">${j.falhas}</td><td class="num">${j.tokens_gastos}</td><td class="muted">${esc(j.erro ?? '')}</td></tr>`).join('')
    : '<tr><td colspan="11" class="empty">Nenhuma sincronização rodou ainda.</td></tr>';
  const errosHtml = erros.length
    ? erros.map((e) => `<tr><td>${esc(when(e.criado_em))}</td><td>${esc(e.entity)}</td><td>${esc(e.source_id ?? '')}</td><td>${esc(e.mensagem)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">Nenhum erro registrado.</td></tr>';
  const usoHtml = uso.length
    ? uso.map((u) => `<tr><td>${esc(u.dia)}</td><td class="num">${u.tokens_gastos}</td><td class="num">${u.requisicoes}</td><td class="num">${u.limite_429}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">Sem uso registrado.</td></tr>';
  return `${alerta}
    ${nunca.length === ENTIDADES.length ? '<div class="banner warn" style="margin-bottom:12px">Nada foi sincronizado ainda. Quando a primeira sincronização rodar, ela aparece aqui.</div>' : ''}
    <section class="card section"><h2>Última atualização de cada item</h2>
      <table class="t"><thead><tr><th>Item</th><th>Situação</th><th>Última vez com sucesso</th><th></th></tr></thead><tbody>${linhas}</tbody></table></section>
    <section class="card section" style="margin-top:16px"><h2>Últimas sincronizações</h2><div style="overflow:auto">
      <table class="t"><thead><tr><th>Início</th><th>Item</th><th>Tipo</th><th>Status</th><th class="num">Lidos</th><th class="num">Novos</th><th class="num">Atualizados</th><th class="num">Iguais</th><th class="num">Falhas</th><th class="num">Unidades da cota</th><th>Erro</th></tr></thead><tbody>${jobsHtml}</tbody></table></div></section>
    <section class="card section" style="margin-top:16px"><h2>Erros recentes</h2>
      <table class="t"><thead><tr><th>Quando</th><th>Item</th><th>ID</th><th>Mensagem</th></tr></thead><tbody>${errosHtml}</tbody></table></section>
    <section class="card section" style="margin-top:16px"><h2>Uso da cota do Pipedrive (últimos dias)</h2>
      <table class="t"><thead><tr><th>Dia</th><th class="num">Unidades gastas</th><th class="num">Requisições</th><th class="num">Limitadas (429)</th></tr></thead><tbody>${usoHtml}</tbody></table></section>`;
}

/* ---------- Configuração ---------- */
const opts = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${(cur ?? '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('');

function viewConfig() {
  if (!S.config.length) return '<div class="card empty">Nenhum pipeline importado ainda. Rode a primeira sincronização.</div>';
  const semProduto = S.config.filter((p) => !p.produto).length;
  const semMarco = S.config.reduce((n, p) => n + p.etapas.filter((e) => !e.marco).length, 0);
  return `
    <div class="banner ${semProduto ? 'warn' : 'ok'}" style="margin-bottom:14px">
      Ligue cada <strong>pipeline a um produto</strong>. Se quiser, marque nas etapas <strong>até onde o negócio chegou</strong> (SQL, reunião, proposta). Salva sozinho ao escolher.
      ${semProduto ? `Faltam ${semProduto} pipeline(s) sem produto.` : 'Todos os pipelines têm produto.'}
      <br><span class="muted">Ganho, perdido, aberto e excluído <strong>não dependem da etapa</strong>: vêm do Status do negócio. MQL <strong>não é etapa</strong>: é a regra dos motivos de perda, logo abaixo.</span>
    </div>
    <section class="card section" style="margin-bottom:14px"><h2>Quais status contam como lead?</h2>
      <p class="muted" style="margin-top:0">Escolha se os negócios em cada status entram na contagem de leads. Vale para todo o histórico, sem reprocessar nada.</p>
      <table class="t"><thead><tr><th>Status do negócio</th><th style="width:220px">Conta como lead?</th></tr></thead><tbody>
      ${S.statusCont.map((s) => `<tr><td>${esc(STATUS.find(([k]) => k === s.status)?.[1] ?? s.status)} <span class="muted">(${esc(s.status)})</span></td><td><select class="sel" data-status="${esc(s.status)}">${SIM_NAO(s.conta_como_lead)}</select></td></tr>`).join('')}
      </tbody></table></section>
    <section class="card section" style="margin-bottom:14px"><h2>MQL: motivos de perda que tiram o negócio do MQL</h2>
      <p class="muted" style="margin-top:0">MQL é todo negócio que <strong>não</strong> foi perdido por um dos motivos marcados “Tira do MQL”. Abertos, ganhos e perdidos por qualquer outro motivo contam como MQL.</p>
      <table class="t"><thead><tr><th style="width:70px">ID</th><th>Motivo da perda</th><th style="width:220px">Efeito</th></tr></thead><tbody>
      ${S.motivos.map((m) => `<tr><td class="muted">#${m.reason_id}</td><td>${m.motivo ? esc(m.motivo) : '<span class="muted">(motivo que o Pipedrive não oferece mais)</span>'}</td><td><select class="sel" data-motivo="${m.reason_id}"><option value="nao" ${m.exclui_mql ? '' : 'selected'}>Conta como MQL</option><option value="sim" ${m.exclui_mql ? 'selected' : ''}>Tira do MQL</option></select></td></tr>`).join('') || '<tr><td colspan="3" class="empty">Nenhum motivo importado ainda.</td></tr>'}
      </tbody></table></section>
    ${S.config.map((p) => `
    <section class="card pipe-card">
      <div class="pipe-head">
        <h3>${esc(p.pipeline)} <span class="muted" style="font-weight:400;font-size:13px">#${p.pipeline_id}</span></h3>
        <label class="muted" style="font-size:13px">Produto</label>
        <select class="sel" data-pipe="${p.pipeline_id}">${opts(PRODUTOS, p.produto)}</select>
      </div>
      ${p.etapas.length ? `<table class="t"><thead><tr><th class="num" style="width:60px">Ordem</th><th>Etapa</th><th style="width:60px">ID</th><th style="width:220px">Chegou até aqui (marco)</th></tr></thead><tbody>
        ${p.etapas.map((e) => `<tr><td class="num">${esc(e.etapa_ordem ?? '')}</td><td>${esc(e.etapa)}</td><td class="muted">#${e.stage_id}</td><td><select class="sel" data-stage="${e.stage_id}">${opts(MARCOS, e.marco)}</select></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">Este pipeline não tem etapas importadas.</div>'}
    </section>`).join('')}`;
}

/* ---------- Exploração ---------- */
function viewExplorar() {
  const q = S.filtro.trim().toLowerCase();
  const rows = [];
  for (const p of S.config) {
    if (!p.etapas.length) rows.push({ p, e: null });
    for (const e of p.etapas) rows.push({ p, e });
  }
  const f = rows.filter(({ p, e }) => !q || `${p.pipeline} ${e?.etapa ?? ''} ${p.produto ?? ''} ${e?.marco ?? ''}`.toLowerCase().includes(q));
  return `
    <div class="row" style="margin-bottom:12px"><input class="field-input search" id="busca" placeholder="Buscar por pipeline, etapa, produto ou marco…" value="${esc(S.filtro)}"><span class="muted">${f.length} linha(s)</span></div>
    <section class="card section" style="overflow:auto"><table class="t"><thead><tr><th class="num">Ordem</th><th>Pipeline</th><th>ID</th><th>Produto</th><th class="num">Ordem</th><th>Etapa</th><th>ID</th><th>Marco</th></tr></thead><tbody>
    ${f.map(({ p, e }) => `<tr><td class="num">${esc(p.pipeline_ordem ?? '')}</td><td>${esc(p.pipeline)}</td><td class="muted">#${p.pipeline_id}</td><td>${p.produto ? `<span class="chip accent">${esc(p.produto)}</span>` : '<span class="muted">—</span>'}</td><td class="num">${esc(e?.etapa_ordem ?? '')}</td><td>${esc(e?.etapa ?? '—')}</td><td class="muted">${e ? '#' + e.stage_id : ''}</td><td>${e?.marco ? `<span class="chip">${esc(e.marco)}</span>` : '<span class="muted">—</span>'}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">Nada encontrado.</td></tr>'}
    </tbody></table></section>`;
}

/* ---------- Negócios ---------- */
function viewNegocios() {
  const { resumo, lista, f } = S.neg;
  const sum = (fn) => resumo.filter(fn).reduce((n, r) => n + r.qtd, 0);
  const total = sum(() => true);
  const mql = resumo.reduce((n, r) => n + r.qtd_mql, 0);
  const byStatus = (s) => sum((r) => r.status === s);
  const arq = sum((r) => r.is_archived);
  const cargaPendente = ['deals', 'deals_archived', 'deals_deleted'].filter((k) => !S.saude?.entidades?.find((e) => e.entity === k)?.backfill_concluido);
  const pipes = [...new Map(resumo.filter((r) => r.pipeline_id != null).map((r) => [r.pipeline_id, r.pipeline])).entries()];
  const porPipe = pipes.map(([id, nome]) => {
    const rs = resumo.filter((r) => r.pipeline_id === id);
    const n = (s) => rs.filter((r) => r.status === s).reduce((a, r) => a + r.qtd, 0);
    const produto = rs[0]?.produto;
    return `<tr><td>${esc(nome)} <span class="muted">#${id}</span></td><td>${produto ? esc(produto) : '<span class="muted">—</span>'}</td><td class="num">${nf.format(n('open'))}</td><td class="num">${nf.format(n('won'))}</td><td class="num">${nf.format(n('lost'))}</td><td class="num">${nf.format(n('deleted'))}</td><td class="num"><b>${nf.format(rs.reduce((a, r) => a + r.qtd, 0))}</b></td><td class="num">${nf.format(rs.reduce((a, r) => a + r.qtd_mql, 0))}</td></tr>`;
  }).join('');
  const sel = (id, val, items) => `<select class="sel" id="${id}">${items.map(([v, l]) => `<option value="${esc(v)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const paginas = Math.max(1, Math.ceil(lista.total / lista.por_pagina));
  const ficha = S.neg.ficha;
  const campos = ficha ? ficha.campos.filter((c) => c.valor !== null && c.valor !== '' && !(Array.isArray(c.valor) && !c.valor.length)) : [];
  return `
    ${cargaPendente.length ? `<div class="banner warn" style="margin-bottom:12px">A <strong>carga inicial</strong> de ${esc(cargaPendente.join(', '))} ainda não terminou. Os números abaixo são parciais até ela acabar (veja a aba Saúde da sincronização).</div>` : ''}
    <div class="kpis">
      <div class="card kpi"><b>${nf.format(total)}</b><span>negócios no banco (todos os status)</span></div>
      <div class="card kpi"><b>${nf.format(byStatus('open'))}</b><span>abertos</span></div>
      <div class="card kpi"><b>${nf.format(byStatus('won'))}</b><span>ganhos</span></div>
      <div class="card kpi"><b>${nf.format(byStatus('lost'))}</b><span>perdidos</span></div>
      <div class="card kpi"><b>${nf.format(byStatus('deleted'))}</b><span>excluídos (marcados, nunca apagados)</span></div>
      <div class="card kpi"><b>${nf.format(mql)}</b><span>MQL (regra dos motivos de perda; ${nf.format(arq)} arquivados incluídos no total)</span></div>
    </div>
    <section class="card section" style="overflow:auto"><h2>Por pipeline <span class="muted" style="font-weight:400">(compare com o Pipedrive)</span></h2>
      <table class="t"><thead><tr><th>Pipeline</th><th>Produto</th><th class="num">Abertos</th><th class="num">Ganhos</th><th class="num">Perdidos</th><th class="num">Excluídos</th><th class="num">Total</th><th class="num">MQL</th></tr></thead><tbody>${porPipe || '<tr><td colspan="8" class="empty">Nenhum negócio importado ainda.</td></tr>'}</tbody></table></section>
    <section class="card section" style="margin-top:16px;overflow:auto"><h2>Histórico de etapas: andamento da carga</h2>
      <p class="muted" style="margin-top:0">Por ano de criação do negócio. "Sem mudança de etapa" nunca saiu da etapa em que nasceu (não precisa consultar o Pipedrive); "histórico lido" já tem a linha do tempo completa; "pendentes" ainda vão ser lidos.</p>
      <table class="t"><thead><tr><th>Ano de criação</th><th class="num">Negócios</th><th class="num">Sem mudança de etapa</th><th class="num">Histórico lido</th><th class="num">Pendentes</th><th class="num">Com linha do tempo</th></tr></thead><tbody>
      ${S.neg.progresso.map((p) => `<tr><td>${p.ano_criacao}</td><td class="num">${nf.format(p.negocios)}</td><td class="num">${nf.format(p.sem_mudanca_de_etapa)}</td><td class="num">${nf.format(p.historico_lido)}</td><td class="num">${p.pendentes ? `<span class="chip warn">${nf.format(p.pendentes)}</span>` : '<span class="chip ok">0</span>'}</td><td class="num">${nf.format(p.com_linha_do_tempo)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nenhum negócio.</td></tr>'}
      </tbody></table></section>
    <section class="card section" style="margin-top:16px;overflow:auto"><h2>Funil dos negócios criados em ${sel('nf-ano', S.neg.ano, [2026, 2025].map((a) => [String(a), String(a)]))}</h2>
      <p class="muted" style="margin-top:0">Leads e MQL vêm das regras de contagem; "chegou em…" vem do histórico de etapas (só vale para quem já tem o histórico lido); ganhos e perdidos vêm do Status do negócio, nunca da etapa.</p>
      <table class="t"><thead><tr><th>Pipeline</th><th>Produto</th><th class="num">Leads</th><th class="num">MQL</th><th class="num">Chegou em SQL</th><th class="num">Chegou em reunião</th><th class="num">Chegou em proposta</th><th class="num">Ganhos</th><th class="num">Perdidos</th></tr></thead><tbody>
      ${S.neg.funil.map((r) => `<tr><td>${esc(r.pipeline ?? '—')} <span class="muted">#${r.pipeline_id ?? ''}</span></td><td>${r.produto ? esc(r.produto) : '<span class="muted">—</span>'}</td><td class="num">${nf.format(r.leads)}</td><td class="num">${nf.format(r.mql)}</td><td class="num">${nf.format(r.chegou_sql)}</td><td class="num">${nf.format(r.chegou_reuniao)}</td><td class="num">${nf.format(r.chegou_proposta)}</td><td class="num">${nf.format(r.ganhos)}</td><td class="num">${nf.format(r.perdidos)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">Nenhum negócio criado neste ano.</td></tr>'}
      </tbody></table></section>
    <section class="card section" style="margin-top:16px"><h2>Lista de negócios</h2>
      <div class="row" style="margin-bottom:12px;flex-wrap:wrap;gap:8px">
        ${sel('nf-pipeline', f.pipeline, [['', 'Todos os pipelines'], ...pipes.map(([id, nome]) => [String(id), nome])])}
        ${sel('nf-status', f.status, [['', 'Todos os status'], ...STATUS])}
        ${sel('nf-mql', f.mql, [['', 'MQL e não MQL'], ['sim', 'Só MQL']])}
        <input class="field-input" id="nf-mes" type="month" value="${esc(f.mes)}" title="Mês de criação">
        <input class="field-input search" id="nf-q" placeholder="ID ou parte do título…" value="${esc(f.q)}">
        <button class="btn" id="nf-limpar" type="button">Limpar</button>
      </div>
      <div class="muted" style="margin-bottom:8px">${nf.format(lista.total)} negócio(s) · página ${lista.pagina} de ${nf.format(paginas)}</div>
      <div style="overflow:auto"><table class="t"><thead><tr><th>ID</th><th>Título</th><th>Pipeline › etapa</th><th>Status</th><th>MQL</th><th class="num">Valor</th><th>Responsável</th><th>Criado</th><th>Motivo da perda</th></tr></thead><tbody>
      ${lista.itens.map((d) => `<tr class="clicavel" data-deal="${d.deal_id}" style="cursor:pointer"><td class="muted">#${d.deal_id}</td><td>${esc(d.titulo ?? '')}</td><td>${esc(d.pipeline ?? '')} <span class="muted">› ${esc(d.etapa ?? '')}</span>${d.is_archived ? ' <span class="chip">arquivado</span>' : ''}</td><td>${statusChip(d.status)}</td><td>${d.is_mql ? '<span class="chip ok">MQL</span>' : '<span class="muted">—</span>'}</td><td class="num">${d.valor != null ? brl.format(d.valor) : '—'}</td><td>${esc(d.responsavel ?? '')}</td><td>${dia(d.criado_em)}</td><td>${d.motivo_perda ? `${esc(d.motivo_perda)} <span class="muted">#${d.motivo_perda_id ?? '?'}</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">Nenhum negócio com esses filtros.</td></tr>'}
      </tbody></table></div>
      <div class="row" style="margin-top:12px;gap:8px"><button class="btn" id="nf-ant" type="button" ${lista.pagina <= 1 ? 'disabled' : ''}>← Anterior</button><button class="btn" id="nf-prox" type="button" ${lista.pagina >= paginas ? 'disabled' : ''}>Próxima →</button></div>
    </section>
    ${ficha ? `<section class="card section" style="margin-top:16px" id="ficha"><div class="row" style="justify-content:space-between"><h2>Ficha do negócio #${ficha.negocio.deal_id}</h2><button class="btn" id="ficha-fechar" type="button">Fechar</button></div>
      <table class="t"><tbody>
        <tr><td class="muted">Título</td><td>${esc(ficha.negocio.titulo ?? '')}</td></tr>
        <tr><td class="muted">Pipeline › etapa</td><td>${esc(ficha.negocio.pipeline ?? '')} <span class="muted">#${ficha.negocio.pipeline_id ?? ''}</span> › ${esc(ficha.negocio.etapa ?? '')} <span class="muted">#${ficha.negocio.stage_id ?? ''}</span>${ficha.negocio.marco ? ` · chegou até: ${esc(ficha.negocio.marco)}` : ''}</td></tr>
        <tr><td class="muted">Status</td><td>${statusChip(ficha.negocio.status)} ${ficha.negocio.is_mql ? '<span class="chip ok">MQL</span>' : ''} ${ficha.negocio.conta_como_lead ? '' : '<span class="chip warn">fora da contagem de leads</span>'}</td></tr>
        <tr><td class="muted">Responsável</td><td>${esc(ficha.negocio.responsavel ?? '')} <span class="muted">#${ficha.negocio.owner_id ?? ''}</span></td></tr>
        <tr><td class="muted">Valor</td><td>${ficha.negocio.valor != null ? brl.format(ficha.negocio.valor) : '—'}</td></tr>
        <tr><td class="muted">Criado · fechado · perdido · atualizado</td><td>${dia(ficha.negocio.criado_em)} · ${dia(ficha.negocio.fechado_em)} · ${dia(ficha.negocio.perdido_em)} · ${dia(ficha.negocio.atualizado_em)}</td></tr>
        <tr><td class="muted">Motivo da perda</td><td>${ficha.negocio.motivo_perda ? `${esc(ficha.negocio.motivo_perda)} <span class="muted">#${ficha.negocio.motivo_perda_id ?? 'sem ID'}</span>` : '—'}</td></tr>
      </tbody></table>
      <h3 style="margin-top:16px">Por onde passou (${ficha.historico.length} etapa(s))</h3>
      <table class="t"><thead><tr><th>Etapa</th><th>Entrou</th><th>Saiu</th><th class="num">Tempo</th><th>Movido por</th></tr></thead><tbody>
      ${ficha.historico.map((h) => `<tr><td>${esc(h.etapa ?? '')} <span class="muted">#${h.stage_id}</span>${h.marco ? ` <span class="chip">${esc(h.marco)}</span>` : ''}${h.etapa_atual ? ' <span class="chip ok">etapa atual</span>' : ''}</td><td>${dia(h.entrou_em)}</td><td>${h.saiu_em ? dia(h.saiu_em) : '—'}</td><td class="num">${h.horas_na_etapa == null ? '—' : Number(h.horas_na_etapa) >= 48 ? `${(Number(h.horas_na_etapa) / 24).toFixed(1)} dias` : `${Number(h.horas_na_etapa).toFixed(1)} h`}</td><td>${esc(h.movido_por ?? (h.origem_dado === 'criacao' ? 'criação do negócio' : ''))}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">O histórico deste negócio ainda não foi lido.</td></tr>'}
      </tbody></table>
      <h3 style="margin-top:16px">Campos personalizados preenchidos (${campos.length})</h3>
      <table class="t"><thead><tr><th>Campo</th><th>Valor</th><th>ID original</th></tr></thead><tbody>
      ${campos.map((c) => `<tr><td>${esc(c.rotulo ?? c.nome_pipedrive ?? '')}${c.rotulo && c.nome_pipedrive ? ` <span class="muted">(${esc(c.nome_pipedrive)})</span>` : ''}</td><td>${c.valor_legivel ? `${esc(c.valor_legivel)} <span class="muted">#${esc(c.valor)}</span>` : esc(typeof c.valor === 'object' ? JSON.stringify(c.valor) : c.valor)}</td><td class="mono muted">${esc(c.field_key)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Nenhum campo personalizado preenchido.</td></tr>'}
      </tbody></table></section>` : ''}`;
}

/* ---------- Usuários e campos ---------- */
function viewUsuarios() {
  return `
    <section class="card section"><h2>Usuários do Pipedrive <span class="muted" style="font-weight:400">(${S.usuarios.length}; e-mails não aparecem aqui)</span></h2>
      <table class="t"><thead><tr><th>ID</th><th>Nome</th><th>Situação</th></tr></thead><tbody>
      ${S.usuarios.map((u) => `<tr><td class="muted">#${u.user_id}</td><td>${esc(u.nome ?? '')}</td><td>${u.ativo === false ? '<span class="chip">inativo</span>' : u.ativo ? '<span class="chip ok">ativo</span>' : '<span class="muted">—</span>'}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Nenhum usuário importado.</td></tr>'}
      </tbody></table></section>
    <section class="card section" style="margin-top:16px;overflow:auto"><h2>Campos <span class="muted" style="font-weight:400">(${S.campos.length})</span></h2>
      <table class="t"><thead><tr><th>Entidade</th><th>Nome no Pipedrive</th><th>Seu rótulo</th><th>Tipo</th><th>ID original</th></tr></thead><tbody>
      ${S.campos.map((c) => `<tr><td>${esc(ENTIDADE_CAMPO[c.entity] ?? c.entity)}</td><td>${esc(c.nome_pipedrive ?? '')}</td><td>${esc(c.rotulo ?? '')}</td><td class="muted">${esc(c.tipo ?? '')}</td><td class="mono muted">${esc(c.field_key)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum campo importado.</td></tr>'}
      </tbody></table></section>`;
}

/* ---------- Conferência ---------- */
function viewConferencia() {
  const nEtapas = S.config.reduce((n, p) => n + p.etapas.length, 0);
  const ativos = S.usuarios.filter((u) => u.ativo === true).length;
  const inativos = S.usuarios.filter((u) => u.ativo === false).length;
  const porEnt = Object.fromEntries(Object.keys(ENTIDADE_CAMPO).map((k) => [k, S.campos.filter((c) => c.entity === k).length]));
  const personalizados = S.campos.filter((c) => /^[0-9a-f]{40}$/.test(c.field_key)).length;
  return `
    <div class="banner ok" style="margin-bottom:14px">Compare estes números com o Pipedrive. Se algum não bater, me diga qual: nada é escondido nem arredondado.</div>
    <div class="kpis">
      <div class="card kpi"><b>${S.config.length}</b><span>pipelines</span></div>
      <div class="card kpi"><b>${nEtapas}</b><span>etapas (todas)</span></div>
      <div class="card kpi"><b>${S.usuarios.length}</b><span>usuários (${ativos} ativos, ${inativos} inativos)</span></div>
      <div class="card kpi"><b>${S.campos.length}</b><span>campos (${personalizados} personalizados)</span></div>
    </div>
    <section class="card section"><h2>Etapas por pipeline</h2><table class="t"><thead><tr><th>Pipeline</th><th class="num">Etapas</th><th>Produto</th></tr></thead><tbody>
      ${S.config.map((p) => `<tr><td>${esc(p.pipeline)}</td><td class="num">${p.etapas.length}</td><td>${p.produto ? esc(p.produto) : '<span class="muted">não definido</span>'}</td></tr>`).join('')}
    </tbody></table></section>
    <section class="card section" style="margin-top:16px"><h2>Regras de contagem</h2><table class="t"><tbody>
      <tr><td>Motivos de perda que tiram do MQL</td><td>${S.motivos.filter((m) => m.exclui_mql).map((m) => `#${m.reason_id} ${esc(m.motivo ?? '')}`).join(' · ') || '<span class="muted">nenhum</span>'} <span class="muted">(de ${S.motivos.length} motivos)</span></td></tr>
      <tr><td>Status que contam como lead</td><td>${S.statusCont.filter((s) => s.conta_como_lead).map((s) => esc(STATUS.find(([k]) => k === s.status)?.[1] ?? s.status)).join(', ') || '<span class="muted">nenhum</span>'}</td></tr>
    </tbody></table></section>
    <section class="card section" style="margin-top:16px"><h2>Campos por entidade</h2><table class="t"><thead><tr><th>Entidade</th><th class="num">Campos</th></tr></thead><tbody>
      ${Object.entries(ENTIDADE_CAMPO).map(([k, l]) => `<tr><td>${l}</td><td class="num">${porEnt[k]}</td></tr>`).join('')}
    </tbody></table></section>`;
}

const VIEWS = { saude: viewSaude, config: viewConfig, explorar: viewExplorar, negocios: viewNegocios, usuarios: viewUsuarios, conferencia: viewConferencia };

/* Negócios: filtros, paginação e ficha */
async function recarregarNegocios(rolarParaFicha = false) {
  try {
    S.neg.lista = await api(`/api/painel/negocios?${negQuery()}`);
    $('#view').innerHTML = viewNegocios();
    if (rolarParaFicha) $('#ficha')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    toast(`Não consegui carregar: ${e.message}`);
  }
}
const aplicarFiltro = (campo, valor) => {
  S.neg.f[campo] = valor;
  S.neg.f.pagina = 1;
  return recarregarNegocios();
};
document.addEventListener('change', async (ev) => {
  if (ev.target.id === 'nf-ano') {
    S.neg.ano = Number(ev.target.value);
    try {
      S.neg.funil = await api(`/api/painel/funil?ano=${S.neg.ano}`);
      $('#view').innerHTML = viewNegocios();
    } catch (e) {
      toast(`Não consegui carregar: ${e.message}`);
    }
    return;
  }
  const m = { 'nf-pipeline': 'pipeline', 'nf-status': 'status', 'nf-mql': 'mql', 'nf-mes': 'mes' }[ev.target.id];
  if (m) aplicarFiltro(m, ev.target.value);
});
let buscaTimer;
document.addEventListener('input', (ev) => {
  if (ev.target.id !== 'nf-q') return;
  clearTimeout(buscaTimer);
  const v = ev.target.value;
  const pos = ev.target.selectionStart;
  buscaTimer = setTimeout(async () => {
    await aplicarFiltro('q', v);
    const b = $('#nf-q');
    if (b) {
      b.focus();
      b.setSelectionRange(pos, pos);
    }
  }, 350);
});
document.addEventListener('click', async (ev) => {
  const t = ev.target;
  if (t.id === 'nf-limpar') {
    S.neg.f = { pipeline: '', status: '', mql: '', mes: '', q: '', pagina: 1 };
    return recarregarNegocios();
  }
  if (t.id === 'nf-ant' && S.neg.f.pagina > 1) {
    S.neg.f.pagina--;
    return recarregarNegocios();
  }
  if (t.id === 'nf-prox') {
    S.neg.f.pagina++;
    return recarregarNegocios();
  }
  if (t.id === 'ficha-fechar') {
    S.neg.ficha = null;
    return recarregarNegocios();
  }
  const linha = t.closest?.('[data-deal]');
  if (linha) {
    try {
      S.neg.ficha = await api(`/api/painel/negocios/${linha.dataset.deal}`);
      $('#view').innerHTML = viewNegocios();
      $('#ficha')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      toast(`Não consegui abrir o negócio: ${e.message}`);
    }
  }
});

async function show(tab) {
  S.tab = tab;
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  const view = $('#view');
  view.innerHTML = '<p class="muted">Carregando…</p>';
  try {
    await load(tab);
    view.innerHTML = VIEWS[tab]();
    $('#aviso').innerHTML = '';
  } catch (e) {
    if (e.status === 503) {
      $('#aviso').innerHTML = `<div class="banner warn" style="margin-bottom:12px"><strong>O Painel ainda não está ligado ao banco.</strong> ${esc(e.message)}</div>`;
      view.innerHTML = '';
    } else {
      view.innerHTML = `<div class="banner danger">Não consegui carregar: ${esc(e.message)}</div>`;
    }
  }
}

document.addEventListener('click', (ev) => {
  const t = ev.target.closest('.tab');
  if (t) show(t.dataset.tab);
});

document.addEventListener('input', (ev) => {
  if (ev.target.id === 'busca') {
    S.filtro = ev.target.value;
    const pos = ev.target.selectionStart;
    $('#view').innerHTML = viewExplorar();
    const b = $('#busca');
    b.focus();
    b.setSelectionRange(pos, pos);
  }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  const pipe = el.dataset?.pipe;
  const stage = el.dataset?.stage;
  const motivo = el.dataset?.motivo;
  const status = el.dataset?.status;
  if (!pipe && !stage && !motivo && !status) return;
  const value = el.value === '' ? null : el.value;
  el.classList.remove('saved', 'err');
  try {
    if (pipe) await api(`/api/painel/config/pipeline/${pipe}`, { method: 'PUT', body: { produto: value } });
    else if (motivo) await api(`/api/painel/config/motivo-perda/${motivo}`, { method: 'PUT', body: { exclui_mql: value === 'sim' } });
    else if (status) await api(`/api/painel/config/status/${status}`, { method: 'PUT', body: { conta_como_lead: value === 'sim' } });
    else await api(`/api/painel/config/stage/${stage}`, { method: 'PUT', body: { marco: value } });
    el.classList.add('saved');
    toast('Salvo');
    const m = S.motivos?.find((x) => String(x.reason_id) === motivo);
    if (m) m.exclui_mql = value === 'sim';
    const st = S.statusCont?.find((x) => x.status === status);
    if (st) st.conta_como_lead = value === 'sim';
    const p = S.config.find((x) => String(x.pipeline_id) === pipe);
    if (p) p.produto = value;
    for (const pp of S.config) for (const e of pp.etapas) if (String(e.stage_id) === stage) e.marco = value;
  } catch (e) {
    el.classList.add('err');
    toast(`Não salvou: ${e.message}`);
  }
});

show('saude');
