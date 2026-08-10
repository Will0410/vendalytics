/**
 * sintetico.ts — controle sintético: o que teria acontecido sem a intervenção.
 *
 * Os outros modelos respondem "onde ir". Este responde a pergunta que vem
 * depois de ir, e que nenhum deles alcança: **a praça mudou por causa da nossa
 * ação, ou mudou de qualquer jeito?**
 *
 * Abrir filial não é teste A/B: acontece uma vez, num lugar só, sem sorteio.
 * O método (Abadie) contorna isso construindo um município CONTRAFACTUAL — uma
 * combinação ponderada de praças que acompanharam a tratada durante anos antes
 * da intervenção. Se depois elas se separam, a diferença é o efeito.
 *
 * ── Onde o método falha, e como isso é declarado ──────────────────────────
 * O ajuste pré-intervenção é o que dá crédito ao contrafactual: um sintético
 * que não acompanhou o passado não tem por que acompanhar o futuro. Por isso o
 * resultado carrega `rmspePre` — e a leitura correta é que um pré ruim invalida
 * o efeito, por maior que ele pareça.
 *
 * A inferência é por PLACEBO, não por teste paramétrico: roda-se o mesmo
 * procedimento fingindo que cada doador foi o tratado. Se metade dos doadores
 * produz um "efeito" tão grande quanto o do tratado, não há efeito nenhum —
 * há ruído que o método sempre produz. É a única forma honesta de inferir com
 * uma unidade tratada.
 *
 * ── Por que em log ────────────────────────────────────────────────────────
 * Contagem de empresas varia de dezenas a centenas de milhares. Em nível, o
 * ajuste é dominado pelas praças grandes e o erro de São Paulo enterra o de
 * todas as outras. Em log, o que se casa é a DINÂMICA proporcional, que é o
 * que interessa: crescer 10% é a mesma notícia em qualquer porte.
 */

/** Doadores considerados. Mais que isto não melhora o ajuste e custa tempo. */
const MAX_DOADORES = 40;

/**
 * Banda de porte do doador, como razão em relação ao tratado.
 *
 * A restrição do simplex (pesos não-negativos que somam 1) impede o sintético
 * de extrapolar: ele nunca fica acima do maior doador nem abaixo do menor. Sem
 * a banda, uma praça de 70 mil empresas só teria doadores menores e o
 * contrafactual bateria no teto — parecendo um ajuste ruim que na verdade é
 * uma impossibilidade aritmética.
 */
const BANDA_PORTE: [number, number] = [0.25, 4];

/** Iterações do gradiente projetado. Medido: converge bem antes disso. */
const ITERACOES = 400;

export interface SerieMunicipio {
  id: number;
  /** Valores por ano, na ordem de `anos`. */
  valores: number[];
}

export interface Contrafactual {
  tratado: number;
  /** Índice, em `anos`, do primeiro ano APÓS a intervenção. */
  corte: number;
  /** Doadores com peso não desprezível, do maior para o menor. */
  pesos: Array<{ id: number; peso: number }>;
  /** Série do contrafactual, mesmo comprimento de `anos`. */
  sintetico: number[];
  observado: number[];
  /** observado - sintetico, ano a ano. */
  efeito: number[];
  /** Erro do ajuste ANTES da intervenção. Se for alto, nada abaixo vale. */
  rmspePre: number;
  rmspePos: number;
  /** rmspePos / rmspePre. É a estatística que o placebo compara. */
  razao: number;
  /**
   * Proporção de doadores que, tratados como placebo, produziram razão MAIOR.
   * Quanto menor, mais improvável que o efeito observado seja o ruído que o
   * método sempre produz. Não é p-valor de teste paramétrico — é posição num
   * ranking, e o número de doadores limita a resolução.
   */
  p: number;
  doadoresNoPlacebo: number;
}

/* ─── Otimização ───────────────────────────────────────────────────────── */

/**
 * Projeta um vetor no simplex (pesos ≥ 0 somando 1) — algoritmo de Duchi.
 *
 * É esta projeção que impede o contrafactual de extrapolar. Sem ela, mínimos
 * quadrados livres dariam pesos negativos e o "município sintético" viraria
 * uma combinação que não corresponde a lugar nenhum — ajuste perfeito no
 * passado e nenhum poder de dizer o que teria acontecido.
 */
function projetarNoSimplex(v: number[]): number[] {
  const n = v.length;
  const u = [...v].sort((a, b) => b - a);
  let soma = 0;
  let rho = 0;
  let theta = 0;
  for (let i = 0; i < n; i++) {
    soma += u[i] as number;
    const t = (soma - 1) / (i + 1);
    if ((u[i] as number) - t > 0) {
      rho = i + 1;
      theta = t;
    }
  }
  void rho;
  return v.map((x) => Math.max(x - theta, 0));
}

