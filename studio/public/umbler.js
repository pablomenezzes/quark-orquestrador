/**
 * Página Umbler: painel de custo e efetividade dos envios/fluxos e a Configuração do que é do Marketing.
 * Tudo vem de /api/umbler/* (o navegador nunca vê o token). Ausência aparece como "indisponível" com o motivo ao passar o mouse.
 */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = new Intl.NumberFormat('pt-BR');
const nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = (v) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v * 100) + '%';
const dmy = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—');
const dh = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR') : '—');
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Valor que pode faltar: {v, m}. Falta = "indisponível" com o motivo. */
const nd = (m) => `<span class="nd" tabindex="0" title="${esc(m || 'Dado indisponível.')}">indisponível</span>`;
const val = (x, f = nf.format) => (x == null || x.v == null ? nd(x?.m) : f(x.v));

const hoje = new Date();
const ler = (k) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } };
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } };

const S = {
  aba: 'painel',
  f: { de: iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), ate: iso(hoje), canal: '', tipo: '', modelo: '', sessao: '', escopo: 'marketing' },
  painel: null, cat: null, erro: '', carregando: false, ordem: { col: 'dia', dir: -1 }, sel: null, passos: null, passosBot: '',
};

async function api(rota, opt = {}) {
  const r = await fetch(`/api/umbler/${rota}`, { headers: { accept: 'application/json', ...(opt.body ? { 'content-type': 'application/json' } : {}) }, ...opt, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.detail || j.error || `Erro ${r.status}`); e.status = r.status; e.corpo = j; throw e; }
  return j;
}
const qs = (extra = {}) => {
  const p = new URLSearchParams({ de: S.f.de, ate: S.f.ate, escopo: S.f.escopo, ...extra });
  for (const k of ['canal', 'tipo', 'modelo', 'sessao']) if (S.f[k]) p.set(k, S.f[k]);
  return p.toString();
};

let seq = 0;
async function carregarPainel(fresh = false) {
  const mine = ++seq;
  S.carregando = true; S.erro = ''; desenhar();
  try {
    const p = await api(`painel?${qs(fresh ? { fresh: '1' } : {})}`);
    if (mine !== seq) return;
    S.painel = p;
    // na Vercel cada requisição tem tempo limitado: o servidor devolve o que deu e a tela pede o resto (o cache guarda o progresso)
    for (let i = 0; S.painel.pendentes > 0 && i < 40 && mine === seq; i++) {
      S.carregando = false; desenhar();
      const mais = await api(`painel?${qs()}`);
      if (mine !== seq) return;
      S.painel = mais;
    }
  } catch (e) {
    if (mine !== seq) return;
    S.painel = null; S.erro = e.corpo?.error === 'organizacao_pendente' ? 'org' : e.message; S.orgs = e.corpo?.organizacoes;
  }
  S.carregando = false; desenhar();
}
async function carregarConfig(fresh = false) {
  S.carregando = true; S.erro = ''; desenhar();
  try {
    S.cat = await api(`catalogo${fresh ? '?fresh=1' : ''}`);
  } catch (e) {
    if (e.corpo?.error === 'organizacao_pendente') { S.cat = null; S.erro = 'org'; S.orgs = e.corpo.organizacoes; }
    else {
      // sem a Umbler (token ausente, rota fora do ar) a configuração local ainda abre: preço, amostra e o que já estava fixado
      const cfg = await api('config').catch(() => null);
      const sec = (tipo) => ({ erro: e.message, itens: (cfg?.[tipo] ?? []).map((i) => ({ id: i.id, nome: i.nome, extra: 'não retornado agora pela API', fixado: i.fixado, alteradoEm: i.alteradoEm || null, presente: false })) });
      S.cat = cfg ? { organizacoes: [], organizacaoId: cfg.organizacaoId, canais: sec('canais'), bots: sec('bots'), setores: sec('setores'), etiquetas: sec('etiquetas'), config: cfg, geradoEm: Date.now() } : null;
      if (!cfg) S.erro = e.message;
    }
  }
  S.carregando = false; desenhar();
}

