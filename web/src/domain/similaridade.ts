/**
 * similaridade.ts — "ache praças parecidas com esta".
 *
 * É a pergunta de expansão: uma operação que vende bem em Ribeirão Preto quer
 * saber onde mais o mesmo modelo funciona, e a resposta não é "as maiores" —
 * é "as com perfil parecido". Ranking por volume manda todo mundo para São
 * Paulo; similaridade encontra a praça média que se comporta como a que já deu
 * certo.
 *
 * ── O que "parecido" significa aqui, exatamente ───────────────────────────
 * Seis dimensões, todas disponíveis para os 5.570 municípios numa carga só:
 * porte populacional, poder de compra, densidade empresarial, peso do setor na
 * economia local, crescimento do setor e porte médio das empresas.
 *
 * **Não** inclui composição setorial completa (as 21 seções). Essa quebra
 * existe no IBGE, mas só município a município — 5.570 requisições para montar
 * o vetor. Fica registrado como o refinamento óbvio se um dia houver carga em
 * lote; até lá, o nome na interface é "perfil econômico", não "mesmo mix
 * setorial", porque prometer o segundo com o dado do primeiro seria falso.
 *
 * ── Por que z-score antes da distância ────────────────────────────────────
 * Sem padronizar, população (centenas de milhares) domina a distância e
 * densidade (dezenas) não pesa nada — o resultado seria "municípios do mesmo
 * tamanho", que é ranking por população com passos extras. O z-score põe as
 * seis dimensões na mesma régua, e o log comprime as que são naturalmente
 * exponenciais (população, PIB per capita).
 */

export interface EntradaSimilaridade {
  id: number;
  nome: string;
  uf: string;
  populacao: number | null;
  pibPerCapita: number | null;
  densidade: number | null;
  /** Empresas do setor ÷ total de empresas da praça. */
  shareSetor: number | null;
  /** Crescimento do setor, % ao ano. */
  crescimentoSetor: number | null;
  /** PIB ÷ nº de empresas — proxy de porte médio do tecido local. */
  pibPorEmpresa: number | null;
}

interface Dimensao {
  chave: string;
  rotulo: string;
  ler: (e: EntradaSimilaridade) => number | null;
  /** `log` para grandezas exponenciais; `linear` para taxas e proporções. */
  escala: "log" | "linear";
}

const DIMENSOES: Dimensao[] = [
  { chave: "pop", rotulo: "Porte populacional", ler: (e) => e.populacao, escala: "log" },
  { chave: "pib", rotulo: "Poder de compra", ler: (e) => e.pibPerCapita, escala: "log" },
  { chave: "den", rotulo: "Densidade empresarial", ler: (e) => e.densidade, escala: "linear" },
  { chave: "sha", rotulo: "Peso do setor na economia", ler: (e) => e.shareSetor, escala: "linear" },
  { chave: "cre", rotulo: "Crescimento do setor", ler: (e) => e.crescimentoSetor, escala: "linear" },
  { chave: "pte", rotulo: "Porte médio das empresas", ler: (e) => e.pibPorEmpresa, escala: "log" },
];

function transformar(v: number | null, escala: Dimensao["escala"]): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (escala !== "log") return v;
  /* log1p aceita zero sem virar -Infinity — município sem empresa do setor é
     um caso real, não um erro a descartar. Negativos não existem nestas
     grandezas, mas o guarda evita NaN se a fonte mudar. */
  return v < 0 ? null : Math.log1p(v);
}

export interface DimensaoComparada {
  rotulo: string;
  /** Distância nesta dimensão, em desvios-padrão. Menor = mais parecido. */
  distancia: number;
  valorAlvo: number;
  valorCandidato: number;
}

export interface Semelhante {
  entrada: EntradaSimilaridade;
  /** 0–100. 100 seria idêntico em todas as dimensões comparáveis. */
  similaridade: number;
  /** As dimensões que mais aproximam, primeiro. Alimenta o "por quê". */
  maisParecidas: DimensaoComparada[];
  /** A dimensão que mais afasta — o contraponto honesto. */
  maiorDiferenca: DimensaoComparada | null;
}

/**
 * Praças mais parecidas com `alvoId` dentro do `universo`.
 *
 * Devolve lista vazia (em vez de resultados fracos) quando o alvo não tem pelo
 * menos três dimensões preenchidas: comparar por uma ou duas produz vizinhos
 * que parecem certos e não são.
 */
export function pracasSemelhantes(
  alvoId: number,
  universo: EntradaSimilaridade[],
  limite = 8,
): Semelhante[] {
  const alvo = universo.find((e) => e.id === alvoId);
  if (!alvo) return [];

  /* Média e desvio de cada dimensão, sobre o universo inteiro. */
  const estat = DIMENSOES.map((d) => {
    const vs = universo
      .map((e) => transformar(d.ler(e), d.escala))
      .filter((v): v is number => v != null);
    if (vs.length < 2) return { d, media: 0, desvio: 0 };
    const media = vs.reduce((a, b) => a + b, 0) / vs.length;
    const variancia = vs.reduce((a, b) => a + (b - media) ** 2, 0) / vs.length;
    return { d, media, desvio: Math.sqrt(variancia) };
  });

  const z = (e: EntradaSimilaridade, i: number): number | null => {
    const st = estat[i];
    if (!st || st.desvio === 0) return null;
    const v = transformar(st.d.ler(e), st.d.escala);
    return v == null ? null : (v - st.media) / st.desvio;
  };

  const zAlvo = DIMENSOES.map((_, i) => z(alvo, i));
  if (zAlvo.filter((v) => v != null).length < 3) return [];

  const candidatos: Semelhante[] = [];

  for (const e of universo) {
    if (e.id === alvoId) continue;

    const comparadas: DimensaoComparada[] = [];
    let soma = 0;
    let usadas = 0;

    DIMENSOES.forEach((d, i) => {
      const a = zAlvo[i];
      const b = z(e, i);
      if (a == null || b == null) return;
      const dist = Math.abs(a - b);
      soma += dist * dist;
      usadas++;
      comparadas.push({
        rotulo: d.rotulo,
        distancia: dist,
        valorAlvo: d.ler(alvo) ?? 0,
        valorCandidato: d.ler(e) ?? 0,
      });
    });

    /* Menos de 3 dimensões em comum não sustenta a comparação. */
    if (usadas < 3) continue;

    /* Distância euclidiana média por dimensão — assim um candidato com 6
       dimensões não é penalizado contra um com 3 só por ter mais termos. */
    const distancia = Math.sqrt(soma / usadas);

    /* Meio desvio-padrão de distância média ≈ 61 de similaridade; dois
       desvios ≈ 14. A curva decai suave, sem corte artificial. */
    const similaridade = Math.round(100 * Math.exp(-distancia / 2));

    comparadas.sort((x, y) => x.distancia - y.distancia);

    candidatos.push({
      entrada: e,
      similaridade,
      maisParecidas: comparadas.slice(0, 3),
      maiorDiferenca: comparadas[comparadas.length - 1] ?? null,
    });
  }

  return candidatos
    .sort((a, b) => b.similaridade - a.similaridade)
    .slice(0, limite);
}
