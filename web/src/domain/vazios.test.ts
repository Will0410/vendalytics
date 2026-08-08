/**
 * vazios.test.ts — o modelo de lacuna de mercado.
 *
 * O que está amarrado aqui, em ordem de importância:
 *
 *   1. o OLS recupera coeficientes conhecidos. Se ele estiver errado, tudo o
 *      que vem depois repousa sobre elasticidades inventadas e continua
 *      parecendo razoável na tela;
 *   2. a trava de setor. Ela existe porque o teste fora da amostra REPROVOU
 *      Construção, e sem ela o produto entregaria um número de aparência
 *      idêntica para um setor onde ele não significa nada.
 */
import { describe, expect, it } from "vitest";
import { mapearVazios, validadoPara, type EntradaVazio } from "./vazios";

/**
 * Universo sintético com elasticidades CONHECIDAS: 1,0 em população e 0,5 em
 * poder de compra. É o que permite verificar o ajuste contra a resposta certa.
 */
function universo(n: number, ajuste?: (i: number, e: EntradaVazio) => void): EntradaVazio[] {
  const saida: EntradaVazio[] = [];
  for (let i = 0; i < n; i++) {
    const pop = 10_000 + ((i * 7919) % 500_000);
    const pibPc = 15_000 + ((i * 104_729) % 40_000);
    const e: EntradaVazio = {
      id: 1000 + i,
      populacao: pop,
      pibPerCapita: pibPc,
      empresas: Math.round(Math.exp(-6 + 1.0 * Math.log(pop) + 0.5 * Math.log(pibPc))),
    };
    ajuste?.(i, e);
    saida.push(e);
  }
  return saida;
}

