/**
 * ibge.ts — cliente da API pública do IBGE (servicodados.ibge.gov.br).
 *
 * Duas APIs distintas:
 *   • localidades v1 — malha político-administrativa (estados, municípios)
 *   • agregados v3 (SIDRA) — as séries estatísticas
 *
 * Agregados/variáveis, todos **validados ao vivo** contra a API real:
 *   6579 / 9324  → população residente estimada
 *   5938 / 37    → PIB municipal a preços correntes (unidade: MIL reais)
 *   9418 / 2585  → nº de empresas e outras organizações, COM quebra CNAE 2.0
 *
 * ── Por que 9418 e não 9510 ────────────────────────────────────────────────
 * O CEMPRE aparece em várias tabelas do SIDRA. A 9510 (variável 367,
 * "atuantes") tem só a categoria "Total": pedir qualquer seção CNAE nela
 * devolve "-" em TODO nível geográfico e em TODOS os períodos (2022, 2023,
 * 2024) — testado. A 9418 publica as 1.067 categorias da CNAE 2.0 (seção,
 * divisão, grupo e classe) em N1/N2/N3/N6, e cobre os 5.570 municípios sem
 * supressão no total. É a diferença entre "existem X empresas nesta praça" e
 * "existem X empresas, das quais Y são do seu setor" — a segunda é a que
 * vende.
 *
 * ── Limites de payload, medidos ────────────────────────────────────────────
 *   21 seções × 27 UFs .............  73 KB, 0,2s  ✓
 *   1 seção × 5.570 municípios ..... 678 KB, 1,5s  ✓
 *   21 seções × 5.570 municípios ... erro 500      ✗  (a API recusa)
 * Daí o desenho: matriz setor×UF numa chamada; drill municipal um setor por
 * vez, sob demanda.
 */
import { fetchJson } from "../lib/http";
import { comCache } from "../lib/cache";

const LOCALIDADES = "https://servicodados.ibge.gov.br/api/v1/localidades";
const AGREGADOS = "https://servicodados.ibge.gov.br/api/v3/agregados";

const AGREGADO_POPULACAO = 6579;
const VARIAVEL_POPULACAO = 9324;
const AGREGADO_PIB = 5938;
const VARIAVEL_PIB = 37; // em MIL reais
const AGREGADO_EMPRESAS = 9418;
const VARIAVEL_EMPRESAS = 2585;
const CLASSIFICACAO_CNAE = 12762;
const CATEGORIA_TOTAL = 117897;

/**
 * Seção CNAE 2.0 → id da categoria na classificação 12762 do agregado 9418.
 * Ids lidos do endpoint `/metadados`, não transcritos de documentação.
 */
export const CATEGORIA_SECAO: Readonly<Record<string, number>> = {
  A: 116830, B: 116880, C: 116910, D: 117296, E: 117307,
  F: 117329, G: 117363, H: 117484, I: 117543, J: 117555,
  K: 117608, L: 117666, M: 117673, N: 117714, O: 117774,
  P: 117788, Q: 117810, R: 117838, S: 117861, T: 117888, U: 117892,
};

/** Divisões do Comércio (seção G) — o drill que o varejo pede primeiro. */
export const CATEGORIA_DIVISAO_COMERCIO: Readonly<Record<string, number>> = {
  "45": 117364, // Comércio e reparação de veículos automotores e motocicletas
  "46": 117376, // Comércio por atacado
  "47": 117438, // Comércio varejista
};

/* ─── Tipos de domínio ─────────────────────────────────────────────────── */

export interface Uf {
  id: number;
  sigla: string;
  nome: string;
  regiao: string;
}

export interface Municipio {
  id: number;
  nome: string;
  uf: string;
}

/** Métrica com o ano junto. O ano nunca é omitido: o PIB do IBGE sai com ~2
 *  anos de defasagem e o usuário precisa saber para não comparar com o
 *  faturamento do mês. */
export interface Medida {
  valor: number;
  ano: number;
}

export interface MetricasLocalidade {
  id: number;
  nome: string;
  uf: string;
  populacao: Medida | null;
  pibTotal: Medida | null;
  empresas: Medida | null;
}

/* ─── Parsing dos agregados ────────────────────────────────────────────── */

interface Serie {
  localidade?: { id?: string; nome?: string };
  serie?: Record<string, string>;
}

