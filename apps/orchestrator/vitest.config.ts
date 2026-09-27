import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "orchestrator",
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    env: {
      ANALYTAX_TELEMETRY_ENABLED: "false",
      LOG_LEVEL: "silent",
    },
  },
});
