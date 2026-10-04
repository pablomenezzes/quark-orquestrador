// Acrescenta extensão .js aos imports relativos de src/, config/ e api/ (exigido pelo Node ESM na Vercel).
// Idempotente. Diretórios viram <dir>/index.js. O TypeScript resolve ".js" para o ".ts" correspondente.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const roots = ['src', 'config', 'api'];
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts')) files.push(p);
  }
};
roots.forEach(walk);

let changed = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const out = src.replace(/(from\s+|import\s*\(\s*)(['"])(\.{1,2}\/[^'"]*)\2/g, (m, pre, q, spec) => {
    if (/\.(js|json|mjs)$/.test(spec)) return m;
    const abs = resolve(dirname(f), spec);
    if (existsSync(`${abs}.ts`)) return `${pre}${q}${spec}.js${q}`;
    if (existsSync(join(abs, 'index.ts'))) return `${pre}${q}${spec.replace(/\/$/, '')}/index.js${q}`;
    console.warn(`Não resolvido em ${f}: ${spec}`);
    return m;
  });
  if (out !== src) {
    writeFileSync(f, out);
    changed++;
  }
}
console.log(`Arquivos alterados: ${changed}`);
