/**
 * filtros.tsx — o estado de filtro global da plataforma.
 *
 * Um contexto só, no topo, porque os filtros do cabeçalho atravessam módulos:
 * o CNAE escolhido no Relatório de Praça é o mesmo que segmenta a Prospecção,
 * e o ticket médio arbitrado alimenta o SAM em todas as telas. Duplicar esse
 * estado por módulo é como as versões divergem — praça diz "Comércio" e a
 * tabela ao lado continua mostrando tudo.
 *
 * Os filtros vão para a URL (hash). Isso faz o F5 preservar o contexto e, mais
 * importante num produto B2B, faz "manda o link dessa análise" funcionar.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Premissas } from "../domain/territorio";

/** Apetite de risco — traduz para um piso de score ICP. */
export type Risco = "conservador" | "equilibrado" | "agressivo";

export const PISO_SCORE: Record<Risco, number> = {
  conservador: 70, // só faixa A e topo da B
  equilibrado: 45, // A, B e boa parte da C
  agressivo: 0, // tudo, inclusive cauda longa
};

export const ROTULO_RISCO: Record<Risco, string> = {
  conservador: "Conservador · score ≥ 70",
  equilibrado: "Equilibrado · score ≥ 45",
  agressivo: "Agressivo · sem piso",
};

/** Faixas de faturamento anual esperado por cliente. É a premissa que
 *  converte "nº de empresas" em "reais de TAM". */
export const FAIXAS_TICKET: readonly { valor: number; rotulo: string }[] = [
  { valor: 6_000, rotulo: "R$ 6 mil/ano — ticket transacional" },
  { valor: 24_000, rotulo: "R$ 24 mil/ano — SMB recorrente" },
  { valor: 60_000, rotulo: "R$ 60 mil/ano — mid-market" },
  { valor: 240_000, rotulo: "R$ 240 mil/ano — enterprise" },
  { valor: 1_200_000, rotulo: "R$ 1,2 mi/ano — grandes contas" },
];

export interface Filtros {
  uf: string;
  municipioId: number | null;
  /** Seções CNAE 2.0 que compõem o ICP. Vazio = todas. */
  secoes: string[];
  ticketMedioAnual: number;
  shareAlvo: number;
  risco: Risco;
}

const PADRAO: Filtros = {
  uf: "SP",
  municipioId: null,
  secoes: [],
  ticketMedioAnual: 24_000,
  shareAlvo: 0.03,
  risco: "equilibrado",
};

interface ContextoFiltros {
  filtros: Filtros;
  definir: <K extends keyof Filtros>(chave: K, valor: Filtros[K]) => void;
  alternarSecao: (letra: string) => void;
  limparSecoes: () => void;
  premissas: Premissas;
  /** Piso de score derivado do apetite de risco. */
  pisoScore: number;
}

const Ctx = createContext<ContextoFiltros | null>(null);

/* ─── Sincronização com a URL ──────────────────────────────────────────── */

