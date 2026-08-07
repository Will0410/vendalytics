/**
 * atratividade.ts — o número único que ordena as praças.
 *
 * A plataforma já mostrava densidade, PIB per capita, saturação e crescimento
 * lado a lado. Nenhum deles responde "por onde eu começo?", porque a resposta
 * exige pesar os quatro ao mesmo tempo. Este arquivo faz esse peso, e o faz
 * explícito.
 *
 * ── Por que percentil, e não normalização min–max ─────────────────────────
 * São Paulo tem 264 mil empresas de Comércio; a mediana municipal tem 90. Num
 * min–max, São Paulo vira 100 e TODO o resto do país fica esmagado perto de
 * zero — o score deixaria de distinguir a 200ª da 4.000ª praça, que é
 * exatamente a distinção que interessa a quem planeja expansão.
 *
 * O percentil resolve isso por construção: cada componente vira "quantas
 * praças esta supera", numa escala uniforme de 0 a 100 imune a outlier.
 *
 * ── Por que os pesos estão à mostra ───────────────────────────────────────
 * Não é um modelo treinado — não existe histórico de ganho/perda por praça
 * aqui, e chamar isto de preditivo seria mentira. É uma soma ponderada de
 * sinais reais com pesos arbitrados, e cada conta é aberta na interface. Um
 * score de expansão que ninguém consegue contestar é um score que ninguém usa.
 */

export interface EntradaAtratividade {
  id: number;
  /** Empresas do setor-alvo na praça. */
  volumeSetor: number | null;
  /** Crescimento composto do setor, em % ao ano. */
  crescimentoSetor: number | null;
  pibPerCapita: number | null;
  /** Densidade da praça ÷ mediana da UF. Maior = mais disputada. */
  saturacao: number | null;
  /** Empresas por 1.000 habitantes. */
  densidade: number | null;
}

export type Sinal = "positivo" | "neutro" | "negativo";

export interface FatorAtratividade {
  rotulo: string;
  pontos: number;
  maximo: number;
  detalhe: string;
  sinal: Sinal;
}

export type FaixaAtratividade = "A" | "B" | "C" | "D";

export interface Atratividade {
  score: number;
  faixa: FaixaAtratividade;
  fatores: FatorAtratividade[];
}

/* Somam 100. Único lugar onde "praça atraente" está definido. */
const PESO = {
  volume: 25, // tamanho do mercado endereçável
  crescimento: 25, // para onde ele está indo
  poderDeCompra: 20, // quanto cada cliente pode pagar
  espaco: 20, // quanto ainda cabe de concorrência
  densidade: 10, // maturidade do tecido empresarial
} as const;

/**
 * Mapeia cada valor para o percentil dele dentro do universo (0–100).
 *
 * Empates recebem o mesmo percentil — sem isso, 3.000 municípios com o mesmo
 * "0 empresas do setor" receberiam notas diferentes só pela ordem em que
 * apareceram no array, e o ranking teria uma cauda inteira de ruído.
 */
function percentis(valores: (number | null)[]): (number | null)[] {
  const validos = valores
    .map((v, i) => ({ v, i }))
    .filter((x): x is { v: number; i: number } => x.v != null && Number.isFinite(x.v))
    .sort((a, b) => a.v - b.v);

  const saida: (number | null)[] = valores.map(() => null);
  if (validos.length === 0) return saida;
  if (validos.length === 1) {
    saida[(validos[0] as { i: number }).i] = 50;
    return saida;
  }

  let k = 0;
  while (k < validos.length) {
    let fim = k;
    while (fim + 1 < validos.length && (validos[fim + 1] as { v: number }).v === (validos[k] as { v: number }).v) {
      fim++;
    }
    /* Posição média do bloco de empates, normalizada em 0–100. */
    const pct = ((k + fim) / 2 / (validos.length - 1)) * 100;
    for (let j = k; j <= fim; j++) saida[(validos[j] as { i: number }).i] = pct;
    k = fim + 1;
  }
  return saida;
}

function faixaDe(score: number): FaixaAtratividade {
  if (score >= 72) return "A";
  if (score >= 55) return "B";
  if (score >= 35) return "C";
  return "D";
}

function sinalDe(pct: number | null): Sinal {
  if (pct == null) return "neutro";
  return pct >= 66 ? "positivo" : pct >= 33 ? "neutro" : "negativo";
}

