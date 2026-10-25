// Checks client/dist before a static deploy (Cloudflare Pages, docs/DEPLOY.md). No network.
// Usage: node client/scripts/check-dist.mjs [distDir]
//  - the VAD / Smart Turn / ONNX Runtime assets are in dist/vad/
//  - no file is over Cloudflare Pages' 25 MiB per-file limit; at most 20,000 files
//  - index.html references its assets relatively (works from any root or sub-path)
//  - _headers is there, has a Content-Type rule for every dist/vad file, and <= 100 rules
//  - prints the SpacetimeDB URI / database baked into the bundle
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
const problems = [];
const MAX = 25 * 1024 * 1024;

const all = [];
const walk = d => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else all.push(p);
  }
};
if (!fs.existsSync(dist)) {
  console.error(`check-dist: ${dist} does not exist (run pnpm --filter client build)`);
  process.exit(1);
}
walk(dist);
if (all.length > 20000) problems.push(`${all.length} files (Pages Free allows 20,000)`);
for (const f of all) {
  const size = fs.statSync(f).size;
  if (size > MAX) problems.push(`${path.relative(dist, f)} is ${(size / 1048576).toFixed(1)} MiB (Pages limit 25 MiB)`);
}

const need = ['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx', 'silero_vad_legacy.onnx', 'smart-turn-v3.2-cpu.onnx', 'LICENSE-smart-turn.txt', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];
const vadDir = path.join(dist, 'vad');
const vadFiles = fs.existsSync(vadDir) ? fs.readdirSync(vadDir) : [];
for (const n of need) if (!vadFiles.includes(n)) problems.push(`missing vad/${n}`);

const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:src|href)="(\/[^/"][^"]*)"/g)) problems.push(`index.html uses the absolute path ${m[1]} (expected ./...)`);

const headersFile = path.join(dist, '_headers');
if (!fs.existsSync(headersFile)) problems.push('missing _headers');
else {
  const lines = fs.readFileSync(headersFile, 'utf8').split('\n');
  const rules = lines.filter(l => /^\//.test(l));
  if (rules.length > 100) problems.push(`_headers has ${rules.length} rules (Pages allows 100)`);
  for (const f of vadFiles) {
    const at = lines.indexOf(`/vad/${f}`);
    const next = at < 0 ? [] : lines.slice(at + 1, lines.findIndex((l, i) => i > at && /^\//.test(l)) >>> 0);
    if (at < 0 || !next.some(l => /^\s+Content-Type:/i.test(l))) problems.push(`_headers has no Content-Type rule for /vad/${f}`);
  }
}

// Baked connection settings (VITE_SPACETIME_URI / VITE_SPACETIME_DB, see client/src/config.ts).
const js = all.filter(f => /assets\/index-.*\.js$/.test(f)).map(f => fs.readFileSync(f, 'utf8')).join('\n');
const uris = [...new Set([...js.matchAll(/VITE_SPACETIME_URI:"([^"]*)"/g)].map(m => m[1]))];
const dbs = [...new Set([...js.matchAll(/VITE_SPACETIME_DB:"([^"]*)"/g)].map(m => m[1]))];
console.log(`dist: ${all.length} files, largest ${(Math.max(...all.map(f => fs.statSync(f).size)) / 1048576).toFixed(1)} MiB`);
console.log(`baked VITE_SPACETIME_URI: ${uris.join(', ') || '(not set: default ws://127.0.0.1:3000)'}`);
console.log(`baked VITE_SPACETIME_DB:  ${dbs.join(', ') || '(not set: default voice-tutor)'}`);
if (problems.length) {
  console.error(`check-dist: ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('check-dist: ok');
