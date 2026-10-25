import { defineConfig, loadEnv } from "vite";
import { teachingOptions } from "./src/server/settings";
import { teachingPlugin } from "./src/server/teachingPlugin";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => ({
  plugins: [react(), teachingPlugin(teachingOptions({ ...loadEnv(mode, process.cwd(), ""), ...process.env }))],
  // Lazily imported chunks must be pre-bundled, or a mid-lesson re-optimisation 504s the dynamic import.
  optimizeDeps: { include: ["katex", "mafs", "motion/react", "react-dom/client"] },
  server: { host: "127.0.0.1", port: 5174, strictPort: true, open: false },
  build: {
    outDir: "dist-teaching",
    rolldownOptions: { input: "teaching.html" },
  },
}));
