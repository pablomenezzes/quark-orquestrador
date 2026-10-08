const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ALERTA_HORAS = 8; // o mesmo limite do Painel de Dados
const PARTES = [
  ['deals', 'Negócios'], ['deals_archived', 'Negócios arquivados'], ['deals_deleted', 'Negócios excluídos'], ['deal_history', 'Histórico de etapas'],
  ['pipelines', 'Pipelines'], ['stages', 'Etapas'], ['users', 'Usuários'], ['deal_fields', 'Campos de negócios'],
];
const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const quando = (v) => (v ? fmt.format(new Date(v)).replace(',', '') : '—');
function haQuanto(v) {
  if (!v) return 'nunca';
  const m = Math.max(0, Math.round((Date.now() - new Date(v).getTime()) / 60000));
  if (m < 1) return 'agora há pouco';
  if (m < 60) return `há ${m} min`;
  if (m < 60 * 48) return `há ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
  return `há ${Math.round(m / 1440)} dias`;
}

async function carregar() {
  let s;
  try {
    const res = await fetch('/api/painel/saude', { headers: { accept: 'application/json' } });
    s = await res.json();
    if (!res.ok) throw Object.assign(new Error(s.detail || s.error), { status: res.status });
  } catch (e) {
    $('#hero').innerHTML = `<div class="rot">Última atualização dos dados</div><div class="hora">—</div>`;
    $('#aviso').innerHTML = `<div class="banner ${e.status === 503 ? 'warn' : 'danger'}" style="margin-bottom:12px">${e.status === 503 ? '<strong>A conexão com o banco ainda não está ligada.</strong> ' : 'Não consegui carregar: '}${esc(e.message)}</div>`;
    return;
  }
  const por = new Map(s.entidades.map((e) => [e.entity, e]));
  const negocios = por.get('deals');
  const horasDesde = (v) => (v ? (Date.now() - new Date(v).getTime()) / 3600000 : Infinity);
  const atrasado = horasDesde(negocios?.ultimo_sucesso_em) > ALERTA_HORAS;

  $('#hero').innerHTML = `
    <div class="rot">Última atualização dos dados (Negócios do Pipedrive)</div>
    <div class="hora">${esc(quando(negocios?.ultimo_sucesso_em))}</div>
    <div class="ha">${esc(haQuanto(negocios?.ultimo_sucesso_em))}</div>
    <div class="estado">${!negocios ? '<span class="chip">nunca atualizado</span>' : atrasado ? `<span class="chip danger">atrasado: mais de ${ALERTA_HORAS} horas sem atualizar</span>` : '<span class="chip ok">em dia</span>'}</div>`;

  const alertas = [];
  const automatica = s.jobs.some((j) => j.origem === 'agendada');
  if (!automatica) alertas.push('A atualização automática a cada 4 horas <strong>ainda não está ligada</strong>: hoje os dados só mudam quando a sincronização é rodada à mão. Ela é a próxima etapa do Data Hub.');
  const parciais = s.entidades.filter((e) => e.ultimo_status && e.ultimo_status !== 'ok');
  if (parciais.length) alertas.push(`Atenção: a última rodada de ${esc(parciais.map((e) => (PARTES.find(([k]) => k === e.entity) ?? [0, e.entity])[1]).join(', '))} não terminou 100% (parcial ou com erro). Veja os detalhes em <a href="/painel">Painel de Dados › Saúde da sincronização</a>.`);
  const uso = s.uso?.[0];
  $('#alertas').innerHTML = alertas.map((a) => `<div class="banner warn" style="margin-bottom:10px">${a}</div>`).join('') +
    (uso ? `<p class="muted" style="margin:0 0 6px;font-size:13px">Cota do Pipedrive usada por esta sincronização no último dia com atividade (${esc(String(uso.dia).slice(0, 10).split('-').reverse().join('/'))}): ${Number(uso.tokens_gastos).toLocaleString('pt-BR')} unidades.</p>` : '');

  $('#partes').innerHTML = PARTES.map(([k, rot]) => {
    const e = por.get(k);
    let chip = '<span class="chip">nunca atualizada</span>';
    if (e) chip = horasDesde(e.ultimo_sucesso_em) > ALERTA_HORAS ? '<span class="chip warn">desatualizada</span>' : e.ultimo_status === 'ok' ? '<span class="chip ok">ok</span>' : `<span class="chip warn">${esc(e.ultimo_status ?? '—')}</span>`;
    return `<tr><td>${esc(rot)}</td><td>${chip}</td><td>${esc(quando(e?.ultimo_sucesso_em))}</td><td class="muted">${esc(haQuanto(e?.ultimo_sucesso_em))}</td></tr>`;
  }).join('');

  $('#atalhos').innerHTML = [
    ['/bi', 'BI', 'Visão geral, Safra, Canais e Qualidade, com filtros de data, fonte e tipo do lead'],
    ['/painel', 'Painel de Dados', 'Saúde da sincronização, configuração, negócios e conferência'],
    ['/studio', 'Studio (testes)', 'Formulários de teste do orquestrador (ambiente de testes)'],
  ].map(([h, t, d]) => `<a class="atalho" href="${h}"><b>${esc(t)}</b><span>${esc(d)}</span></a>`).join('');
}
carregar();
