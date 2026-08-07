/**
 * dominio.test.ts — as regras de negócio que a interface apenas exibe.
 *
 * O que se testa aqui não é aritmética (o JavaScript soma bem), e sim as
 * PROPRIEDADES que fazem cada cálculo cumprir seu papel: que ausência de dado
 * nunca vira zero, que o score não colapsa por causa de um outlier, que
 * empates recebem o mesmo tratamento, que o desenho de território é
 * determinístico.
 *
 * São propriedades que quebram em silêncio — nenhuma delas derruba a tela.
 */
import { describe, expect, it } from "vitest";
import { divisaoCnae, secaoDeCnae } from "../data/cnae";
import { cnpjValido, cnpjMascara, num, moedaCompacta, anosDesde } from "../lib/format";
import { calcularCrescimento } from "./crescimento";
import { calcularAtratividade, type EntradaAtratividade } from "./atratividade";
import { pracasSemelhantes, type EntradaSimilaridade } from "./similaridade";
import { calcularIcp } from "./icp";
import { mediana } from "./territorio";
import type { Empresa } from "../data/brasilapi";

/* ─── CNAE ─────────────────────────────────────────────────────────────── */

describe("CNAE", () => {
  /* REGRESSÃO: a Receita entrega o CNAE sem o zero à esquerda. Sem
     normalizar para 7 posições, 0600001 (extração de petróleo, divisão 06)
     viraria divisão 60 — telecomunicações. Petrobras apareceria como empresa
     de telecom, e a composição setorial inteira ficaria errada em silêncio. */
  it("normaliza o zero à esquerda antes de extrair a divisão", () => {
    expect(divisaoCnae(600001)).toBe(6);
    expect(secaoDeCnae(600001).letra).toBe("B"); // extrativas, não J
  });

  it("classifica as seções corretamente", () => {
    expect(secaoDeCnae(4713004).letra).toBe("G"); // varejo
    expect(secaoDeCnae(6422100).letra).toBe("K"); // bancos
    expect(secaoDeCnae(2910701).letra).toBe("C"); // automotivo
    expect(secaoDeCnae(4120400).letra).toBe("F"); // construção
  });

  it("devolve 'não classificado' em vez de chutar", () => {
    expect(secaoDeCnae(null).letra).toBe("?");
    /* Divisão 04 é uma LACUNA da CNAE 2.0 — existe 03 e 05, não existe 04.
       (99 não serve de exemplo: é a seção U, organismos internacionais.) */
    expect(secaoDeCnae("0400000").letra).toBe("?");
    expect(secaoDeCnae("3400000").letra).toBe("?"); // outra lacuna: 33 e 35 existem
  });
});

/* ─── Formatação ───────────────────────────────────────────────────────── */

describe("formatação", () => {
  it("valida CNPJ pelos dígitos verificadores", () => {
    expect(cnpjValido("33000167000101")).toBe(true); // Petrobras
    expect(cnpjValido("00000000000191")).toBe(true); // Banco do Brasil
    expect(cnpjValido("33000167000102")).toBe(false); // DV alterado
    expect(cnpjValido("11111111111111")).toBe(false); // repetido
    expect(cnpjValido("123")).toBe(false);
  });

  it("ausência de dado vira travessão, nunca zero", () => {
    /* A regra que atravessa o produto: "0 empresas" afirma que não existe
       nenhuma; "—" admite que o IBGE não publicou. São coisas diferentes. */
    expect(num(null)).toBe("—");
    expect(moedaCompacta(null)).toBe("—");
    expect(num(0)).toBe("0"); // zero de verdade continua zero
  });

  it("formata em pt-BR", () => {
    expect(num(1201528)).toBe("1.201.528");
    expect(moedaCompacta(28_836_672_000)).toBe("R$ 28,8 bi");
    expect(cnpjMascara("33000167000101")).toBe("33.000.167/0001-01");
  });

  it("anosDesde devolve null para data ausente ou inválida", () => {
    expect(anosDesde(null)).toBeNull();
    expect(anosDesde("não é data")).toBeNull();
  });
});

/* ─── Crescimento ──────────────────────────────────────────────────────── */

