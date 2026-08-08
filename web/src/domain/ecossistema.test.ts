/**
 * ecossistema.test.ts — a rede de capacidades.
 *
 * Diferente dos outros testes de domínio, este roda sobre o ARTEFATO REAL
 * (`data/espaco-cnae.json`, IBGE 2024) e não sobre dado sintético. É de
 * propósito: o que precisa ser amarrado aqui não é a aritmética — é que a rede
 * gerada offline continue coerente com o que a validação mediu.
 *
 * Se alguém regerar o artefato com outro nível da CNAE, outro ano ou outra
 * definição de RCA, estes testes quebram. É o objetivo.
 */
import { describe, expect, it } from "vitest";
import {
  AUC_MINIMO,
  aucDe,
  calcularProntidao,
  divisoes,
  divisoesValidadas,
  indiceDoCodigo,
  popularidadeDe,
  validadaPara,
} from "./ecossistema";

/* Códigos CNAE de divisão usados nos testes, com nome por extenso para o dia
   em que alguém precisar entender o que falhou sem abrir o IBGE. */
const METALURGIA = "24";
const MAQUINAS = "28"; // Fabricação de máquinas e equipamentos
const VAREJO = "47";

describe("o artefato", () => {
  it("traz as 87 divisões da CNAE 2.0", () => {
    /* Nível 2 da classificação 12762. Nível 1 são 21 seções (grosso demais
       para haver rede) e nível 3 são 284 grupos (a API não entrega). */
    expect(divisoes()).toHaveLength(87);
    expect(divisoes().every((d) => d.codigo && d.nome)).toBe(true);
    /* Cada divisão carrega o próprio AUC — é o que permite o portão medido. */
    expect(divisoes().every((d) => d.auc === null || typeof d.auc === "number")).toBe(true);
  });

  it("os códigos que os testes usam existem", () => {
    for (const c of [METALURGIA, MAQUINAS, VAREJO]) {
      expect(indiceDoCodigo(c), `divisão ${c}`).toBeGreaterThanOrEqual(0);
    }
    expect(indiceDoCodigo("99999")).toBe(-1);
  });
});

describe("o portão medido", () => {
  /* O artefato traz o AUC de cada divisão, medido fora da amostra. É ele que
     decide o que o produto oferece — não uma heurística sobre popularidade.

     Isto substituiu um chute meu: eu barrava por "ubiquidade > 70%", que pega
     varejo e administração pública mas deixa passar Educação (31% de
     ubiquidade, AUC 0,423) e Agricultura (28%, AUC 0,470). */

  it("reprova varejo, que é o caso óbvio", () => {
    const i = indiceDoCodigo(VAREJO);
    expect(aucDe(i)).toBeLessThan(AUC_MINIMO);
    expect(validadaPara(i)).toBe(false);
  });

  it("reprova Educação, que a heurística de ubiquidade deixaria passar", () => {
    /* 31% de ubiquidade — longe do corte de 70% que eu usava — e AUC 0,423.
       Escola acompanha população; não precisa de ecossistema nenhum. */
    const i = indiceDoCodigo("85");
    expect(popularidadeDe(i)).toBeLessThan(0.7);
    expect(aucDe(i)).toBeLessThan(AUC_MINIMO);
    expect(validadaPara(i)).toBe(false);
  });

  it("aprova fabricação de máquinas", () => {
    const i = indiceDoCodigo(MAQUINAS);
    expect(aucDe(i)).toBeGreaterThanOrEqual(AUC_MINIMO);
    expect(validadaPara(i)).toBe(true);
  });

  it("as melhores são atividades de capacidade específica", () => {
    /* O padrão que dá sentido ao método: a rede prevê o que exige capacidade
       e falha no que só acompanha gente. Se um dia o topo virar "varejo",
       alguma coisa quebrou na geração do artefato. */
    const topo = divisoesValidadas().slice(0, 8).map((d) => d.divisao.codigo);
    expect(topo).toContain("21"); // farmoquímicos
    expect(topo).not.toContain("47"); // varejo
    expect(topo).not.toContain("84"); // administração pública
  });

  it("divisão sem AUC medido é reprovada — não medido não é aprovado", () => {
    const semAuc = divisoes().findIndex((d) => d.auc === null);
    if (semAuc >= 0) expect(validadaPara(semAuc)).toBe(false);
  });

  it("a maioria das divisões passa, senão o produto não teria o que oferecer", () => {
    const n = divisoesValidadas().length;
    expect(n).toBeGreaterThan(50);
    expect(n).toBeLessThan(87);
  });
});

