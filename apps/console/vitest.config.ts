import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const contractsSource = new URL("../../packages/contracts/src/index.ts", import.meta.url).pathname;

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@mnemos/contracts": contractsSource } },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.tsx"],
    fileParallelism: false,
  },
});
