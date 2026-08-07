/**
 * crescimento.ts — direção, não retrato.
 *
 * O produto inteiro respondia "quantas empresas existem nesta praça". Duas
 * praças do mesmo tamanho, porém, pedem decisões opostas se uma está subindo e
 * a outra caindo — e essa diferença não aparecia em lugar nenhum:
 *
 *     Cabixi/RO ............  57 →  55 →  64   entrando
 *     Alta Floresta/RO ..... 359 → 358 → 345   saindo
 *
 * Com a série 2022–2024 do CEMPRE, isso passa a ser mensurável.
 *
 * ── Sobre a honestidade dos números daqui ─────────────────────────────────
 * São TRÊS pontos anuais. Dá para dizer com segurança se cresceu, encolheu e
 * se o ritmo mudou. NÃO dá para projetar o ano que vem — três pontos não
 * sustentam extrapolação, e nada neste arquivo tenta. `aceleracao` compara
 * duas variações consecutivas; é a segunda diferença, não uma tendência
 * ajustada.
 */

export interface PontoSerie {
  ano: number;
  valor: number;
}

export type Tendencia = "acelerando" | "crescendo" | "estavel" | "encolhendo" | "indefinida";

export interface Crescimento {
  /** Taxa composta anual, em % (ex.: 3.4 = +3,4% ao ano). */
  cagr: number | null;
  /** Variação do último ano contra o anterior, em %. */
  ultimoAno: number | null;
  /** Variação do ano anterior — a base de comparação da aceleração. */
  anoAnterior: number | null;
  /** `ultimoAno − anoAnterior`, em pontos percentuais. Positivo = ganhou ritmo. */
  aceleracao: number | null;
  absoluto: number | null;
  anoInicial: number | null;
  anoFinal: number | null;
  tendencia: Tendencia;
  serie: PontoSerie[];
}

const VAZIO: Crescimento = {
  cagr: null,
  ultimoAno: null,
  anoAnterior: null,
  aceleracao: null,
  absoluto: null,
  anoInicial: null,
  anoFinal: null,
  tendencia: "indefinida",
  serie: [],
};

/** Faixa em que a variação é ruído de cadastro, não movimento de mercado.
 *  Abertura/baixa de empresa tem sazonalidade administrativa; ±1% ao ano num
 *  município pequeno é meia dúzia de CNPJs. */
const LIMIAR_ESTAVEL = 1;
const LIMIAR_FORTE = 4;

function variacao(de: number, para: number): number | null {
  /* Base zero não tem variação percentual definida — "de 0 para 5" é
     crescimento infinito, não 500%. Devolver null é o honesto. */
  if (!(de > 0)) return null;
  return ((para - de) / de) * 100;
}

export function calcularCrescimento(serie: PontoSerie[] | undefined): Crescimento {
  if (!serie || serie.length < 2) return { ...VAZIO, serie: serie ?? [] };

  const ordenada = [...serie].sort((a, b) => a.ano - b.ano);
  const primeiro = ordenada[0] as PontoSerie;
  const ultimo = ordenada[ordenada.length - 1] as PontoSerie;
  const anos = ultimo.ano - primeiro.ano;

  const cagr =
    primeiro.valor > 0 && anos > 0
      ? (Math.pow(ultimo.valor / primeiro.valor, 1 / anos) - 1) * 100
      : null;

  const penultimo = ordenada[ordenada.length - 2] as PontoSerie;
  const ultimoAno = variacao(penultimo.valor, ultimo.valor);

  /* A aceleração precisa de três pontos: duas variações para comparar. */
  const antepenultimo = ordenada.length >= 3 ? (ordenada[ordenada.length - 3] as PontoSerie) : null;
  const anoAnterior = antepenultimo ? variacao(antepenultimo.valor, penultimo.valor) : null;
  const aceleracao =
    ultimoAno != null && anoAnterior != null ? ultimoAno - anoAnterior : null;

  let tendencia: Tendencia = "indefinida";
  if (cagr != null) {
    if (cagr <= -LIMIAR_ESTAVEL) tendencia = "encolhendo";
    else if (cagr < LIMIAR_ESTAVEL) tendencia = "estavel";
    else if (cagr >= LIMIAR_FORTE && (aceleracao ?? 0) > 0) tendencia = "acelerando";
    else tendencia = "crescendo";
  }

  return {
    cagr,
    ultimoAno,
    anoAnterior,
    aceleracao,
    absoluto: ultimo.valor - primeiro.valor,
    anoInicial: primeiro.ano,
    anoFinal: ultimo.ano,
    tendencia,
    serie: ordenada,
  };
}

export const ROTULO_TENDENCIA: Record<Tendencia, string> = {
  acelerando: "Acelerando",
  crescendo: "Crescendo",
  estavel: "Estável",
  encolhendo: "Encolhendo",
  indefinida: "Sem série",
};

/** Tom visual da tendência. Usa os tokens de STATUS (reservados), nunca as
 *  cores de série de gráfico — direção de mercado é estado, não categoria. */
export const TOM_TENDENCIA: Record<Tendencia, "bom" | "acento" | "neutro" | "critico"> = {
  acelerando: "bom",
  crescendo: "acento",
  estavel: "neutro",
  encolhendo: "critico",
  indefinida: "neutro",
};

/** Frase pronta para tooltip e para o motor de insights. */
export function descreverCrescimento(c: Crescimento, unidade = "empresas"): string {
  if (c.tendencia === "indefinida" || c.cagr == null) {
    return "Série histórica indisponível para esta praça.";
  }
  const sinal = c.cagr >= 0 ? "+" : "";
  const base = `${sinal}${c.cagr.toFixed(1).replace(".", ",")}% ao ano entre ${c.anoInicial} e ${c.anoFinal}`;
  const delta =
    c.absoluto != null
      ? ` (${c.absoluto >= 0 ? "+" : ""}${c.absoluto.toLocaleString("pt-BR")} ${unidade})`
      : "";
  const ritmo =
    c.aceleracao == null
      ? ""
      : c.aceleracao > 0.5
        ? " · ganhando ritmo no último ano"
        : c.aceleracao < -0.5
          ? " · perdendo ritmo no último ano"
          : "";
  return base + delta + ritmo;
}
