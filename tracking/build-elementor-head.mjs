// Gera tracking/elementor-head.html: o bloco único que se cola no cabeçalho do WordPress
// (Elementor > Custom Code, local <head>, todo o site). Contém, nesta ordem:
//   1. a configuração do script de atribuição (domínios da Quark);
//   2. o attribution.js inteiro;
//   3. o gancho "submit_success" do Elementor (consome o event_id e gera outro para o próximo envio).
//
//   node tracking/build-elementor-head.mjs
//
// Um teste confere que o arquivo gerado nunca fica diferente do attribution.js.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONFIG =
  "window.QUARK_ATTR_CONFIG={cookieDomain:'.quarkrh.com.br',decorateHosts:['fillout.com','form.fillout.com','quarkrh-diagnostico.lovable.app'],ignoreReferrerHosts:['quarkrh.com.br']};";

export const HOOK =
  "document.addEventListener('DOMContentLoaded',function(){if(!window.jQuery)return;jQuery(document).on('submit_success','.elementor-form',function(){if(!window.QuarkAttribution)return;var f=jQuery(this);window.QuarkAttribution.pushLead({form_id:f.find('input[name*=qk_form_id]').val()||'',lp_id:f.find('input[name*=qk_lp_id]').val()||''});});});";

export function buildHead(attributionJs) {
  return `<!-- Quark Orquestrador: script de atribuicao (gerado por tracking/build-elementor-head.mjs; nao edite a mao) -->\n<script>${CONFIG}</script>\n<script>\n${attributionJs}\n</script>\n<script>${HOOK}</script>\n`;
}

const here = fileURLToPath(new URL('.', import.meta.url));
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = buildHead(readFileSync(`${here}attribution.js`, 'utf8'));
  writeFileSync(`${here}elementor-head.html`, out);
  console.log(`tracking/elementor-head.html gerado (${out.length} caracteres).`);
}
