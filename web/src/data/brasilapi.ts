/**
 * brasilapi.ts — cliente da BrasilAPI (dados públicos da Receita Federal).
 *
 * Endpoint: https://brasilapi.com.br/api/cnpj/v1/{cnpj} — verificado ao vivo,
 * CORS liberado (`access-control-allow-origin: *`), sem chave.
 *
 * ── O que este arquivo protege ─────────────────────────────────────────────
 * A BrasilAPI é gratuita e limita por IP. Uma tabela de 20 CNPJs disparados
 * em paralelo toma 429. Três defesas, nesta ordem:
 *   1. validar o CNPJ antes de sair (dígito verificador) — não gasta cota com
 *      número que a fonte vai recusar;
 *   2. cache por CNPJ — cadastro da Receita muda em escala de meses;
 *   3. pool com concorrência 3 + espaçamento, e backoff que respeita
 *      `Retry-After` (em http.ts).
 *
 * O resultado por linha é independente: um CNPJ que falhou aparece com o erro
 * dele, e as outras dezenove linhas seguem preenchendo.
 */
import { fetchJson, ApiError } from "../lib/http";
import { comCache } from "../lib/cache";
import { mapaComLimite, type Resultado } from "../lib/pool";
import { cnpjValido, soDigitos } from "../lib/format";
import { secaoDeCnae, type SecaoCnae } from "./cnae";

const BASE = "https://brasilapi.com.br/api/cnpj/v1";

/* ─── Resposta crua ────────────────────────────────────────────────────── */

interface CnpjBruto {
  cnpj?: string;
  razao_social?: string;
  nome_fantasia?: string;
  cnae_fiscal?: number;
  cnae_fiscal_descricao?: string;
  cnaes_secundarios?: { codigo?: number; descricao?: string }[];
  codigo_porte?: number;
  porte?: string;
  natureza_juridica?: string;
  capital_social?: number;
  data_inicio_atividade?: string;
  situacao_cadastral?: number;
  descricao_situacao_cadastral?: string;
  data_situacao_cadastral?: string;
  municipio?: string;
  uf?: string;
  bairro?: string;
  logradouro?: string;
  descricao_tipo_de_logradouro?: string;
  numero?: string;
  cep?: string;
  codigo_municipio_ibge?: number;
  ddd_telefone_1?: string;
  email?: string;
  opcao_pelo_simples?: boolean | null;
  opcao_pelo_mei?: boolean | null;
  descricao_identificador_matriz_filial?: string;
  qsa?: { nome_socio?: string; qualificacao_socio?: string }[];
}

/* ─── Tipo de domínio ──────────────────────────────────────────────────── */

export type Porte = "MEI" | "Micro" | "Pequeno" | "Médio/Grande" | "Não informado";
export type SituacaoCadastral = "Ativa" | "Suspensa" | "Inapta" | "Baixada" | "Nula" | "Desconhecida";

export interface Empresa {
  cnpj: string;
  razaoSocial: string;
  nomeFantasia: string | null;
  cnaeCodigo: number | null;
  cnaeDescricao: string | null;
  cnaesSecundarios: number;
  secao: SecaoCnae;
  porte: Porte;
  naturezaJuridica: string | null;
  capitalSocial: number | null;
  dataAbertura: string | null;
  situacao: SituacaoCadastral;
  matriz: boolean;
  municipio: string;
  uf: string;
  bairro: string | null;
  endereco: string | null;
  cep: string | null;
  municipioIbgeId: number | null;
  telefone: string | null;
  email: string | null;
  simples: boolean | null;
  mei: boolean | null;
  socios: number;
}

/** Códigos de porte da Receita: 1 micro, 3 EPP, 5 demais. */
function normalizarPorte(b: CnpjBruto): Porte {
  if (b.opcao_pelo_mei) return "MEI";
  switch (b.codigo_porte) {
    case 1:
      return "Micro";
    case 3:
      return "Pequeno";
    case 5:
      return "Médio/Grande";
    default:
      return "Não informado";
  }
}

/** Situação cadastral: 2 é ativa; o resto significa que a empresa não deve
 *  entrar em campanha de prospecção. */
function normalizarSituacao(b: CnpjBruto): SituacaoCadastral {
  switch (b.situacao_cadastral) {
    case 1:
      return "Nula";
    case 2:
      return "Ativa";
    case 3:
      return "Inapta";
    case 4:
      return "Suspensa";
    case 8:
      return "Baixada";
    default:
      return "Desconhecida";
  }
}

function montarEndereco(b: CnpjBruto): string | null {
  const partes = [b.descricao_tipo_de_logradouro, b.logradouro, b.numero]
    .map((p) => (p ?? "").trim())
    .filter(Boolean);
  return partes.length ? partes.join(" ") : null;
}

