/**
 * ferramentas.ts — o que o agente de IA pode fazer.
 *
 * ── A ideia central ───────────────────────────────────────────────────────
 * O modelo NÃO recebe os dados. Recebe **funções**.
 *
 * Isso não é detalhe de implementação, é o que torna o recurso honesto. Um LLM
 * que recebe 5.570 linhas no prompt vai citar a linha errada, arredondar
 * sozinho e inventar o município que faltou — com a mesma fluência com que
 * acerta. Um LLM que só sabe chamar `filtrar_pracas({uf:"SC"})` e ler o
 * retorno não tem por onde inventar: cada número na resposta passou por um
 * cálculo determinístico daqui.
 *
 * O prompt do servidor reforça a regra ("você NÃO tem nenhum dado de mercado
 * na memória"), mas a garantia real é arquitetural, não textual.
 *
 * ── Orçamento de tokens ───────────────────────────────────────────────────
 * Todo retorno é limitado e enxuto. Uma ferramenta que devolvesse 5.570 linhas
 * recriaria exatamente o problema que ela existe para evitar — e estouraria a
 * janela de contexto na segunda pergunta.
 */
import type { Praca, Universo } from "../app/useUniverso";
import { pracasSemelhantes } from "./similaridade";
import { DESCRICAO_FAIXA_ATRATIVIDADE } from "./atratividade";
import { ROTULO_TENDENCIA } from "./crescimento";
import { SECOES } from "../data/cnae";

/** Teto de itens por resposta. Acima disso a conversa fica cara e o modelo
 *  começa a resumir mal em vez de listar. */
const TETO = 25;

/* ─── Declaração no formato OpenAI/Groq ────────────────────────────────── */

