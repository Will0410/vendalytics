/**
 * icp.ts — Score ICP (Ideal Customer Profile), explicável por construção.
 *
 * ── Por que o score devolve os fatores, e não só o número ──────────────────
 * Um score opaco morre na primeira reunião: o vendedor discorda de uma conta,
 * ninguém sabe dizer de onde veio o 72, e a tela vira decoração. Aqui cada
 * fator devolve quanto valeu, de quanto podia valer e por quê — a interface
 * abre a conta inteira ao clicar na linha.
 *
 * ── O que este score NÃO é ─────────────────────────────────────────────────
 * Não é um modelo treinado. É uma soma ponderada de sinais do cadastro
 * público da Receita, com pesos arbitrados e escritos aqui em cima. Sem
 * histórico de ganho/perda do cliente não existe modelo — e chamar isto de
 * "IA preditiva" seria mentira. Quando houver desfecho comercial rotulado, os
 * pesos saem daqui e viram coeficientes ajustados; a interface não muda.
 *
 * ── Regra de desqualificação ───────────────────────────────────────────────
 * Situação cadastral não-ativa zera o score, em vez de descontar pontos.
 * Empresa baixada não é "lead ruim", é lead inexistente — deixá-la com 40
 * pontos faria ela aparecer à frente de uma micro empresa ativa de verdade.
 */
import type { Empresa } from "../data/brasilapi";
import { SECOES_ALTA_PROPENSAO } from "../data/cnae";
import { anosDesde } from "../lib/format";

export type Sinal = "positivo" | "neutro" | "negativo";
export type FaixaIcp = "A" | "B" | "C" | "D";

export interface Fator {
  rotulo: string;
  pontos: number;
  maximo: number;
  detalhe: string;
  sinal: Sinal;
}

export interface ResultadoIcp {
  score: number;
  faixa: FaixaIcp;
  desqualificada: boolean;
  motivoDesqualificacao: string | null;
  fatores: Fator[];
}

/* Pesos. Somam 100. Mudar aqui muda o score de toda a base — de propósito:
   é o único lugar onde a definição de "cliente ideal" vive. */
const PESO = {
  porte: 22,
  setor: 20,
  capital: 18,
  maturidade: 14,
  acionabilidade: 10,
  decisao: 8,
  amplitude: 8,
} as const;

function pontosPorte(e: Empresa): Fator {
  const tabela: Record<Empresa["porte"], { p: number; s: Sinal; d: string }> = {
    "Médio/Grande": { p: PESO.porte, s: "positivo", d: "Porte médio/grande — maior ticket potencial" },
    Pequeno: { p: 16, s: "positivo", d: "Empresa de pequeno porte — ciclo de decisão curto" },
    Micro: { p: 9, s: "neutro", d: "Microempresa — ticket menor, volume maior" },
    MEI: { p: 4, s: "negativo", d: "MEI — teto de faturamento limita o ticket" },
    "Não informado": { p: 6, s: "neutro", d: "Porte não informado no cadastro da Receita" },
  };
  const t = tabela[e.porte];
  return { rotulo: "Porte", pontos: t.p, maximo: PESO.porte, detalhe: t.d, sinal: t.s };
}

function pontosSetor(e: Empresa): Fator {
  const alta = SECOES_ALTA_PROPENSAO.has(e.secao.letra);
  return {
    rotulo: "Aderência setorial",
    pontos: alta ? PESO.setor : 7,
    maximo: PESO.setor,
    detalhe: alta
      ? `${e.secao.curto} está entre os setores de alta propensão configurados`
      : `${e.secao.curto} está fora dos setores de alta propensão configurados`,
    sinal: alta ? "positivo" : "neutro",
  };
}

/**
 * Capital social em escala logarítmica.
 *
 * Linear não serve: entre R$ 10 mil e R$ 100 mil há uma diferença de porte
 * real; entre R$ 100 milhões e R$ 100,1 milhões não há nenhuma. O log
 * comprime a cauda e preserva a distinção que importa. Faixa útil calibrada
 * entre R$ 10 mil (0 ponto) e R$ 100 milhões (pontuação cheia).
 */
function pontosCapital(e: Empresa): Fator {
  const c = e.capitalSocial;
  if (c == null || c <= 0) {
    return {
      rotulo: "Capital social",
      pontos: 0,
      maximo: PESO.capital,
      detalhe: "Capital social não declarado no cadastro",
      sinal: "neutro",
    };
  }
  const min = Math.log10(10_000);
  const max = Math.log10(100_000_000);
  const norm = Math.min(1, Math.max(0, (Math.log10(c) - min) / (max - min)));
  return {
    rotulo: "Capital social",
    pontos: Math.round(norm * PESO.capital),
    maximo: PESO.capital,
    detalhe: `R$ ${c.toLocaleString("pt-BR", { maximumFractionDigits: 0 })} declarados`,
    sinal: norm >= 0.55 ? "positivo" : norm >= 0.25 ? "neutro" : "negativo",
  };
}

