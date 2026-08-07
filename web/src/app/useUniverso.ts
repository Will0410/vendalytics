/**
 * useUniverso.ts — as 5.570 praças, enriquecidas, calculadas uma vez.
 *
 * Relatório de Praça, Mapa e Geomarketing precisam exatamente do mesmo
 * conjunto: métricas do IBGE + crescimento da série + score de atratividade +
 * o vetor de similaridade. Deixar isso em cada módulo significaria três cópias
 * da mesma regra divergindo com o tempo — e o percentil de atratividade
 * calculado sobre universos ligeiramente diferentes em cada tela, o que faria
 * a MESMA praça aparecer com scores diferentes conforme a aba. É o tipo de
 * inconsistência que destrói a confiança num painel.
 *
 * O custo real está aqui, então fica num `useMemo` só: cinco ordenações de
 * 5.570 itens para os percentis, mais uma passada para crescimento. Milésimos,
 * mas repetidos a cada render seriam perceptíveis.
 */
import { useMemo } from "react";
import {
  cargaNacional,
  municipiosDoSetor,
  ufDoCodigo,
  type MetricasLocalidade,
} from "../data/ibge";
import { useAsync } from "../lib/useAsync";
import { densidadeDe, mediana } from "../domain/territorio";
import { calcularCrescimento, type Crescimento } from "../domain/crescimento";
import {
  calcularAtratividade,
  type Atratividade,
  type EntradaAtratividade,
} from "../domain/atratividade";
import type { EntradaSimilaridade } from "../domain/similaridade";

export interface Praca {
  id: number;
  nome: string;
  uf: string;
  populacao: number | null;
  pibTotal: number | null;
  pibPerCapita: number | null;
  empresasTotal: number | null;
  /** Empresas do setor-alvo. */
  setor: number | null;
  crescimento: Crescimento;
  densidade: number | null;
  /** Densidade ÷ mediana da UF. 1,0 = na mediana. */
  saturacao: number | null;
  /** Fatia do setor no tecido empresarial local. */
  shareSetor: number | null;
  pibPorEmpresa: number | null;
  atratividade: Atratividade;
  bruto: MetricasLocalidade;
}

export interface Universo {
  pracas: Praca[];
  porId: Map<number, Praca>;
  /** Entradas prontas para `pracasSemelhantes` — mesmo universo, mesma ordem. */
  paraSimilaridade: EntradaSimilaridade[];
  anoReferencia: number | null;
}

const VAZIO: Universo = {
  pracas: [],
  porId: new Map(),
  paraSimilaridade: [],
  anoReferencia: null,
};

export function useUniverso(setor: string) {
  const doSetor = useAsync(() => municipiosDoSetor(setor), [setor]);
  const nacional = useAsync(() => cargaNacional(), []);

  const universo = useMemo<Universo>(() => {
    if (!doSetor.dado || !nacional.dado) return VAZIO;

    /* Mediana de densidade por UF, uma vez. Sem isto cada uma das 5.570
       praças varreria os pares do próprio estado — 5.570 × ~200. */
    const densidadesPorUf = new Map<string, number[]>();
    for (const m of nacional.dado.municipios) {
      const d = densidadeDe(m);
      if (d == null) continue;
      const uf = m.uf || ufDoCodigo(m.id);
      const lista = densidadesPorUf.get(uf) ?? [];
      lista.push(d);
      densidadesPorUf.set(uf, lista);
    }
    const medianaUf = new Map<string, number>();
    for (const [uf, ds] of densidadesPorUf) {
      const med = mediana(ds);
      if (med && med > 0) medianaUf.set(uf, med);
    }

    const doSetorPorId = new Map(doSetor.dado.map((m) => [m.id, m.empresas]));

    /* Primeira passada: tudo que não depende do universo. */
    const parciais = nacional.dado.municipios.map((m) => {
      const uf = m.uf || ufDoCodigo(m.id);
      const medidaSetor = doSetorPorId.get(m.id) ?? null;
      const setorValor = medidaSetor?.valor ?? null;
      const crescimento = calcularCrescimento(medidaSetor?.serie);

      const populacao = m.populacao?.valor ?? null;
      const pibTotal = m.pibTotal?.valor ?? null;
      const empresasTotal = m.empresas?.valor ?? null;
      const densidade = densidadeDe(m);
      const med = medianaUf.get(uf);

      return {
        id: m.id,
        nome: m.nome,
        uf,
        populacao,
        pibTotal,
        pibPerCapita: pibTotal != null && populacao ? pibTotal / populacao : null,
        empresasTotal,
        setor: setorValor,
        crescimento,
        densidade,
        saturacao: densidade != null && med ? densidade / med : null,
        shareSetor:
          setorValor != null && empresasTotal ? setorValor / empresasTotal : null,
        pibPorEmpresa: pibTotal != null && empresasTotal ? pibTotal / empresasTotal : null,
        bruto: m,
      };
    });

    /* Segunda passada: o score, que só existe em relação ao universo. */
    const entradas: EntradaAtratividade[] = parciais.map((p) => ({
      id: p.id,
      volumeSetor: p.setor,
      crescimentoSetor: p.crescimento.cagr,
      pibPerCapita: p.pibPerCapita,
      saturacao: p.saturacao,
      densidade: p.densidade,
    }));
    const scores = calcularAtratividade(entradas);

    const pracas: Praca[] = parciais.map((p) => ({
      ...p,
      atratividade: scores.get(p.id) ?? { score: 0, faixa: "D", fatores: [] },
    }));

    const paraSimilaridade: EntradaSimilaridade[] = pracas.map((p) => ({
      id: p.id,
      nome: p.nome,
      uf: p.uf,
      populacao: p.populacao,
      pibPerCapita: p.pibPerCapita,
      densidade: p.densidade,
      shareSetor: p.shareSetor,
      crescimentoSetor: p.crescimento.cagr,
      pibPorEmpresa: p.pibPorEmpresa,
    }));

    return {
      pracas,
      porId: new Map(pracas.map((p) => [p.id, p])),
      paraSimilaridade,
      anoReferencia: doSetor.dado[0]?.empresas?.ano ?? null,
    };
  }, [doSetor.dado, nacional.dado]);

  return {
    universo,
    carregando: doSetor.carregando || nacional.carregando,
    erro: doSetor.erro ?? nacional.erro,
    recarregar: () => {
      doSetor.recarregar();
      nacional.recarregar();
    },
  };
}

/** Percentil de um valor dentro de uma lista — usado pelas âncoras dos KPIs. */
export function percentilDe(valor: number | null, universo: (number | null)[]): number | null {
  if (valor == null) return null;
  const validos = universo.filter((v): v is number => v != null && Number.isFinite(v));
  if (validos.length < 2) return null;
  const abaixo = validos.filter((v) => v < valor).length;
  return (abaixo / (validos.length - 1)) * 100;
}

/** Posição no ranking (1 = maior) e total comparável. */
export function posicaoDe(
  valor: number | null,
  universo: (number | null)[],
): { posicao: number; total: number } | null {
  if (valor == null) return null;
  const validos = universo.filter((v): v is number => v != null && Number.isFinite(v));
  if (validos.length === 0) return null;
  return { posicao: validos.filter((v) => v > valor).length + 1, total: validos.length };
}