export const FERRAMENTAS = [
  {
    type: "function",
    function: {
      name: "filtrar_pracas",
      description:
        "Filtra os 5.570 municípios brasileiros por critérios combinados e devolve os que atendem, " +
        "ordenados por Score de Atratividade. Use para perguntas do tipo 'quais praças...'.",
      parameters: {
        type: "object",
        properties: {
          uf: { type: "string", description: "Sigla da UF (ex: SP, SC). Omita para o Brasil todo." },
          regiao: {
            type: "string",
            enum: ["Norte", "Nordeste", "Centro-Oeste", "Sudeste", "Sul"],
            description: "Região do país. Alternativa a `uf`.",
          },
          populacao_min: { type: "number" },
          populacao_max: { type: "number" },
          crescimento_min_pct: {
            type: "number",
            description: "Crescimento mínimo do setor em % ao ano (use 0 para 'crescendo').",
          },
          score_min: { type: "number", description: "Score de Atratividade mínimo, 0 a 100." },
          saturacao_max: {
            type: "number",
            description: "Saturação máxima. 1,0 = mediana da UF. Use 0.8 para 'subexplorada'.",
          },
          empresas_setor_min: { type: "number" },
          limite: { type: "number", description: `Quantas devolver. Máximo ${TETO}.` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "detalhar_praca",
      description:
        "Todos os indicadores de UM município: população, PIB, empresas, densidade, saturação, " +
        "crescimento do setor e a decomposição completa do Score de Atratividade.",
      parameters: {
        type: "object",
        properties: {
          municipio: { type: "string", description: "Nome do município." },
          uf: { type: "string", description: "UF, para desambiguar nomes repetidos." },
        },
        required: ["municipio"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pracas_semelhantes",
      description:
        "Municípios com perfil econômico parecido com o informado — porte, poder de compra, " +
        "densidade, peso e crescimento do setor. Use para perguntas de expansão.",
      parameters: {
        type: "object",
        properties: {
          municipio: { type: "string" },
          uf: { type: "string" },
          limite: { type: "number" },
        },
        required: ["municipio"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resumo_setor",
      description:
        "Números agregados do setor analisado: total de empresas, crescimento, quantas praças " +
        "concentram 80% do mercado, e as maiores. Aceita recorte por UF.",
      parameters: {
        type: "object",
        properties: { uf: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "comparar_pracas",
      description: "Compara de 2 a 5 municípios lado a lado nos mesmos indicadores.",
      parameters: {
        type: "object",
        properties: {
          municipios: {
            type: "array",
            items: { type: "string" },
            description: "Nomes dos municípios, 2 a 5.",
          },
        },
        required: ["municipios"],
      },
    },
  },
] as const;

/* ─── Execução ─────────────────────────────────────────────────────────── */

const REGIOES: Record<string, string[]> = {
  Norte: ["RO", "AC", "AM", "RR", "PA", "AP", "TO"],
  Nordeste: ["MA", "PI", "CE", "RN", "PB", "PE", "AL", "SE", "BA"],
  "Centro-Oeste": ["MS", "MT", "GO", "DF"],
  Sudeste: ["MG", "ES", "RJ", "SP"],
  Sul: ["PR", "SC", "RS"],
};

/** Normaliza para casar "Sao Paulo", "SÃO PAULO" e "são  paulo". O modelo
 *  escreve o nome como ouviu, não como está na base do IBGE. */
function chave(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function acharPraca(universo: Universo, nome: string, uf?: string): Praca | null {
  const alvo = chave(nome);
  const candidatos = universo.pracas.filter((p) => chave(p.nome) === alvo);
  if (candidatos.length === 0) return null;
  if (uf) {
    const naUf = candidatos.find((p) => p.uf.toUpperCase() === uf.toUpperCase());
    if (naUf) return naUf;
  }
  /* Nome repetido sem UF: devolve o de maior população. É a desambiguação que
     um humano faria — "Bom Jesus" sem UF quase sempre é a maior. */
  return candidatos.sort((a, b) => (b.populacao ?? 0) - (a.populacao ?? 0))[0] ?? null;
}

const r1 = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;

/** Projeção enxuta: só o que sustenta uma resposta, sem inflar o contexto. */
function resumir(p: Praca) {
  return {
    municipio: p.nome,
    uf: p.uf,
    score_atratividade: p.atratividade.score,
    faixa: p.atratividade.faixa,
    empresas_do_setor: p.setor,
    crescimento_setor_pct_ao_ano: r1(p.crescimento.cagr),
    tendencia: ROTULO_TENDENCIA[p.crescimento.tendencia],
    populacao: p.populacao,
    pib_per_capita_reais: p.pibPerCapita == null ? null : Math.round(p.pibPerCapita),
    densidade_por_1000_hab: r1(p.densidade),
    saturacao_vs_mediana_uf: p.saturacao == null ? null : Math.round(p.saturacao * 100) / 100,
  };
}

export interface ContextoFerramentas {
  universo: Universo;
  /** Letra da seção CNAE em análise — entra nas respostas para o modelo não
   *  confundir "empresas do setor" com "todas as empresas". */
  setor: string;
}

export interface ResultadoFerramenta {
  ok: boolean;
  dados?: unknown;
  erro?: string;
}

export function executarFerramenta(
  nome: string,
  args: Record<string, unknown>,
  ctx: ContextoFerramentas,
): ResultadoFerramenta {
  const { universo, setor } = ctx;
  const nomeSetor = SECOES.find((s) => s.letra === setor)?.nome ?? setor;

  if (universo.pracas.length === 0) {
    return { ok: false, erro: "Os dados do IBGE ainda estão carregando. Tente em instantes." };
  }

  switch (nome) {
    case "filtrar_pracas": {
      const {
        uf,
        regiao,
        populacao_min,
        populacao_max,
        crescimento_min_pct,
        score_min,
        saturacao_max,
        empresas_setor_min,
        limite,
      } = args as Record<string, number | string | undefined>;

      const ufsDaRegiao = regiao ? REGIOES[String(regiao)] : null;

      const filtradas = universo.pracas.filter((p) => {
        if (uf && p.uf.toUpperCase() !== String(uf).toUpperCase()) return false;
        if (ufsDaRegiao && !ufsDaRegiao.includes(p.uf.toUpperCase())) return false;
        if (populacao_min != null && (p.populacao ?? 0) < Number(populacao_min)) return false;
        if (populacao_max != null && (p.populacao ?? Infinity) > Number(populacao_max)) return false;
        if (crescimento_min_pct != null) {
          /* Sem série não dá para afirmar que cresce — fica de fora em vez de
             entrar como se crescesse zero. */
          if (p.crescimento.cagr == null) return false;
          if (p.crescimento.cagr < Number(crescimento_min_pct)) return false;
        }
        if (score_min != null && p.atratividade.score < Number(score_min)) return false;
        if (saturacao_max != null) {
          if (p.saturacao == null) return false;
          if (p.saturacao > Number(saturacao_max)) return false;
        }
        if (empresas_setor_min != null && (p.setor ?? 0) < Number(empresas_setor_min)) return false;
        return true;
      });

      const n = Math.min(Number(limite) || 10, TETO);
      const ordenadas = [...filtradas].sort(
        (a, b) => b.atratividade.score - a.atratividade.score,
      );

      return {
        ok: true,
        dados: {
          setor_analisado: nomeSetor,
          total_que_atendem: filtradas.length,
          exibindo: Math.min(n, ordenadas.length),
          pracas: ordenadas.slice(0, n).map(resumir),
        },
      };
    }

    case "detalhar_praca": {
      const p = acharPraca(universo, String(args.municipio ?? ""), args.uf as string | undefined);
      if (!p) {
        return {
          ok: false,
          erro: `Município "${args.municipio}" não encontrado na base do IBGE. Confira o nome.`,
        };
      }
      return {
        ok: true,
        dados: {
          setor_analisado: nomeSetor,
          ...resumir(p),
          pib_total_reais: p.pibTotal,
          empresas_total_todos_setores: p.empresasTotal,
          share_do_setor_na_praca_pct:
            p.shareSetor == null ? null : Math.round(p.shareSetor * 1000) / 10,
          serie_do_setor: p.crescimento.serie,
          leitura_da_faixa: DESCRICAO_FAIXA_ATRATIVIDADE[p.atratividade.faixa],
          decomposicao_do_score: p.atratividade.fatores.map((f) => ({
            fator: f.rotulo,
            pontos: f.pontos,
            de: f.maximo,
            detalhe: f.detalhe,
          })),
        },
      };
    }

    case "pracas_semelhantes": {
      const p = acharPraca(universo, String(args.municipio ?? ""), args.uf as string | undefined);
      if (!p) return { ok: false, erro: `Município "${args.municipio}" não encontrado.` };

      const n = Math.min(Number(args.limite) || 6, 12);
      const lista = pracasSemelhantes(p.id, universo.paraSimilaridade, n);
      if (lista.length === 0) {
        return {
          ok: false,
          erro: `${p.nome} não tem dimensões suficientes preenchidas para comparação confiável.`,
        };
      }

      return {
        ok: true,
        dados: {
          referencia: `${p.nome}/${p.uf}`,
          criterio:
            "distância padronizada em 6 dimensões econômicas — NÃO inclui composição setorial completa",
          semelhantes: lista.map((s) => {
            const alvo = universo.porId.get(s.entrada.id);
            return {
              municipio: s.entrada.nome,
              uf: s.entrada.uf,
              similaridade_pct: s.similaridade,
              parecidas_em: s.maisParecidas.map((d) => d.rotulo),
              difere_em: s.maiorDiferenca?.rotulo ?? null,
              empresas_do_setor: alvo?.setor ?? null,
              score_atratividade: alvo?.atratividade.score ?? null,
            };
          }),
        },
      };
    }

    case "resumo_setor": {
      const uf = args.uf as string | undefined;
      const escopo = uf
        ? universo.pracas.filter((p) => p.uf.toUpperCase() === uf.toUpperCase())
        : universo.pracas;

      if (escopo.length === 0) return { ok: false, erro: `UF "${uf}" não encontrada.` };

      const total = escopo.reduce((s, p) => s + (p.setor ?? 0), 0);
      const ordenadas = [...escopo].sort((a, b) => (b.setor ?? 0) - (a.setor ?? 0));

      let acumulado = 0;
      let para80: number | null = null;
      for (let i = 0; i < ordenadas.length; i++) {
        acumulado += ordenadas[i]?.setor ?? 0;
        if (total > 0 && acumulado / total >= 0.8) {
          para80 = i + 1;
          break;
        }
      }

      /* Crescimento do AGREGADO, não média dos percentuais municipais — a
         média daria o mesmo peso a São Paulo e a uma praça de 300 empresas. */
      const porAno = new Map<number, number>();
      for (const p of escopo) {
        for (const ponto of p.crescimento.serie) {
          porAno.set(ponto.ano, (porAno.get(ponto.ano) ?? 0) + ponto.valor);
        }
      }
      const serie = [...porAno.entries()]
        .map(([ano, valor]) => ({ ano, valor }))
        .sort((a, b) => a.ano - b.ano);
      const pri = serie[0];
      const ult = serie[serie.length - 1];
      const cagr =
        pri && ult && pri.valor > 0 && ult.ano > pri.ano
          ? (Math.pow(ult.valor / pri.valor, 1 / (ult.ano - pri.ano)) - 1) * 100
          : null;

      return {
        ok: true,
        dados: {
          setor_analisado: nomeSetor,
          escopo: uf ? uf.toUpperCase() : "Brasil",
          total_de_empresas_do_setor: total,
          municipios_avaliados: escopo.length,
          municipios_com_presenca: escopo.filter((p) => (p.setor ?? 0) > 0).length,
          crescimento_agregado_pct_ao_ano: r1(cagr),
          serie_agregada: serie,
          pracas_para_cobrir_80_pct: para80,
          maiores: ordenadas.slice(0, 10).map(resumir),
        },
      };
    }

    case "comparar_pracas": {
      const nomes = (args.municipios as string[] | undefined) ?? [];
      if (nomes.length < 2) return { ok: false, erro: "Informe ao menos 2 municípios." };

      const achadas: ReturnType<typeof resumir>[] = [];
      const faltando: string[] = [];
      for (const n of nomes.slice(0, 5)) {
        const p = acharPraca(universo, n);
        if (p) achadas.push(resumir(p));
        else faltando.push(n);
      }
      if (achadas.length < 2) {
        return { ok: false, erro: `Não encontrei: ${faltando.join(", ")}.` };
      }
      return {
        ok: true,
        dados: {
          setor_analisado: nomeSetor,
          comparacao: achadas,
          nao_encontrados: faltando.length ? faltando : undefined,
        },
      };
    }

    default:
      return { ok: false, erro: `Ferramenta desconhecida: ${nome}` };
  }
}
