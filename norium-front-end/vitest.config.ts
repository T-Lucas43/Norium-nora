import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = process.cwd();
const dependencyRoot = realpathSync(resolve(projectRoot, "node_modules"));

// Config separada do vite.config.ts: os testes nao precisam do plugin do Tailwind
// (nao renderizam CSS) e carrega-lo aqui so deixaria a suite mais lenta.
export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      // Worktrees share node_modules through a junction. Keep the allowlist
      // restricted to the project and its resolved dependency directory.
      allow: [projectRoot, dependencyRoot],
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/features/mail/**", "src/components/emails/**"],
      reporter: ["text", "html"],
    },
  },
});