describe("mapearVazios", () => {
  it("recupera as elasticidades usadas para gerar o dado", () => {
    const r = mapearVazios(universo(400));

    expect(r.r2).toBeGreaterThan(0.99);
    expect(r.coeficientes.populacao).toBeCloseTo(1.0, 1);
    expect(r.coeficientes.poderDeCompra).toBeCloseTo(0.5, 1);
  });

  it("aponta como desabastecido quem foi rebaixado de propósito", () => {
    /* Um município com metade das empresas que seu porte e sua renda pedem. */
    const alvo = 1007;
    const r = mapearVazios(
      universo(400, (_, e) => {
        if (e.id === alvo) e.empresas = Math.round((e.empresas as number) * 0.5);
      }),
    );
    const v = r.porId.get(alvo);

    expect(v).toBeDefined();
    expect(v?.residuo).toBeLessThan(-0.5); // ln(0,5) ≈ -0,69
    expect(v?.lacuna).toBeGreaterThan(0); // faltam empresas
    expect(v?.percentil).toBeGreaterThan(95);
  });

  it("aponta como saturado quem foi inflado de propósito", () => {
    const alvo = 1011;
    const r = mapearVazios(
      universo(400, (_, e) => {
        if (e.id === alvo) e.empresas = Math.round((e.empresas as number) * 2);
      }),
    );
    const v = r.porId.get(alvo);

    expect(v?.residuo).toBeGreaterThan(0.5);
    expect(v?.lacuna).toBeLessThan(0); // sobra empresa
    expect(v?.percentil).toBeLessThan(5);
  });

  it("separa cidade pobre de cidade desabastecida", () => {
    /* O caso que justifica o modelo existir, e que a densidade sozinha erra.
       Duas cidades com a MESMA densidade de empresas: uma pobre, outra rica.
       Só a rica é oportunidade — na pobre, a densidade baixa é explicada pela
       renda, e não há demanda reprimida nenhuma. */
    const base = universo(300);
    const pobre: EntradaVazio = {
      id: 9001, populacao: 100_000, pibPerCapita: 12_000, empresas: 900,
    };
    const rica: EntradaVazio = {
      id: 9002, populacao: 100_000, pibPerCapita: 60_000, empresas: 900,
    };

    const r = mapearVazios([...base, pobre, rica]);
    const vp = r.porId.get(9001);
    const vr = r.porId.get(9002);

    expect(vr?.percentil).toBeGreaterThan(vp?.percentil as number);
    expect(vr?.lacuna).toBeGreaterThan(vp?.lacuna as number);
  });

  it("não deixa uma renda absurda inflar o esperado", () => {
    /* Maricá/RJ tem R$ 631 mil de PIB per capita por royalties de petróleo, e
       Paulínia/SP tem R$ 575 mil por causa da refinaria — contra uma mediana
       nacional de R$ 13,5 mil. Isso não é poder de compra das famílias; é uma
       planta industrial dividida pela população.

       Sem teto, o modelo esperava 24 comércios por mil habitantes para esses
       municípios. Nenhum município brasileiro chega perto disso, e o erro cai
       justamente no topo do ranking — onde as pessoas agem. */
    const entradas = universo(300);
    /* Mesma população, mesmo número de empresas. A única diferença é a renda:
       uma alta e plausível, a outra dez vezes maior — o caso dos royalties. */
    const rica: EntradaVazio = {
      id: 9100, populacao: 200_000, pibPerCapita: 60_000, empresas: 1_800,
    };
    const royalties: EntradaVazio = {
      id: 9101, populacao: 200_000, pibPerCapita: 600_000, empresas: 1_800,
    };

    const r = mapearVazios([...entradas, rica, royalties]);
    const a = r.porId.get(9100);
    const b = r.porId.get(9101);

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    /* Com o teto, as duas caem no mesmo ponto do modelo. Sem ele, a segunda
       esperaria ~3x mais empresas só porque tem uma refinaria dentro. */
    expect(b?.esperado).toBeCloseTo(a?.esperado as number, 6);
  });

  it("o teto sai da amostra, não de um valor fixo em reais", () => {
    /* Um teto em reais de 2013 estaria errado em 2024 só por inflação. Dobrar
       todas as rendas não pode mudar a ordem de ninguém. */
    const base = universo(300);
    const dobrado = base.map((e) => ({
      ...e,
      pibPerCapita: (e.pibPerCapita as number) * 2,
    }));

    const a = mapearVazios(base).vazios.map((v) => v.id);
    const b = mapearVazios(dobrado).vazios.map((v) => v.id);
    expect(b).toEqual(a);
  });

  it("ordena do mais desabastecido para o mais saturado", () => {
    const r = mapearVazios(universo(300));
    const residuos = r.vazios.map((v) => v.residuo);

    expect(residuos).toEqual([...residuos].sort((a, b) => a - b));
    expect(r.vazios[0]?.percentil).toBeGreaterThan(
      r.vazios[r.vazios.length - 1]?.percentil as number,
    );
  });

  it("dá o mesmo percentil a resíduos idênticos", () => {
    /* Dois municípios iguais não podem sair em posições diferentes só pela
       ordem em que chegaram na lista. */
    const entradas = universo(200);
    const a = entradas[10] as EntradaVazio;
    const b = entradas[11] as EntradaVazio;
    b.populacao = a.populacao;
    b.pibPerCapita = a.pibPerCapita;
    b.empresas = a.empresas;

    const r = mapearVazios(entradas);
    expect(r.porId.get(b.id)?.percentil).toBeCloseTo(
      r.porId.get(a.id)?.percentil as number,
      6,
    );
  });

  it("o esperado bate com a lacuna e com o resíduo", () => {
    /* Três leituras do mesmo ajuste. Se divergirem, a tela mostra um número
       e o ranking usa outro. */
    const r = mapearVazios(universo(200));
    for (const v of r.vazios.slice(0, 20)) {
      expect(v.lacuna).toBeCloseTo(v.esperado - v.observado, 6);
      expect(v.residuo).toBeCloseTo(Math.log(v.observado / v.esperado), 6);
    }
  });

  it("deixa de fora quem está abaixo do piso de porte", () => {
    /* Município com 5 empresas: uma abertura é +20%. Isso é cadastro, não
       mercado, e entraria no ajuste como ruído puro. */
    const entradas = universo(300, (i, e) => {
      if (i === 5) e.empresas = 5;
    });
    const r = mapearVazios(entradas);

    expect(r.porId.has(entradas[5]?.id as number)).toBe(false);
    expect(r.amostra).toBe(299);
  });

  it("ignora município sem população, sem PIB ou sem empresas", () => {
    const r = mapearVazios(
      universo(300, (i, e) => {
        if (i === 1) e.populacao = null;
        if (i === 2) e.pibPerCapita = null;
        if (i === 3) e.empresas = null;
      }),
    );
    expect(r.amostra).toBe(297);
  });

  it("devolve resultado vazio — não estoura — com amostra insuficiente", () => {
    const r = mapearVazios(universo(10));

    expect(r.vazios).toEqual([]);
    expect(r.amostra).toBe(0);
    expect(r.r2).toBe(0);
  });

  it("não compartilha o Map entre chamadas vazias", () => {
    /* O objeto de retorno vazio é uma constante de módulo. Se o Map dela
       vazasse, uma chamada bem-sucedida contaminaria a seguinte. */
    const a = mapearVazios(universo(10));
    a.porId.set(999, {} as never);
    expect(mapearVazios(universo(10)).porId.size).toBe(0);
  });
});

describe("validadoPara", () => {
  it("libera as seções em que o indicador foi validado", () => {
    expect(validadoPara("G")).toBe(true); // Comércio, rho = -0,225
    expect(validadoPara("C")).toBe(true); // Indústria, rho = -0,178
    expect(validadoPara("g")).toBe(true);
  });

  it("bloqueia Construção, reprovada no teste fora da amostra", () => {
    /* rho = +0,040: sinal nulo E trocado. Construtora não fica onde atende —
       empresa de São Paulo constrói na Bahia — e a premissa de equilíbrio de
       mercado local não vale. */
    expect(validadoPara("F")).toBe(false);
  });

  it("bloqueia qualquer seção não testada", () => {
    for (const s of ["A", "B", "D", "E", "H", "I", "J", "K", "L", "M"]) {
      expect(validadoPara(s)).toBe(false);
    }
  });
});
