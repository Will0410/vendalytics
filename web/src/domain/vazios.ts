/**
 * vazios.ts — onde falta empresa que deveria existir.
 *
 * Todo o resto da plataforma é DESCRITIVO: conta empresas, calcula densidade,
 * ordena por atratividade. Isso responde "onde está o mercado hoje". Este
 * módulo tenta a pergunta seguinte, que é a que vende: **onde o mercado ainda
 * não está, mas as condições para ele existir já estão.**
 *
 * O modelo estima quantas empresas do setor um município DEVERIA ter, dado seu
 * tamanho e seu poder de compra, e mede quem está abaixo disso. A lacuna entre
 * esperado e observado é demanda sem oferta.
 *
 * ── O que foi medido ──────────────────────────────────────────────────────
 * Validado FORA da janela de ajuste: modelo estimado com dados de 2013,
 * confrontado com o crescimento de 2015 a 2020 (CEMPRE 6449, 4.833 municípios).
 * Nenhum dado da janela de validação entra no ajuste.
 *
 *   resíduo -> crescimento futuro ............ rho = -0,225
 *   densidade pura -> crescimento futuro ..... rho = -0,152   (referência)
 *   resíduo 2013 x resíduo 2015 .............. rho = +0,913
 *
 * O sinal negativo é o esperado: quem está abaixo do previsto hoje cresce mais
 * depois. O rho de +0,913 entre dois anos é o que torna isso utilizável — o
 * desequilíbrio é estrutural, não ruído de um ano. Por decil do resíduo, o
 * crescimento médio 2015–2020 vai de -1,5% (mais desabastecidos) a -18,2%
 * (mais saturados): 17 pontos de diferença, com o modelo ajustado dois anos
 * ANTES da janela.
 *
 * rho = -0,225 explica ~5% da variação. É um indicador de PRIORIZAÇÃO, não uma
 * previsão. Serve para ordenar 5.570 municípios; não serve para afirmar o que
 * vai acontecer em um deles.
 *
 * ── Por que só alguns setores ─────────────────────────────────────────────
 * O mesmo teste fora da amostra, por seção CNAE:
 *
 *   Comércio (G) .... rho = -0,225   (densidade: -0,152)   FUNCIONA
 *   Indústria (C) ... rho = -0,178   (densidade: -0,075)   FUNCIONA
 *   Construção (F) .. rho = +0,040   (densidade: +0,079)   NÃO FUNCIONA
 *
 * Construção quebra a premissa do modelo, que é equilíbrio de mercado LOCAL:
 * construtora não fica onde atende — empresa sediada em São Paulo constrói na
 * Bahia. Onde a premissa não vale, o número não é oferecido. Calcular em
 * silêncio um indicador que não se sustenta é pior do que não ter indicador.
 *
 * ── O que faz o trabalho, e o que foi descartado ──────────────────────────
 * As duas variáveis não valem o mesmo:
 *
 *   só população .................... rho = -0,151   (= densidade, com outro nome)
 *   + poder de compra ............... rho = -0,218   <- é aqui que o sinal nasce
 *   + hinterlândia por gravidade .... rho = -0,225   <- descartado
 *
 * O coeficiente de população sozinho dá +0,994, praticamente 1: o resíduo desse
 * modelo É a densidade. O salto vem do PODER DE COMPRA, que separa "densidade
 * baixa porque a cidade é pobre" — onde não há oportunidade alguma — de
 * "densidade baixa apesar do dinheiro", que é o caso que interessa.
 *
 * O termo de gravidade (modelo de Huff redistribuindo demanda entre municípios
 * vizinhos) era a hipótese original e foi CORTADO. Dois motivos:
 *
 *   1. Ganho de 0,007 no rho e 0,001 no R². Dentro do ruído.
 *   2. A razão que ele produz é artefato de agregação. O modelo trata a
 *      população inteira de um município como um ponto no centroide; o
 *      centroide de área de São Paulo cai a 7,0 km de Diadema, então Diadema
 *      "captura" parte de 12 milhões de pessoas e sai com a maior razão do
 *      país (1,611) sem ser polo de coisa nenhuma. A razão vira quase uma
 *      função da distância ao centroide do vizinho grande: 7,0km->1,61,
 *      8,7km->1,21, 15,9km->0,93, 20,1km->0,81.
 *
 * Explicação falsa entregue com confiança é pior que explicação nenhuma, e ela
 * falharia justamente nos mercados mais densos. O registro completo está em
 * `docs/vazios-de-mercado.md`.
 *
 * O efeito colateral bom: sem gravidade, o modelo não precisa de coordenada
 * nenhuma — três números por município bastam.
 */

import { calibrar, intervalo, type Conformal, type Ponto } from "./conformal";

/** Seções CNAE em que o indicador foi validado fora da amostra. */
export const SETORES_VALIDADOS: readonly string[] = ["G", "C"];

/** Abaixo disto, variação de cadastro domina e o resíduo vira ruído. */
const MINIMO_EMPRESAS = 20;

