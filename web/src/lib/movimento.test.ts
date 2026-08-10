/**
 * movimento.test.ts — a animação some quando o usuário pede para sumir.
 *
 * O `globalStyles` já zera keyframe e transição em `prefers-reduced-motion:
 * reduce`. O que ele NÃO alcança é movimento movido por JavaScript: um
 * contador em `requestAnimationFrame` continuaria correndo, e é exatamente o
 * tipo de movimento que provoca enjoo em quem pediu para não ter movimento.
 *
 * Por isso quase todo teste aqui é sobre o caminho "reduce".
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atraso, duracaoGrafico, prefereMovimento, useContagem } from "./movimento";

/** Substitui `matchMedia` para responder o que o teste quiser. */
function comPreferencia(aceita: boolean) {
  vi.stubGlobal("matchMedia", (consulta: string) => ({
    matches: consulta.includes("no-preference") ? aceita : !aceita,
    media: consulta,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("prefereMovimento", () => {
  it("respeita a preferência declarada", () => {
    comPreferencia(true);
    expect(prefereMovimento()).toBe(true);
    comPreferencia(false);
    expect(prefereMovimento()).toBe(false);
  });

  it("sem matchMedia, assume que NÃO deve animar", () => {
    /* A falha segura é não animar. Assumir o contrário significa mover a tela
       de alguém que pediu para não mover, num ambiente onde nem dá para
       perguntar. */
    vi.stubGlobal("matchMedia", undefined);
    expect(prefereMovimento()).toBe(false);
  });
});

describe("useContagem", () => {
  it("com reduce, entrega o alvo sem quadro intermediário", () => {
    comPreferencia(false);
    const { result } = renderHook(() => useContagem(10_607_110));
    expect(result.current).toBe(10_607_110);
  });

  it("com movimento, começa abaixo do alvo e chega nele", async () => {
    comPreferencia(true);
    const { result } = renderHook(() => useContagem(1000, 60));

    expect(result.current).toBeLessThan(1000);
    await act(() => new Promise((r) => setTimeout(r, 140)));
    expect(result.current).toBe(1000);
  });

  it("anima a partir do valor atual, não de zero", async () => {
    /* Ao trocar de filtro, recomeçar do zero apaga a comparação que o usuário
       está fazendo entre o número de antes e o de agora. */
    comPreferencia(true);
    const { result, rerender } = renderHook(({ v }) => useContagem(v, 60), {
      initialProps: { v: 1000 },
    });
    await act(() => new Promise((r) => setTimeout(r, 140)));
    expect(result.current).toBe(1000);

    rerender({ v: 1200 });
    /* O primeiro quadro do novo alvo tem que sair de perto de 1000, não de 0. */
    expect(result.current).toBeGreaterThan(500);
  });

  it("não estoura com valor não-finito", () => {
    comPreferencia(true);
    const { result } = renderHook(() => useContagem(Number.NaN));
    expect(Number.isNaN(result.current)).toBe(true);
  });
});

describe("duracaoGrafico e atraso", () => {
  it("zeram com reduce", () => {
    comPreferencia(false);
    expect(duracaoGrafico()).toBe(0);
    expect(atraso(3)).toBe(0);
  });

  it("o escalonamento tem teto", () => {
    /* Sem teto, a linha 25 apareceria um segundo e meio depois da primeira, e
       quem abriu a tela para ler a tabela espera o enfeite terminar. */
    comPreferencia(true);
    expect(atraso(3)).toBe(165);
    expect(atraso(50)).toBe(atraso(6));
  });
});
