/**
 * setup.ts — ambiente comum dos testes.
 *
 * Limpa o estado global entre arquivos. `lib/cache.ts` mantém cache de módulo
 * e escreve em sessionStorage; sem esta limpeza, um teste que popula o cache
 * faria o seguinte passar por acidente — e a suíte inteira dependeria da ordem
 * de coleta.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { limparCache } from "../lib/cache";

beforeEach(() => {
  limparCache();
  try {
    sessionStorage.clear();
    localStorage.clear();
  } catch {
    /* storage indisponível — nada a limpar */
  }
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