/** Sem um número mínimo de municípios não há o que ajustar. */
const MINIMO_AMOSTRA = 50;

/**
 * Teto para o PIB per capita, como percentil da própria amostra.
 *
 * PIB per capita é o proxy de poder de compra, e em alguns municípios ele não
 * mede poder de compra nenhum: é uma planta industrial dividida pela
 * população. Maricá/RJ aparece com R$ 631 mil per capita por royalties de
 * petróleo; Paulínia/SP com R$ 575 mil por causa da refinaria. A mediana do
 * país é R$ 13,5 mil.
 *
 * Sem teto, o modelo extrapola muito além do que existe: chegava a esperar 24
 * comércios por mil habitantes, e nenhum município brasileiro chega perto
 * disso. Pior, a distorção se concentra no TOPO do ranking — que é justamente
 * onde as pessoas agem —, então o erro médio ficava bom e o produto ficava
 * ruim.
 *
 * O corte no p95 não é um meio-termo: ele melhora as três coisas ao mesmo
 * tempo, medido na validação fora da amostra.
 *
 *   sem teto ....... R2 = 0,8606   rho = -0,2292   espera até 23,9/1000hab
 *   teto no p99 .... R2 = 0,8634   rho = -0,2301   espera até 21,2/1000hab
 *   teto no p95 .... R2 = 0,8691   rho = -0,2318   espera até 15,3/1000hab
 *
 * É percentil e não valor fixo porque o modelo roda sobre o dado do momento —
 * um teto em reais de 2013 estaria errado em 2024 só por inflação.
 */
const PERCENTIL_TETO_RENDA = 0.95;

export interface EntradaVazio {
  id: number;
  populacao: number | null;
  pibPerCapita: number | null;
  /** Empresas do setor-alvo. */
  empresas: number | null;
}

export interface Vazio {
  id: number;
  /** Empresas que o modelo prevê para este município. */
  esperado: number;
  observado: number;
  /** esperado - observado. Positivo = falta empresa. */
  lacuna: number;
  /** ln(observado) - ln(esperado). É a medida do modelo; a lacuna é a leitura. */
  residuo: number;
  /** 0–100. Quanto MAIOR, mais desabastecido em relação aos demais. */
  percentil: number;
  /** Piso do intervalo de 90% para o esperado. `null` sem calibração. */
  esperadoMin: number | null;
  /** Teto do intervalo de 90% para o esperado. */
  esperadoMax: number | null;
  /**
   * A lacuna se sustenta? Verdadeiro só quando o observado fica ABAIXO do piso
   * do intervalo — ou seja, quando o município não pode ser explicado como
   * "está dentro do que o modelo consegue prever".
   *
   * Medido na amostra de validação: 89,8% dos municípios caem DENTRO do
   * intervalo e 6,6% ficam abaixo do piso. O produto ranqueia esses 6,6%.
   * Parece pouco e é o número honesto — um modelo que explica ~5% da variação
   * do crescimento não tem direito de afirmar lacuna em 5.570 lugares.
   */
  sustentavel: boolean;
}

export interface ResultadoVazios {
  vazios: Vazio[];
  porId: Map<number, Vazio>;
  /** Quantos municípios entraram no ajuste. */
  amostra: number;
  /** R² do ajuste — quanto da contagem de empresas o modelo explica. */
  r2: number;
  /**
   * Elasticidades estimadas. Expostas porque modelo que não se deixa
   * inspecionar não se deixa contestar: se `populacao` sair muito longe de 1
   * ou `poderDeCompra` sair negativo, o ajuste está dizendo algo que a
   * economia do problema não sustenta, e é para aparecer.
   */
  coeficientes: { populacao: number; poderDeCompra: number };
  /** Calibração conformal, ou `null` quando a amostra não a sustenta. */
  conformal: Conformal | null;
  /** Quantos municípios têm lacuna sustentável — os únicos que o produto afirma. */
  sustentaveis: number;
}

/* ─── Mínimos quadrados ────────────────────────────────────────────────── */

/**
 * OLS por equações normais com eliminação de Gauss-Jordan e pivotamento
 * parcial. São 3 colunas e alguns milhares de linhas — não vale trazer uma
 * biblioteca de álgebra linear para o bundle por causa disto.
 */
function ols(X: number[][], y: number[]): { beta: number[]; r2: number } {
  const k = X[0]?.length ?? 0;
  const n = X.length;
  if (k === 0 || n <= k) return { beta: new Array<number>(k).fill(0), r2: 0 };

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

  const beta = Array.from({ length: k }, (_, i) => {
    const d = A[i]?.[i] ?? 0;
    return Math.abs(d) > 1e-12 ? (A[i]?.[k] ?? 0) / d : 0;
  });

  const media = y.reduce((a, b) => a + b, 0) / n;
  let sqt = 0;
  let sqr = 0;
  for (let r = 0; r < n; r++) {
    let previsto = 0;
    for (let i = 0; i < k; i++) previsto += (beta[i] ?? 0) * (X[r]?.[i] ?? 0);
    sqt += ((y[r] ?? 0) - media) ** 2;
    sqr += ((y[r] ?? 0) - previsto) ** 2;
  }
  return { beta, r2: sqt > 0 ? 1 - sqr / sqt : 0 };
}