function lerDaUrl(): Partial<Filtros> {
  try {
    const hash = window.location.hash.replace(/^#/, "");
    const [, query = ""] = hash.split("?");
    const p = new URLSearchParams(query);
    const saida: Partial<Filtros> = {};

    const uf = p.get("uf");
    if (uf && /^[A-Za-z]{2}$/.test(uf)) saida.uf = uf.toUpperCase();

    const mun = p.get("mun");
    if (mun && /^\d+$/.test(mun)) saida.municipioId = Number(mun);

    const secoes = p.get("cnae");
    if (secoes) saida.secoes = secoes.split(",").filter((s) => /^[A-U]$/.test(s));

    const ticket = p.get("ticket");
    if (ticket && Number.isFinite(Number(ticket))) saida.ticketMedioAnual = Number(ticket);

    const share = p.get("share");
    if (share && Number.isFinite(Number(share))) saida.shareAlvo = Number(share);

    const risco = p.get("risco");
    if (risco === "conservador" || risco === "equilibrado" || risco === "agressivo")
      saida.risco = risco;

    return saida;
  } catch {
    return {};
  }
}

function escreverNaUrl(f: Filtros): void {
  try {
    const hash = window.location.hash.replace(/^#/, "");
    const [rota = ""] = hash.split("?");
    const p = new URLSearchParams();

    if (f.uf !== PADRAO.uf) p.set("uf", f.uf);
    if (f.municipioId) p.set("mun", String(f.municipioId));
    if (f.secoes.length) p.set("cnae", f.secoes.join(","));
    if (f.ticketMedioAnual !== PADRAO.ticketMedioAnual) p.set("ticket", String(f.ticketMedioAnual));
    if (f.shareAlvo !== PADRAO.shareAlvo) p.set("share", String(f.shareAlvo));
    if (f.risco !== PADRAO.risco) p.set("risco", f.risco);

    const query = p.toString();
    const novo = `#${rota}${query ? `?${query}` : ""}`;
    if (novo !== window.location.hash) {
      /* replaceState, não pushState: mexer num filtro não deve encher o
         histórico — o "voltar" do navegador tem que voltar de MÓDULO. */
      window.history.replaceState(null, "", novo);
    }
  } catch {
    /* history bloqueado (iframe sandbox) — o app funciona sem a URL. */
  }
}

/** Compara sem depender da ordem das seções — `["G","C"]` e `["C","G"]` são o
 *  mesmo recorte, e tratá-los como diferentes causaria um render a cada
 *  `hashchange`. */
function iguais(a: Filtros, b: Filtros): boolean {
  return (
    a.uf === b.uf &&
    a.municipioId === b.municipioId &&
    a.ticketMedioAnual === b.ticketMedioAnual &&
    a.shareAlvo === b.shareAlvo &&
    a.risco === b.risco &&
    a.secoes.length === b.secoes.length &&
    [...a.secoes].sort().join() === [...b.secoes].sort().join()
  );
}

export function ProvedorFiltros({ children }: { children: ReactNode }) {
  const [filtros, setFiltros] = useState<Filtros>(() => ({ ...PADRAO, ...lerDaUrl() }));

  useEffect(() => {
    escreverNaUrl(filtros);
  }, [filtros]);

  /**
   * Relê os filtros quando a URL muda POR FORA — e isso acontece mais do que
   * parece: colar um link numa aba já aberta, usar voltar/avançar do
   * navegador, ou trocar de módulo (que reescreve o hash preservando a query).
   *
   * Sem este listener, o estado era lido uma vez só, na montagem. Trocar de
   * hash não remonta nada, então um link com `?uf=SP&mun=3550308` abria a tela
   * certa com o filtro errado — o Relatório de Praça mostrava "escolha uma
   * praça" mesmo com o município na URL. Deep link que só funciona em carga
   * limpa não é deep link.
   *
   * Não há laço: o efeito acima grava com `replaceState`, que não dispara
   * `hashchange`; e quando dispara (troca de módulo), a comparação abaixo
   * descarta o valor idêntico antes de mexer no estado.
   */
  useEffect(() => {
    const aoMudar = () => {
      const daUrl = { ...PADRAO, ...lerDaUrl() };
      setFiltros((atual) => (iguais(atual, daUrl) ? atual : daUrl));
    };
    window.addEventListener("hashchange", aoMudar);
    return () => window.removeEventListener("hashchange", aoMudar);
  }, []);

  const definir = useCallback(<K extends keyof Filtros>(chave: K, valor: Filtros[K]) => {
    setFiltros((f) => {
      if (f[chave] === valor) return f;
      const proximo = { ...f, [chave]: valor };
      /* Trocar de UF invalida o município selecionado — mantê-lo mostraria
         uma praça de outro estado sob o rótulo do estado novo. */
      if (chave === "uf") proximo.municipioId = null;
      return proximo;
    });
  }, []);

  const alternarSecao = useCallback((letra: string) => {
    setFiltros((f) => ({
      ...f,
      secoes: f.secoes.includes(letra)
        ? f.secoes.filter((s) => s !== letra)
        : [...f.secoes, letra],
    }));
  }, []);

  const limparSecoes = useCallback(() => {
    setFiltros((f) => (f.secoes.length === 0 ? f : { ...f, secoes: [] }));
  }, []);

  const valor = useMemo<ContextoFiltros>(
    () => ({
      filtros,
      definir,
      alternarSecao,
      limparSecoes,
      premissas: {
        ticketMedioAnual: filtros.ticketMedioAnual,
        shareAlvo: filtros.shareAlvo,
        secoesAlvo: filtros.secoes,
      },
      pisoScore: PISO_SCORE[filtros.risco],
    }),
    [filtros, definir, alternarSecao, limparSecoes],
  );

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useFiltros(): ContextoFiltros {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useFiltros precisa estar dentro de <ProvedorFiltros>");
  return ctx;
}
