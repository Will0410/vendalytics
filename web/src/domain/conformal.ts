/**
 * conformal.ts — intervalo com cobertura garantida, e o direito de calar.
 *
 * O resto da plataforma publica a própria acurácia mas entrega ESTIMATIVA
 * PONTUAL: "esperado 115.930". Um ponto não diz se o modelo está confortável
 * ali ou chutando, e essas duas situações não podem ter a mesma cara.
 *
 * ── O que é predição conformal ────────────────────────────────────────────
 * Um jeito de transformar qualquer preditor em intervalo com **cobertura
 * garantida**, sem supor distribuição nenhuma. O procedimento inteiro:
 *
 *   1. separa uma fatia de CALIBRAÇÃO que o ajuste não vê;
 *   2. mede o erro do modelo nessa fatia;
 *   3. o quantil desses erros é a meia-largura do intervalo.
 *
 * A garantia é distribution-free e vale em amostra finita: se pedir 90%, pelo
 * menos 90% dos casos futuros caem dentro — sob a única hipótese de que os
 * dados são trocáveis. Não há normalidade suposta, não há teorema assintótico.
 *
 * ── Por que NORMALIZADO ───────────────────────────────────────────────────
 * A versão simples devolve a mesma largura para todo mundo. Isso é válido e é
 * inútil aqui: se o intervalo de São Paulo e o de Careiro da Várzea têm a
 * mesma largura relativa, o intervalo não distingue nada e a abstenção vira
 * tudo-ou-nada.
 *
 * A versão normalizada divide o erro por uma estimativa da dificuldade local
 * — um segundo ajuste, sobre o tamanho do próprio erro. Onde o modelo é
 * historicamente ruim, o intervalo abre; onde é bom, fecha. É o que torna a
 * abstenção seletiva de verdade.
 *
 * ── A regra de abstenção ──────────────────────────────────────────────────
 * Não é limiar arbitrário de largura. É a própria pergunta do produto:
 *
 *   se o intervalo do ESPERADO contém o OBSERVADO, não há como afirmar que
 *   existe lacuna — o município está dentro do que o modelo consegue prever.
 *
 * O produto então não mostra número: mostra que não sabe. Só sobra no ranking
 * quem está abaixo do piso do próprio intervalo.
 */

/** Cobertura nominal. 90% é o padrão da literatura aplicada. */
export const COBERTURA = 0.9;

/**
 * Fração da amostra reservada para calibração.
 *
 * O ajuste NÃO pode ver esta fatia — é o que sustenta a garantia. Metade é
 * generoso e é o que a amostra permite: com ~5.000 municípios, 2.500 de
 * calibração dão um quantil estável.
 */
export const FRACAO_CALIBRACAO = 0.5;

export interface Ponto {
  /** Variáveis do modelo, já transformadas, COM o intercepto. */
  x: number[];
  /** Resposta observada, na mesma escala em que o modelo trabalha. */
  y: number;
}

export interface Conformal {
  /** Quantil do escore normalizado — a meia-largura em unidades de dificuldade. */
  q: number;
  /** Coeficientes do modelo de dispersão, sobre log|resíduo|. */
  beta: number[];
  /** Quantos pontos entraram na calibração. */
  n: number;
  cobertura: number;
}

export interface IntervaloPrevisto {
  /** Previsão pontual, na escala do modelo. */
  previsto: number;
  baixo: number;
  alto: number;
  /** Meia-largura efetiva deste ponto. Maior = modelo menos confortável aqui. */
  meiaLargura: number;
}

/* ─── Álgebra ──────────────────────────────────────────────────────────── */

/** Mínimos quadrados por equações normais. Mesmo motor de `vazios.ts`. */
function ols(X: number[][], y: number[]): number[] {
  const k = X[0]?.length ?? 0;
  const n = X.length;
  if (k === 0 || n <= k) return new Array<number>(k).fill(0);

  const A: number[][] = [];
  for (let i = 0; i < k; i++) {
    const linha = new Array<number>(k + 1).fill(0);
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let r = 0; r < n; r++) s += (X[r]?.[i] ?? 0) * (X[r]?.[j] ?? 0);
      linha[j] = s;
    }
    let s = 0;
    for (let r = 0; r < n; r++) s += (X[r]?.[i] ?? 0) * (y[r] ?? 0);
    linha[k] = s;
    A.push(linha);
  }
  for (let i = 0; i < k; i++) {
    let melhor = i;
    for (let r = i + 1; r < k; r++) {
      if (Math.abs(A[r]?.[i] ?? 0) > Math.abs(A[melhor]?.[i] ?? 0)) melhor = r;
    }
    const tmp = A[i] as number[];
    A[i] = A[melhor] as number[];
    A[melhor] = tmp;
    const pivo = A[i]?.[i] ?? 0;
    if (Math.abs(pivo) < 1e-12) continue;
    for (let r = 0; r < k; r++) {
      if (r === i) continue;
      const f = (A[r]?.[i] ?? 0) / pivo;
      if (f === 0) continue;
      for (let c = i; c <= k; c++) {
        (A[r] as number[])[c] = (A[r]?.[c] ?? 0) - f * (A[i]?.[c] ?? 0);
      }
    }
  }
  return Array.from({ length: k }, (_, i) => {
    const d = A[i]?.[i] ?? 0;
    return Math.abs(d) > 1e-12 ? (A[i]?.[k] ?? 0) / d : 0;
  });
}