const fmt = (v: number, casas = 1) => v.toFixed(casas).replace(".", ",");

/**
 * Calcula o score de todas as praças de uma vez.
 *
 * É em lote de propósito: percentil só existe em relação a um universo, e
 * calcular praça a praça exigiria varrer o universo inteiro a cada chamada —
 * 5.570 × 5.570 comparações para preencher um mapa.
 */
export function calcularAtratividade(
  universo: EntradaAtratividade[],
): Map<number, Atratividade> {
  const pVolume = percentis(universo.map((u) => u.volumeSetor));
  const pCrescimento = percentis(universo.map((u) => u.crescimentoSetor));
  const pPib = percentis(universo.map((u) => u.pibPerCapita));
  const pDensidade = percentis(universo.map((u) => u.densidade));
  /* Saturação é invertida: praça MENOS disputada vale MAIS. É o "whitespace"
     — espaço que ainda cabe, não mercado que já existe. */
  const pEspaco = percentis(universo.map((u) => (u.saturacao == null ? null : -u.saturacao)));

  const saida = new Map<number, Atratividade>();

  universo.forEach((u, i) => {
    const componentes: {
      chave: keyof typeof PESO;
      rotulo: string;
      pct: number | null;
      detalhe: string;
    }[] = [
      {
        chave: "volume",
        rotulo: "Volume do setor",
        pct: pVolume[i] ?? null,
        detalhe:
          u.volumeSetor == null
            ? "sem dado de empresas do setor"
            : `${u.volumeSetor.toLocaleString("pt-BR")} empresas do setor na praça`,
      },
      {
        chave: "crescimento",
        rotulo: "Crescimento do setor",
        pct: pCrescimento[i] ?? null,
        detalhe:
          u.crescimentoSetor == null
            ? "série histórica indisponível"
            : `${u.crescimentoSetor >= 0 ? "+" : ""}${fmt(u.crescimentoSetor)}% ao ano no setor`,
      },
      {
        chave: "poderDeCompra",
        rotulo: "Poder de compra",
        pct: pPib[i] ?? null,
        detalhe:
          u.pibPerCapita == null
            ? "PIB per capita indisponível"
            : `R$ ${Math.round(u.pibPerCapita).toLocaleString("pt-BR")} de PIB por habitante`,
      },
      {
        chave: "espaco",
        rotulo: "Espaço competitivo",
        pct: pEspaco[i] ?? null,
        detalhe:
          u.saturacao == null
            ? "sem comparação com a UF"
            : u.saturacao <= 0.8
              ? `densidade ${fmt((1 - u.saturacao) * 100, 0)}% abaixo da mediana da UF — cabe entrar`
              : u.saturacao >= 1.2
                ? `densidade ${fmt((u.saturacao - 1) * 100, 0)}% acima da mediana da UF — disputada`
                : "densidade na mediana da UF",
      },
      {
        chave: "densidade",
        rotulo: "Tecido empresarial",
        pct: pDensidade[i] ?? null,
        detalhe:
          u.densidade == null
            ? "densidade indisponível"
            : `${fmt(u.densidade)} empresas por 1.000 habitantes`,
      },
    ];

    let total = 0;
    let pesoDisponivel = 0;
    const fatores: FatorAtratividade[] = componentes.map((c) => {
      const maximo = PESO[c.chave];
      const pontos = c.pct == null ? 0 : (c.pct / 100) * maximo;
      if (c.pct != null) pesoDisponivel += maximo;
      total += pontos;
      return {
        rotulo: c.rotulo,
        pontos: Math.round(pontos * 10) / 10,
        maximo,
        detalhe: c.detalhe,
        sinal: sinalDe(c.pct),
      };
    });

    /* Reescala pelo peso realmente disponível: uma praça sem série histórica
       perderia 25 pontos por ausência de dado, não por demérito — e apareceria
       artificialmente pior que uma vizinha idêntica que tem a série. */
    const score =
      pesoDisponivel > 0 ? Math.round((total / pesoDisponivel) * 100) : 0;

    saida.set(u.id, { score, faixa: faixaDe(score), fatores });
  });

  return saida;
}

export const DESCRICAO_FAIXA_ATRATIVIDADE: Record<FaixaAtratividade, string> = {
  A: "Praça prioritária",
  B: "Boa oportunidade",
  C: "Avaliar caso a caso",
  D: "Baixa prioridade",
};
