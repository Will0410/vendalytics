/**
 * territorios.test.ts — o desenho automático de território.
 *
 * O que se testa não é a qualidade estética do agrupamento (heurística não
 * tem resposta certa), e sim as garantias sem as quais o resultado é
 * inutilizável para dividir comissão:
 *
 *   • **determinismo** — o mesmo pedido produz o mesmo desenho, sempre;
 *   • **cobertura** — nenhuma praça com mercado fica sem território;
 *   • **compacidade** — territórios não se interpenetram sem motivo;
 *   • **honestidade** — o desequilíbrio relatado é o desequilíbrio real.
 */
import { describe, expect, it } from "vitest";
import { planejarTerritorios } from "./territorios";
import type { Praca } from "../app/useUniverso";

/** Praça mínima para o algoritmo — só o que ele lê. */
function praca(id: number, nome: string, setor: number): Praca {
  return {
    id,
    nome,
    uf: "XX",
    populacao: setor * 100,
    pibTotal: setor * 1_000_000,
    pibPerCapita: 30_000,
    empresasTotal: setor * 4,
    setor,
    crescimento: {
      cagr: 2,
      ultimoAno: 2,
      anoAnterior: 2,
      aceleracao: 0,
      absoluto: 10,
      anoInicial: 2022,
      anoFinal: 2024,
      tendencia: "crescendo",
      serie: [],
    },
    densidade: 40,
    saturacao: 1,
    shareSetor: 0.25,
    pibPorEmpresa: 250_000,
    atratividade: { score: 50, faixa: "B", fatores: [] },
    bruto: {} as Praca["bruto"],
  };
}

/**
 * Duas nuvens bem separadas de 10 praças cada — oeste e leste.
 * Um agrupamento correto em 2 territórios precisa separá-las.
 */
const NUVENS: { p: Praca; lat: number; lon: number }[] = [
  ...Array.from({ length: 10 }, (_, i) => ({
    p: praca(i + 1, `Oeste ${i + 1}`, 100 + i * 10),
    lat: -23 + (i % 3) * 0.2,
    lon: -52 + Math.floor(i / 3) * 0.2,
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    p: praca(i + 21, `Leste ${i + 1}`, 100 + i * 10),
    lat: -23 + (i % 3) * 0.2,
    lon: -42 + Math.floor(i / 3) * 0.2,
  })),
];

const coords = (id: number): [number, number] | null => {
  const achado = NUVENS.find((n) => n.p.id === id);
  return achado ? [achado.lat, achado.lon] : null;
};
const PRACAS = NUVENS.map((n) => n.p);

