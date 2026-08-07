/**
 * territorio.ts — a matemática de inteligência de território.
 *
 * ── A regra que governa este arquivo ───────────────────────────────────────
 * Todo número devolvido daqui carrega a **procedência**: `real` (veio do
 * IBGE, sem transformação além de unidade), `derivado` (conta feita só com
 * números reais) ou `premissa` (depende de um parâmetro que o usuário
 * arbitrou — ticket médio, share alvo).
 *
 * Isso não é preciosismo. Um TAM em reais é sempre "base real × premissa
 * comercial"; um dashboard que mistura os dois num número só faz o usuário
 * tratar a premissa dele como dado do IBGE, e decidir investimento de praça
 * em cima disso. A interface mostra a etiqueta ao lado do valor.
 */
import type { MetricasLocalidade, SetorLocalidade } from "../data/ibge";

export type Procedencia = "real" | "derivado" | "premissa";

export interface Metrica {
  valor: number | null;
  procedencia: Procedencia;
  /** De onde veio, na linguagem do usuário. Vai para o tooltip. */
  fonte: string;
  ano?: number;
}

const semDado = (fonte: string): Metrica => ({ valor: null, procedencia: "real", fonte });

/* ─── Premissas comerciais ─────────────────────────────────────────────── */

export interface Premissas {
  /** Receita anual esperada por cliente, em reais. */
  ticketMedioAnual: number;
  /** Fatia da praça que a operação considera alcançável, 0–1. */
  shareAlvo: number;
  /** Seções CNAE que compõem o ICP. Vazio = todas. */
  secoesAlvo: string[];
}

export const PREMISSAS_PADRAO: Premissas = {
  ticketMedioAnual: 24_000,
  shareAlvo: 0.03,
  secoesAlvo: [],
};

/* ─── Indicadores de praça ─────────────────────────────────────────────── */

export interface AnaliseTerritorio {
  municipio: MetricasLocalidade;
  populacao: Metrica;
  pib: Metrica;
  empresas: Metrica;
  pibPerCapita: Metrica;
  /** Empresas por 1.000 habitantes. */
  densidade: Metrica;
  /** PIB dividido pelo nº de empresas — proxy de porte médio do tecido local. */
  pibPorEmpresa: Metrica;
  /** Densidade da praça ÷ mediana da UF. 1,0 = na mediana. */
  indiceSaturacao: Metrica;
  classificacao: ClassificacaoPraca;
  tam: Metrica;
  sam: Metrica;
  som: Metrica;
  /** Nº de empresas dentro das seções-alvo. `null` sem quebra CNAE carregada. */
  empresasAlvo: Metrica;
}

export type ClassificacaoPraca =
  | "subexplorada"
  | "equilibrada"
  | "saturada"
  | "indeterminada";

/**
 * Classifica a praça pela densidade relativa aos pares da MESMA UF.
 *
 * Comparar com a mediana estadual, e não com um número absoluto, é o que
 * torna a leitura transportável: 30 empresas/1.000 hab é denso no Maranhão e
 * ralo em Santa Catarina. Um limiar fixo diria bobagem em metade do país.
 *
 * As faixas (±20% da mediana) são uma convenção de produto, não um teste
 * estatístico — está escrito aqui, num lugar só, para poder ser discutido.
 */
function classificar(indice: number | null): ClassificacaoPraca {
  if (indice == null) return "indeterminada";
  if (indice >= 1.2) return "saturada";
  if (indice <= 0.8) return "subexplorada";
  return "equilibrada";
}

export function mediana(valores: number[]): number | null {
  const v = valores.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const meio = Math.floor(v.length / 2);
  return v.length % 2 ? (v[meio] as number) : ((v[meio - 1] as number) + (v[meio] as number)) / 2;
}

/** Densidade empresarial (empresas por 1.000 hab) de uma localidade. */
export function densidadeDe(m: MetricasLocalidade): number | null {
  if (!m.empresas || !m.populacao || m.populacao.valor <= 0) return null;
  return (m.empresas.valor / m.populacao.valor) * 1000;
}