interface Resultado {
  classificacoes?: { id?: string; categoria?: Record<string, string> }[];
  series?: Serie[];
}

interface RespostaAgregado {
  resultados?: Resultado[];
}

/** Valores suprimidos pelo IBGE. Viram `null`, nunca 0 — um "0 empresas"
 *  inventado é pior que um "indisponível" honesto, porque o usuário acredita. */
const SUPRIMIDO = new Set(["-", "..", "...", "X", "..X", ""]);

function medidaDaSerie(s: Serie): Medida | null {
  const entradas = Object.entries(s.serie ?? {});
  if (entradas.length === 0) return null;
  const [ano, bruto] = entradas[entradas.length - 1] as [string, string];
  if (bruto == null || SUPRIMIDO.has(String(bruto).trim())) return null;
  const valor = Number(bruto);
  return Number.isFinite(valor) ? { valor, ano: Number(ano) } : null;
}

/** Achata um `resultado` em `id da localidade → medida`. */
function porLocalidade(resultado: Resultado | undefined): Map<number, Medida> {
  const saida = new Map<number, Medida>();
  for (const s of resultado?.series ?? []) {
    const id = Number(s.localidade?.id);
    if (!Number.isFinite(id)) continue;
    const m = medidaDaSerie(s);
    if (m) saida.set(id, m);
  }
  return saida;
}

function urlAgregado(
  agregado: number,
  variavel: number,
  nivel: string,
  classificacao?: string,
): string {
  const p = new URLSearchParams({ localidades: nivel });
  if (classificacao) p.set("classificacao", classificacao);
  return `${AGREGADOS}/${agregado}/periodos/-1/variaveis/${variavel}?${p}`;
}

/* ─── Malha político-administrativa ────────────────────────────────────── */

export function listarUfs(): Promise<Uf[]> {
  return comCache(
    "ibge:ufs",
    async () => {
      const bruto = await fetchJson<
        { id: number; sigla: string; nome: string; regiao?: { nome?: string } }[]
      >(`${LOCALIDADES}/estados?orderBy=nome`, {});
      return bruto.map((e) => ({
        id: e.id,
        sigla: e.sigla,
        nome: e.nome,
        regiao: e.regiao?.nome ?? "—",
      }));
    },
    { ttlMs: 30 * 24 * 3600 * 1000 }, // a malha muda a cada década, não a cada dia
  );
}

export function listarMunicipios(uf: string): Promise<Municipio[]> {
  return comCache(
    `ibge:municipios:${uf}`,
    async () => {
      const bruto = await fetchJson<{ id: number; nome: string }[]>(
        `${LOCALIDADES}/estados/${uf.toUpperCase()}/municipios`,
        {},
      );
      return bruto
        .map((m) => ({ id: m.id, nome: m.nome, uf: uf.toUpperCase() }))
        .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    },
    { ttlMs: 30 * 24 * 3600 * 1000 },
  );
}

/* ─── Carga territorial ────────────────────────────────────────────────── */

/** Vem como "São Paulo (SP)" ou "São Paulo - SP" conforme o agregado. */
function separarNomeUf(nome: string): { nome: string; uf: string } {
  const comParenteses = /^(.*)\s+\(([A-Z]{2})\)\s*$/.exec(nome);
  if (comParenteses) return { nome: comParenteses[1] as string, uf: comParenteses[2] as string };
  const comTraco = /^(.*)\s+-\s+([A-Z]{2})\s*$/.exec(nome);
  if (comTraco) return { nome: comTraco[1] as string, uf: comTraco[2] as string };
  return { nome, uf: "" };
}

export interface CargaNacional {
  municipios: MetricasLocalidade[];
  /** Índice por código IBGE — consulta direta sem varrer 5.570 itens. */
  porId: Map<number, MetricasLocalidade>;
}

/**
 * População, PIB e nº de empresas dos 5.570 municípios do Brasil.
 * 3 requisições, ~2s. Cache só em memória: ~1,5MB não cabe confortavelmente
 * no sessionStorage e tentar gravar custaria tempo à toa.
 */