describe("crescimento", () => {
  it("calcula CAGR e identifica encolhimento", () => {
    const c = calcularCrescimento([
      { ano: 2022, valor: 359 },
      { ano: 2023, valor: 358 },
      { ano: 2024, valor: 345 },
    ]);
    expect(c.cagr).toBeLessThan(0);
    expect(c.tendencia).toBe("encolhendo");
    expect(c.absoluto).toBe(-14);
  });

  it("identifica aceleração pela segunda diferença", () => {
    const c = calcularCrescimento([
      { ano: 2022, valor: 100 },
      { ano: 2023, valor: 105 }, // +5%
      { ano: 2024, valor: 120 }, // +14,3% — ganhou ritmo
    ]);
    expect(c.aceleracao).toBeGreaterThan(0);
    expect(c.tendencia).toBe("acelerando");
  });

  it("base zero não vira crescimento infinito", () => {
    /* "de 0 para 5" não é 500%; é indefinido. Devolver um número aqui
       colocaria municípios minúsculos no topo de qualquer ranking. */
    const c = calcularCrescimento([
      { ano: 2023, valor: 0 },
      { ano: 2024, valor: 5 },
    ]);
    expect(c.ultimoAno).toBeNull();
    expect(c.cagr).toBeNull();
  });

  it("um ponto só não é tendência", () => {
    const c = calcularCrescimento([{ ano: 2024, valor: 10 }]);
    expect(c.tendencia).toBe("indefinida");
    expect(c.cagr).toBeNull();
  });

  it("ordena por ano em vez de confiar na ordem recebida", () => {
    const c = calcularCrescimento([
      { ano: 2024, valor: 120 },
      { ano: 2022, valor: 100 },
      { ano: 2023, valor: 110 },
    ]);
    expect(c.anoInicial).toBe(2022);
    expect(c.anoFinal).toBe(2024);
    expect(c.cagr).toBeGreaterThan(0);
  });
});

/* ─── Atratividade ─────────────────────────────────────────────────────── */

describe("Score de Atratividade", () => {
  const base = (id: number, volume: number): EntradaAtratividade => ({
    id,
    volumeSetor: volume,
    crescimentoSetor: 2,
    pibPerCapita: 30000,
    saturacao: 1,
    densidade: 40,
  });

  it("um outlier extremo não achata o resto da distribuição", () => {
    /* É a razão de usar percentil e não min–max. São Paulo tem 264 mil
       empresas de Comércio; a mediana municipal tem 90. Num min–max, todo o
       país ficaria colado em zero e o score não distinguiria a 200ª da
       4.000ª praça. */
    const universo = [
      base(1, 264675), // São Paulo
      ...Array.from({ length: 50 }, (_, i) => base(i + 2, 50 + i * 10)),
    ];
    const scores = calcularAtratividade(universo);

    const pequenas = universo.slice(1).map((u) => scores.get(u.id)!.score);
    const menor = Math.min(...pequenas);
    const maior = Math.max(...pequenas);

    expect(maior - menor).toBeGreaterThan(20); // continua discriminando
  });

  it("empates recebem o mesmo percentil", () => {
    /* Milhares de municípios têm "0 empresas do setor". Sem tratar empate,
       receberiam notas diferentes só pela ordem no array — uma cauda inteira
       de ruído no ranking. */
    const universo = [base(1, 0), base(2, 0), base(3, 0), base(4, 500)];
    const scores = calcularAtratividade(universo);

    expect(scores.get(1)!.score).toBe(scores.get(2)!.score);
    expect(scores.get(2)!.score).toBe(scores.get(3)!.score);
  });

  it("reescala pelo peso disponível quando falta um componente", () => {
    /* Uma praça sem série histórica perderia 25 pontos por ausência de dado,
       não por demérito — e apareceria pior que a vizinha idêntica que tem a
       série. */
    const comSerie = [base(1, 100), base(2, 200), base(3, 300)];
    const semSerie = comSerie.map((u) => ({ ...u, crescimentoSetor: null }));

    const a = calcularAtratividade(comSerie).get(2)!.score;
    const b = calcularAtratividade(semSerie).get(2)!.score;

    expect(Math.abs(a - b)).toBeLessThan(15);
  });

  it("devolve a decomposição, sempre", () => {
    /* Score sem a conta aberta morre na primeira reunião. */
    const r = calcularAtratividade([base(1, 100), base(2, 200)]).get(1)!;
    expect(r.fatores.length).toBe(5);
    expect(r.fatores.every((f) => f.detalhe.length > 0)).toBe(true);
    expect(r.fatores.reduce((s, f) => s + f.maximo, 0)).toBe(100);
  });
});

/* ─── Similaridade ─────────────────────────────────────────────────────── */

