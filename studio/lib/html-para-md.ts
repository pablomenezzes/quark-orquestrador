/**
 * HTML do editor de documentação -> Markdown (para o ClickUp) e texto simples (para a planilha). Sem DOM: o servidor roda em função serverless.
 * Cobre o que o editor produz: títulos, parágrafos, negrito, itálico, links, listas, citações, tabelas, KPIs e barras do relatório. Os gráficos (SVG) viram uma
 * linha "[gráfico: ...]" com o título dele, porque o ClickUp não aceita SVG; as tabelas do relatório trazem os mesmos números.
 */
const ENTIDADES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&times;': '×', '&divide;': '÷' };
const decodifica = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp|times|divide);/g, (m) => ENTIDADES[m] ?? m).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const atributo = (attrs: string, nome: string): string | null => new RegExp(`${nome}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)?.[1] ?? new RegExp(`${nome}\\s*=\\s*'([^']*)'`, 'i').exec(attrs)?.[1] ?? null;
const celula = (s: string) => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

export function htmlParaMarkdown(html: string): string {
  // gráficos: o SVG inteiro vira uma linha com o título que ele traz em aria-label
  // \u0001 marca quebra de linha INSERIDA por nós (o espaço em branco do HTML comum é colapsado; este não)
  let h = html.replace(/<svg\b([^>]*)>[\s\S]*?<\/svg>/gi, (_, a) => `\u0001\u0001_[gráfico: ${decodifica(atributo(a, 'aria-label') ?? 'sem título')}]_\u0001\u0001`);
  h = h.replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, '');
  // tabelas: linha a linha, a primeira vira cabeçalho
  h = h.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, corpo: string) => {
    const linhas = [...corpo.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => [...m[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => celula(decodifica(c[1]!.replace(/<[^>]+>/g, ' ')))));
    if (!linhas.length) return '';
    const largura = Math.max(...linhas.map((l) => l.length));
    const pad = (l: string[]) => `| ${[...l, ...Array(largura - l.length).fill('')].join(' | ')} |`;
    return `\u0001\u0001${[pad(linhas[0]!), `| ${Array(largura).fill('---').join(' | ')} |`, ...linhas.slice(1).map(pad)].join('\u0001')}\u0001\u0001`;
  });

  const out: string[] = [];
  const listas: Array<{ ordenada: boolean; n: number }> = [];
  const hrefs: Array<string | null> = [];
  let citacao = 0;
  const emite = (s: string) => out.push(s);
  for (const m of h.matchAll(/<(\/?)([a-z0-9]+)\b([^>]*)>|([^<]+)/gi)) {
    if (m[4] !== undefined) { emite(decodifica(m[4]).replace(/\s+/g, ' ')); continue; }
    const fecha = m[1] === '/', tag = m[2]!.toLowerCase(), attrs = m[3] ?? '';
    if (/^h[1-6]$/.test(tag)) emite(fecha ? '\n\n' : `\n\n${'#'.repeat(Math.min(3, Number(tag[1])))} `);
    else if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'figure' || tag === 'article') emite('\n\n');
    else if (tag === 'br') emite('\n');
    else if (tag === 'strong' || tag === 'b') emite('**');
    else if (tag === 'em' || tag === 'i') emite('_');
    else if (tag === 'blockquote') { citacao += fecha ? -1 : 1; emite(fecha ? '\n\n' : '\n\n> '); }
    else if (tag === 'ul' || tag === 'ol') { if (fecha) listas.pop(); else listas.push({ ordenada: tag === 'ol', n: 0 }); emite('\n'); }
    else if (tag === 'li') { if (!fecha) { const l = listas[listas.length - 1]; if (l) l.n++; emite(`\n${'  '.repeat(Math.max(0, listas.length - 1))}${l?.ordenada ? `${l.n}. ` : '- '}`); } }
    else if (tag === 'a') { if (!fecha) { hrefs.push(atributo(attrs, 'href')); emite('['); } else { const href = hrefs.pop(); emite(href && /^(https?:|mailto:)/i.test(href) ? `](${href})` : ']'); } }
    else if (tag === 'tr' || tag === 'span' || tag === 'small') { if (fecha && tag !== 'tr') emite(' '); }
  }
  void citacao;
  return out.join('').replace(/\u0001/g, '\n')
    .replace(/\[\s*\]\([^)]*\)/g, '')            // links vazios
    .replace(/\*\*\s*\*\*/g, '')                  // negrito vazio
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Texto simples (sem marcação) do mesmo HTML, para colocar numa célula da planilha. */
export function htmlParaTexto(html: string): string {
  return htmlParaMarkdown(html).replace(/^#{1,3} /gm, '').replace(/\*\*/g, '').replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2').replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)').replace(/^\| ---.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
