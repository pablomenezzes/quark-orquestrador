import { AdapterError, isPlainObject, type AdapterResult } from './errors';

/**
 * Vercel (LP em código): o navegador faz fetch já no formato do contrato (seção 7).
 * O adaptador só separa o honeypot e remove o que quem decide é o servidor (ip e user_agent).
 */
export function parseVercel(body: unknown): AdapterResult {
  if (!isPlainObject(body)) throw new AdapterError('corpo deve ser um objeto JSON');
  const attribution = isPlainObject(body.attribution) ? { ...body.attribution } : {};
  delete attribution.ip;
  delete attribution.user_agent;
  const { website_hp, ...rest } = body;
  return {
    candidate: { ...rest, attribution },
    honeypot: typeof website_hp === 'string' ? website_hp.trim() : website_hp ? String(website_hp) : '',
  };
}
