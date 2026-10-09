import type { BiFiltros, BiOpcao, BiProduto, BiResultado } from '../../studio/lib/bi.js';

/**
 * Lógica pura do conector do Claude Desktop (servidor MCP "quark-dados"): sem rede, sem banco. Testada em tests/mcp-quark-dados.test.ts.
 * A segurança de verdade está no banco (o papel orq_chat só lê visões sem dados pessoais); o que está aqui é a segunda trava e a conversa.
 */

export const LIMITE_LINHAS = 200;
export const LIMITE_SQL = 4000;

/** Palavras que nunca deveriam aparecer numa consulta de leitura. Conferência extra: o banco já recusa qualquer escrita. */
const PROIBIDAS = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|execute|vacuum|analyze|set|reset|listen|notify|comment|refresh|lock|merge|prepare|declare|fetch|pg_sleep|pg_read_file|pg_ls_dir|dblink|lo_import|lo_export|set_config|current_setting|pg_terminate_backend|pg_cancel_backend)\b/i;

export class SqlRecusado extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = 'SqlRecusado';
  }
}

/** Valida uma consulta de leitura e a embrulha com limite de linhas. Aceita uma única instrução SELECT/WITH. */
export function guardaSql(sql: string, limite = LIMITE_LINHAS): string {
  const s = String(sql ?? '').trim().replace(/;+\s*$/, '');
  if (!s) throw new SqlRecusado('Consulta vazia.');
  if (s.length > LIMITE_SQL) throw new SqlRecusado(`Consulta longa demais (máximo ${LIMITE_SQL} caracteres).`);
  if (s.includes(';')) throw new SqlRecusado('Só uma instrução por vez (sem ponto e vírgula no meio).');
  if (/--|\/\*/.test(s)) throw new SqlRecusado('Comentários SQL não são aceitos.');
  if (!/^(select|with)\b/i.test(s)) throw new SqlRecusado('Só consultas de leitura que começam com SELECT ou WITH.');
  const p = PROIBIDAS.exec(s);
  if (p) throw new SqlRecusado(`A palavra "${p[1]}" não é permitida (este acesso é somente leitura).`);
  const n = Math.max(1, Math.min(Math.floor(limite), LIMITE_LINHAS));
  return `select * from (${s}) as consulta limit ${n}`;
}

