// Teste SOMENTE LEITURA da conexao com a Marketing API da Meta. Nao grava nada no banco e nunca mostra o token.
// Uso: node scripts/meta-teste.mjs
import { readFileSync } from 'node:fs';

const env = {};
for (const l of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const token = env.META_ACCESS_TOKEN;
const contas = [['QuarkRH', env.META_AD_ACCOUNT_RH], ['QuarkClinic', env.META_AD_ACCOUNT_CLINIC]].filter(([, id]) => id);
if (!token) throw new Error('Falta META_ACCESS_TOKEN no .env.local (rode scripts/guardar-token-meta.mjs).');
if (!contas.length) throw new Error('Faltam META_AD_ACCOUNT_RH / META_AD_ACCOUNT_CLINIC no .env.local.');
const VERSAO = 'v26.0';
const base = `https://graph.facebook.com/${VERSAO}`;

async function get(caminho, params = {}) {
  const url = new URL(`${base}/${caminho}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } }); // o token vai no cabecalho, nao na URL
  const uso = r.headers.get('x-business-use-case-usage') ?? r.headers.get('x-ad-account-usage');
  const j = await r.json();
  if (!r.ok) throw new Error(`${caminho}: ${j?.error?.type ?? r.status} (${j?.error?.code ?? '-'}): ${j?.error?.message ?? ''}`);
  return { j, uso };
}

try {
  const eu = (await get('me', { fields: 'id,name' })).j;
  console.log(`Token valido para: ${eu.name} (${eu.id})`);
  const perm = (await get('me/permissions')).j.data ?? [];
  console.log('Permissoes concedidas:', perm.filter((p) => p.status === 'granted').map((p) => p.permission).join(', ') || '(nenhuma listada)');
} catch (e) {
  console.log('Identificacao do token:', e.message);
}
for (const [nome, id] of contas) {
  console.log(`\n== ${nome} (act_${id}) ==`);
  try {
    const { j: c } = await get(`act_${id}`, { fields: 'name,account_status,currency,timezone_name,amount_spent,business_name' });
    console.log(`Conta: ${c.name} | status ${c.account_status} (1 = ativa) | moeda ${c.currency} | fuso ${c.timezone_name} | negocio ${c.business_name ?? '-'}`);
    const ads = (await get(`act_${id}/ads`, { fields: 'id', limit: '1', summary: 'total_count' })).j;
    console.log(`Anuncios na conta: ${ads.summary?.total_count ?? '(sem total)'}`);
    const camp = (await get(`act_${id}/campaigns`, { fields: 'id', limit: '1', summary: 'total_count' })).j;
    console.log(`Campanhas na conta: ${camp.summary?.total_count ?? '(sem total)'}`);
    const ins = await get(`act_${id}/insights`, { fields: 'spend,impressions,reach,clicks,inline_link_clicks,cpm,ctr,actions', date_preset: 'last_7d' });
    const l = ins.j.data?.[0];
    console.log(l ? `Ultimos 7 dias: gasto ${l.spend} | impressoes ${l.impressions} | cliques no link ${l.inline_link_clicks ?? '-'} | CPM ${Number(l.cpm).toFixed(2)} | CTR ${Number(l.ctr).toFixed(2)}%` : 'Ultimos 7 dias: sem dados');
    console.log('Uso da cota (cabecalho da Meta):', ins.uso ?? '(nao informado)');
  } catch (e) {
    console.log('Falhou:', e.message);
  }
}
