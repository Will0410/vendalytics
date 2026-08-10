/**
 * sintetico.test.ts — o contrafactual acha efeito onde existe, e cala onde não?
 *
 * A segunda metade é a que importa. Um método de inferência causal que sempre
 * encontra alguma coisa é pior que método nenhum: ele produz justificativa
 * para qualquer decisão já tomada, com aparência de evidência.
 *
 * Por isso o teste central aqui roda sobre a série REAL do IBGE, em municípios
 * onde nenhuma intervenção houve, e exige que os falsos positivos fiquem perto
 * do que o acaso produz.
 */
import { describe, expect, it } from "vitest";
import { contrafactual, type SerieMunicipio } from "./sintetico";
import historico from "./__fixtures__/serie-historica-amostra.json";

const ANOS: number[] = (historico as { anos: number[] }).anos;
const SERIE = (historico as { series: Record<string, number[]> }).series;

const universo: SerieMunicipio[] = Object.entries(SERIE).map(([id, valores]) => ({
  id: Number(id),
  valores,
}));

/** Índice do ano de corte usado nos testes: sobra pré e pós. */
const CORTE = 10; // 2006–2015 como pré, 2016–2021 como pós

describe("o artefato de série", () => {
  it("traz 16 anos e municípios com série completa", () => {
    expect(ANOS).toHaveLength(16);
    expect(universo.length).toBeGreaterThan(200);
    expect(universo.every((m) => m.valores.length === 16)).toBe(true);
  });
});

describe("contrafactual", () => {
  it("acompanha o tratado no período pré", () => {
    /* É o ajuste pré que dá crédito ao contrafactual: um sintético que não
       acompanhou o passado não tem por que acompanhar o futuro. */
    const alvo = universo[0] as SerieMunicipio;
    const r = contrafactual(alvo, universo, CORTE);

    expect(r).not.toBeNull();
    expect(r?.rmspePre).toBeLessThan(0.25); // ~25% em log ≈ erro médio tolerável
    expect(r?.sintetico).toHaveLength(16);
  });

  it("os pesos formam uma combinação, não uma extrapolação", () => {
    /* A restrição do simplex é o que impede o "município sintético" de ser
       uma combinação que não corresponde a lugar nenhum. */
    const r = contrafactual(universo[3] as SerieMunicipio, universo, CORTE);
    const soma = (r?.pesos ?? []).reduce((s, p) => s + p.peso, 0);

    expect(soma).toBeGreaterThan(0.98);
    expect(soma).toBeLessThan(1.02);
    expect((r?.pesos ?? []).every((p) => p.peso >= 0)).toBe(true);
  });

  it("nunca usa o próprio tratado como doador", () => {
    const alvo = universo[5] as SerieMunicipio;
    const r = contrafactual(alvo, universo, CORTE);
    expect((r?.pesos ?? []).some((p) => p.id === alvo.id)).toBe(false);
  });

  it("recusa corte sem período suficiente dos dois lados", () => {
    /* Sem pré não há como validar o ajuste; sem pós não há efeito a medir. */
    const alvo = universo[0] as SerieMunicipio;
    expect(contrafactual(alvo, universo, 2)).toBeNull();
    expect(contrafactual(alvo, universo, 15)).toBeNull();
  });

  it("recusa quando não há doadores comparáveis", () => {
    const gigante: SerieMunicipio = {
      id: 999999,
      valores: ANOS.map((_, i) => 5_000_000 + i * 1000),
    };
    expect(contrafactual(gigante, universo, CORTE)).toBeNull();
  });
});

describe("detecção de efeito", () => {
  it("encontra um choque grande que foi injetado", () => {
    /* Verdade conhecida: dobra o tratado depois do corte. Se o método não
       pegar isto, não pega nada. */
    const base = universo[7] as SerieMunicipio;
    const tratado: SerieMunicipio = {
      id: base.id,
      valores: base.valores.map((v, t) => (t >= CORTE ? v * 2 : v)),
    };

    const r = contrafactual(tratado, universo, CORTE);
    expect(r).not.toBeNull();
    expect(r?.razao).toBeGreaterThan(3);
    expect(r?.p).toBeLessThan(0.1);
    /* O efeito estimado tem que ter o sinal certo e ordem de grandeza certa. */
    const ultimo = (r?.efeito ?? [])[15] as number;
    expect(ultimo).toBeGreaterThan(0);
  });

  it("o efeito estimado é ~zero antes da intervenção", () => {
    const base = universo[7] as SerieMunicipio;
    const tratado: SerieMunicipio = {
      id: base.id,
      valores: base.valores.map((v, t) => (t >= CORTE ? v * 2 : v)),
    };
    const r = contrafactual(tratado, universo, CORTE);

    /* Se o "efeito" já existisse no pré, ele não seria efeito da intervenção
       — seria erro de ajuste com outro nome. */
    const preMedio =
      (r?.efeito ?? []).slice(0, CORTE).reduce((s, e) => s + Math.abs(e), 0) / CORTE;
    const posFinal = Math.abs((r?.efeito ?? [])[15] as number);
    expect(preMedio).toBeLessThan(posFinal / 3);
  });
});

describe("o método cala onde não há efeito", () => {
  /* ── O teste que decide se isto entra no produto ────────────────────────
     Série real, nenhuma intervenção. Se o método achasse "efeito" em boa
     parte desses casos, ele estaria fabricando justificativa para qualquer
     decisão já tomada — com aparência de evidência. */

  /* 30s de folga: cada município roda 1 ajuste + 40 placebos, e são 60
     municípios. É custo DESTE teste, não do produto — uma chamada isolada
     leva ~140ms, que é o que a tela paga. */
  it("os falsos positivos ficam perto do que o acaso produz", { timeout: 30_000 }, () => {
    const amostra = universo.slice(0, 60);
    const ps: number[] = [];
    for (const m of amostra) {
      const r = contrafactual(m, universo, CORTE);
      if (r && r.rmspePre > 0) ps.push(r.p);
    }

    expect(ps.length).toBeGreaterThan(30);
    const significativos = ps.filter((p) => p < 0.1).length / ps.length;
    /* Com p < 0,10 e nenhum efeito real, espera-se ~10%. A folga até 25%
       cobre a resolução grosseira do placebo (o denominador é o número de
       doadores) sem deixar passar um método que acha efeito em todo lugar. */
    expect(significativos, `${(significativos * 100).toFixed(0)}% deram p < 0,10`)
      .toBeLessThan(0.25);
  });

  it("a mediana do p fica longe de zero", { timeout: 30_000 }, () => {
    const ps: number[] = [];
    for (const m of universo.slice(0, 60)) {
      const r = contrafactual(m, universo, CORTE);
      if (r) ps.push(r.p);
    }
    ps.sort((a, b) => a - b);
    const mediana = ps[Math.floor(ps.length / 2)] as number;
    expect(mediana).toBeGreaterThan(0.25);
  });
});