export function analisarTerritorio(
  municipio: MetricasLocalidade,
  paresDaUf: MetricasLocalidade[],
  premissas: Premissas,
  setores?: SetorLocalidade[] | null,
): AnaliseTerritorio {
  const pop = municipio.populacao;
  const pib = municipio.pibTotal;
  const emp = municipio.empresas;

  const densidade = densidadeDe(municipio);

  const densidadesPares = paresDaUf
    .map(densidadeDe)
    .filter((d): d is number => d != null && Number.isFinite(d));
  const medianaUf = mediana(densidadesPares);

  const indice = densidade != null && medianaUf && medianaUf > 0 ? densidade / medianaUf : null;

  /* Empresas dentro do ICP setorial. Com as seções carregadas do IBGE, isto é
     dado REAL — não uma proporção estimada a partir de amostra. */
  const alvo = premissas.secoesAlvo;
  let empresasAlvo: number | null = null;
  let procedenciaAlvo: Procedencia = "real";
  let fonteAlvo = "IBGE · CEMPRE 9418, quebra por seção CNAE 2.0";

  if (alvo.length === 0) {
    empresasAlvo = emp?.valor ?? null;
    fonteAlvo = "IBGE · CEMPRE 9418, total de empresas";
  } else if (setores && setores.length > 0) {
    empresasAlvo = setores
      .filter((s) => alvo.includes(s.secao))
      .reduce((soma, s) => soma + s.empresas, 0);
  } else {
    /* Sem a quebra setorial carregada, não há como saber — e estimar por
       proporção nacional daria um número plausível e errado para a praça. */
    empresasAlvo = null;
    procedenciaAlvo = "derivado";
    fonteAlvo = "quebra setorial desta praça ainda não carregada";
  }

  const tam = emp ? emp.valor * premissas.ticketMedioAnual : null;
  const sam = empresasAlvo != null ? empresasAlvo * premissas.ticketMedioAnual : null;
  const som = sam != null ? sam * premissas.shareAlvo : null;

  return {
    municipio,
    populacao: pop
      ? { valor: pop.valor, procedencia: "real", fonte: "IBGE · estimativa populacional (6579)", ano: pop.ano }
      : semDado("IBGE não publica população para esta localidade"),
    pib: pib
      ? { valor: pib.valor, procedencia: "real", fonte: "IBGE · PIB dos Municípios (5938)", ano: pib.ano }
      : semDado("IBGE não publica PIB para esta localidade"),
    empresas: emp
      ? { valor: emp.valor, procedencia: "real", fonte: "IBGE · CEMPRE (9418/2585)", ano: emp.ano }
      : semDado("IBGE suprime este valor por sigilo estatístico"),
    pibPerCapita:
      pib && pop && pop.valor > 0
        ? {
            valor: pib.valor / pop.valor,
            procedencia: "derivado",
            fonte: "PIB ÷ população, ambos do IBGE",
            ano: pib.ano,
          }
        : semDado("depende de PIB e população, e uma das duas falta"),
    densidade:
      densidade != null
        ? {
            valor: densidade,
            procedencia: "derivado",
            fonte: "empresas ÷ população × 1.000, ambos do IBGE",
          }
        : semDado("depende de empresas e população, e uma das duas falta"),
    pibPorEmpresa:
      pib && emp && emp.valor > 0
        ? {
            valor: pib.valor / emp.valor,
            procedencia: "derivado",
            fonte: "PIB ÷ nº de empresas, ambos do IBGE",
          }
        : semDado("depende de PIB e nº de empresas"),
    indiceSaturacao:
      indice != null
        ? {
            valor: indice,
            procedencia: "derivado",
            fonte: `densidade da praça ÷ mediana de ${densidadesPares.length} municípios da UF`,
          }
        : semDado("sem municípios comparáveis na UF"),
    classificacao: classificar(indice),
    empresasAlvo:
      empresasAlvo != null
        ? { valor: empresasAlvo, procedencia: procedenciaAlvo, fonte: fonteAlvo }
        : semDado(fonteAlvo),
    tam:
      tam != null
        ? {
            valor: tam,
            procedencia: "premissa",
            fonte: `${emp?.valor.toLocaleString("pt-BR")} empresas (IBGE) × ticket médio arbitrado`,
          }
        : semDado("sem nº de empresas para esta praça"),
    sam:
      sam != null
        ? {
            valor: sam,
            procedencia: "premissa",
            fonte: "empresas das seções-alvo (IBGE) × ticket médio arbitrado",
          }
        : semDado("sem quebra setorial para esta praça"),
    som:
      som != null
        ? {
            valor: som,
            procedencia: "premissa",
            fonte: "SAM × share alvo arbitrado",
          }
        : semDado("depende do SAM"),
  };
}

/* ─── Rankings ─────────────────────────────────────────────────────────── */

export type CriterioRanking = "empresas" | "populacao" | "pib" | "densidade" | "pibPerCapita";

export function valorPorCriterio(
  m: MetricasLocalidade,
  criterio: CriterioRanking,
): number | null {
  switch (criterio) {
    case "empresas":
      return m.empresas?.valor ?? null;
    case "populacao":
      return m.populacao?.valor ?? null;
    case "pib":
      return m.pibTotal?.valor ?? null;
    case "densidade":
      return densidadeDe(m);
    case "pibPerCapita":
      return m.populacao && m.pibTotal && m.populacao.valor > 0
        ? m.pibTotal.valor / m.populacao.valor
        : null;
  }
}

export function ranquear(
  municipios: MetricasLocalidade[],
  criterio: CriterioRanking,
  limite = 12,
): { municipio: MetricasLocalidade; valor: number }[] {
  return municipios
    .map((m) => ({ municipio: m, valor: valorPorCriterio(m, criterio) }))
    .filter((r): r is { municipio: MetricasLocalidade; valor: number } => r.valor != null)
    .sort((a, b) => b.valor - a.valor)
    .slice(0, limite);
}

/**
 * Concentração: quanto do total está nos N primeiros municípios.
 *
 * É o indicador que decide cobertura — 60% do mercado em 5 cidades pede
 * equipe concentrada; 60% espalhado em 200 pede canal indireto.
 */
export function concentracao(
  municipios: MetricasLocalidade[],
  criterio: CriterioRanking,
  n: number,
): { pctNosTop: number; total: number; nosTop: number } | null {
  const valores = municipios
    .map((m) => valorPorCriterio(m, criterio))
    .filter((v): v is number => v != null)
    .sort((a, b) => b - a);

  if (valores.length === 0) return null;
  const total = valores.reduce((s, v) => s + v, 0);
  if (total <= 0) return null;
  const nosTop = valores.slice(0, n).reduce((s, v) => s + v, 0);
  return { pctNosTop: (nosTop / total) * 100, total, nosTop };
}
