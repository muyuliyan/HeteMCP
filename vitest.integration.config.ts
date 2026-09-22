import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["tests/integration/**/*.integration.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