/** Pesos que melhor reproduzem a série do tratado no período pré. */
function ajustarPesos(alvo: number[], doadores: number[][], corte: number): number[] {
  const J = doadores.length;
  if (J === 0) return [];
  let w = new Array<number>(J).fill(1 / J);

  /* Passo escalado pela magnitude do problema: fixo, ele diverge em séries
     grandes e rasteja em séries pequenas. */
  let escala = 0;
  for (let t = 0; t < corte; t++) {
    for (let j = 0; j < J; j++) escala += ((doadores[j] as number[])[t] as number) ** 2;
  }
  const passo = escala > 0 ? 1 / (escala / (corte * J)) / corte : 0.01;

  for (let it = 0; it < ITERACOES; it++) {
    const grad = new Array<number>(J).fill(0);
    for (let t = 0; t < corte; t++) {
      let previsto = 0;
      for (let j = 0; j < J; j++) previsto += (w[j] as number) * ((doadores[j] as number[])[t] as number);
      const erro = previsto - (alvo[t] as number);
      for (let j = 0; j < J; j++) {
        grad[j] = (grad[j] as number) + 2 * erro * ((doadores[j] as number[])[t] as number);
      }
    }
    const proximo = w.map((x, j) => x - passo * (grad[j] as number));
    w = projetarNoSimplex(proximo);
  }
  return w;
}

const rmspe = (erros: number[]): number =>
  erros.length === 0
    ? 0
    : Math.sqrt(erros.reduce((s, e) => s + e * e, 0) / erros.length);

/* ─── API ──────────────────────────────────────────────────────────────── */

interface Preparado {
  alvo: number[];
  doadores: number[][];
  ids: number[];
}

/** Log das séries, com a banda de porte aplicada ao conjunto de doadores. */
function preparar(
  tratado: SerieMunicipio,
  universo: SerieMunicipio[],
  corte: number,
): Preparado | null {
  const alvo = tratado.valores.map((v) => Math.log(Math.max(v, 1)));
  const nivel = tratado.valores[corte - 1] ?? 0;
  if (nivel <= 0) return null;

  const candidatos = universo
    .filter((d) => d.id !== tratado.id && d.valores.length === tratado.valores.length)
    .filter((d) => {
      const n = d.valores[corte - 1] ?? 0;
      return n > 0 && n >= nivel * BANDA_PORTE[0] && n <= nivel * BANDA_PORTE[1];
    })
    /* Os doadores mais parecidos em TRAJETÓRIA pré, não só em porte: dois
       municípios do mesmo tamanho podem ter histórias opostas. */
    .map((d) => {
      const logs = d.valores.map((v) => Math.log(Math.max(v, 1)));
      let dist = 0;
      for (let t = 0; t < corte; t++) dist += ((logs[t] as number) - (alvo[t] as number)) ** 2;
      return { id: d.id, logs, dist };
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, MAX_DOADORES);

  if (candidatos.length < 5) return null;
  return {
    alvo,
    doadores: candidatos.map((c) => c.logs),
    ids: candidatos.map((c) => c.id),
  };
}

function rodar(alvo: number[], doadores: number[][], corte: number) {
  const w = ajustarPesos(alvo, doadores, corte);
  const sintetico = alvo.map((_, t) => {
    let s = 0;
    for (let j = 0; j < doadores.length; j++) {
      s += (w[j] as number) * ((doadores[j] as number[])[t] as number);
    }
    return s;
  });
  const erros = alvo.map((v, t) => v - (sintetico[t] as number));
  return {
    w,
    sintetico,
    erros,
    pre: rmspe(erros.slice(0, corte)),
    pos: rmspe(erros.slice(corte)),
  };
}

/**
 * Constrói o contrafactual de um município e mede o efeito, com inferência
 * por placebo.
 *
 * `corte` é o índice do primeiro ano APÓS a intervenção. Precisa sobrar
 * período dos dois lados: sem pré não há como validar o ajuste, sem pós não há
 * efeito para medir.
 */
export function contrafactual(
  tratado: SerieMunicipio,
  universo: SerieMunicipio[],
  corte: number,
): Contrafactual | null {
  const n = tratado.valores.length;
  if (corte < 4 || corte > n - 2) return null;

  const prep = preparar(tratado, universo, corte);
  if (!prep) return null;

  const r = rodar(prep.alvo, prep.doadores, corte);
  if (!Number.isFinite(r.pre) || r.pre <= 0) return null;

  /* ── Inferência por placebo ────────────────────────────────────────────
     Cada doador vira "tratado" e recebe o mesmo tratamento. Se muitos deles
     produzirem razão pós/pré tão extrema quanto a do tratado de verdade, o
     efeito observado é o ruído que o método sempre gera. */
  const razoes: number[] = [];
  for (let k = 0; k < prep.doadores.length; k++) {
    const outros = prep.doadores.filter((_, j) => j !== k);
    if (outros.length < 4) continue;
    const p = rodar(prep.doadores[k] as number[], outros, corte);
    if (p.pre > 0 && Number.isFinite(p.pre) && Number.isFinite(p.pos)) {
      razoes.push(p.pos / p.pre);
    }
  }

  const razao = r.pos / r.pre;
  const maiores = razoes.filter((x) => x >= razao).length;
  const p = razoes.length > 0 ? (maiores + 1) / (razoes.length + 1) : 1;

  /* De volta à escala de empresas — a tela fala em empresas, não em log. */
  const sintetico = r.sintetico.map((v) => Math.exp(v));
  const observado = tratado.valores.slice();

  return {
    tratado: tratado.id,
    corte,
    pesos: prep.ids
      .map((id, j) => ({ id, peso: r.w[j] as number }))
      .filter((x) => x.peso > 0.001)
      .sort((a, b) => b.peso - a.peso),
    sintetico,
    observado,
    efeito: observado.map((v, t) => v - (sintetico[t] as number)),
    rmspePre: r.pre,
    rmspePos: r.pos,
    razao,
    p,
    doadoresNoPlacebo: razoes.length,
  };
}
