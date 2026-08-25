import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // 13+ archivos de integración levantan cada uno un PostgreSQL WASM (PGlite):
    // sin tope, la memoria revienta esporádicamente en máquinas modestas.
    poolOptions: { forks: { maxForks: 6 } },
  },
});