/* ─── API ──────────────────────────────────────────────────────────────── */

/** O indicador foi validado para esta seção CNAE? */
export function validadoPara(secao: string): boolean {
  return SETORES_VALIDADOS.includes(secao.toUpperCase());
}

const VAZIO: ResultadoVazios = {
  vazios: [],
  porId: new Map(),
  amostra: 0,
  r2: 0,
  coeficientes: { populacao: 0, poderDeCompra: 0 },
  conformal: null,
  sustentaveis: 0,
};

/**
 * Ajusta o modelo no universo recebido e devolve a lacuna de cada município.
 *
 * O modelo é reestimado a cada chamada, sobre o dado do momento, em vez de
 * carregar coeficientes fixos: a elasticidade do Comércio não é a da Indústria,
 * e nenhuma das duas é constante no tempo.
 */
export function mapearVazios(entradas: EntradaVazio[]): ResultadoVazios {
  /* Só entra no ajuste quem tem os três valores e porte acima do piso. Abaixo
     dele o resíduo mede cadastro, não mercado. */
  const usaveis = entradas.filter(
    (e) =>
      (e.empresas ?? 0) >= MINIMO_EMPRESAS &&
      (e.populacao ?? 0) > 0 &&
      (e.pibPerCapita ?? 0) > 0,
  );
  if (usaveis.length < MINIMO_AMOSTRA) return { ...VAZIO, porId: new Map() };

  /* O teto sai da própria amostra — ver PERCENTIL_TETO_RENDA. */
  const rendas = usaveis.map((e) => e.pibPerCapita as number).sort((a, b) => a - b);
  const teto = rendas[
    Math.min(Math.floor(PERCENTIL_TETO_RENDA * rendas.length), rendas.length - 1)
  ] as number;

  const X: number[][] = [];
  const y: number[] = [];
  for (const e of usaveis) {
    X.push([
      1,
      Math.log(e.populacao as number),
      Math.log(Math.min(e.pibPerCapita as number, teto)),
    ]);
    y.push(Math.log(e.empresas as number));
  }

  const { beta, r2 } = ols(X, y);
  if (!Number.isFinite(r2) || r2 <= 0) return { ...VAZIO, porId: new Map() };

  /* Intervalo com cobertura garantida sobre o mesmo ajuste. A calibração usa
     uma fatia que o ajuste do intervalo não vê — ver `conformal.ts`. Devolve
     `null` quando a amostra não sustenta o quantil, e nesse caso o produto
     simplesmente não afirma nada sobre lacuna. */
  const pontos: Ponto[] = X.map((x, i) => ({ x, y: y[i] as number }));
  const cal = calibrar(pontos);

  let sustentaveis = 0;
  const vazios: Vazio[] = usaveis.map((e, i) => {
    const linha = X[i] as number[];
    let previsto = 0;
    for (let j = 0; j < beta.length; j++) previsto += (beta[j] ?? 0) * (linha[j] ?? 0);
    const esperado = Math.exp(previsto);
    const observado = e.empresas as number;

    let esperadoMin: number | null = null;
    let esperadoMax: number | null = null;
    let sustentavel = false;
    if (cal) {
      const iv = intervalo(cal, linha, previsto);
      esperadoMin = Math.exp(iv.baixo);
      esperadoMax = Math.exp(iv.alto);
      /* A regra não é limiar de largura, é a própria pergunta do produto:
         se o observado cabe no intervalo, não há como afirmar que falta
         empresa aqui. */
      sustentavel = observado < esperadoMin;
      if (sustentavel) sustentaveis++;
    }

    return {
      id: e.id,
      esperado,
      observado,
      lacuna: esperado - observado,
      residuo: (y[i] as number) - previsto,
      percentil: 0,
      esperadoMin,
      esperadoMax,
      sustentavel,
    };
  });

  /* Ordena do mais desabastecido (resíduo mais negativo) para o mais saturado
     e atribui percentil. Empates recebem o mesmo valor — dois municípios
     idênticos não podem sair em posições diferentes só pela ordem de chegada. */
  vazios.sort((a, b) => a.residuo - b.residuo);
  const n = vazios.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && (vazios[j + 1] as Vazio).residuo === (vazios[i] as Vazio).residuo) j++;
    const p = n > 1 ? (100 * (n - 1 - (i + j) / 2)) / (n - 1) : 50;
    for (let t = i; t <= j; t++) (vazios[t] as Vazio).percentil = p;
    i = j + 1;
  }

  return {
    vazios,
    porId: new Map(vazios.map((v) => [v.id, v])),
    amostra: n,
    r2,
    coeficientes: { populacao: beta[1] ?? 0, poderDeCompra: beta[2] ?? 0 },
    conformal: cal,
    sustentaveis,
  };
}
