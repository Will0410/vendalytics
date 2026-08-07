/**
 * vitest.config.ts — configuração dos testes do frontend.
 *
 * Duas coisas merecem explicação:
 *
 * `environment: "jsdom"` — a maior parte da suíte testa lógica pura e nem
 * precisaria de DOM, mas os testes de regressão dos bugs que chegaram em
 * produção precisam: dois deles só aparecem com o React montando de verdade.
 *
 * `pool: "threads"` com isolamento — `lib/cache.ts` guarda estado de módulo
 * (memória + sessionStorage). Sem isolar, um arquivo de teste veria o cache
 * que outro deixou, e a suíte passaria ou falharia conforme a ORDEM de
 * execução — que é o pior tipo de teste, porque some quando se investiga.
 */
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/testes/setup.ts"],
    isolate: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
