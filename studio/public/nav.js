/**
 * Menu único do Quark Dados. Cada página tem <header class="top" data-pagina="...">; este arquivo monta a marca e o menu
 * dentro dele (o que já estiver no header, como as etiquetas do Studio, fica depois do menu).
 * Ordem do menu: Início (última atualização dos dados), Monitor, Experimentos, BI, SEO, Painel de Dados e, por último, Studio (testes).
 * Publicado (com login): sem o Studio de testes, com "Usuários" para o admin e, à direita, o nome, "Minha conta" e "Sair".
 */
const ITENS = [
  ['inicio', 'Início', '/'],
  ['monitor', 'Monitor', '/monitor'],
  ['experimentos', 'Experimentos', '/experimentos'],
  ['bi', 'BI', '/bi'],
  ['seo', 'SEO', '/seo'],
  ['umbler', 'Umbler', '/umbler'],
  ['painel', 'Painel de Dados', '/painel'],
  ['studio', 'Studio (testes)', '/studio'],
];

const header = document.querySelector('header.top[data-pagina]');
if (header) {
  const atual = header.dataset.pagina;
  const eu = await fetch('/api/me').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const publico = eu.publico === true;
  const itens = ITENS.filter(([id]) => !(publico && id === 'studio')).concat(publico && eu.papel === 'admin' ? [['usuarios', 'Usuários', '/usuarios']] : []);
  const nav = document.createElement('nav');
  nav.className = 'menu';
  nav.setAttribute('aria-label', 'Menu principal');
  for (const [id, rotulo, href] of itens) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = rotulo;
    if (id === 'studio') a.className = 'teste';
    if (id === atual) a.setAttribute('aria-current', 'page');
    nav.append(a);
  }
  const marca = document.createElement('span');
  marca.className = 'marca';
  marca.textContent = 'Quark Dados';
  header.prepend(marca, nav);
  let spacer = header.querySelector('.spacer');
  if (!spacer) {
    spacer = document.createElement('span');
    spacer.className = 'spacer';
    nav.after(spacer);
  }
  if (publico) {
    const conta = document.createElement('nav');
    conta.className = 'menu';
    conta.setAttribute('aria-label', 'Conta');
    const c = document.createElement('a');
    c.href = '/conta';
    c.textContent = eu.nome || eu.email;
    if (atual === 'conta') c.setAttribute('aria-current', 'page');
    const sair = document.createElement('a');
    sair.href = '/login';
    sair.textContent = 'Sair';
    sair.addEventListener('click', async (ev) => {
      ev.preventDefault();
      await fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
      location.assign('/login');
    });
    conta.append(c, sair);
    spacer.after(conta);
  }
}