/* ---------- Painel ---------- */
function cartao(nome, valor, nota) {
  return `<div class="kpi"><div class="n">${esc(nome)}</div><div class="v">${valor}</div><div class="d">${nota}</div></div>`;
}
const xy = (c) => (c ? `em ${nf.format(c.x)} de ${nf.format(c.y)} sessões` : '');

function desenhaPainel() {
  const p = S.painel;
  if (!p) return '';
  const c = p.completude, k = p.cartoes;
  const filtrosOpc = (lista, atual, vazio) => `<option value="">${vazio}</option>` + lista.map(([v, t]) => `<option value="${esc(v)}"${v === atual ? ' selected' : ''}>${esc(t)}</option>`).join('');
  const canais = [...new Map(p.sessoes.filter((s) => s.canalId).map((s) => [s.canalId, s.canalNome || s.canalId])).entries()];
  const mods = [...new Map([...p.modelos.map((g) => [g.chave, `Template: ${g.nome}`]), ...p.fluxos.map((g) => [g.chave, `Fluxo: ${g.nome}`])]).entries()];
  const sess = p.sessoes.map((s) => [s.id, `${dmy(s.dia)} · ${s.titulo ?? s.id}`]);
  const barra = `
  <section class="card filtros" aria-label="Filtros">
    <label>De <input type="date" id="f-de" value="${S.f.de}"></label>
    <label>Até <input type="date" id="f-ate" value="${S.f.ate}"></label>
    <label>Canal <select id="f-canal">${filtrosOpc(canais, S.f.canal, 'Todos')}</select></label>
    <label>Tipo <select id="f-tipo">${filtrosOpc([['Template', 'Template'], ['Bot', 'Bot']], S.f.tipo, 'Todos')}</select></label>
    <label>Template ou fluxo <select id="f-modelo">${filtrosOpc(mods, S.f.modelo, 'Todos')}</select></label>
    <label>Sessão <select id="f-sessao">${filtrosOpc(sess, S.f.sessao, 'Todas')}</select></label>
    <label class="chk"><input type="checkbox" id="f-escopo"${S.f.escopo === 'marketing' ? ' checked' : ''}> Só o que está fixado como Marketing</label>
    <button class="btn" id="b-atualizar" title="Ignora o cache de 15 minutos e consulta a Umbler de novo">Atualizar agora</button>
    <a class="btn" id="b-csv" href="/api/umbler/csv?${qs()}">Exportar CSV</a>
  </section>`;
  const completude = `
  <div class="card comp" role="status">
    <span>Sessões no filtro: <b>${nf.format(c.sessoes.y)}</b></span>
    <span>custo disponível em <b>${nf.format(c.custo.x)}</b> de <b>${nf.format(c.custo.y)}</b></span>
    <span>R$ em <b>${nf.format(c.reais.x)}</b> de <b>${nf.format(c.reais.y)}</b></span>
    <span>respostas em <b>${nf.format(c.respondidas.x)}</b> de <b>${nf.format(c.respondidas.y)}</b></span>
    <span>lidas em <b>${nf.format(c.lidas.x)}</b> de <b>${nf.format(c.lidas.y)}</b></span>
    ${p.pendentes > 0 ? '<span><b>carregando o resto do período…</b></span>' : ''}<span class="muted">${nf.format(p.chamadas)} consulta(s) à Umbler agora · dados de ${dh(p.geradoEm)} (cache de 15 min)</span>
  </div>`;
  const cartoes = `<div class="kpis">
    ${cartao('Custo (créditos)', val(k.custoCreditos), xy(c.custo))}
    ${cartao('Custo (R$)', val(k.custoReais, brl.format), xy(c.reais))}
    ${cartao('Enviadas', val(k.enviadas), xy(c.enviadas))}
    ${cartao('Lidas', val(k.lidas), xy(c.lidas))}
    ${cartao('Respondidas', val(k.respondidas), xy(c.respondidas))}
    ${cartao('Falhas', val(k.falhas), xy(c.falhas))}
    ${cartao('Custo por resposta (R$)', val(k.cprReais, brl.format), k.cprReais.x != null ? `base: ${nf.format(k.cprReais.x)} de ${nf.format(k.cprReais.y)} sessões` : '')}
    ${cartao('Custo por resposta (créditos)', val(k.cprCreditos, nf2.format), k.cprCreditos.x != null ? `base: ${nf.format(k.cprCreditos.x)} de ${nf.format(k.cprCreditos.y)} sessões` : '')}
  </div>`;
  return barra + completude + (p.avisos.length ? `<div class="banner warn aviso"><ul>${p.avisos.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>` : '') + cartoes + funis(p) + serie(p) + tabela(p) + comparacao(p) + fluxos(p);
}

