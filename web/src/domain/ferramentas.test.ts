/**
 * ferramentas.test.ts — o que o agente de IA pode fazer.
 *
 * Estas funções são a única fonte de números do Copiloto: o modelo não recebe
 * dado nenhum, só o retorno daqui. Um erro neste arquivo não vira tela
 * quebrada — vira uma resposta fluente e errada, que é bem pior, porque
 * ninguém desconfia de um parágrafo bem escrito.
 *
 * O foco está na ferramenta preditiva (`vazios_de_mercado`), que é a única com
 * um portão: ela precisa RECUSAR setores onde o indicador foi reprovado, e
 * precisa devolver a própria acurácia junto com o resultado.
 */
import { describe, expect, it } from "vitest";
import { FERRAMENTAS, executarFerramenta } from "./ferramentas";
import type { Praca, Universo } from "../app/useUniverso";

/** Universo sintético com elasticidades conhecidas, grande o bastante para o
 *  modelo ajustar (o piso é 50 municípios). */
function universoFalso(n = 200): Universo {
  const pracas: Praca[] = [];
  for (let i = 0; i < n; i++) {
    const populacao = 20_000 + ((i * 7919) % 900_000);
    const pibPerCapita = 15_000 + ((i * 104_729) % 40_000);
    const setor = Math.round(
      Math.exp(-6 + Math.log(populacao) + 0.5 * Math.log(pibPerCapita)),
    );
    pracas.push({
      id: 1000 + i,
      nome: `Praça ${i}`,
      uf: i % 3 === 0 ? "SP" : i % 3 === 1 ? "SC" : "BA",
      populacao,
      pibTotal: (populacao * pibPerCapita) / 1000,
      pibPerCapita,
      empresasTotal: setor * 4,
      setor,
      crescimento: { serie: [], cagr: 2, aceleracao: null, tendencia: "estavel" },
      densidade: (setor / populacao) * 1000,
      saturacao: 1,
      shareSetor: 0.25,
      pibPorEmpresa: null,
      atratividade: { score: 50, faixa: "media", fatores: [] },
      bruto: {} as never,
    } as unknown as Praca);
  }
  return {
    pracas,
    porId: new Map(pracas.map((p) => [p.id, p])),
    paraSimilaridade: [],
    anoReferencia: 2024,
  };
}

const ctx = (setor: string, n = 200) => ({ universo: universoFalso(n), setor });

describe("declaração das ferramentas", () => {
  it("toda ferramenta declarada tem execução correspondente", () => {
    /* Uma ferramenta declarada sem `case` no switch é pior que ausente: o
       modelo a chama, recebe "desconhecida" e tenta contornar inventando. */
    const universo = universoFalso();
    for (const f of FERRAMENTAS) {
      const r = executarFerramenta(f.function.name, {}, { universo, setor: "G" });
      expect(r.erro ?? "", `ferramenta ${f.function.name}`).not.toMatch(/desconhecid/i);
    }
  });

  it("recusa nome de ferramenta que não existe", () => {
    const r = executarFerramenta("inventada", {}, ctx("G"));
    expect(r.ok).toBe(false);
  });

  it("avisa em vez de responder quando o IBGE ainda não chegou", () => {
    /* Sem este ramo o modelo receberia listas vazias e concluiria que não há
       mercado — em vez de dizer que o dado ainda está carregando. */
    const vazio: Universo = {
      pracas: [], porId: new Map(), paraSimilaridade: [], anoReferencia: null,
    };
    const r = executarFerramenta("filtrar_pracas", {}, { universo: vazio, setor: "G" });
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/carregando/i);
  });
});