describe("planejarTerritorios", () => {
  it("separa nuvens geograficamente distantes", () => {
    const plano = planejarTerritorios(PRACAS, coords, { quantidade: 2 })!;
    expect(plano.territorios).toHaveLength(2);

    /* Cada território deve conter praças de UMA nuvem só. Se misturar,
       o vendedor cruzaria 1.000 km entre dois clientes. */
    for (const t of plano.territorios) {
      const lados = new Set(t.pracas.map((p) => p.nome.split(" ")[0]));
      expect(lados.size).toBe(1);
    }
  });

  it("é determinístico — o mesmo pedido, o mesmo desenho", () => {
    /* Território que muda entre dois cliques não serve para dividir comissão.
       É a propriedade que motivou a semente fixa. */
    const a = planejarTerritorios(PRACAS, coords, { quantidade: 3 })!;
    const b = planejarTerritorios(PRACAS, coords, { quantidade: 3 })!;

    const assinatura = (p: typeof a) =>
      p.territorios.map((t) => `${t.sede.id}:${t.pracas.map((x) => x.id).sort().join(",")}`).join("|");

    expect(assinatura(a)).toBe(assinatura(b));
  });

  it("nenhuma praça com mercado fica de fora", () => {
    const plano = planejarTerritorios(PRACAS, coords, { quantidade: 4 })!;
    const atribuidas = plano.territorios.flatMap((t) => t.pracas.map((p) => p.id));

    expect(new Set(atribuidas).size).toBe(PRACAS.length);
    expect(atribuidas.length).toBe(PRACAS.length); // nenhuma em dois territórios
  });

  it("ignora praças sem mercado no setor", () => {
    /* Alocar vendedor para município onde não há um único cliente potencial
       é ruído no desenho. */
    const comVazias = [...PRACAS, praca(99, "Vazia", 0)];
    const coordsMais = (id: number): [number, number] | null =>
      id === 99 ? [-23, -47] : coords(id);

    const plano = planejarTerritorios(comVazias, coordsMais, { quantidade: 2 })!;
    const ids = plano.territorios.flatMap((t) => t.pracas.map((p) => p.id));

    expect(ids).not.toContain(99);
    expect(plano.pracasAtendidas).toBe(PRACAS.length);
  });

  it("a sede é a praça de maior mercado, não o centro geométrico", () => {
    /* O vendedor mora onde estão os clientes. */
    const plano = planejarTerritorios(PRACAS, coords, { quantidade: 2 })!;
    for (const t of plano.territorios) {
      const maior = t.pracas.reduce((a, b) => ((b.setor ?? 0) > (a.setor ?? 0) ? b : a));
      expect(t.sede.id).toBe(maior.id);
    }
  });

  it("equilibra o mercado quando a geografia permite", () => {
    /* As duas nuvens têm mercado idêntico por construção — dividir em 2 tem
       que dar quase zero de desequilíbrio. */
    const plano = planejarTerritorios(PRACAS, coords, { quantidade: 2 })!;
    expect(plano.desequilibrio).toBeLessThan(0.05);
  });

  it("relata o desequilíbrio real quando não consegue equilibrar", () => {
    /* Uma praça indivisível com metade do mercado — é o caso São Paulo. O
       algoritmo não pode consertar, mas TEM que admitir. */
    const gigante = praca(50, "Gigante", 10_000);
    const comGigante = [...PRACAS, gigante];
    const coordsMais = (id: number): [number, number] | null =>
      id === 50 ? [-23, -52] : coords(id);

    const plano = planejarTerritorios(comGigante, coordsMais, { quantidade: 2 })!;

    expect(plano.desequilibrio).toBeGreaterThan(0.5);
    /* E o número relatado precisa bater com os mercados devolvidos. */
    const m = plano.territorios.map((t) => t.mercado);
    const media = m.reduce((a, b) => a + b, 0) / m.length;
    expect(plano.desequilibrio).toBeCloseTo((Math.max(...m) - Math.min(...m)) / media, 5);
  });

  it("a soma dos territórios é o mercado total", () => {
    const plano = planejarTerritorios(PRACAS, coords, { quantidade: 3 })!;
    const soma = plano.territorios.reduce((s, t) => s + t.mercado, 0);
    expect(soma).toBe(plano.mercadoTotal);
    expect(soma).toBe(PRACAS.reduce((s, p) => s + (p.setor ?? 0), 0));
  });

  it("limita a 8 territórios — o teto da paleta validada", () => {
    const plano = planejarTerritorios(PRACAS, coords, { quantidade: 20 })!;
    expect(plano.territorios.length).toBeLessThanOrEqual(8);
  });

  it("devolve null quando não há praças suficientes", () => {
    expect(planejarTerritorios([praca(1, "Única", 10)], coords, { quantidade: 5 })).toBeNull();
    expect(planejarTerritorios([], coords, { quantidade: 2 })).toBeNull();
  });

  it("praça sem coordenada não entra e não quebra", () => {
    const semCoord = () => null;
    expect(planejarTerritorios(PRACAS, semCoord, { quantidade: 2 })).toBeNull();
  });

  it("territórios vêm ordenados por mercado, do maior para o menor", () => {
    const plano = planejarTerritorios(PRACAS, coords, { quantidade: 4 })!;
    const mercados = plano.territorios.map((t) => t.mercado);
    expect([...mercados].sort((a, b) => b - a)).toEqual(mercados);
    expect(plano.territorios.map((t) => t.indice)).toEqual([0, 1, 2, 3]);
  });
});