function barrasFunil(etapas, topo) {
  return etapas.map((e) => {
    const w = e.v != null && topo > 0 ? Math.max(1, (e.v / topo) * 100) : 0;
    const queda = e.queda != null ? `<small class="muted"> · queda de ${pct(e.queda)}</small>` : '';
    return `<div class="passo"><span>${esc(e.etapa)}</span><div>${e.v != null ? `<div class="fill" style="width:${w}%"></div>` : ''}</div><span class="n">${val(e)}${queda}</span></div>`;
  }).join('');
}
function funis(p) {
  const topo = Math.max(0, ...p.funil.map((e) => e.v ?? 0));
  const s = p.sessoes.find((x) => x.id === S.sel);
  let porSessao = '<p class="muted" style="font-size:12.5px">Clique numa linha da tabela abaixo para ver o funil só daquela sessão.</p>';
  if (s) {
    const e = [['Enviadas', s.enviadas, null], ['Lidas', s.lidas, s.enviadas], ['Respondidas', s.respondidas, s.lidas]].map(([etapa, x, ant]) => ({ etapa, v: x.v, m: x.m, queda: x.v != null && ant?.v > 0 ? 1 - x.v / ant.v : null }));
    porSessao = `<p style="margin:0 0 4px;font-size:13px"><b>${esc(s.titulo ?? s.id)}</b> · ${dmy(s.dia)}</p>${barrasFunil(e, Math.max(0, ...e.map((x) => x.v ?? 0)))}`;
  }
  return `<div class="secao"><h2>Funil</h2><span>enviadas, lidas e respondidas, com a queda entre passos</span></div>
  <div class="par"><div class="card2"><h3 style="font-size:14px">Total do filtro</h3>${barrasFunil(p.funil, topo)}</div><div class="card2"><h3 style="font-size:14px">Por sessão</h3>${porSessao}</div></div>`;
}

function serie(p) {
  if (!p.serie.length) return `<div class="secao"><h2>Por dia</h2></div><div class="card2 vazio">Sem sessões no período.</div>`;
  const W = 900, H = 200, pl = 44, pb = 28, pt = 10;
  const max = Math.max(1, ...p.serie.map((d) => Math.max(d.envios ?? 0, d.respostas ?? 0)));
  const bw = (W - pl) / p.serie.length;
  const y = (v) => pt + (H - pt - pb) * (1 - v / max);
  const barras = p.serie.map((d, i) => d.envios == null ? '' : `<rect x="${pl + i * bw + bw * 0.15}" y="${y(d.envios)}" width="${bw * 0.7}" height="${H - pb - y(d.envios)}" fill="var(--accent)" opacity=".75"><title>${dmy(d.dia)}: ${nf.format(d.envios)} envios · ${d.creditos != null ? nf.format(d.creditos) + ' créditos' : 'custo indisponível'}${d.reais != null ? ' · ' + brl.format(d.reais) : ''}</title></rect>`).join('');
  const pts = p.serie.map((d, i) => d.respostas == null ? null : `${pl + i * bw + bw / 2},${y(d.respostas)}`).filter(Boolean);
  const rot = p.serie.map((d, i) => (p.serie.length <= 16 || i % Math.ceil(p.serie.length / 16) === 0) ? `<text x="${pl + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${d.dia.slice(8)}/${d.dia.slice(5, 7)}</text>` : '').join('');
  const semResp = p.serie.every((d) => d.respostas == null);
  return `<div class="secao"><h2>Por dia</h2><span>envios (barras), respostas (linha) e custo (ao passar o mouse); o dia é o da criação da sessão de envio</span></div>
  <div class="card2"><svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Envios e respostas por dia">
    <g style="fill:var(--muted);font-size:11px"><text x="4" y="${pt + 8}">${nf.format(max)}</text><text x="4" y="${H - pb}">0</text>${rot}</g>
    <line x1="${pl}" x2="${W}" y1="${H - pb}" y2="${H - pb}" stroke="var(--border)"/>${barras}
    ${pts.length > 1 ? `<polyline fill="none" stroke="var(--warn)" stroke-width="2" points="${pts.join(' ')}"/>` : pts.map((q) => `<circle cx="${q.split(',')[0]}" cy="${q.split(',')[1]}" r="3" fill="var(--warn)"/>`).join('')}
  </svg>${semResp ? '<p class="muted" style="font-size:12px;margin:6px 0 0">Respostas por dia: ' + nd('A API só conta respostas de formulário (WhatsApp Flow); estes envios não têm contagem de respostas.') + '</p>' : ''}</div>`;
}