describe("filtrar_pracas — ordenação", () => {
  /* Esta suíte existe por uma falha vista ao vivo, gravando a demonstração.

     Perguntado "quais praças de SC têm MAIS empresas de comércio", o modelo
     chamou a ferramenta, recebeu o top-10 por ATRATIVIDADE e respondeu
     "Navegantes 1.452, Içara 1.321, Itajaí 7.246" — três números corretos
     apresentados como um ranking de volume que eles não formam.

     Números certos na ordem errada é a falha mais perigosa desta camada: cada
     valor resiste à conferência individual e a frase inteira é falsa. A
     descrição da ferramenta já dizia por qual critério a lista vinha. Dizer
     não bastou; virou parâmetro. */

  const ordenado = (criterio: string | undefined, campo: (p: never) => number) => {
    const args = criterio ? { ordenar_por: criterio, limite: 25 } : { limite: 25 };
    const d = executarFerramenta("filtrar_pracas", args, ctx("G")).dados as Record<string, unknown>;
    const v = (d["pracas"] as never[]).map(campo);
    return { v, d };
  };

  it("por padrão ordena por atratividade e diz isso no retorno", () => {
    const { v, d } = ordenado(undefined, (p) => (p as { score_atratividade: number }).score_atratividade);
    expect(d["ordenado_por"]).toBe("atratividade");
    expect(v).toEqual([...v].sort((a, b) => b - a));
  });

  it("ordena por número de empresas quando pedido", () => {
    const { v, d } = ordenado("empresas", (p) => (p as { empresas_do_setor: number }).empresas_do_setor);
    expect(d["ordenado_por"]).toBe("empresas");
    expect(v).toEqual([...v].sort((a, b) => b - a));
  });

  it("ordena por população quando pedido", () => {
    const { v } = ordenado("populacao", (p) => (p as { populacao: number }).populacao);
    expect(v).toEqual([...v].sort((a, b) => b - a));
  });

  it("critério inválido cai no padrão em vez de devolver ordem aleatória", () => {
    const { v, d } = ordenado("inventado", (p) => (p as { score_atratividade: number }).score_atratividade);
    expect(d["ordenado_por"]).toBe("inventado");
    expect(v).toEqual([...v].sort((a, b) => b - a));
  });

  it("o critério viaja no payload — a resposta precisa poder se qualificar", () => {
    /* Sem este campo o modelo não tem como saber por qual régua a lista veio,
       e foi exatamente assim que ele errou. */
    for (const c of ["atratividade", "empresas", "crescimento", "populacao"]) {
      const d = executarFerramenta("filtrar_pracas", { ordenar_por: c }, ctx("G")).dados as Record<string, unknown>;
      expect(d["ordenado_por"]).toBe(c);
    }
  });
});

