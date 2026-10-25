/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Copies the Silero model, the VAD worklet and the ONNX Runtime wasm files into public/vad/,
 *  so voice detection works offline (headless Chrome in the E2E harness). Runs on dev and build. */
function copyVadAssets(): Plugin {
  return {
    name: 'copy-vad-assets',
    buildStart() {
      const out = join(here, 'public', 'vad');
      mkdirSync(out, { recursive: true });
      const vadDir = dirname(require.resolve('@ricky0123/vad-web/package.json'));
      // Resolve onnxruntime-web the way vad-web does, so the wasm matches the JS that loads it.
      const vadRequire = createRequire(join(vadDir, 'package.json'));
      // (no ./package.json export; the main entry lives in dist/)
      const ortDist = dirname(vadRequire.resolve('onnxruntime-web'));
      const files: [string, string][] = [
        [join(vadDir, 'dist', 'vad.worklet.bundle.min.js'), 'vad.worklet.bundle.min.js'],
        [join(vadDir, 'dist', 'silero_vad_v5.onnx'), 'silero_vad_v5.onnx'],
        [join(vadDir, 'dist', 'silero_vad_legacy.onnx'), 'silero_vad_legacy.onnx'],
      ];
      for (const f of readdirSync(ortDist)) {
        if (/^ort-wasm-simd-threaded(\.jsep)?\.(wasm|mjs)$/.test(f)) files.push([join(ortDist, f), f]);
      }
      for (const [src, name] of files) copyFileSync(src, join(out, name));
    },
  };
}

export default defineConfig({
  plugins: [copyVadAssets(), react(), tailwindcss()],
  optimizeDeps: { exclude: ['onnxruntime-web', '@ricky0123/vad-web'] },
  server: { host: '127.0.0.1', port: 5173 },
  test: { include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], environment: 'node' },
});
