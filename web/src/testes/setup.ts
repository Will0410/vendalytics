/**
 * setup.ts — ambiente comum dos testes.
 *
 * Limpa o estado global entre arquivos. `lib/cache.ts` mantém cache de módulo
 * e escreve em sessionStorage; sem esta limpeza, um teste que popula o cache
 * faria o seguinte passar por acidente — e a suíte inteira dependeria da ordem
 * de coleta.
 */
import "@testing-library/jest-dom/vitest";
/* O jsdom não implementa IndexedDB — sem este polyfill, os testes da camada
   durável exercitariam apenas o caminho "indisponível", que é justamente o
   que NÃO precisa de teste. */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { limparCache } from "../lib/cache";

/* ─── Lacunas do jsdom ─────────────────────────────────────────────────────
 * O jsdom não implementa APIs de layout, porque não faz layout. Estas quatro
 * são usadas pelo app e, sem elas, o teste falha por motivo que não tem nada
 * a ver com o código sendo testado.
 *
 * São stubs deliberadamente burros: nenhum teste aqui verifica dimensão de
 * elemento — se um dia verificar, o lugar é um navegador de verdade, não uma
 * simulação de layout que sempre devolve zero. */

if (!("ResizeObserver" in globalThis)) {
  // O `ResponsiveContainer` do Recharts observa o contêiner para se
  // redimensionar. Sem layout, nada muda de tamanho — observar é inócuo.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!window.matchMedia) {
  // O Stitches usa media queries (`@motion`, `@lg`). No teste, nenhuma casa.
  // O `in` estreitaria o tipo para `never` no bloco — daí a checagem direta.
  window.matchMedia = ((consulta: string) => ({
    matches: false,
    media: consulta,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// O Copiloto rola a conversa para o fim a cada mensagem.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// A exportação de CSV cria um blob e dispara o download.
if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:teste";
  URL.revokeObjectURL = () => {};
}

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
