// Teste SOMENTE LEITURA da conexao com o GA4 (nao grava nada no banco, nao mostra segredo).
// Uso: node scripts/ga4-teste.mjs
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const env = {};
for (const l of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const email = env.GOOGLE_SA_CLIENT_EMAIL;
const chave = JSON.parse(env.GOOGLE_SA_PRIVATE_KEY);
const prop = env.GA4_PROPERTY_ID;
if (!email || !chave || !prop) throw new Error('Faltam GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_PRIVATE_KEY ou GA4_PROPERTY_ID no .env.local');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const agora = Math.floor(Date.now() / 1000);
const corpo = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
  iss: email,
  scope: 'https://www.googleapis.com/auth/analytics.readonly',
  aud: 'https://oauth2.googleapis.com/token',
  iat: agora,
  exp: agora + 3600,
})}`;
const assinatura = createSign('RSA-SHA256').update(corpo).sign(chave, 'base64url');

const tk = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${corpo}.${assinatura}` }),
});
const tkj = await tk.json();
if (!tk.ok) throw new Error(`Falha ao autenticar: ${tkj.error} ${tkj.error_description ?? ''}`);
const h = { authorization: `Bearer ${tkj.access_token}`, 'content-type': 'application/json' };
const base = `https://analyticsdata.googleapis.com/v1beta/properties/${prop}`;

const meta = await fetch(`${base}/metadata`, { headers: h });
const mj = await meta.json();
if (!meta.ok) {
  console.log('Metadata falhou:', meta.status, mj.error?.status, mj.error?.message);
  process.exit(1);
}
const nomes = (arr) => new Set(arr.map((x) => x.apiName));
const dims = nomes(mj.dimensions), mets = nomes(mj.metrics);
console.log(`Metadata OK: ${mj.dimensions.length} dimensoes, ${mj.metrics.length} metricas.`);
const quero = {
  dim: ['date', 'hostName', 'landingPage', 'landingPagePlusQueryString', 'pagePath', 'sessionSource', 'sessionMedium', 'sessionCampaignName', 'sessionCampaignId', 'sessionGoogleAdsCampaignName', 'sessionGoogleAdsCampaignId', 'eventName', 'isKeyEvent'],
  met: ['sessions', 'newUsers', 'activeUsers', 'engagedSessions', 'screenPageViews', 'keyEvents', 'conversions', 'advertiserAdCost', 'advertiserAdClicks', 'advertiserAdImpressions'],
};
console.log('Dimensoes:', quero.dim.map((d) => `${d}=${dims.has(d) ? 'sim' : 'NAO'}`).join(' '));
console.log('Metricas:', quero.met.map((m) => `${m}=${mets.has(m) ? 'sim' : 'NAO'}`).join(' '));

const rel = await fetch(`${base}:runReport`, {
  method: 'POST',
  headers: h,
  body: JSON.stringify({
    dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
    dimensions: [{ name: 'hostName' }, { name: 'landingPage' }],
    metrics: [{ name: 'sessions' }, { name: 'newUsers' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 10,
    returnPropertyQuota: true,
  }),
});
const rj = await rel.json();
if (!rel.ok) {
  console.log('runReport falhou:', rel.status, rj.error?.status, rj.error?.message);
  process.exit(1);
}
console.log(`\nTop paginas de entrada (ultimos 7 dias, ${rj.rowCount} linhas no total):`);
for (const r of rj.rows ?? []) console.log(`  ${r.dimensionValues[0].value}${r.dimensionValues[1].value}  sessoes=${r.metricValues[0].value} novos=${r.metricValues[1].value}`);
console.log('\nCota usada:', JSON.stringify(rj.propertyQuota));