const COLS = [
  ['dia', 'Data'], ['titulo', 'Título'], ['tipo', 'Tipo'], ['alvo', 'Template / fluxo'], ['enviadas', 'Enviadas'], ['lidas', 'Lidas'], ['respondidas', 'Respondidas'], ['falhas', 'Falhas'],
  ['creditos', 'Créditos'], ['reais', 'R$'], ['cpr', 'Custo / resposta'], ['comp', 'Completude'],
];
const chaveOrdem = (s, c) => ({ alvo: s.tipo === 'Bot' ? s.botNome : s.modeloNome, cpr: s.cprReais, comp: { v: s.completude.campos } })[c] ?? s[c];
function tabela(p) {
  const { col, dir } = S.ordem;
  const lista = [...p.sessoes].sort((a, b) => {
    const x = chaveOrdem(a, col), y = chaveOrdem(b, col);
    const vx = x && typeof x === 'object' ? x.v : x, vy = y && typeof y === 'object' ? y.v : y;
    if (vx == null && vy == null) return 0;
    if (vx == null) return 1; // ausentes sempre no fim
    if (vy == null) return -1;
    return (typeof vx === 'number' ? vx - vy : String(vx).localeCompare(String(vy), 'pt-BR')) * dir;
  });
  const th = COLS.map(([c, t]) => `<th class="sc" data-col="${c}"${col === c ? ` aria-sort="${dir > 0 ? 'ascending' : 'descending'}"` : ''}>${t}${col === c ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
  const linhas = lista.map((s) => `<tr data-id="${esc(s.id)}"${s.id === S.sel ? ' class="sel"' : ''}>
    <td>${dmy(s.dia)}</td><td>${esc(s.titulo ?? '—')}<small>${esc(s.canalNome ?? '')}</small></td><td><span class="pill">${esc(s.tipo ?? '—')}</span></td>
    <td>${esc((s.tipo === 'Bot' ? s.botNome : s.modeloNome) ?? '—')}${s.tipo === 'Bot' && s.gatilho ? `<small>gatilho: ${esc(s.gatilho)}</small>` : ''}</td>
    <td class="num">${val(s.enviadas)}</td><td class="num">${val(s.lidas)}</td><td class="num">${val(s.respondidas)}</td><td class="num">${val(s.falhas)}</td>
    <td class="num">${val(s.creditos)}</td><td class="num">${val(s.reais, brl.format)}</td><td class="num">${val(s.cprReais, brl.format)}</td>
    <td class="num"><span class="pill ${s.completude.campos === s.completude.de ? 'bom' : 'atencao'}">${s.completude.campos} de ${s.completude.de}</span></td></tr>`).join('');
  return `<div class="secao"><h2>Sessões</h2><span>${nf.format(lista.length)} no filtro · clique no cabeçalho para ordenar</span></div>
  <div class="card2 tabela-wrap"><table class="t"><thead><tr>${th}</tr></thead><tbody>${linhas || '<tr><td colspan="12" class="vazio">Nenhuma sessão no filtro.</td></tr>'}</tbody></table></div>`;
}

function tabelaGrupos(titulo, grupos, minimo, rotulo) {
  if (!grupos.length) return `<div class="card2"><h3 style="font-size:14px">${titulo}</h3><p class="muted" style="font-size:13px">Nada para comparar no filtro.</p></div>`;
  const linhas = grupos.map((g) => `<tr><td>${g.posicao ?? '<span class="pill atencao" title="Abaixo da amostra mínima: não entra no ranking.">amostra pequena</span>'}</td><td>${esc(g.nome)}</td>
    <td class="num">${nf.format(g.sessoes)}</td><td class="num">${val(g.enviadas)}</td><td class="num">${val(g.taxaLeitura, pct)}</td><td class="num">${val(g.taxaResposta, pct)}</td><td class="num">${val(g.creditos)}</td><td class="num">${val(g.cprReais, brl.format)}</td></tr>`).join('');
  return `<div class="card2 tabela-wrap"><h3 style="font-size:14px">${titulo}</h3><p class="muted" style="font-size:12px;margin:2px 0 6px">Abaixo de ${nf.format(minimo)} envios aparece "amostra pequena" e não é ranqueado. ${rotulo}</p>
  <table class="t" style="min-width:700px"><thead><tr><th>#</th><th>Nome</th><th>Sessões</th><th>Enviadas (amostra)</th><th>Leitura</th><th>Resposta</th><th>Créditos</th><th>R$ / resposta</th></tr></thead><tbody>${linhas}</tbody></table></div>`;
}
function comparacao(p) {
  return `<div class="secao"><h2>Comparação</h2><span>entre templates e entre fluxos</span></div>${tabelaGrupos('Templates', p.modelos, p.amostraMinima, 'Ordenado pela taxa de resposta.')}${tabelaGrupos('Fluxos', p.fluxos, p.amostraMinima, 'Ordenado pela taxa de resposta (a API só conta respostas de formulário).')}`;
}

const MOTIVOS = { ReachedFlowEnd: 'Chegou ao fim do fluxo', MemberTookOver: 'Atendente assumiu', ChatClosed: 'Conversa encerrada', OtherBotTookOver: 'Outro fluxo assumiu', BotExpired: 'Fluxo expirou', FatalError: 'Erro no fluxo', ManuallyRequested: 'Parado manualmente', LoopInterrupted: 'Laço interrompido', BotNotFound: 'Fluxo não encontrado', BotFeatureDisabled: 'Recurso desligado', ContractPendency: 'Pendência de contrato', InconsistencyFound: 'Inconsistência' };
function fluxos(p) {
  let corpo;
  if (!p.paradas) {
    corpo = '<p class="muted" style="font-size:13px">Nenhuma sessão de fluxo (Bot) no filtro.</p>';
  } else {
    const tot = p.paradas.itens.reduce((a, b) => a + b.n, 0);
    corpo = `<p class="muted" style="font-size:12.5px;margin:0 0 6px">Como terminaram os contatos dos fluxos (motivo de parada informado pela Umbler), em ${nf.format(p.paradas.sessoesComDado)} de ${nf.format(p.paradas.sessoesDeBot)} sessões de fluxo.</p>` +
      (p.paradas.itens.length ? barrasFunil(p.paradas.itens.map((i) => ({ etapa: MOTIVOS[i.motivo] ?? i.motivo, v: i.n, m: null, queda: null })), Math.max(...p.paradas.itens.map((i) => i.n))) + `<p class="muted" style="font-size:12px">Total: ${nf.format(tot)} contatos com motivo registrado.</p>` : `<p>${nd('A API não informou motivos de parada para estas sessões.')}</p>`);
  }
  const bots = (S.cat?.bots?.itens ?? []).filter((b) => b.fixado);
  const passos = S.passos;
  const passosHtml = passos ? `<p class="muted" style="font-size:12.5px">Instâncias lidas: <b>${nf.format(passos.lidas)}</b>${passos.total != null ? ` de <b>${nf.format(passos.total)}</b>` : ''}${passos.completo ? '' : ' (leitura parcial: limite de páginas)'}. Último passo registrado de cada contato:</p>` +
    (passos.porPasso.length ? `<table class="t" style="min-width:0"><thead><tr><th>Passo (ID)</th><th>Contatos</th></tr></thead><tbody>${passos.porPasso.slice(0, 20).map((x) => `<tr><td class="mono">${esc(x.passo)}</td><td class="num">${nf.format(x.n)}</td></tr>`).join('')}</tbody></table>` : '<p>Nenhuma instância no período.</p>') : '';
  return `<div class="secao"><h2>Fluxos: onde os contatos páram</h2><span>e o que acontece depois da resposta</span></div>
  <div class="card2">${corpo}
    <hr style="border:0;border-top:1px solid var(--border);margin:12px 0">
    <h3 style="font-size:14px">Passo do fluxo</h3>
    <p class="muted" style="font-size:12.5px;margin:2px 0 8px">A API expõe o caminho de cada contato dentro do fluxo (por ID do passo, sem o nome). Para escolher o fluxo, ele precisa estar fixado em Configuração. A leitura percorre as instâncias (até 500) e guarda só contagens.</p>
    <div class="form"><label>Fluxo<select id="p-bot"><option value="">Escolha…</option>${bots.map((b) => `<option value="${esc(b.id)}"${b.id === S.passosBot ? ' selected' : ''}>${esc(b.nome)}</option>`).join('')}</select></label><button class="btn" id="p-ir">Ver passos</button></div>
    ${passosHtml}
    <hr style="border:0;border-top:1px solid var(--border);margin:12px 0">
    <h3 style="font-size:14px">Depois da resposta</h3>
    <p class="muted" style="font-size:13px;margin:4px 0 0">Não exposto pela API como número agregado. O que a Umbler devolve sobre o que o contato disse ou fez depois são as conversas individuais (mensagens, nome e telefone), e este painel não lê nem guarda dados pessoais. Por isso não há estimativa aqui.</p>
  </div>`;
}

/* ---------- Configuração ---------- */
function desenhaConfig() {
  const c = S.cat;
  if (!c) return '';
  const cfg = c.config;
  const secao = (tipo, titulo, ajuda, sec) => `<div class="secao"><h2>${titulo}</h2><span>${ajuda}</span></div><div class="card2">
    ${sec.erro ? `<div class="banner warn aviso">A rota falhou: ${esc(sec.erro)}</div>` : ''}
    ${sec.itens.length ? sec.itens.map((i) => `<div class="lista-item" data-tipo="${tipo}" data-id="${esc(i.id)}" data-nome="${esc(i.nome)}" data-salvo="${i.fixado ? 1 : 0}">
      <label class="nome"><input type="checkbox" class="m-chk"${i.fixado ? ' checked' : ''}> <b>${esc(i.nome)}</b> <small>${esc(i.extra ?? '')} · ID ${esc(i.id)}${i.alteradoEm ? ` · alterado em ${dh(i.alteradoEm)}` : ''}</small></label>
      <span class="pill ${i.fixado ? 'bom' : ''}">${i.fixado ? 'Fixado como Marketing' : 'Não fixado'}</span>
      <button class="btn small m-fixar" disabled>Fixar</button></div>`).join('') : '<p class="muted" style="margin:0">Nenhum item retornado pela API.</p>'}</div>`;
  const orgs = c.organizacoes.length > 1 ? `<div class="card2"><b>Organização da Umbler</b> <div class="form"><label>Usar<select id="c-org"><option value="">Escolha…</option>${c.organizacoes.map((o) => `<option value="${esc(o.id)}"${o.id === c.organizacaoId ? ' selected' : ''}>${esc(o.nome)}</option>`).join('')}</select></label><button class="btn" id="c-org-ok">Salvar</button></div></div>` : '';
  const precos = cfg.precoCredito.length ? cfg.precoCredito.map((e) => `<div class="lista-item"><span class="nome">A partir de <b>${dmy(e.desde)}</b></span><b>R$ ${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 6 }).format(e.preco)}</b> <small class="muted">por crédito</small></div>`).join('') : '<p class="muted" style="margin:0">Nenhum preço cadastrado: o custo aparece só em créditos.</p>';
  return `${orgs}
  <div class="card2"><b>Como o painel decide o que é do Marketing</b>
    <p style="margin:6px 0 0;font-size:13px">Uma sessão de envio é do Marketing se o <b>canal</b> está fixado. Se houver <b>bots fixados</b> e a sessão for de bot, o bot também precisa estar fixado. Sem bots fixados, valem todos os bots dos canais fixados. Marque a caixa e clique em <b>Fixar</b> para gravar (a data da alteração fica salva em <span class="mono">studio/config/umbler-marketing.json</span>). Setores e etiquetas são registrados, mas a sessão de envio não traz setor nem etiqueta, então <b>não entram na regra</b>. Conversas individuais não são listadas: têm dados pessoais, e a unidade deste painel é a sessão de envio.</p></div>
  ${secao('canais', 'Canais (números)', 'obrigatório para o painel mostrar algo', c.canais)}
  ${secao('bots', 'Bots (fluxos)', 'opcional: restringe os bots dos canais fixados', c.bots)}
  ${secao('setores', 'Setores', 'só registro', c.setores)}
  ${secao('etiquetas', 'Etiquetas', 'só registro', c.etiquetas)}
  <div class="secao"><h2>Preço do crédito</h2><span>só se acrescenta; o custo usa o preço vigente na data da sessão</span></div>
  <div class="card2">${precos}<div class="form"><label>Vale a partir de<input type="date" id="c-pdesde"></label><label>Preço (R$ por crédito)<input type="text" inputmode="decimal" id="c-ppreco" placeholder="ex.: 0,0001" style="width:120px"></label><button class="btn primary" id="c-padd">Acrescentar</button></div>
  <p class="muted" style="font-size:12px;margin:8px 0 0"><b>Atenção à unidade:</b> a Umbler devolve o custo como número inteiro de créditos (nos testes, um template custou 3.900 créditos), então o preço é de <i>um</i> crédito e costuma ser fração de centavo. Confira comparando um envio com a tela da Umbler. Uma entrada não pode ser editada nem ter data anterior à última. Para mudar o preço, acrescente uma nova a partir da data em que ele passou a valer.</p></div>
  <div class="secao"><h2>Amostra mínima</h2><span>abaixo disso, "amostra pequena" e fora do ranking</span></div>
  <div class="card2"><div class="form"><label>Envios<input type="number" min="1" id="c-amostra" value="${cfg.amostraMinima}" style="width:120px"></label><button class="btn" id="c-aok">Salvar</button></div></div>
  <p class="muted" style="font-size:12px">Configuração guardada ${cfg.origem === 'banco' ? 'no Supabase (a mesma no Studio local e na Vercel)' : 'no arquivo local'}. Só o admin consegue alterar na versão publicada. Atualizado em ${dh(c.geradoEm)} (cache de 15 min). <button class="btn small" id="c-refresh">Atualizar agora</button></p>`;
}

/* ---------- geral ---------- */
function desenhar() {
  $('#abas').querySelectorAll('.aba').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.aba === S.aba)));
  const av = $('#avisos'), main = $('#conteudo');
  av.innerHTML = S.estado && !S.estado.ok ? `<div class="banner warn" role="alert">${esc(S.estado.motivo)} A aba Configuração (preço e amostra) funciona; os dados da Umbler, não.</div>` : '';
  if (S.carregando) { main.innerHTML = '<div class="card2 vazio" role="status">Consultando a Umbler… (uma requisição por vez, respeitando o limite da API)</div>'; return; }
  if (S.erro === 'org') {
    main.innerHTML = `<div class="banner warn">A conta tem mais de uma organização na Umbler. Escolha qual usar:</div><div class="card2"><div class="form"><label>Organização<select id="c-org">${(S.orgs ?? []).map((o) => `<option value="${esc(o.id)}">${esc(o.nome)}</option>`).join('')}</select></label><button class="btn primary" id="c-org-ok">Usar esta</button></div></div>`;
    return;
  }
  if (S.erro) { av.innerHTML += `<div class="banner danger" role="alert">${esc(S.erro)}</div>`; main.innerHTML = ''; return; }
  main.innerHTML = S.aba === 'painel' ? desenhaPainel() : desenhaConfig();
}

