/* Apoio compartilhado da página de Experimentos e do editor de documentação: formatação em pt-BR, chamadas à API (/api/experimentos) e rótulos. */
export const $ = (s, el = document) => el.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
export const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
export const brl0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
export const brl2 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const FORMATOS = { int: (v) => nf0.format(v), brl: (v) => brl0.format(v), brl2: (v) => brl2.format(v), pct: (v) => `${nf.format(v * 100)}%` };
export const dm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
export const dmy = (d) => `${dm(d)}/${d.slice(0, 4)}`;

export const STATUS_ROTULO = { backlog: 'Backlog', planejado: 'Planejado', rodando: 'Rodando', bloqueado: 'Bloqueado', concluido: 'Concluído', cancelado: 'Cancelado' };
export const AVALIACAO_ROTULO = { sucesso: 'Sucesso', falha: 'Falha', inconclusivo: 'Inconclusivo' };
export const DESFECHO_ROTULO = { atingiu: 'Atingiu a meta', parcial: 'Atingiu em parte', nao_atingiu: 'Não atingiu' };
export const ESTADO_ROTULO = {
  sem_metrica: 'Sem acompanhamento automático', cancelado: 'Cancelado', nao_iniciou: 'Ainda não começou', cedo: 'Poucos dias de dados', sem_dados: 'Sem dados no período',
  atingida: 'Meta atingida', em_linha: 'Em linha', atencao: 'Atenção', fora: 'Abaixo do previsto',
};
export const ESTADO_CLS = { atingida: 'bom', em_linha: 'bom', atencao: 'atencao', fora: 'ruim' };
export const PRODUTO_ROTULO = { rh: 'QuarkRH', clinic: 'QuarkClinic' };

export const fmtM = (m, v) => (v == null || !m ? '—' : FORMATOS[m.formato](v));
/** Percentuais são digitados em % (12 = 12%) e guardados como fração (0,12). */
export const paraTela = (m, v) => (v == null ? '' : String(m?.formato === 'pct' ? Math.round(v * 1e6) / 1e4 : v).replace('.', ','));
export const doCampo = (m, s) => {
  const t = String(s ?? '').trim();
  if (t === '') return null;
  const n = Number(t.replace(/\./g, '').replace(',', '.'));
  if (!isFinite(n)) return NaN;
  return m?.formato === 'pct' ? n / 100 : n;
};

export async function api(path, init) {
  const r = await fetch(path, init && { ...init, headers: { 'content-type': 'application/json' } });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.detail || corpo.error || `erro ${r.status}`);
  return corpo;
}
export const somaDias = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
