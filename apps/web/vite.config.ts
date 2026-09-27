import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
  },
  build: {
    target: "es2022",
    sourcemap: true,
    // elkjs ships a ~1.5 MB bundled layout engine; it lives in the lazily loaded DAG chunk.
    chunkSizeWarningLimit: 2500,
  },
});
