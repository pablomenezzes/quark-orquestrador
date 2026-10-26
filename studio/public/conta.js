/* Troca da própria senha: confere a atual no servidor e grava a nova no Supabase Auth. */
const $ = (s) => document.querySelector(s);
const msg = (t, erro) => { $('#msg').textContent = t; $('#msg').className = erro ? 'erro' : ''; };
const eu = await fetch('/api/me').then((r) => r.json()).catch(() => ({}));
$('#quem').textContent = eu.email ? `${eu.nome ? `${eu.nome} · ` : ''}${eu.email} · ${eu.papel === 'admin' ? 'Admin' : 'Editor'}` : '';
$('#f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if ($('#nova').value !== $('#rep').value) return msg('As duas senhas novas não são iguais.', true);
  $('#ok').disabled = true;
  try {
    const r = await fetch('/api/senha', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ atual: $('#atual').value, nova: $('#nova').value }) });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(corpo.detail || 'Não foi possível trocar a senha.');
    $('#f').reset();
    msg('Senha trocada.', false);
  } catch (e) { msg(e.message, true); } finally { $('#ok').disabled = false; }
});