function normalizar(b: CnpjBruto, cnpjPedido: string): Empresa {
  return {
    cnpj: soDigitos(b.cnpj ?? cnpjPedido),
    razaoSocial: b.razao_social?.trim() || "(sem razão social)",
    nomeFantasia: b.nome_fantasia?.trim() || null,
    cnaeCodigo: b.cnae_fiscal ?? null,
    cnaeDescricao: b.cnae_fiscal_descricao?.trim() || null,
    cnaesSecundarios: b.cnaes_secundarios?.length ?? 0,
    secao: secaoDeCnae(b.cnae_fiscal),
    porte: normalizarPorte(b),
    naturezaJuridica: b.natureza_juridica?.trim() || null,
    capitalSocial: typeof b.capital_social === "number" ? b.capital_social : null,
    dataAbertura: b.data_inicio_atividade ?? null,
    situacao: normalizarSituacao(b),
    matriz: b.descricao_identificador_matriz_filial !== "FILIAL",
    municipio: b.municipio?.trim() || "—",
    uf: b.uf?.trim() || "—",
    bairro: b.bairro?.trim() || null,
    endereco: montarEndereco(b),
    cep: b.cep ? soDigitos(String(b.cep)) : null,
    municipioIbgeId: b.codigo_municipio_ibge ?? null,
    telefone: b.ddd_telefone_1?.trim() || null,
    email: b.email?.trim() || null,
    simples: b.opcao_pelo_simples ?? null,
    mei: b.opcao_pelo_mei ?? null,
    socios: b.qsa?.length ?? 0,
  };
}

/* ─── Consultas ────────────────────────────────────────────────────────── */

/**
 * Consulta de um CNPJ, memoizada por 24h.
 *
 * Não recebe `AbortSignal` de propósito: o resultado é compartilhado no
 * cache, e um consumidor que desmonta não pode cancelar a busca que outros
 * estão esperando (ver a regra no topo de `lib/cache.ts`). O cancelamento
 * útil do lote acontece no pool, que para de disparar tarefas novas.
 */
export async function buscarCnpj(bruto: string): Promise<Empresa> {
  const cnpj = soDigitos(bruto);

  if (!cnpjValido(cnpj)) {
    throw new ApiError(`CNPJ inválido: ${bruto}`, {
      status: 400,
      url: `${BASE}/${cnpj}`,
      repetivel: false,
    });
  }

  return comCache(
    `brasilapi:cnpj:${cnpj}`,
    async () => normalizar(await fetchJson<CnpjBruto>(`${BASE}/${cnpj}`), cnpj),
    { ttlMs: 24 * 3600 * 1000 },
  );
}

export interface LoteOpts {
  signal?: AbortSignal;
  aoProgredir?: (concluidos: number, total: number) => void;
  /** Concorrência. 3 é o teto empírico confortável da BrasilAPI pública. */
  limite?: number;
}

export interface ItemLote {
  cnpj: string;
  empresa: Empresa | null;
  erro: ApiError | null;
}

/** Consulta em lote. Nunca rejeita — cada item carrega o próprio desfecho. */
export async function buscarLote(cnpjs: readonly string[], opts: LoteOpts = {}): Promise<ItemLote[]> {
  const { signal, aoProgredir, limite = 3 } = opts;

  const resultados: Resultado<Empresa>[] = await mapaComLimite(
    cnpjs,
    (cnpj) => buscarCnpj(cnpj),
    /* O `signal` fica no pool, não na requisição: desmontar a tela para de
       enfileirar CNPJs novos, mas as consultas já em voo terminam e populam o
       cache — reabrir a tela em seguida fica instantâneo. */
    { limite, intervaloMs: 180, signal, aoProgredir },
  );

  return cnpjs.map((cnpj, i) => {
    const r = resultados[i];
    if (r?.ok) return { cnpj: soDigitos(cnpj), empresa: r.valor, erro: null };
    const erro = r?.erro;
    return {
      cnpj: soDigitos(cnpj),
      empresa: null,
      erro:
        erro instanceof ApiError
          ? erro
          : new ApiError(erro instanceof Error ? erro.message : String(erro ?? "falha"), {
              url: `${BASE}/${soDigitos(cnpj)}`,
            }),
    };
  });
}

/**
 * Carteira inicial da tela de prospecção.
 *
 * Todos os 14 dígitos foram **conferidos contra a BrasilAPI real**: os 12
 * respondem 200, situação ATIVA, com razão social e CNAE conforme anotado ao
 * lado. Nenhum é exemplo de documentação nem número gerado.
 *
 * A seleção é deliberadamente diversa em CNAE — banco, petróleo, varejo
 * alimentar, varejo de eletro, energia, telecom, bebida, linha branca,
 * automotivo — porque é a diversidade setorial que faz o gráfico de
 * composição da carteira e o motor de insights terem o que dizer. A tela
 * aceita qualquer CNPJ adicional.
 */
export const CARTEIRA_INICIAL: readonly string[] = [
  "00000000000191", // Banco do Brasil — DF — CNAE 6422-1/00
  "33000167000101", // Petrobras — RJ — CNAE 0600-0/01
  "60701190000104", // Itaú Unibanco — SP — CNAE 6421-2/00
  "47508411000156", // Cia. Brasileira de Distribuição (GPA) — SP — CNAE 4789-0/99
  "06057223000171", // Sendas Distribuidora (Assaí) — SP — CNAE 4711-3/02
  "61695227000193", // Eletropaulo Metropolitana — SP — CNAE 3514-0/00
  "47960950000121", // Magazine Luiza — SP — CNAE 4713-0/04
  "07526557000100", // Ambev — SP — CNAE 1113-5/02
  "02558157000162", // Telefônica Brasil (Vivo) — SP — CNAE 6120-5/99
  "33041260065290", // Grupo Casas Bahia — SP — CNAE 4753-9/00
  "59105999000186", // Whirlpool — SP — CNAE 2751-1/00
  "16701716000156", // Stellantis Automóveis Brasil — MG — CNAE 2910-7/01
];
