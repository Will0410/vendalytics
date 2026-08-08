/**
 * ecossistema.ts — o tecido econômico municipal como REDE de capacidades.
 *
 * Os outros módulos tratam cada atividade econômica como uma coluna
 * independente: conta comércios, conta indústrias, ordena. Este parte de outra
 * premissa, emprestada da economia da complexidade (Hausmann–Hidalgo, o
 * "espaço de produtos"): **atividades não aparecem em qualquer lugar. Aparecem
 * onde as capacidades vizinhas já existem.**
 *
 * Um município que já é forte em metalurgia e produtos de metal tem mais
 * chance de ganhar fabricação de máquinas do que de ganhar turismo — não
 * porque é maior ou mais rico, mas porque as capacidades se sobrepõem.
 *
 * A pergunta que isso responde, e que nenhum outro módulo responde: **quais
 * praças já têm os pré-requisitos para o seu tipo de cliente, mas ainda não
 * têm o cliente?**
 *
 * ── O que foi medido ──────────────────────────────────────────────────────
 * Rede construída com o CEMPRE de 2013; confronto com quais divisões CNAE
 * efetivamente APARECERAM em cada município até 2020. Metade dos municípios
 * ficou fora do ajuste — inclusive da construção da rede, senão o conjunto de
 * teste já teria visto a própria coocorrência.
 *
 * AUC no conjunto de teste (2.785 municípios nunca vistos, 198.004 casos):
 *
 *   só popularidade (referência) .... 0,7185
 *   só densidade (a rede) ........... 0,7100
 *   as duas juntas .................. 0,7549
 *
 * ── A parte que quase me enganou ──────────────────────────────────────────
 * Sozinha, a rede PERDE para a referência ingênua. Se eu tivesse olhado só
 * para os decis da densidade (1,0% → 19,9% de aparecimento) teria embarcado um
 * grafo bonito que uma linha de heurística supera.
 *
 * O que salva o método não é a rede substituir a popularidade — é ela carregar
 * informação INDEPENDENTE. Controlando por faixa de popularidade, a rede vence
 * em todas:
 *
 *   rara (<10%) ....... 0,7155 x 0,6675
 *   incomum (10-35%) .. 0,6513 x 0,6147
 *   comum (35-70%) .... 0,5941 x 0,5082
 *   ubíqua (>70%) ..... 0,4492 x 0,4227   <- as duas piores que moeda
 *
 * ── Por que média geométrica, e não um modelo ajustado ────────────────────
 * A regressão logística sobre log(densidade) e log(popularidade) devolveu
 * pesos +0,999 e +0,997 — praticamente idênticos. Ou seja: o modelo ajustado
 * É o produto das duas.
 *
 *   logística ajustada ............... AUC 0,7549
 *   sqrt(densidade × popularidade) ... AUC 0,7540
 *
 * Diferença de 0,0009. Fica a média geométrica: mesma acurácia, escala 0–1
 * legível, e nenhum parâmetro ajustado para versionar, envelhecer ou explicar.
 */
import espacoBruto from "../data/espaco-cnae.json";

/**
 * Piso de AUC para o indicador ser oferecido.
 *
 * O artefato traz o AUC MEDIDO de cada divisão, fora da amostra. Ele não é
 * parecido entre elas — vai de 0,88 a 0,39 — e o padrão é interpretável:
 *
 *   FUNCIONA                          FALHA
 *   39 Descontaminação ...... 0,878   82 Serviços de escritório . 0,394
 *   51 Transporte aéreo ..... 0,873   47 Comércio varejista ..... 0,412
 *   21 Farmoquímicos ........ 0,847   85 Educação ............... 0,423
 *   30 Equip. de transporte . 0,845   84 Administração pública .. 0,461
 *   65 Seguros .............. 0,835   01 Agricultura ............ 0,470
 *   26 Equip. de informática  0,826   41 Construção de edifícios  0,482
 *
 * A rede prevê atividades que exigem CAPACIDADE ESPECÍFICA e falha nas que
 * apenas acompanham população — todo município tem varejo, escola e prefeitura
 * na medida da sua gente, sem precisar de ecossistema industrial nenhum.
 *
 * Este corte substituiu um chute meu. Eu tinha barrado por "ubiquidade > 70%",
 * o que pegava varejo e administração pública mas deixava passar Educação
 * (31% de ubiquidade, AUC 0,423) e Agricultura (28%, AUC 0,470). Medir cada
 * divisão é mais trabalho e é a única forma de acertar quais.
 *
 * 69 das 87 divisões passam.
 */
