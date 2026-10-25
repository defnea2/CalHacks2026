/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** The Silero + Smart Turn models, the VAD worklet and the ONNX Runtime wasm + glue, by served file name. */
function vadAssetFiles(): Map<string, string> {
  const vadDir = dirname(require.resolve('@ricky0123/vad-web/package.json'));
  // Resolve onnxruntime-web the way vad-web does, so the wasm matches the JS that loads it
  // (no ./package.json export; the main entry lives in dist/).
  const ortDist = dirname(createRequire(join(vadDir, 'package.json')).resolve('onnxruntime-web'));
  const files = new Map<string, string>([
    ['vad.worklet.bundle.min.js', join(vadDir, 'dist', 'vad.worklet.bundle.min.js')],
    ['silero_vad_v5.onnx', join(vadDir, 'dist', 'silero_vad_v5.onnx')],
    ['silero_vad_legacy.onnx', join(vadDir, 'dist', 'silero_vad_legacy.onnx')],
    // Pipecat Smart Turn v3.2 (BSD-2, committed under client/models/, see its README)
    ['smart-turn-v3.2-cpu.onnx', join(here, 'models', 'smart-turn-v3.2-cpu.onnx')],
    ['LICENSE-smart-turn.txt', join(here, 'models', 'LICENSE-smart-turn')],
  ]);
  for (const f of readdirSync(ortDist)) {
    if (/^ort-wasm-simd-threaded(\.jsep)?\.(wasm|mjs)$/.test(f)) files.set(f, join(ortDist, f));
  }
  return files;
}

const TYPES: Record<string, string> = { txt: 'text/plain', js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm', onnx: 'application/octet-stream' };

/** Serves VAD assets under /vad/ from node_modules, so voice detection works offline (headless
 *  Chrome in the E2E harness). Dev: raw middleware (ORT dynamically imports its .mjs glue, which
 *  Vite refuses to serve from public/). Build: copied to dist/vad/. */
function vadAssets(): Plugin {
  const files = vadAssetFiles();
  let outDir = 'dist';
  return {
    name: 'vad-assets',
    configResolved(c) {
      outDir = c.build.outDir.startsWith('/') ? c.build.outDir : join(c.root, c.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/vad\/([^?#]+)/);
        const src = m ? files.get(m[1]!) : undefined;
        if (!src) return next();
        res.setHeader('Content-Type', TYPES[src.split('.').pop()!] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(readFileSync(src));
      });
    },
    writeBundle() {
      mkdirSync(join(outDir, 'vad'), { recursive: true });
      for (const [name, src] of files) copyFileSync(src, join(outDir, 'vad', name));
    },
  };
}

export default defineConfig({
  envDir: '..',
  // The team's UI (repo-root src/: app, teaching, presentation, visuals, interactions, visual-math)
  // is part of this one static build under the alias @tutor/visual (folder names unchanged).
  resolve: { dedupe: ['react', 'react-dom', 'zod', 'motion', 'mafs', 'katex'], alias: { '@tutor/visual': join(here, '..', 'src') } },
  plugins: [vadAssets(), react(), tailwindcss()],
  // Team canvas deps pre-bundled too: a mid-session re-optimisation reloads the page (E2E flake).
  optimizeDeps: { include: ['@ricky0123/vad-web', 'onnxruntime-web/wasm', 'katex', 'mafs', 'motion/react'] },
  // the Smart Turn worker imports ONNX Runtime, which code-splits (needs ES module workers)
  worker: { format: 'es' },
  // 5175: the team's root app (src/) keeps 5173
  server: { host: '127.0.0.1', port: 5175, strictPort: true },
  preview: { host: '127.0.0.1' },
  test: { include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], environment: 'node' },
});
