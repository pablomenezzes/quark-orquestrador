/**
 * Menu único do Quark Dados. Cada página tem <header class="top" data-pagina="...">; este arquivo monta a marca e o menu
 * dentro dele (o que já estiver no header, como as etiquetas do Studio, fica depois do menu).
 * Ordem do menu: Início (última atualização dos dados), BI, Painel de Dados e, por último, Studio (testes).
 */
const ITENS = [
  ['inicio', 'Início', '/'],
  ['bi', 'BI', '/bi'],
  ['painel', 'Painel de Dados', '/painel'],
  ['studio', 'Studio (testes)', '/studio'],
];

const header = document.querySelector('header.top[data-pagina]');
if (header) {
  const atual = header.dataset.pagina;
  const nav = document.createElement('nav');
  nav.className = 'menu';
  nav.setAttribute('aria-label', 'Menu principal');
  for (const [id, rotulo, href] of ITENS) {
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
  const spacer = header.querySelector('.spacer');
  if (!spacer) {
    const s = document.createElement('span');
    s.className = 'spacer';
    nav.after(s);
  }
}