export const AUC_MINIMO = 0.55;

export interface DivisaoCnae {
  codigo: string;
  nome: string;
  /** AUC medido fora da amostra. `null` = poucos casos para medir. */
  auc: number | null;
}

export interface Vizinha {
  codigo: string;
  nome: string;
  /** Proximidade com a divisão-alvo, 0 a 1. */
  phi: number;
}

export interface Prontidao {
  municipioId: number;
  /** Quanto do entorno da atividade-alvo este município já domina, 0 a 1. */
  densidade: number;
  /** sqrt(densidade × popularidade). É o score validado. */
  prontidao: number;
  /** Já tem vantagem comparativa revelada nesta divisão. */
  jaTem: boolean;
  /** As capacidades presentes que mais puxam a atividade-alvo — o porquê. */
  vizinhas: Vizinha[];
}

export interface ResultadoEcossistema {
  divisao: DivisaoCnae;
  popularidade: number;
  /** Municípios SEM a atividade, ordenados por prontidão. */
  prontos: Prontidao[];
  /** Quantos já têm vantagem comparativa nela. */
  jaTem: number;
  ano: number;
}

interface Espaco {
  ano: number;
  divisoes: DivisaoCnae[];
  popularidade: number[];
  proximidade: Array<[number, number, number]>;
  presenca: Record<string, number[]>;
}

const espaco = espacoBruto as unknown as Espaco;

/**
 * Matriz densa 87×87 montada uma vez.
 *
 * O artefato guarda só o triângulo superior — a matriz é simétrica e gravar as
 * duas metades dobraria o arquivo. Aqui ela é espelhada porque o cálculo de
 * densidade percorre uma linha inteira por município, e procurar num array de
 * 3.655 triplas a cada acesso seria absurdamente mais lento.
 */
const N = espaco.divisoes.length;
const PHI: Float64Array = (() => {
  const m = new Float64Array(N * N);
  for (const [i, j, v] of espaco.proximidade) {
    m[i * N + j] = v;
    m[j * N + i] = v;
  }
  return m;
})();

/** Soma de φ de cada divisão com todas as outras — denominador da densidade. */
const SOMA_PHI: Float64Array = (() => {
  const s = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let t = 0;
    for (let j = 0; j < N; j++) if (j !== i) t += PHI[i * N + j] as number;
    s[i] = t;
  }
  return s;
})();

export function divisoes(): DivisaoCnae[] {
  return espaco.divisoes;
}

export function popularidadeDe(indice: number): number {
  return espaco.popularidade[indice] ?? 0;
}

/**
 * O indicador foi validado para esta divisão?
 *
 * `null` (poucos aparecimentos entre 2013 e 2020) também reprova: não medido
 * não é o mesmo que aprovado.
 */
export function validadaPara(indice: number): boolean {
  const auc = espaco.divisoes[indice]?.auc;
  return typeof auc === "number" && auc >= AUC_MINIMO;
}

/** AUC medido da divisão, ou `null` se não houve casos suficientes. */
export function aucDe(indice: number): number | null {
  return espaco.divisoes[indice]?.auc ?? null;
}

