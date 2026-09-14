import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@mnemos/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@mnemos/storage": new URL("./packages/storage/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    // PTC tests spawn resource-limited child processes; serial files avoid
    // host CPU contention making the hard-timeout assertion nondeterministic.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
