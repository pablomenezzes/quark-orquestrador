/* Gerência de usuários (só admin): criar, mudar o papel, redefinir a senha, bloquear e remover. Tudo passa por /api/usuarios. */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let EU = null;
let USUARIOS = [];

async function api(path, init) {
  const r = await fetch(path, init && { ...init, headers: { 'content-type': 'application/json' } });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.detail || corpo.error || `erro ${r.status}`);
  return corpo;
}
const aviso = (t, erro) => { const m = $('#msg'); m.textContent = t; m.className = erro ? 'erro' : ''; };
const quando = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca');

function desenhar() {
  $('#lista').innerHTML = USUARIOS.map((u) => {
    const eu = u.id === EU.id;
    const situ = u.papel == null ? '<span class="chip danger">Sem papel (sem acesso)</span>' : u.bloqueado ? '<span class="chip danger">Bloqueado</span>' : '<span class="chip">Ativo</span>';
    return `<tr data-id="${esc(u.id)}"><td>${esc(u.nome || '—')}${eu ? ' <span class="muted">(você)</span>' : ''}</td><td>${esc(u.email)}</td>
      <td><select class="field-input" data-acao="papel" ${eu ? 'disabled' : ''} aria-label="Papel de ${esc(u.email)}"><option value="editor" ${u.papel === 'editor' ? 'selected' : ''}>Editor</option><option value="admin" ${u.papel === 'admin' ? 'selected' : ''}>Admin</option>${u.papel == null ? '<option value="" selected>—</option>' : ''}</select></td>
      <td>${situ}</td><td>${esc(quando(u.ultimoLogin))}</td>
      <td><div class="acoes"><button class="btn" data-acao="senha">Redefinir senha</button>${eu ? '' : `<button class="btn" data-acao="bloquear">${u.bloqueado ? 'Desbloquear' : 'Bloquear'}</button><button class="btn danger" data-acao="remover">Remover</button>`}</div></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="muted">Nenhum usuário.</td></tr>';
}
async function carregar() {
  try { USUARIOS = await api('/api/usuarios'); desenhar(); } catch (e) { aviso(e.message, true); }
}
async function mudar(id, corpo, ok) {
  try { await api(`/api/usuarios/${id}`, { method: 'PUT', body: JSON.stringify(corpo) }); aviso(ok, false); } catch (e) { aviso(e.message, true); }
  await carregar();
}

$('#novo').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#n-ok').disabled = true;
  try {
    const u = await api('/api/usuarios', { method: 'POST', body: JSON.stringify({ nome: $('#n-nome').value, email: $('#n-email').value, papel: $('#n-papel').value, senha: $('#n-senha').value }) });
    aviso(`Usuário ${u.email} criado. Passe a senha provisória a ele por um canal privado.`, false);
    $('#novo').reset();
    await carregar();
  } catch (e) { aviso(e.message, true); } finally { $('#n-ok').disabled = false; }
});
$('#lista').addEventListener('change', (ev) => {
  const s = ev.target.closest('[data-acao="papel"]');
  if (s && s.value) mudar(s.closest('[data-id]').dataset.id, { papel: s.value }, 'Papel atualizado.');
});
$('#lista').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-acao]');
  if (!b) return;
  const id = b.closest('[data-id]').dataset.id;
  const u = USUARIOS.find((x) => x.id === id);
  if (b.dataset.acao === 'senha') {
    const nova = prompt(`Nova senha provisória para ${u.email} (mín. 10, letras e números):`);
    if (nova) mudar(id, { senha: nova }, 'Senha redefinida. Passe a nova senha a ele por um canal privado.');
  } else if (b.dataset.acao === 'bloquear') {
    mudar(id, { bloqueado: !u.bloqueado }, u.bloqueado ? 'Usuário desbloqueado.' : 'Usuário bloqueado: perde o acesso em até 5 minutos.');
  } else if (b.dataset.acao === 'remover') {
    if (!confirm(`Remover ${u.email}? Isso não pode ser desfeito.`)) return;
    try { await api(`/api/usuarios/${id}`, { method: 'DELETE' }); aviso('Usuário removido.', false); } catch (e) { aviso(e.message, true); }
    await carregar();
  }
});

EU = await api('/api/me');
carregar();
