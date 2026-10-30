/**
 * Sanitização de amostras da API da Umbler para documentação: remove nome, telefone, e-mail, token, texto livre e links,
 * troca IDs por rótulos estáveis (ID-1, ID-2...) e corta listas em 3 itens. O formato (chaves e tipos) é preservado.
 */
const CHAVE_NOME = /name|title|label|botname|trigger|displayname|signature|username/i;
const CHAVE_SENSIVEL = /phone|email|mail|token|secret|password|picture|url|link|content|body|text|note|address|document|cpf|cnpj|example|postback|autofill|code|host|domain|whatsapp/i;
const CHAVE_ID = /^(id|_id)$|Id$|Ids$/;
const PADRAO_SENSIVEL = /(\+?\d[\d\s().-]{8,}\d)|([\w.+-]+@[\w-]+\.[\w.-]+)|(Bearer\s+\S+)|(https?:\/\/\S+)/;

export function sanitizar(valor: unknown, ids: Map<string, string> = new Map(), chave = ''): unknown {
  if (Array.isArray(valor)) return valor.slice(0, 3).map((v) => sanitizar(v, ids, chave));
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(Object.entries(valor as Record<string, unknown>).map(([k, v]) => [k, sanitizar(v, ids, k)]));
  }
  if (typeof valor === 'string') {
    if (CHAVE_ID.test(chave)) {
      if (!ids.has(valor)) ids.set(valor, `ID-${ids.size + 1}`);
      return ids.get(valor);
    }
    if (/^\d{4}-\d{2}-\d{2}T/.test(valor)) return valor; // datas ficam
    if (CHAVE_SENSIVEL.test(chave)) return '[removido]';
    if (CHAVE_NOME.test(chave)) return '[nome]';
    if (PADRAO_SENSIVEL.test(valor)) return '[removido]';
    return valor.length > 40 ? '[texto]' : valor; // enums e rótulos curtos (Template, Bot, Live...) ficam
  }
  return valor;
}
