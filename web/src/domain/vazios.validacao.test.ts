/**
 * vazios.validacao.test.ts — a evidência, em forma executável.
 *
 * Os outros testes verificam propriedades do código sobre dado sintético. Este
 * verifica a única coisa que o dado sintético não alcança: **que o modelo que
 * está em produção é o mesmo que foi validado.**
 *
 * O indicador foi medido em Python, fora da amostra: ajuste com dados de 2013,
 * confronto com o crescimento 2015–2020. Depois foi portado para TypeScript
 * para rodar no navegador. Um port infiel entrega um número validado por um
 * algoritmo que não é o que está rodando — e ninguém percebe, porque a saída
 * continua parecendo razoável.
 *
 * Este arquivo roda o TypeScript sobre o conjunto EXATO da pesquisa e compara
 * com os valores que o Python produziu. Se alguém "melhorar" o modelo sem
 * revalidar, a divergência aparece aqui.
 *
 * Roda também como documentação: o rho abaixo é a acurácia real do indicador,
 * e ela é modesta de propósito — quem for vender isso como previsão tem, neste
 * arquivo, o número que desmente.
 */
import { describe, expect, it } from "vitest";
import { mapearVazios } from "./vazios";
import conjunto from "./__fixtures__/cempre-comercio-2013-2020.json";

type Linha = [
  id: number,
  populacao: number,
  pibPerCapita: number,
  empresas2013: number,
  empresas2015: number,
  empresas2020: number,
];

const linhas = conjunto.linhas as Linha[];
const referencia = conjunto._referencia_python;

/** Correlação de posto. Variação percentual de município pequeno tem cauda
 *  pesadíssima — de 2 para 4 empresas é +100% — e Pearson viraria refém. */
function spearman(xs: number[], ys: number[]): number {
  const postos = (v: number[]): number[] => {
    const ordem = [...v.keys()].sort((a, b) => (v[a] as number) - (v[b] as number));
    const r = new Array<number>(v.length).fill(0);
    let i = 0;
    while (i < ordem.length) {
      let j = i;
      while (j + 1 < ordem.length && v[ordem[j + 1] as number] === v[ordem[i] as number]) j++;
      const media = (i + j) / 2 + 1;
      for (let t = i; t <= j; t++) r[ordem[t] as number] = media;
      i = j + 1;
    }
    return r;
  };
  const a = postos(xs);
  const b = postos(ys);
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] as number) - ma;
    const y = (b[i] as number) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

describe("validação fora da amostra (CEMPRE 2013 → 2015-2020, Comércio)", () => {
  const resultado = mapearVazios(
    linhas.map(([id, populacao, pibPerCapita, empresas2013]) => ({
      id,
      populacao,
      pibPerCapita,
      empresas: empresas2013,
    })),
  );

  it("o ajuste em TypeScript é o mesmo que o do Python", () => {
    expect(resultado.amostra).toBe(referencia.n);
    expect(resultado.r2).toBeCloseTo(referencia.r2, 5);
    expect(resultado.coeficientes.populacao).toBeCloseTo(referencia.coef_populacao, 5);
    expect(resultado.coeficientes.poderDeCompra).toBeCloseTo(
      referencia.coef_poder_de_compra,
      5,
    );
  });

  it("a elasticidade da população é ~1 e a do poder de compra é positiva", () => {
    /* Não é decoração: se a população saísse longe de 1, o modelo estaria
       dizendo que empresa não escala com gente, e aí ele não descreve mercado
       nenhum. O coeficiente positivo do poder de compra é o que separa este
       modelo da densidade pura. */
    expect(resultado.coeficientes.populacao).toBeGreaterThan(0.9);
    expect(resultado.coeficientes.populacao).toBeLessThan(1.1);
    expect(resultado.coeficientes.poderDeCompra).toBeGreaterThan(0.3);
  });

  it("o resíduo de 2013 antecipa o crescimento de 2015 a 2020", () => {
    /* A afirmação central do módulo, e a razão de ele existir.
       Sinal NEGATIVO: quem está abaixo do esperado cresce mais depois.
       Nenhum dado de 2015 ou 2020 entrou no ajuste. */
    const crescimento = new Map(
      linhas.map(([id, , , , e15, e20]) => [id, Math.log(e20 / e15)]),
    );

    const res: number[] = [];
    const cre: number[] = [];
    for (const v of resultado.vazios) {
      const c = crescimento.get(v.id);
      if (c === undefined || !Number.isFinite(c)) continue;
      res.push(v.residuo);
      cre.push(c);
    }

    expect(spearman(res, cre)).toBeCloseTo(referencia.rho_residuo_crescimento, 4);
    expect(spearman(res, cre)).toBeLessThan(-0.2);
  });

  it("bate a densidade pura, que é a referência honesta", () => {
    /* Se o modelo não superasse log(empresas ÷ população), ele seria um nome
       novo para uma conta velha — e o módulo inteiro seria injustificável. */
    const porId = new Map(linhas.map((l) => [l[0], l]));
    const res: number[] = [];
    const dens: number[] = [];
    const cre: number[] = [];
    for (const v of resultado.vazios) {
      const l = porId.get(v.id);
      if (!l) continue;
      const c = Math.log(l[5] / l[4]);
      if (!Number.isFinite(c)) continue;
      res.push(v.residuo);
      dens.push(Math.log(l[3] / l[1]));
      cre.push(c);
    }

    const rhoModelo = spearman(res, cre);
    const rhoDensidade = spearman(dens, cre);

    expect(rhoModelo).toBeLessThan(rhoDensidade); // mais negativo = melhor
    expect(Math.abs(rhoModelo)).toBeGreaterThan(Math.abs(rhoDensidade) * 1.3);
  });

  it("os mais desabastecidos crescem mais que os mais saturados", () => {
    /* A leitura que um vendedor faz: o primeiro decil contra o último.
       É esta diferença que justifica priorizar por lacuna. */
    const crescimento = new Map(
      linhas.map(([id, , , , e15, e20]) => [id, Math.log(e20 / e15)]),
    );
    const validos = resultado.vazios.filter((v) => {
      const c = crescimento.get(v.id);
      return c !== undefined && Number.isFinite(c);
    });

    const d = Math.floor(validos.length / 10);
    const media = (fatia: typeof validos) =>
      fatia.reduce((s, v) => s + (crescimento.get(v.id) as number), 0) / fatia.length;

    /* `vazios` vem ordenado do resíduo mais negativo (mais desabastecido). */
    const desabastecidos = media(validos.slice(0, d));
    const saturados = media(validos.slice(-d));

    expect(desabastecidos).toBeGreaterThan(saturados);
    /* A diferença medida foi de ~17 pontos percentuais em 5 anos. */
    expect(Math.exp(desabastecidos) - Math.exp(saturados)).toBeGreaterThan(0.1);
  });
});
