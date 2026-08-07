/**
 * rotas.ts — roteamento por hash, feito à mão.
 *
 * Sem react-router de propósito: a plataforma tem 5 rotas planas, sem
 * aninhamento, sem loader, sem rota protegida. O router inteiro cabe em 40
 * linhas e evita ~15kb de dependência que não seria exercitada. Se um dia
 * houver rota aninhada ou lazy por rota, trocar por react-router é local.
 *
 * Hash e não History API porque isso aqui roda como arquivo estático — em
 * `file://` ou num bucket sem regra de rewrite, `/praca` daria 404 e
 * `#/praca` sempre funciona.
 */
import { useEffect, useState } from "react";
import type { AssetId } from "../assets/catalog";

export type RotaId =
  | "vendas"
  | "geomarketing"
  | "mapa"
  | "praca"
  | "prospeccao"
  | "enriquecimento"
  | "usuarios";

export interface DefinicaoRota {
  id: RotaId;
  titulo: string;
  descricao: string;
  icone: AssetId;
  /** Só aparece no menu para quem tem perfil admin. */
  somenteAdmin?: boolean;
}

export const ROTAS: readonly DefinicaoRota[] = [
  {
    id: "vendas",
    titulo: "Inteligência de Vendas",
    descricao: "O mercado brasileiro por setor — 10,6 milhões de empresas, quebradas por CNAE",
    icone: "icon.vendas",
  },
  {
    id: "geomarketing",
    titulo: "Geomarketing",
    descricao: "Onde estão as empresas do seu setor, município a município",
    icone: "icon.geomarketing",
  },
  {
    id: "mapa",
    titulo: "Mapa Territorial",
    descricao: "Os 5.570 municípios do Brasil no mapa — uma bolinha por praça",
    icone: "icon.mapa",
  },
  {
    id: "praca",
    titulo: "Relatório de Praça",
    descricao: "TAM, SAM, SOM, densidade e saturação de um município",
    icone: "icon.praca",
  },
  {
    id: "prospeccao",
    titulo: "Prospecção B2B",
    descricao: "Carteira de CNPJs com Score ICP explicável",
    icone: "icon.prospeccao",
  },
  {
    id: "enriquecimento",
    titulo: "Enriquecimento",
    descricao: "Cadastro completo da Receita Federal por CNPJ",
    icone: "icon.enriquecimento",
  },
  {
    id: "usuarios",
    titulo: "Usuários",
    descricao: "Contas de acesso, perfis e senhas",
    icone: "icon.usuarios",
    somenteAdmin: true,
  },
];

const PADRAO: RotaId = "vendas";

function lerRota(): RotaId {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const [rota = ""] = hash.split("?");
  return ROTAS.some((r) => r.id === rota) ? (rota as RotaId) : PADRAO;
}

export function useRota(): [RotaId, (r: RotaId) => void] {
  const [rota, setRota] = useState<RotaId>(lerRota);

  useEffect(() => {
    const aoMudar = () => setRota(lerRota());
    window.addEventListener("hashchange", aoMudar);
    return () => window.removeEventListener("hashchange", aoMudar);
  }, []);

  const navegar = (r: RotaId) => {
    /* Preserva a query de filtros ao trocar de módulo — é o comportamento
       esperado: mudar de tela não pode resetar o contexto de análise. */
    const [, query = ""] = window.location.hash.replace(/^#/, "").split("?");
    window.location.hash = `/${r}${query ? `?${query}` : ""}`;
  };

  return [rota, navegar];
}
