import { defineConfig } from "vitest/config";

// Pure view-model and lib tests. A separate config so Vitest never loads the Tailwind / React Vite plugins.
export default defineConfig({
  test: {
    name: "web",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