document.addEventListener('click', async (ev) => {
  const t = ev.target;
  if (!(t instanceof Element)) return;
  const aba = t.closest('.aba');
  if (aba) { S.aba = aba.dataset.aba; S.erro = ''; if (S.aba === 'painel') { if (!S.painel) await carregarPainel(); else desenhar(); if (!S.cat) carregarCatSilencioso(); } else await carregarConfig(); return; }
  if (t.id === 'b-atualizar') return void carregarPainel(true);
  if (t.id === 'c-refresh') return void carregarConfig(true);
  const th = t.closest('th.sc');
  if (th) { const c = th.dataset.col; S.ordem = { col: c, dir: S.ordem.col === c ? -S.ordem.dir : (c === 'dia' || c === 'titulo' || c === 'tipo' || c === 'alvo' ? 1 : -1) }; return desenhar(); }
  const tr = t.closest('table.t tbody tr[data-id]');
  if (tr) { S.sel = S.sel === tr.dataset.id ? null : tr.dataset.id; return desenhar(); }
  if (t.id === 'p-ir') {
    const bot = $('#p-bot').value; if (!bot) return;
    S.passosBot = bot; t.disabled = true; t.textContent = 'Lendo…';
    try { S.passos = await api(`passos?bot=${encodeURIComponent(bot)}&de=${S.f.de}&ate=${S.f.ate}`); } catch (e) { S.passos = null; alert(e.message); }
    return desenhar();
  }
  if (t.classList.contains('m-fixar')) {
    const li = t.closest('.lista-item');
    t.disabled = true;
    try { await api('config/fixar', { method: 'PUT', body: { tipo: li.dataset.tipo, id: li.dataset.id, nome: li.dataset.nome, fixado: li.querySelector('.m-chk').checked } }); S.painel = null; await carregarConfig(); } catch (e) { alert(e.message); t.disabled = false; }
    return;
  }
  if (t.id === 'c-padd') {
    const preco = Number(String($('#c-ppreco').value).replace(/\./g, '').replace(',', '.'));
    try { await api('config/preco', { method: 'POST', body: { desde: $('#c-pdesde').value, preco } }); S.painel = null; await carregarConfig(); } catch (e) { alert(e.message); }
    return;
  }
  if (t.id === 'c-aok') { try { await api('config/amostra', { method: 'PUT', body: { valor: Number($('#c-amostra').value) } }); S.painel = null; await carregarConfig(); } catch (e) { alert(e.message); } return; }
  if (t.id === 'c-org-ok') { const id = $('#c-org').value; if (!id) return; try { await api('config/organizacao', { method: 'PUT', body: { id } }); S.painel = null; S.erro = ''; S.aba === 'painel' ? await carregarPainel() : await carregarConfig(); } catch (e) { alert(e.message); } }
});
document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (!(t instanceof Element)) return;
  if (t.classList.contains('m-chk')) { const li = t.closest('.lista-item'); li.querySelector('.m-fixar').disabled = (t.checked ? 1 : 0) === Number(li.dataset.salvo); return; }
  const mapa = { 'f-de': 'de', 'f-ate': 'ate', 'f-canal': 'canal', 'f-tipo': 'tipo', 'f-modelo': 'modelo', 'f-sessao': 'sessao' };
  if (mapa[t.id]) {
    S.f[mapa[t.id]] = t.value;
    if (t.id !== 'f-sessao') S.f.sessao = ''; // escolher outro filtro solta a sessão específica
    guardar('umbler.f', S.f);
    return void carregarPainel();
  }
  if (t.id === 'f-escopo') { S.f.escopo = t.checked ? 'marketing' : 'tudo'; guardar('umbler.f', S.f); carregarPainel(); }
});

async function carregarCatSilencioso() { try { S.cat = await api('catalogo'); if (S.aba === 'painel') desenhar(); } catch { /* o painel já mostra o seu próprio erro */ } }

const salvo = ler('umbler.f');
if (salvo && typeof salvo === 'object') for (const k of ['canal', 'tipo', 'modelo', 'escopo']) if (typeof salvo[k] === 'string') S.f[k] = salvo[k];
(async () => {
  const st = await api('estado').catch(() => null);
  S.estado = st;
  await carregarPainel();
  carregarCatSilencioso();
})();
