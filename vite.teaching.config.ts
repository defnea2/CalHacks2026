import { defineConfig } from "vite";
import { teachingPlugin } from "./src/server/teachingPlugin";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react(), teachingPlugin({ binary: process.env.TUTOR_CODEX_BIN, model: process.env.TUTOR_CODEX_MODEL })],
  server: { host: "127.0.0.1", port: 5174, strictPort: true, open: false },
  build: {
    outDir: "dist-teaching",
    rolldownOptions: { input: "teaching.html" },
  },
});