/** As divisões em que o indicador se sustenta, da mais previsível para a menos. */
export function divisoesValidadas(): Array<{ indice: number; divisao: DivisaoCnae }> {
  return espaco.divisoes
    .map((divisao, indice) => ({ indice, divisao }))
    .filter(({ indice }) => validadaPara(indice))
    .sort((a, b) => (b.divisao.auc ?? 0) - (a.divisao.auc ?? 0));
}

export function indiceDoCodigo(codigo: string): number {
  return espaco.divisoes.findIndex((d) => d.codigo === codigo);
}

/**
 * Ordena os municípios pela prontidão para receber a atividade-alvo.
 *
 * `municipiosPermitidos` recorta o universo (uma UF, por exemplo) SEM refazer
 * a rede: a proximidade entre atividades é uma propriedade da economia
 * brasileira, não da UF. Reestimá-la em 75 municípios de Sergipe produziria
 * uma rede de ruído.
 */
export function calcularProntidao(
  divisaoIdx: number,
  municipiosPermitidos?: Set<number>,
): ResultadoEcossistema {
  const divisao = espaco.divisoes[divisaoIdx] as DivisaoCnae;
  const popularidade = popularidadeDe(divisaoIdx);
  const denominador = SOMA_PHI[divisaoIdx] as number;

  const prontos: Prontidao[] = [];
  let jaTem = 0;

  for (const [chave, presentes] of Object.entries(espaco.presenca)) {
    const id = Number(chave);
    if (municipiosPermitidos && !municipiosPermitidos.has(id)) continue;

    const tem = presentes.includes(divisaoIdx);
    if (tem) {
      jaTem++;
      continue;
    }

    let soma = 0;
    for (const j of presentes) {
      if (j !== divisaoIdx) soma += PHI[divisaoIdx * N + j] as number;
    }
    const densidade = denominador > 0 ? soma / denominador : 0;

    /* As três capacidades presentes que mais puxam a atividade-alvo. É o que
       transforma um score em argumento: "Caxias do Sul está pronta porque já
       tem metalurgia, produtos de metal e manutenção de máquinas". */
    const vizinhas: Vizinha[] = presentes
      .filter((j) => j !== divisaoIdx && (PHI[divisaoIdx * N + j] as number) > 0)
      .map((j) => ({
        codigo: (espaco.divisoes[j] as DivisaoCnae).codigo,
        nome: (espaco.divisoes[j] as DivisaoCnae).nome,
        phi: PHI[divisaoIdx * N + j] as number,
      }))
      .sort((a, b) => b.phi - a.phi)
      .slice(0, 3);

    prontos.push({
      municipioId: id,
      densidade,
      prontidao: Math.sqrt(densidade * popularidade),
      jaTem: false,
      vizinhas,
    });
  }

  prontos.sort((a, b) => b.prontidao - a.prontidao);
  return { divisao, popularidade, prontos, jaTem, ano: espaco.ano };
}

/* ─── Por que não existe o caminho inverso ──────────────────────────────
 *
 * "Dado um município, o que ele está mais pronto para receber" parece a
 * pergunta gêmea, e não é: as duas formas testadas saem degeneradas.
 *
 * Ordenando pela prontidão, a popularidade varia entre divisões e domina —
 * Caxias do Sul e São Paulo recebem quase a MESMA lista, encabeçada pelas
 * atividades mais comuns. Normalizando pela densidade média da divisão, o
 * ranking inverte e passa a ser dominado pelas mais raras: as três cidades
 * testadas recebiam "Extração de carvão mineral" e "Extração de petróleo".
 *
 * A assimetria tem explicação. Fixando a ATIVIDADE, a popularidade é constante
 * entre os candidatos e não afeta a ordem — sobra só a densidade, que é o
 * sinal específico do município. Fixando o MUNICÍPIO, ela vira o termo
 * dominante e não diz nada sobre aquele lugar.
 *
 * O que foi validado é uma direção só, e é a que o produto entrega.
 */