/**
 * Maturidade pela idade da empresa.
 *
 * Não é "mais velho é melhor". Abaixo de 2 anos há risco de mortalidade alto
 * (o que também significa cadastro instável); acima de 3 anos a operação já
 * se provou. O topo é um platô, não uma rampa — 40 anos não compra mais que
 * 15 do ponto de vista de risco de crédito.
 */
function pontosMaturidade(e: Empresa): Fator {
  const anos = anosDesde(e.dataAbertura);
  if (anos == null) {
    return {
      rotulo: "Maturidade",
      pontos: 4,
      maximo: PESO.maturidade,
      detalhe: "Data de abertura ausente no cadastro",
      sinal: "neutro",
    };
  }
  let p: number;
  let s: Sinal;
  if (anos < 2) {
    p = 3;
    s = "negativo";
  } else if (anos < 5) {
    p = 9;
    s = "neutro";
  } else {
    p = PESO.maturidade;
    s = "positivo";
  }
  return {
    rotulo: "Maturidade",
    pontos: p,
    maximo: PESO.maturidade,
    detalhe: `${anos} ${anos === 1 ? "ano" : "anos"} de operação desde a abertura`,
    sinal: s,
  };
}

/** Acionabilidade: sem canal de contato, o lead não é trabalhável hoje. */
function pontosAcionabilidade(e: Empresa): Fator {
  const canais = [e.telefone, e.email].filter(Boolean).length;
  const detalhes = [e.telefone ? "telefone" : null, e.email ? "e-mail" : null].filter(Boolean);
  return {
    rotulo: "Acionabilidade",
    pontos: canais === 2 ? PESO.acionabilidade : canais === 1 ? 6 : 0,
    maximo: PESO.acionabilidade,
    detalhe: canais ? `Cadastro traz ${detalhes.join(" e ")}` : "Sem telefone nem e-mail públicos",
    sinal: canais === 2 ? "positivo" : canais === 1 ? "neutro" : "negativo",
  };
}

/** Matriz concentra a decisão de compra; filial costuma executar política. */
function pontosDecisao(e: Empresa): Fator {
  return {
    rotulo: "Poder de decisão",
    pontos: e.matriz ? PESO.decisao : 3,
    maximo: PESO.decisao,
    detalhe: e.matriz
      ? "Matriz — normalmente onde a compra é decidida"
      : "Filial — a decisão tende a estar na matriz",
    sinal: e.matriz ? "positivo" : "neutro",
  };
}

/** CNAEs secundários indicam operação diversificada — mais superfície de venda. */
function pontosAmplitude(e: Empresa): Fator {
  const n = e.cnaesSecundarios;
  const p = n === 0 ? 2 : n <= 3 ? 5 : PESO.amplitude;
  return {
    rotulo: "Amplitude de atividades",
    pontos: p,
    maximo: PESO.amplitude,
    detalhe:
      n === 0
        ? "Só a atividade principal registrada"
        : `${n} ${n === 1 ? "CNAE secundário" : "CNAEs secundários"} além da principal`,
    sinal: n > 3 ? "positivo" : "neutro",
  };
}

function faixaDe(score: number): FaixaIcp {
  if (score >= 75) return "A";
  if (score >= 55) return "B";
  if (score >= 35) return "C";
  return "D";
}

export function calcularIcp(e: Empresa): ResultadoIcp {
  const fatores = [
    pontosPorte(e),
    pontosSetor(e),
    pontosCapital(e),
    pontosMaturidade(e),
    pontosAcionabilidade(e),
    pontosDecisao(e),
    pontosAmplitude(e),
  ];

  if (e.situacao !== "Ativa") {
    return {
      score: 0,
      faixa: "D",
      desqualificada: true,
      motivoDesqualificacao: `Situação cadastral: ${e.situacao}`,
      fatores: [
        {
          rotulo: "Situação cadastral",
          pontos: 0,
          maximo: 100,
          detalhe: `Empresa ${e.situacao.toLowerCase()} na Receita Federal — não é lead trabalhável`,
          sinal: "negativo",
        },
        ...fatores,
      ],
    };
  }

  const score = Math.min(100, Math.round(fatores.reduce((s, f) => s + f.pontos, 0)));

  return {
    score,
    faixa: faixaDe(score),
    desqualificada: false,
    motivoDesqualificacao: null,
    fatores: [
      {
        rotulo: "Situação cadastral",
        pontos: 0,
        maximo: 0,
        detalhe: "Ativa na Receita Federal — pré-requisito atendido",
        sinal: "positivo",
      },
      ...fatores,
    ],
  };
}

export const DESCRICAO_FAIXA: Record<FaixaIcp, string> = {
  A: "Aderência alta — priorizar contato",
  B: "Boa aderência — trabalhar em cadência",
  C: "Aderência parcial — nutrir",
  D: "Fora do perfil — não priorizar",
};