describe("vazios_de_mercado", () => {
  it("devolve as praças desabastecidas do setor validado", () => {
    const r = executarFerramenta("vazios_de_mercado", {}, ctx("G"));
    const d = r.dados as Record<string, unknown>;

    expect(r.ok).toBe(true);
    expect(Array.isArray(d["praças"])).toBe(true);
    expect(d["municipios_no_modelo"]).toBeGreaterThan(50);
  });

  /* ── O portão ──────────────────────────────────────────────────────────
     A razão de existir deste arquivo. O modelo roda em qualquer seção CNAE e
     devolve números de aparência idêntica; foi o teste fora da amostra que
     reprovou Construção. Sem o portão, o Copiloto responderia com números
     bem formatados que não significam nada. */
  it("RECUSA Construção e explica por quê", () => {
    const r = executarFerramenta("vazios_de_mercado", {}, ctx("F"));

    expect(r.ok).toBe(false);
    expect(r.dados).toBeUndefined();
    expect(r.erro).toMatch(/\+0,040/); // o rho reprovado
    expect(r.erro).toMatch(/mercado local/i); // a premissa quebrada
  });

  it("marca a recusa como DEFINITIVA para o agente não insistir", () => {
    /* Medido ao vivo com a Llama 3.3: ao receber a recusa, o modelo não
       repassou a explicação — repetiu `vazios_de_mercado({uf:"SP"})`, porque
       LLM lê erro como "tente diferente". Sem esta marca, quem pergunta sobre
       Construção queima as 4 rodadas do agente e recebe "tente uma pergunta
       mais específica" em vez do motivo.

       A garantia é do laço, não do texto do erro: ver `Copiloto.tsx`. */
    expect(executarFerramenta("vazios_de_mercado", {}, ctx("F")).definitivo).toBe(true);
    /* Insistir com outro argumento também não passa. */
    expect(
      executarFerramenta("vazios_de_mercado", { uf: "SP" }, ctx("F")).definitivo,
    ).toBe(true);
  });

  it("falha recuperável NÃO é definitiva", () => {
    /* Amostra insuficiente pode mudar quando o resto do IBGE carregar, e
       recorte vazio muda com outro argumento. Marcar tudo como definitivo
       tiraria do agente a chance de se corrigir sozinho. */
    expect(executarFerramenta("vazios_de_mercado", {}, ctx("G", 20)).definitivo)
      .toBeFalsy();
    expect(
      executarFerramenta("vazios_de_mercado", { uf: "ZZ" }, ctx("G")).definitivo,
    ).toBeFalsy();
  });

  it("recusa qualquer seção não validada", () => {
    for (const s of ["A", "B", "F", "H", "K"]) {
      expect(executarFerramenta("vazios_de_mercado", {}, ctx(s)).ok).toBe(false);
    }
    for (const s of ["G", "C"]) {
      expect(executarFerramenta("vazios_de_mercado", {}, ctx(s)).ok).toBe(true);
    }
  });

  it("manda a acurácia junto com o resultado", () => {
    /* O modelo parafraseia o que recebe. Se a ressalva não viajar dentro do
       retorno, ele apresenta uma estimativa que explica 5% da variação com a
       mesma confiança de uma contagem do IBGE. */
    const d = executarFerramenta("vazios_de_mercado", {}, ctx("G")).dados as Record<
      string,
      Record<string, unknown>
    >;
    const a = d["acuracia"] as Record<string, unknown>;

    expect(a).toBeDefined();
    expect(a["correlacao_com_crescimento_futuro"]).toBeLessThan(0);
    /* A referência honesta viaja junto: sem ela o modelo não tem como dizer
       que o indicador é melhor que a densidade pura, nem quanto. */
    expect(a["referencia_densidade_pura"]).toBeLessThan(0);
    expect(String(a["ressalva"])).toMatch(/priorizar/i);
    expect(String(a["metodo"])).toMatch(/2013/);
  });

  it("usa a acurácia do setor pedido, não uma fixa", () => {
    const g = executarFerramenta("vazios_de_mercado", {}, ctx("G")).dados as never;
    const c = executarFerramenta("vazios_de_mercado", {}, ctx("C")).dados as never;
    const rho = (d: never) =>
      (d as Record<string, Record<string, number>>)["acuracia"]?.[
        "correlacao_com_crescimento_futuro"
      ];

    expect(rho(g)).toBeCloseTo(-0.232, 3); // Comércio
    expect(rho(c)).toBeCloseTo(-0.201, 3); // Indústria
  });

  it("recorta por UF sem reajustar o modelo só naquela UF", () => {
    /* A elasticidade estimada só em Sergipe sairia de 75 municípios. A
       pergunta é se a praça está abaixo do padrão do PAÍS — não abaixo do
       padrão dos vizinhos pobres. */
    const nacional = executarFerramenta("vazios_de_mercado", {}, ctx("G"))
      .dados as Record<string, unknown>;
    const porUf = executarFerramenta("vazios_de_mercado", { uf: "SC" }, ctx("G"))
      .dados as Record<string, unknown>;

    expect(porUf["municipios_no_modelo"]).toBe(nacional["municipios_no_modelo"]);
    expect(porUf["recorte"]).toMatch(/SC/);
    for (const p of porUf["praças"] as Array<{ uf: string }>) {
      expect(p.uf).toBe("SC");
    }
  });

  it("avisa quando a amostra não dá para ajustar", () => {
    const r = executarFerramenta("vazios_de_mercado", {}, ctx("G", 20));
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/insuficient/i);
  });

  it("respeita o teto de itens — não estoura a janela de contexto", () => {
    const d = executarFerramenta("vazios_de_mercado", {}, ctx("G", 900)).dados as Record<
      string,
      unknown
    >;
    expect((d["praças"] as unknown[]).length).toBeLessThanOrEqual(25);
  });
});
