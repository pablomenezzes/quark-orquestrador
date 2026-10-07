const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PRODUTOS = [['', 'Não definido'], ['rh', 'RH (QuarkRH)'], ['clinic', 'Clínica (QuarkClinic)']];
// Ganho/perdido/aberto/excluído vêm do Status do negócio e MQL é regra pelo motivo de perda: nenhum dos dois é marco de etapa.
const MARCOS = [['', 'Nenhum'], ['sql', 'SQL'], ['reuniao', 'Reunião'], ['proposta', 'Proposta']];
const STATUS = [['open', 'Aberto'], ['won', 'Ganho'], ['lost', 'Perdido'], ['deleted', 'Excluído']];
const SIM_NAO = (v) => [['sim', 'Sim'], ['nao', 'Não']].map(([k, l]) => `<option value="${k}" ${(v ? 'sim' : 'nao') === k ? 'selected' : ''}>${l}</option>`).join('');
const ENTIDADES = [
  ['pipelines', 'Pipelines'], ['stages', 'Etapas'], ['users', 'Usuários'],
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

const S = { tab: 'saude', saude: null, config: null, motivos: null, statusCont: null, usuarios: null, campos: null, filtro: '' };

async function load(tab) {
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

const VIEWS = { saude: viewSaude, config: viewConfig, explorar: viewExplorar, usuarios: viewUsuarios, conferencia: viewConferencia };

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