export function cargaNacional(): Promise<CargaNacional> {
  return comCache(
    "ibge:nacional:municipios",
    async () => {
      const [pop, pib, emp] = await Promise.all([
        fetchJson<RespostaAgregado[]>(
          urlAgregado(AGREGADO_POPULACAO, VARIAVEL_POPULACAO, "N6[all]"),
          { timeoutMs: 45_000 },
        ),
        fetchJson<RespostaAgregado[]>(urlAgregado(AGREGADO_PIB, VARIAVEL_PIB, "N6[all]"), { timeoutMs: 45_000 }),
        fetchJson<RespostaAgregado[]>(
          urlAgregado(
            AGREGADO_EMPRESAS,
            VARIAVEL_EMPRESAS,
            "N6[all]",
            `${CLASSIFICACAO_CNAE}[${CATEGORIA_TOTAL}]`,
          ),
          { timeoutMs: 45_000 },
        ),
      ]);

      const mPop = porLocalidade(pop?.[0]?.resultados?.[0]);
      const mPib = porLocalidade(pib?.[0]?.resultados?.[0]);
      const mEmp = porLocalidade(emp?.[0]?.resultados?.[0]);

      /* Os nomes vêm da série de empresas (5.570/5.570 sem supressão). */
      const nomes = new Map<number, string>();
      for (const s of emp?.[0]?.resultados?.[0]?.series ?? []) {
        const id = Number(s.localidade?.id);
        if (Number.isFinite(id) && s.localidade?.nome) nomes.set(id, s.localidade.nome);
      }
      for (const s of pop?.[0]?.resultados?.[0]?.series ?? []) {
        const id = Number(s.localidade?.id);
        if (Number.isFinite(id) && s.localidade?.nome && !nomes.has(id))
          nomes.set(id, s.localidade.nome);
      }

      const municipios: MetricasLocalidade[] = [];
      for (const [id, nomeBruto] of nomes) {
        const { nome, uf } = separarNomeUf(nomeBruto);
        const pibMil = mPib.get(id);
        municipios.push({
          id,
          nome,
          uf: uf || ufDoCodigo(id),
          populacao: mPop.get(id) ?? null,
          /* A variável 37 é publicada em MIL reais — converter aqui, uma vez,
             evita que cada tela lembre (ou esqueça) de multiplicar. */
          pibTotal: pibMil ? { valor: pibMil.valor * 1000, ano: pibMil.ano } : null,
          empresas: mEmp.get(id) ?? null,
        });
      }

      municipios.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
      return { municipios, porId: new Map(municipios.map((m) => [m.id, m])) };
    },
    { ttlMs: 6 * 3600 * 1000, persistir: false },
  );
}

/** Mesmas métricas agregadas nas 27 UFs. 3 requisições, payload pequeno. */
export function cargaEstadual(): Promise<MetricasLocalidade[]> {
  return comCache(
    "ibge:nacional:ufs",
    async () => {
      const [pop, pib, emp] = await Promise.all([
        fetchJson<RespostaAgregado[]>(
          urlAgregado(AGREGADO_POPULACAO, VARIAVEL_POPULACAO, "N3[all]"),
          {},
        ),
        fetchJson<RespostaAgregado[]>(urlAgregado(AGREGADO_PIB, VARIAVEL_PIB, "N3[all]"), {}),
        fetchJson<RespostaAgregado[]>(
          urlAgregado(
            AGREGADO_EMPRESAS,
            VARIAVEL_EMPRESAS,
            "N3[all]",
            `${CLASSIFICACAO_CNAE}[${CATEGORIA_TOTAL}]`,
          ),
          {},
        ),
      ]);

      const mPop = porLocalidade(pop?.[0]?.resultados?.[0]);
      const mPib = porLocalidade(pib?.[0]?.resultados?.[0]);
      const mEmp = porLocalidade(emp?.[0]?.resultados?.[0]);

      const nomes = new Map<number, string>();
      for (const s of pop?.[0]?.resultados?.[0]?.series ?? []) {
        const id = Number(s.localidade?.id);
        if (Number.isFinite(id) && s.localidade?.nome) nomes.set(id, s.localidade.nome);
      }

      const saida: MetricasLocalidade[] = [];
      for (const [id, nome] of nomes) {
        const pibMil = mPib.get(id);
        saida.push({
          id,
          nome,
          uf: SIGLA_POR_CODIGO[id] ?? nome,
          populacao: mPop.get(id) ?? null,
          pibTotal: pibMil ? { valor: pibMil.valor * 1000, ano: pibMil.ano } : null,
          empresas: mEmp.get(id) ?? null,
        });
      }
      return saida.sort((a, b) => (b.populacao?.valor ?? 0) - (a.populacao?.valor ?? 0));
    },
    { ttlMs: 6 * 3600 * 1000 },
  );
}

