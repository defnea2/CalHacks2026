import { defineConfig } from 'vite';
import { teachingPlugin } from "./src/server/teachingPlugin";
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), teachingPlugin({ binary: process.env.TUTOR_CODEX_BIN, model: process.env.TUTOR_CODEX_MODEL })],
  server: {
    port: 5173,
    strictPort: true,
  },
});