describe("similaridade", () => {
  const praca = (
    id: number,
    nome: string,
    pop: number,
    pib: number,
    den: number,
  ): EntradaSimilaridade => ({
    id,
    nome,
    uf: "SP",
    populacao: pop,
    pibPerCapita: pib,
    densidade: den,
    shareSetor: 0.22,
    crescimentoSetor: 3,
    pibPorEmpresa: 400000,
  });

  const universo = [
    praca(1, "Metrópole", 12_000_000, 90_000, 100),
    praca(2, "Outra metrópole", 6_500_000, 85_000, 95),
    praca(3, "Média A", 700_000, 50_000, 70),
    praca(4, "Média B", 650_000, 52_000, 72),
    praca(5, "Pequena", 15_000, 18_000, 30),
    praca(6, "Pequena 2", 12_000, 20_000, 28),
  ];

  it("aproxima praças de porte semelhante", () => {
    const r = pracasSemelhantes(3, universo, 3);
    expect(r[0]?.entrada.nome).toBe("Média B");
  });

  it("uma metrópole não casa com uma cidade pequena", () => {
    const r = pracasSemelhantes(1, universo, 5);
    const pequena = r.find((s) => s.entrada.nome === "Pequena");
    const outraMetropole = r.find((s) => s.entrada.nome === "Outra metrópole");
    expect(outraMetropole!.similaridade).toBeGreaterThan(pequena!.similaridade);
  });

  it("explica em quê são parecidas e em quê diferem", () => {
    const r = pracasSemelhantes(3, universo, 1)[0]!;
    expect(r.maisParecidas.length).toBeGreaterThan(0);
    expect(r.maiorDiferenca).not.toBeNull();
  });

  it("recusa comparar quando faltam dimensões", () => {
    /* Comparar por uma ou duas dimensões produz vizinhos que parecem certos
       e não são. Lista vazia é mais honesta que resultado fraco. */
    const pobre = [
      { ...praca(9, "Sem dado", 0, 0, 0), populacao: null, pibPerCapita: null, densidade: null,
        shareSetor: null, crescimentoSetor: null, pibPorEmpresa: null },
      ...universo,
    ];
    expect(pracasSemelhantes(9, pobre, 5)).toEqual([]);
  });
});

/* ─── ICP ──────────────────────────────────────────────────────────────── */

describe("Score ICP", () => {
  const empresa = (over: Partial<Empresa> = {}): Empresa => ({
    cnpj: "33000167000101",
    razaoSocial: "Teste S.A.",
    nomeFantasia: null,
    cnaeCodigo: 4713004,
    cnaeDescricao: "Varejo",
    cnaesSecundarios: 4,
    secao: { letra: "G", nome: "Comércio", curto: "Comércio" },
    porte: "Médio/Grande",
    naturezaJuridica: "S.A.",
    capitalSocial: 10_000_000,
    dataAbertura: "2000-01-01",
    situacao: "Ativa",
    matriz: true,
    municipio: "São Paulo",
    uf: "SP",
    bairro: null,
    endereco: null,
    cep: null,
    municipioIbgeId: 3550308,
    telefone: "1130000000",
    email: "contato@teste.com",
    simples: false,
    mei: false,
    socios: 3,
    ...over,
  });

  it("empresa não-ativa é desqualificada, não penalizada", () => {
    /* Empresa baixada não é "lead ruim", é lead inexistente. Deixá-la com 40
       pontos a colocaria à frente de uma micro empresa ativa de verdade. */
    const r = calcularIcp(empresa({ situacao: "Baixada" }));
    expect(r.score).toBe(0);
    expect(r.desqualificada).toBe(true);
    expect(r.motivoDesqualificacao).toContain("Baixada");
  });

  it("empresa ideal pontua alto e nunca passa de 100", () => {
    const r = calcularIcp(empresa());
    expect(r.score).toBeGreaterThan(75);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.faixa).toBe("A");
  });

  it("sem canal de contato o score cai", () => {
    const com = calcularIcp(empresa()).score;
    const sem = calcularIcp(empresa({ telefone: null, email: null })).score;
    expect(sem).toBeLessThan(com);
  });

  it("capital social usa escala logarítmica", () => {
    /* A propriedade do log é que RAZÕES iguais valem incrementos iguais —
       escrever o teste me obrigou a formular isso direito. Cada 100× de
       capital rende o mesmo número de pontos. */
    const a = calcularIcp(empresa({ capitalSocial: 10_000 })).score;
    const b = calcularIcp(empresa({ capitalSocial: 1_000_000 })).score; // 100×
    const c = calcularIcp(empresa({ capitalSocial: 100_000_000 })).score; // 100×
    expect(b - a).toBe(c - b);
  });

  it("no capital, R$ 100 mil pesam muito no pequeno e nada no grande", () => {
    /* É o que a escala linear erraria: o MESMO acréscimo absoluto move o
       score de uma micro empresa e é irrelevante para uma gigante. */
    const ganhoNoPequeno =
      calcularIcp(empresa({ capitalSocial: 110_000 })).score -
      calcularIcp(empresa({ capitalSocial: 10_000 })).score;
    const ganhoNoGrande =
      calcularIcp(empresa({ capitalSocial: 100_100_000 })).score -
      calcularIcp(empresa({ capitalSocial: 100_000_000 })).score;

    expect(ganhoNoPequeno).toBeGreaterThan(ganhoNoGrande);
    expect(ganhoNoGrande).toBe(0);
  });

  it("toda decomposição vem com explicação legível", () => {
    const r = calcularIcp(empresa());
    expect(r.fatores.every((f) => f.detalhe.length > 5)).toBe(true);
  });
});

/* ─── Estatística de apoio ─────────────────────────────────────────────── */

describe("mediana", () => {
  it("lida com par, ímpar e vazio", () => {
    expect(mediana([3, 1, 2])).toBe(2);
    expect(mediana([4, 1, 3, 2])).toBe(2.5);
    expect(mediana([])).toBeNull();
  });
});