describe("calcularProntidao", () => {
  const r = calcularProntidao(indiceDoCodigo(MAQUINAS));

  it("cobre os 5.570 municípios entre quem tem e quem não tem", () => {
    expect(r.prontos.length + r.jaTem).toBe(5570);
    expect(r.jaTem).toBeGreaterThan(100);
  });

  it("devolve ordenado por prontidão", () => {
    const v = r.prontos.map((p) => p.prontidao);
    expect(v).toEqual([...v].sort((a, b) => b - a));
  });

  it("prontidão é a média geométrica de densidade e popularidade", () => {
    /* A forma validada: sqrt(d × p) deu AUC 0,7540 contra 0,7549 da logística
       ajustada, cujos pesos saíram +0,999 e +0,997. Se alguém trocar por uma
       soma ponderada, este teste avisa. */
    for (const p of r.prontos.slice(0, 40)) {
      expect(p.prontidao).toBeCloseTo(Math.sqrt(p.densidade * r.popularidade), 10);
    }
  });

  it("densidade fica entre 0 e 1", () => {
    for (const p of r.prontos) {
      expect(p.densidade).toBeGreaterThanOrEqual(0);
      expect(p.densidade).toBeLessThanOrEqual(1);
    }
  });

  it("nunca lista quem já tem a atividade", () => {
    expect(r.prontos.every((p) => !p.jaTem)).toBe(true);
  });

  it("explica a recomendação com as capacidades já presentes", () => {
    /* O score sozinho é um número. As vizinhas são o argumento que um
       vendedor usa na porta do cliente. */
    const topo = r.prontos[0];
    expect(topo?.vizinhas.length).toBeGreaterThan(0);
    expect(topo?.vizinhas.length).toBeLessThanOrEqual(3);
    /* Ordenadas da mais próxima para a menos. */
    const phis = topo?.vizinhas.map((v) => v.phi) ?? [];
    expect(phis).toEqual([...phis].sort((a, b) => b - a));
  });

  it("recorta por UF sem reconstruir a rede", () => {
    /* A proximidade entre atividades é propriedade da economia brasileira, não
       da UF. Reestimá-la em 75 municípios de Sergipe produziria ruído. */
    const alguns = new Set(r.prontos.slice(0, 200).map((p) => p.municipioId));
    const recorte = calcularProntidao(indiceDoCodigo(MAQUINAS), alguns);

    expect(recorte.prontos.length + recorte.jaTem).toBeLessThanOrEqual(200);
    for (const p of recorte.prontos) {
      const nacional = r.prontos.find((x) => x.municipioId === p.municipioId);
      expect(p.densidade).toBeCloseTo(nacional?.densidade as number, 10);
    }
  });

  /* ── Sanidade econômica ────────────────────────────────────────────────
     Um teste estatístico passa com uma rede embaralhada. Estes não. */
  it("metalurgia e fabricação de máquinas são vizinhas próximas", () => {
    /* Se a rede não capturar isto, ela não está medindo capacidade nenhuma. */
    const maquinas = calcularProntidao(indiceDoCodigo(MAQUINAS));
    const comMetalurgia = maquinas.prontos.filter((p) =>
      p.vizinhas.some((v) => v.codigo === METALURGIA),
    );
    expect(comMetalurgia.length).toBeGreaterThan(0);

    /* Quem tem metalurgia entre as três vizinhas mais fortes está, em média,
       mais pronto para máquinas do que o município mediano. */
    const medianaGeral =
      maquinas.prontos[Math.floor(maquinas.prontos.length / 2)]?.prontidao ?? 0;
    const mediaComMetalurgia =
      comMetalurgia.reduce((s, p) => s + p.prontidao, 0) / comMetalurgia.length;
    expect(mediaComMetalurgia).toBeGreaterThan(medianaGeral);
  });
});
