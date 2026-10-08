// Gera mcp/dist/quark-dados.mjs: o conector do Claude Desktop num arquivo só (sem precisar de tsx nem de node_modules para rodar).
//   npm run mcp:build
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('mcp/dist', { recursive: true });
await build({
  entryPoints: ['mcp/quark-dados/server.ts'],
  outfile: 'mcp/dist/quark-dados.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['pg-native'],
  // o driver do Postgres usa require(); este atalho faz o arquivo ESM aceitar isso
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
console.log('Conector gerado em mcp/dist/quark-dados.mjs');