const prever = (beta: number[], x: number[]): number =>
  beta.reduce((s, b, i) => s + b * (x[i] ?? 0), 0);

/**
 * Dificuldade prevista para um ponto: exp(ajuste sobre log|resíduo|).
 *
 * O piso não é cosmético. Sem ele, um resíduo perto de zero na calibração
 * produziria dificuldade ~0, o escore normalizado explodiria e um único ponto
 * definiria o quantil de todo mundo.
 */
const PISO_DIFICULDADE = 1e-3;
const dificuldade = (beta: number[], x: number[]): number =>
  Math.max(Math.exp(prever(beta, x)), PISO_DIFICULDADE);

/**
 * Partição determinística por índice.
 *
 * Determinística de propósito: o mesmo universo tem que produzir o mesmo
 * intervalo em toda execução, senão o número na tela muda ao recarregar a
 * página e ninguém confia nele. O passo primo espalha a fatia em vez de cortar
 * a lista ao meio, que agruparia por ordem de chegada — e a lista chega
 * ordenada por código IBGE, ou seja, por estado.
 */
function particionar(n: number): { ajuste: number[]; calibracao: number[] } {
  const ajuste: number[] = [];
  const calibracao: number[] = [];
  const passo = 7919;
  for (let i = 0; i < n; i++) {
    ((i * passo) % 1000 < FRACAO_CALIBRACAO * 1000 ? calibracao : ajuste).push(i);
  }
  return { ajuste, calibracao };
}

/* ─── Calibração ───────────────────────────────────────────────────────── */

/**
 * Calibra o intervalo conformal normalizado.
 *
 * Devolve `null` quando a amostra não sustenta o quantil pedido — melhor não
 * ter intervalo do que ter um intervalo que não cobre o que promete.
 */
export function calibrar(pontos: Ponto[], cobertura = COBERTURA): Conformal | null {
  const { ajuste, calibracao } = particionar(pontos.length);
  /* Com poucos pontos o quantil vira o máximo da amostra e o intervalo fica
     arbitrariamente largo — sem informação, e ainda por cima com cara de
     rigor. */
  if (ajuste.length < 60 || calibracao.length < 60) return null;

  const Xa = ajuste.map((i) => (pontos[i] as Ponto).x);
  const ya = ajuste.map((i) => (pontos[i] as Ponto).y);
  const betaMedia = ols(Xa, ya);

  /* Modelo de dispersão: log|resíduo| nas mesmas variáveis. É o que faz o
     intervalo abrir onde o modelo historicamente erra mais. */
  const absResiduos = ya.map((y, k) => Math.abs(y - prever(betaMedia, Xa[k] as number[])));
  const betaDisp = ols(Xa, absResiduos.map((r) => Math.log(Math.max(r, PISO_DIFICULDADE))));

  /* Escore conformal: erro em unidades de dificuldade local. */
  const escores = calibracao
    .map((i) => {
      const p = pontos[i] as Ponto;
      return Math.abs(p.y - prever(betaMedia, p.x)) / dificuldade(betaDisp, p.x);
    })
    .sort((a, b) => a - b);

  /**
   * Quantil conformal com a correção de amostra finita.
   *
   * O índice é ⌈(n+1)·cobertura⌉ e não ⌈n·cobertura⌉. Esse "+1" é o que
   * converte a promessa de assintótica para exata: sem ele a cobertura fica
   * sistematicamente ABAIXO do nominal, e o intervalo mente por pouco —
   * exatamente o tipo de erro que ninguém percebe olhando a tela.
   */
  const n = escores.length;
  const idx = Math.ceil((n + 1) * cobertura) - 1;
  if (idx >= n) return null; // cobertura inatingível com esta amostra
  return { q: escores[idx] as number, beta: betaDisp, n, cobertura };
}

/** Intervalo para um ponto, dada uma calibração e a previsão do modelo. */
export function intervalo(
  cal: Conformal,
  x: number[],
  previsto: number,
): IntervaloPrevisto {
  const meiaLargura = cal.q * dificuldade(cal.beta, x);
  return { previsto, baixo: previsto - meiaLargura, alto: previsto + meiaLargura, meiaLargura };
}

/**
 * Cobertura empírica: a fração de pontos cujo valor real caiu dentro.
 *
 * Existe para ser MEDIDA, não suposta. A garantia teórica vale sob
 * trocabilidade; se o dado violar isso, o número aqui denuncia. É o único
 * jeito honesto de embarcar um intervalo.
 */
export function medirCobertura(cal: Conformal, pontos: Ponto[], beta: number[]): number {
  if (pontos.length === 0) return 0;
  let dentro = 0;
  for (const p of pontos) {
    const iv = intervalo(cal, p.x, prever(beta, p.x));
    if (p.y >= iv.baixo && p.y <= iv.alto) dentro++;
  }
  return dentro / pontos.length;
}
