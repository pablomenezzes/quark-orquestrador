/* Tela de entrada: envia e-mail e senha para /api/login e volta para a página que a pessoa queria abrir. */
const $ = (s) => document.querySelector(s);
/** Só volta para um caminho do próprio site (nunca para outro endereço) e nunca para a própria tela de login. */
const volta = () => {
  const v = new URLSearchParams(location.search).get('voltar') || '/';
  return /^\/(?![/\\])/.test(v) && !v.startsWith('/login') ? v : '/';
};
$('#f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const erro = $('#erro');
  erro.hidden = true;
  $('#ok').disabled = true;
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('#email').value, senha: $('#senha').value }) });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(corpo.detail || 'Não foi possível entrar. Tente de novo.');
    location.assign(volta());
  } catch (e) {
    erro.textContent = e.message;
    erro.hidden = false;
    $('#ok').disabled = false;
    $('#senha').select();
  }
});
