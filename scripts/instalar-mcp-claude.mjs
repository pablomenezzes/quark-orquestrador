// Registra o conector "quark-dados" no Claude Desktop (acrescenta UMA entrada em mcpServers e preserva tudo o que ja existe).
//
//   node scripts/instalar-mcp-claude.mjs           -> mostra o que faria (nao altera nada)
//   node scripts/instalar-mcp-claude.mjs --apply   -> grava (antes, copia o arquivo de configuracao para .bak-AAAAMMDD-HHMMSS)
//   node scripts/instalar-mcp-claude.mjs --remover --apply   -> tira o conector da configuracao
//
// Depois de gravar: FECHE o Claude Desktop por completo (inclusive o icone perto do relogio) e abra de novo.
// Nenhum segredo vai para a configuracao do Claude Desktop: o conector le a conexao do .env.local do proprio projeto.
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const apply = process.argv.includes('--apply');
const remover = process.argv.includes('--remover');
const NOME = 'quark-dados';
const bundle = resolve('mcp/dist/quark-dados.mjs');

// A instalacao da Microsoft Store guarda a configuracao dentro de Packages; a classica fica em %APPDATA%. Cobrimos as duas.
const candidatos = [join(process.env.APPDATA ?? '', 'Claude', 'claude_desktop_config.json')];
const pacotes = join(process.env.LOCALAPPDATA ?? '', 'Packages');
if (existsSync(pacotes)) {
  for (const d of readdirSync(pacotes).filter((n) => n.startsWith('Claude_'))) candidatos.push(join(pacotes, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
}
const arquivos = candidatos.filter((p) => existsSync(p));
if (!arquivos.length) {
  console.error('Nao encontrei a configuracao do Claude Desktop. Abra o Claude Desktop uma vez e rode de novo.');
  process.exit(1);
}
if (!remover && !existsSync(bundle)) {
  console.error('O conector ainda nao foi gerado. Rode antes: npm run mcp:build');
  process.exit(1);
}

const entrada = { command: process.execPath, args: [bundle] };
const carimbo = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
for (const arq of arquivos) {
  const bruto = readFileSync(arq, 'utf8').replace(/^﻿/, '');
  let cfg;
  try {
    cfg = bruto.trim() ? JSON.parse(bruto) : {};
  } catch {
    console.error(`Nao consegui ler ${arq} como JSON; nao vou mexer nele.`);
    process.exitCode = 1;
    continue;
  }
  const antes = cfg.mcpServers ?? {};
  const depois = { ...antes };
  if (remover) delete depois[NOME];
  else depois[NOME] = entrada;
  const preservados = Object.keys(antes).filter((k) => k !== NOME);
  console.log(`\n${arq}`);
  console.log(`  ${remover ? 'remover' : antes[NOME] ? 'atualizar' : 'acrescentar'} o conector "${NOME}"; outros conectores preservados: ${preservados.length ? preservados.join(', ') : '(nenhum)'}; demais configuracoes: ${Object.keys(cfg).filter((k) => k !== 'mcpServers').join(', ') || '(nenhuma)'}`);
  if (!apply) continue;
  copyFileSync(arq, `${arq}.bak-${carimbo}`);
  const novo = { ...cfg, mcpServers: depois };
  if (!Object.keys(depois).length) delete novo.mcpServers;
  writeFileSync(arq, `${JSON.stringify(novo, null, 2)}\n`, 'utf8');
  console.log(`  gravado (copia de seguranca: ${arq}.bak-${carimbo})`);
}
console.log(apply ? '\nFeito. Feche o Claude Desktop por completo e abra de novo.' : '\n(simulacao) Nada foi alterado. Rode com --apply para gravar.');
