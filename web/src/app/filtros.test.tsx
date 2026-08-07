/**
 * filtros.test.tsx — o estado de filtro global.
 *
 * Existe por causa de um bug que só apareceu quando o próprio teste de
 * navegador navegou para um deep link: o provedor lia a URL apenas na
 * montagem, e trocar de hash não remonta nada. Colar
 * `#/praca?uf=SP&mun=3550308` numa aba já aberta abria a tela certa com o
 * filtro errado — o Relatório mostrava "escolha uma praça" com o município na
 * URL.
 *
 * Deep link que só funciona em carga limpa não é deep link, e é o tipo de
 * defeito que ninguém reporta: a pessoa dá F5 e segue a vida.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { ProvedorFiltros, useFiltros, PISO_SCORE } from "./filtros";

const envolver = ({ children }: { children: ReactNode }) => (
  <ProvedorFiltros>{children}</ProvedorFiltros>
);

function montar() {
  return renderHook(() => useFiltros(), { wrapper: envolver });
}

describe("ProvedorFiltros", () => {
  it("lê os filtros da URL na montagem", () => {
    window.location.hash = "#/praca?uf=BA&mun=2927408&cnae=G,F&ticket=60000";

    const { result } = montar();

    expect(result.current.filtros.uf).toBe("BA");
    expect(result.current.filtros.municipioId).toBe(2927408);
    expect(result.current.filtros.secoes).toEqual(["G", "F"]);
    expect(result.current.filtros.ticketMedioAnual).toBe(60000);
  });

  it("ignora valores malformados em vez de quebrar", () => {
    /* A URL é entrada do usuário: alguém edita à mão, um link vem truncado. */
    window.location.hash = "#/praca?uf=BAHIA&mun=abc&cnae=Z,9&risco=turbo";

    const { result } = montar();

    expect(result.current.filtros.uf).toBe("SP"); // padrão
    expect(result.current.filtros.municipioId).toBeNull();
    expect(result.current.filtros.secoes).toEqual([]);
    expect(result.current.filtros.risco).toBe("equilibrado");
  });

  it("escreve os filtros na URL ao mudar", () => {
    window.location.hash = "#/mapa";
    const { result } = montar();

    act(() => result.current.definir("uf", "PR"));

    expect(window.location.hash).toContain("uf=PR");
    expect(window.location.hash).toContain("/mapa");
  });

  it("trocar de UF invalida o município selecionado", () => {
    /* Manter o município mostraria uma praça de outro estado sob o rótulo do
       estado novo — números certos, contexto errado. */
    window.location.hash = "#/praca?uf=SP&mun=3550308";
    const { result } = montar();
    expect(result.current.filtros.municipioId).toBe(3550308);

    act(() => result.current.definir("uf", "RJ"));

    expect(result.current.filtros.municipioId).toBeNull();
  });

  it("alternarSecao adiciona e remove", () => {
    const { result } = montar();

    act(() => result.current.alternarSecao("G"));
    expect(result.current.filtros.secoes).toEqual(["G"]);

    act(() => result.current.alternarSecao("C"));
    expect(result.current.filtros.secoes).toEqual(["G", "C"]);

    act(() => result.current.alternarSecao("G"));
    expect(result.current.filtros.secoes).toEqual(["C"]);
  });

  it("o apetite de risco vira piso de score", () => {
    const { result } = montar();

    act(() => result.current.definir("risco", "conservador"));
    expect(result.current.pisoScore).toBe(PISO_SCORE.conservador);

    act(() => result.current.definir("risco", "agressivo"));
    expect(result.current.pisoScore).toBe(0);
  });

  /* ── REGRESSÃO ───────────────────────────────────────────────────────── */
  describe("regressão: deep link em aba já aberta", () => {
    it("relê os filtros quando a URL muda por fora", () => {
      window.location.hash = "#/mapa";
      const { result } = montar();
      expect(result.current.filtros.municipioId).toBeNull();

      /* É o que acontece ao colar um link, usar voltar/avançar, ou trocar de
         módulo — nenhum desses remonta o provedor. */
      act(() => {
        window.location.hash = "#/praca?uf=SP&mun=3550308&cnae=G";
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });

      expect(result.current.filtros.uf).toBe("SP");
      expect(result.current.filtros.municipioId).toBe(3550308);
      expect(result.current.filtros.secoes).toEqual(["G"]);
    });

    it("volta ao padrão quando a URL perde os parâmetros", () => {
      window.location.hash = "#/praca?uf=BA&mun=2927408";
      const { result } = montar();
      expect(result.current.filtros.municipioId).toBe(2927408);

      act(() => {
        window.location.hash = "#/vendas";
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });

      expect(result.current.filtros.municipioId).toBeNull();
      expect(result.current.filtros.uf).toBe("SP");
    });

    it("não entra em laço quando o hash muda para o valor equivalente", () => {
      /* A escrita usa replaceState (não dispara hashchange), mas trocar de
         módulo dispara — e a comparação precisa descartar o idêntico, senão
         cada navegação vira um render extra. Ordem das seções não conta. */
      window.location.hash = "#/mapa?uf=SP&cnae=G,C";
      const { result } = montar();
      const antes = result.current.filtros;

      act(() => {
        window.location.hash = "#/praca?uf=SP&cnae=C,G";
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });

      expect(result.current.filtros).toBe(antes); // mesma referência
    });
  });
});