/* ─── Composição setorial (a quebra CNAE que só a 9418 dá) ─────────────── */

export interface SetorLocalidade {
  /** Letra da seção CNAE 2.0 (A–U). */
  secao: string;
  empresas: number;
  ano: number;
}

/** Lê um resultado por categoria (uma entrada por seção pedida). */
function porSecao(
  resultados: Resultado[] | undefined,
  idParaSecao: Map<number, string>,
): Map<number, SetorLocalidade[]> {
  const saida = new Map<number, SetorLocalidade[]>();

  for (const res of resultados ?? []) {
    const catId = Number(Object.keys(res.classificacoes?.[0]?.categoria ?? {})[0]);
    const secao = idParaSecao.get(catId);
    if (!secao) continue;

    for (const s of res.series ?? []) {
      const localidade = Number(s.localidade?.id);
      if (!Number.isFinite(localidade)) continue;
      const m = medidaDaSerie(s);
      if (!m) continue;
      const lista = saida.get(localidade) ?? [];
      lista.push({ secao, empresas: m.valor, ano: m.ano });
      saida.set(localidade, lista);
    }
  }

  for (const lista of saida.values()) lista.sort((a, b) => b.empresas - a.empresas);
  return saida;
}

const TODAS_SECOES = Object.entries(CATEGORIA_SECAO);
const ID_PARA_SECAO = new Map(TODAS_SECOES.map(([letra, id]) => [id, letra]));
const IDS_TODAS_SECOES = TODAS_SECOES.map(([, id]) => id).join(",");

/**
 * Matriz completa setor × UF: as 21 seções CNAE nas 27 UFs.
 * **Uma requisição, 73KB** — é o que sustenta a tela nacional de setores.
 */
export function setoresPorUf(): Promise<Map<number, SetorLocalidade[]>> {
  return comCache(
    "ibge:setores:ufs",
    async () => {
      const corpo = await fetchJson<RespostaAgregado[]>(
        urlAgregado(
          AGREGADO_EMPRESAS,
          VARIAVEL_EMPRESAS,
          "N3[all]",
          `${CLASSIFICACAO_CNAE}[${IDS_TODAS_SECOES}]`,
        ),
        { timeoutMs: 30_000 },
      );
      return porSecao(corpo?.[0]?.resultados, ID_PARA_SECAO);
    },
    { ttlMs: 6 * 3600 * 1000 },
  );
}

/** As 21 seções do Brasil inteiro (N1). Uma requisição, ~6KB. */
export function setoresDoBrasil(): Promise<SetorLocalidade[]> {
  return comCache(
    "ibge:setores:brasil",
    async () => {
      const corpo = await fetchJson<RespostaAgregado[]>(
        urlAgregado(
          AGREGADO_EMPRESAS,
          VARIAVEL_EMPRESAS,
          "N1[all]",
          `${CLASSIFICACAO_CNAE}[${IDS_TODAS_SECOES}]`,
        ),
        {},
      );
      return porSecao(corpo?.[0]?.resultados, ID_PARA_SECAO).get(1) ?? [];
    },
    { ttlMs: 6 * 3600 * 1000 },
  );
}

/** As 21 seções de UM município. Requisição pequena, sob demanda. */
export function setoresDoMunicipio(municipioId: number): Promise<SetorLocalidade[]> {
  return comCache(
    `ibge:setores:municipio:${municipioId}`,
    async () => {
      const corpo = await fetchJson<RespostaAgregado[]>(
        urlAgregado(
          AGREGADO_EMPRESAS,
          VARIAVEL_EMPRESAS,
          `N6[${municipioId}]`,
          `${CLASSIFICACAO_CNAE}[${IDS_TODAS_SECOES}]`,
        ),
        {},
      );
      return porSecao(corpo?.[0]?.resultados, ID_PARA_SECAO).get(municipioId) ?? [];
    },
    { ttlMs: 6 * 3600 * 1000 },
  );
}