const norm = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Casa nomes ("google", "Meta Ads", "orgânico") ou IDs com as opções do Pipedrive. "todas" = sem filtro. */
export function resolverOpcoes(pedido: string[] | undefined, opcoes: BiOpcao[], rotulo: string): { ids: string[] | undefined; texto: string } {
  if (!pedido || pedido.length === 0) {
    const padrao = opcoes.filter((o) => o.padrao);
    return { ids: padrao.map((o) => o.id), texto: `${rotulo}: ${padrao.map((o) => o.nome).join(', ') || 'todas'} (seleção fixa do BI)` };
  }
  if (pedido.some((p) => norm(p) === 'todas' || norm(p) === 'todos')) return { ids: undefined, texto: `${rotulo}: todas` };
  const ids = new Set<string>();
  const nomes: string[] = [];
  for (const p of pedido) {
    const q = norm(p);
    if (q === 'branco' || q === '(em branco)' || q === 'em branco') {
      ids.add('branco');
      nomes.push('(em branco)');
      continue;
    }
    const achadas = opcoes.filter((o) => o.id === p.trim() || norm(o.nome) === q || norm(o.nome).includes(q));
    if (!achadas.length) throw new SqlRecusado(`${rotulo}: não encontrei "${p}". Opções: ${opcoes.map((o) => `${o.nome} (#${o.id})`).join('; ')}`);
    // nome exato ganha de "contém" (ex.: "Marketing" não deve puxar "Marketing [Meta ADS]" no Tipo do Lead)
    const exatas = achadas.filter((o) => o.id === p.trim() || norm(o.nome) === q);
    for (const o of exatas.length ? exatas : achadas) {
      ids.add(o.id);
      nomes.push(o.nome);
    }
  }
  return { ids: [...ids], texto: `${rotulo}: ${nomes.join(', ')}` };
}

export type PedidoAnalise = { de?: string; ate?: string; produto?: string; pipeline?: string | number; fontes?: string[]; tipos?: string[] };
export type OpcoesBi = {
  pipelines: Array<{ pipeline_id: number; pipeline: string; produto: string | null }>;
  fontes: BiOpcao[];
  tipos: BiOpcao[];
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dataValida = (v: string) => {
  if (!ISO.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v; // recusa 2026-13-01 e 2026-02-30
};
const isoLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Traduz o pedido da conversa em filtros do BI (os mesmos do painel) e em um texto que diz exatamente o que foi aplicado. */
export function resolverFiltros(p: PedidoAnalise, o: OpcoesBi, hoje = new Date()): { filtros: BiFiltros; descricao: string } {
  const de = p.de ?? `${hoje.getFullYear()}-01-01`;
  const ate = p.ate ?? isoLocal(hoje);
  if (!dataValida(de) || !dataValida(ate)) throw new SqlRecusado('As datas precisam estar no formato AAAA-MM-DD.');
  if (de > ate) throw new SqlRecusado('A data inicial é depois da final.');
  const filtros: BiFiltros = { de, ate };
  const partes = [`Data de criação: ${de} a ${ate}`];
  if (p.produto) {
    const prod = norm(p.produto);
    const mapa: Record<string, BiProduto> = { rh: 'rh', quarkrh: 'rh', clinic: 'clinic', clinica: 'clinic', quarkclinic: 'clinic' };
    if (!mapa[prod]) throw new SqlRecusado('Produto: use "rh" ou "clinica".');
    filtros.produto = mapa[prod];
    partes.push(`Produto: ${filtros.produto === 'rh' ? 'RH' : 'Clínica'}`);
  }
  if (p.pipeline !== undefined && String(p.pipeline).trim() !== '') {
    const q = norm(String(p.pipeline));
    const achado = o.pipelines.find((x) => String(x.pipeline_id) === String(p.pipeline).trim() || norm(x.pipeline) === q) ?? o.pipelines.find((x) => norm(x.pipeline).includes(q));
    if (!achado) throw new SqlRecusado(`Pipeline não encontrado. Opções: ${o.pipelines.map((x) => `${x.pipeline} (#${x.pipeline_id})`).join('; ')}`);
    filtros.pipeline_id = achado.pipeline_id;
    partes.push(`Pipeline: ${achado.pipeline} (#${achado.pipeline_id})`);
  }
  const f = resolverOpcoes(p.fontes, o.fontes, 'Fonte do Lead');
  const t = resolverOpcoes(p.tipos, o.tipos, 'Tipo do Lead');
  if (f.ids) filtros.fontes = f.ids;
  if (t.ids) filtros.tipos = t.ids;
  partes.push(f.texto, t.texto);
  return { filtros, descricao: partes.join(' | ') };
}

const celula = (tipo: string, v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') {
    if (tipo === 'pct') return `${(v * 100).toFixed(1).replace('.', ',')}%`;
    if (tipo === 'brl') return `R$ ${v.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;
    if (tipo === 'dias') return `${v.toFixed(1).replace('.', ',')} d`;
    return v.toLocaleString('pt-BR');
  }
  return String(v).replace(/\|/g, '/').replace(/\n/g, ' ');
};

/** Tabela em Markdown (o que o Claude lê melhor), limitada a `max` linhas. */
export function tabelaMarkdown(colunas: Array<{ id: string; rotulo: string; tipo: string }>, linhas: Array<Record<string, unknown>>, max = 60): string {
  if (!linhas.length) return '_(sem linhas para este filtro)_';
  const cab = `| ${colunas.map((c) => c.rotulo).join(' | ')} |`;
  const sep = `| ${colunas.map((c) => (c.tipo === 'texto' ? '---' : '---:')).join(' | ')} |`;
  const corpo = linhas.slice(0, max).map((l) => `| ${colunas.map((c) => celula(c.tipo, l[c.id])).join(' | ')} |`);
  const resto = linhas.length > max ? [`_(mostrando ${max} de ${linhas.length} linhas)_`] : [];
  return [cab, sep, ...corpo, ...resto].join('\n');
}

export function textoAnalise(titulo: string, pergunta: string, comoLer: string, descricaoFiltros: string, r: BiResultado): string {
  const avisos = r.avisos.length ? `\n**Avisos:**\n${r.avisos.map((a) => `- ${a}`).join('\n')}\n` : '';
  return [`## ${titulo}`, `_${pergunta}_`, `**Filtros aplicados:** ${descricaoFiltros}`, '', tabelaMarkdown(r.tabela.colunas, r.tabela.linhas), avisos, `**Como ler:** ${comoLer}`].join('\n');
}

/** Linhas de uma consulta SQL livre em Markdown, com as colunas na ordem devolvida pelo banco. */
export function textoSql(campos: string[], linhas: Array<Record<string, unknown>>, limite: number): string {
  const colunas = campos.map((id) => ({ id, rotulo: id, tipo: 'texto' }));
  const cortado = linhas.length >= limite ? `\n\n_(limite de ${limite} linhas atingido: refine a consulta com filtros ou agregações)_` : '';
  return `${tabelaMarkdown(colunas, linhas, limite)}${cortado}`;
}

/** Definições do negócio que o Claude precisa saber para não inventar conceitos. */
export const DEFINICOES = `# Definições deste banco (Quark Data Hub, dados do Pipedrive)

- **Negócio** = um registro (deal) do Pipedrive. **Safra** = mês de criação do negócio. Todo período filtra a DATA DE CRIAÇÃO.
- **Status**: ganho (won), perdido (lost), aberto (open) vêm SÓ do campo Status do negócio, nunca da etapa; "deleted" = excluído.
- **Lead** = negócio que conta como lead (por padrão todos os status, menos excluídos). **MQL** = lead que NÃO foi perdido por um motivo de perda que a regra exclui do MQL (hoje: Lead Invalido #398, Cliente em Busca de Suporte #185, Contato Inexistente #184, Oportunidade Duplicada #587). **Inválido** = lead perdido por um desses motivos.
- **Taxa de ganho** = ganhos ÷ (ganhos + perdidos). Taxas de passo do funil = dos que chegaram na etapa anterior, quantos chegaram na seguinte.
- **Chegou em SQL / Reunião Agendada / proposta** = passou pela etapa marcada com esse nome **ou por uma posterior** (negócios pulam etapas). Depende das etapas marcadas no Painel de Dados e do histórico de etapas lido.
- **MRR** = o valor (coluna \`valor\`, em R$) do negócio no Pipedrive; o campo MRR nativo do Pipedrive está zerado e o time guarda a mensalidade em "Valor". **MRR criado** = soma do valor dos leads criados no período; **MRR ganho** = status ganho; **MRR perdido** = status perdido; **MRR em aberto** = status aberto; **Ticket médio ganho** = MRR ganho ÷ ganhos. Esses cinco números acompanham toda análise de safra, canais, mês e responsável.
- **Fonte do Lead** e **Tipo do Lead** são campos do Pipedrive. Seleção fixa do BI: fontes Google ADS, Meta ADS, Orgânico e Social; tipo Marketing. Outras fontes/tipos podem ser pedidos pelo nome.
- **Produto**: rh (QuarkRH) ou clinic (QuarkClinic), definido pelo pipeline. Em branco = campo do Pipedrive não preenchido.
- Faixa de Colaboradores só existe para RH; Faixa de profissionais da saúde só para Clínica.
- Cada análise informa os filtros que aplicou; confira antes de concluir. Os dados NÃO incluem e-mail, telefone, nome de pessoa nem o título do negócio.`;
