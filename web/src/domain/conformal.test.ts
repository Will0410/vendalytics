/**
 * conformal.test.ts — o intervalo cobre o que promete?
 *
 * Predição conformal vem com garantia teórica sob trocabilidade. Este arquivo
 * existe porque garantia teórica não é evidência: se o dado violar a hipótese,
 * o intervalo mente e nada na tela denuncia.
 *
 * A medição roda sobre o conjunto REAL da pesquisa (CEMPRE 2013, 4.979
 * municípios) — o mesmo que valida o modelo de vazios.
 */
import { describe, expect, it } from "vitest";
import { COBERTURA, calibrar, intervalo, medirCobertura, type Ponto } from "./conformal";
import conjunto from "./__fixtures__/cempre-comercio-2013-2020.json";

type Linha = [number, number, number, number, number, number];
const linhas = conjunto.linhas as Linha[];

/** Mesma preparação de `vazios.ts`: piso de porte e teto de renda no p95. */
function pontos(): Ponto[] {
  const usaveis = linhas.filter((l) => l[3] >= 20 && l[1] > 0 && l[2] > 0);
  const rendas = usaveis.map((l) => l[2]).sort((a, b) => a - b);
  const teto = rendas[Math.min(Math.floor(0.95 * rendas.length), rendas.length - 1)] as number;
  return usaveis.map((l) => ({
    x: [1, Math.log(l[1]), Math.log(Math.min(l[2], teto))],
    y: Math.log(l[3]),
  }));
}

/** OLS de referência sobre TODOS os pontos — é o modelo que a tela mostra. */
function ajusteCompleto(ps: Ponto[]): number[] {
  const k = 3;
  const A: number[][] = [];
  for (let i = 0; i < k; i++) {
    const linha = new Array<number>(k + 1).fill(0);
    for (let j = 0; j < k; j++) {
      linha[j] = ps.reduce((s, p) => s + (p.x[i] as number) * (p.x[j] as number), 0);
    }
    linha[k] = ps.reduce((s, p) => s + (p.x[i] as number) * p.y, 0);
    A.push(linha);
  }
  for (let i = 0; i < k; i++) {
    const pivo = A[i]?.[i] as number;
    for (let r = 0; r < k; r++) {
      if (r === i) continue;
      const f = (A[r]?.[i] as number) / pivo;
      for (let c = i; c <= k; c++) {
        (A[r] as number[])[c] = (A[r]?.[c] as number) - f * (A[i]?.[c] as number);
      }
    }
  }
  return Array.from({ length: k }, (_, i) => (A[i]?.[k] as number) / (A[i]?.[i] as number));
}

const ps = pontos();
const cal = calibrar(ps);
const beta = ajusteCompleto(ps);

describe("calibração", () => {
  it("calibra sobre a amostra real", () => {
    expect(cal).not.toBeNull();
    expect(cal?.n).toBeGreaterThan(1500);
    expect(cal?.q).toBeGreaterThan(0);
    expect(Number.isFinite(cal?.q as number)).toBe(true);
  });

  it("recusa calibrar quando a amostra não sustenta o quantil", () => {
    /* Melhor não ter intervalo do que ter um que não cobre o que promete. */
    expect(calibrar(ps.slice(0, 40))).toBeNull();
  });

  it("é determinística — o mesmo universo dá o mesmo intervalo", () => {
    /* Se a partição fosse aleatória, o número na tela mudaria a cada F5. */
    expect(calibrar(ps)?.q).toBe(cal?.q);
  });
});

describe("cobertura empírica", () => {
  /* ── A medição que decide se isto entra no produto ────────────────────── */

  it("cobre pelo menos o nominal de 90%", () => {
    const c = medirCobertura(cal as never, ps, beta);
    expect(c).toBeGreaterThanOrEqual(COBERTURA - 0.02);
  });

  it("cobre também nos extremos de porte, não só na média", () => {
    /* Cobertura global boa pode esconder um intervalo que erra sistematicamente
       nas praças pequenas — que são a maioria do país e a maioria do ranking. */
    const porPop = [...ps].sort((a, b) => (a.x[1] as number) - (b.x[1] as number));
    const n = porPop.length;
    const faixas: Array<[string, Ponto[]]> = [
      ["menores 20%", porPop.slice(0, Math.floor(n * 0.2))],
      ["meio", porPop.slice(Math.floor(n * 0.4), Math.floor(n * 0.6))],
      ["maiores 20%", porPop.slice(Math.floor(n * 0.8))],
    ];
    for (const [rotulo, faixa] of faixas) {
      const c = medirCobertura(cal as never, faixa, beta);
      expect(c, `cobertura na faixa ${rotulo}`).toBeGreaterThan(0.8);
    }
  });

  it("cobertura maior pede intervalo maior — a troca é monotônica", () => {
    const q80 = calibrar(ps, 0.8)?.q as number;
    const q90 = calibrar(ps, 0.9)?.q as number;
    const q99 = calibrar(ps, 0.99)?.q as number;
    expect(q80).toBeLessThan(q90);
    expect(q90).toBeLessThan(q99);
  });
});

describe("intervalo normalizado", () => {
  it("não devolve a mesma largura para todo mundo", () => {
    /* A versão simples do conformal daria largura constante — válida e inútil
       aqui, porque a abstenção viraria tudo-ou-nada.

       Medido na amostra inteira: razão máx/mín de 1,62. A primeira versão
       deste teste olhava só os 400 primeiros pontos e dava 1,49 — a lista
       chega ordenada por código IBGE, então esse recorte é meia dúzia de
       estados, não uma amostra do país. */
    const larguras = ps.map((p) => intervalo(cal as never, p.x, 0).meiaLargura);
    const min = Math.min(...larguras);
    const max = Math.max(...larguras);
    expect(max / min).toBeGreaterThan(1.5);
  });

  it("a banda é multiplicativa e larga — e é isso que justifica calar", () => {
    /* O modelo trabalha em log, então o intervalo vira um fator na escala de
       empresas: cerca de x2 para cada lado. Um intervalo desses NÃO sustenta
       afirmar lacuna para quem está perto do esperado, e é exatamente por isso
       que a abstenção existe. */
    const meia = ps.map((p) => intervalo(cal as never, p.x, 0).meiaLargura).sort((a, b) => a - b);
    const mediana = meia[Math.floor(meia.length / 2)] as number;
    expect(Math.exp(mediana)).toBeGreaterThan(1.7);
    expect(Math.exp(mediana)).toBeLessThan(2.6);
  });

  it("o intervalo contém a previsão e é simétrico na escala do modelo", () => {
    for (const p of ps.slice(0, 50)) {
      const iv = intervalo(cal as never, p.x, 5);
      expect(iv.baixo).toBeLessThan(5);
      expect(iv.alto).toBeGreaterThan(5);
      expect(5 - iv.baixo).toBeCloseTo(iv.alto - 5, 10);
    }
  });
});