/**
 * UM setor em TODOS os 5.570 municípios — o "onde estão as empresas do meu
 * setor no Brasil inteiro". Uma requisição de ~680KB, ~1,5s.
 *
 * Um setor por vez porque a API recusa (500) o produto cartesiano
 * 21 seções × 5.570 municípios. Cache em memória, sem persistir.
 */
export function municipiosDoSetor(secao: string): Promise<MetricasLocalidade[]> {
  const categoria = CATEGORIA_SECAO[secao];
  if (!categoria) return Promise.reject(new Error(`seção CNAE desconhecida: ${secao}`));

  return comCache(
    `ibge:setor:${secao}:municipios`,
    async () => {
      const corpo = await fetchJson<RespostaAgregado[]>(
        urlAgregado(
          AGREGADO_EMPRESAS,
          VARIAVEL_EMPRESAS,
          "N6[all]",
          `${CLASSIFICACAO_CNAE}[${categoria}]`,
        ),
        { timeoutMs: 45_000 },
      );

      const saida: MetricasLocalidade[] = [];
      for (const s of corpo?.[0]?.resultados?.[0]?.series ?? []) {
        const id = Number(s.localidade?.id);
        if (!Number.isFinite(id)) continue;
        const m = medidaDaSerie(s);
        const { nome, uf } = separarNomeUf(s.localidade?.nome ?? "");
        saida.push({
          id,
          nome,
          uf: uf || ufDoCodigo(id),
          populacao: null,
          pibTotal: null,
          empresas: m,
        });
      }
      return saida.sort((a, b) => (b.empresas?.valor ?? 0) - (a.empresas?.valor ?? 0));
    },
    { ttlMs: 6 * 3600 * 1000, persistir: false },
  );
}

/** Divisões do Comércio (45/46/47) no Brasil. Uma requisição. */
export function divisoesDoComercio(): Promise<{ divisao: string; empresas: number; ano: number }[]> {
  return comCache(
    "ibge:comercio:divisoes:brasil",
    async () => {
      const ids = Object.values(CATEGORIA_DIVISAO_COMERCIO).join(",");
      const idParaDivisao = new Map(
        Object.entries(CATEGORIA_DIVISAO_COMERCIO).map(([d, id]) => [id, d]),
      );
      const corpo = await fetchJson<RespostaAgregado[]>(
        urlAgregado(
          AGREGADO_EMPRESAS,
          VARIAVEL_EMPRESAS,
          "N1[all]",
          `${CLASSIFICACAO_CNAE}[${ids}]`,
        ),
        {},
      );

      const saida: { divisao: string; empresas: number; ano: number }[] = [];
      for (const res of corpo?.[0]?.resultados ?? []) {
        const catId = Number(Object.keys(res.classificacoes?.[0]?.categoria ?? {})[0]);
        const divisao = idParaDivisao.get(catId);
        const serie = res.series?.[0];
        if (!divisao || !serie) continue;
        const m = medidaDaSerie(serie);
        if (m) saida.push({ divisao, empresas: m.valor, ano: m.ano });
      }
      return saida.sort((a, b) => b.empresas - a.empresas);
    },
    { ttlMs: 6 * 3600 * 1000 },
  );
}

/* ─── Códigos de UF ────────────────────────────────────────────────────── */

const SIGLA_POR_CODIGO: Record<number, string> = {
  11: "RO", 12: "AC", 13: "AM", 14: "RR", 15: "PA", 16: "AP", 17: "TO",
  21: "MA", 22: "PI", 23: "CE", 24: "RN", 25: "PB", 26: "PE", 27: "AL", 28: "SE", 29: "BA",
  31: "MG", 32: "ES", 33: "RJ", 35: "SP",
  41: "PR", 42: "SC", 43: "RS",
  50: "MS", 51: "MT", 52: "GO", 53: "DF",
};

/** Código IBGE do município → sigla da UF, pelos 2 primeiros dígitos. */
export function ufDoCodigo(codigoMunicipio: number): string {
  return SIGLA_POR_CODIGO[Math.floor(codigoMunicipio / 100000)] ?? "";
}

/** Filtra a carga nacional por UF. Barato: só um `filter` em memória. */
export function municipiosDaUf(carga: CargaNacional, uf: string): MetricasLocalidade[] {
  const alvo = uf.toUpperCase();
  return carga.municipios.filter((m) => (m.uf || ufDoCodigo(m.id)) === alvo);
}
