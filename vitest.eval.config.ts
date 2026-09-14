import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@mnemos/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@mnemos/storage": new URL("./packages/storage/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["packages/*/src/**/*.eval.ts"],
    environment: "node",
  },
});
