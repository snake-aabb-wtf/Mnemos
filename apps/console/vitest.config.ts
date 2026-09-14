import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const contractsSource = new URL("../../packages/contracts/src/index.ts", import.meta.url).pathname;
const consoleRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: consoleRoot,
  plugins: [react()],
  resolve: { alias: { "@mnemos/contracts": contractsSource } },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.tsx"],
    fileParallelism: false,
  },
});
