import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Config separada do vite.config.ts: os testes nao precisam do plugin do Tailwind
// (nao renderizam CSS) e carrega-lo aqui so deixaria a suite mais lenta.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/features/mail/**", "src/components/emails/**"],
      reporter: ["text", "html"],
    },
  },
});
