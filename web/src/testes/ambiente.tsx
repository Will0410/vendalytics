/**
 * ambiente.tsx — o mínimo para montar um módulo inteiro num teste.
 *
 * Os módulos dependem de três provedores (assets, sessão, filtros) e de duas
 * APIs externas. Testar cada um em isolamento cobriria a lógica, mas **não**
 * cobriria a classe de bug que mais apareceu neste projeto: interação entre
 * React e estado que sobrevive ao ciclo de vida — StrictMode montando duas
 * vezes, evento sintético lido tarde demais, ref apontando para objeto morto.
 *
 * Esses só aparecem com o React montando de verdade. Daí este arquivo.
 *
 * ── Sobre os dados dos mocks ──────────────────────────────────────────────
 * As respostas imitam a FORMA real das APIs, com números reais conferidos ao
 * vivo (São Paulo tem 1.201.528 empresas e 264.675 de Comércio no CEMPRE
 * 2024). Mock com forma inventada testa o mock, não o código.
 */
import type { ReactNode } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { vi } from "vitest";
import { AssetProvider } from "../assets/AssetProvider";
import { ProvedorFiltros } from "../app/filtros";
import { ProvedorSessao } from "../app/sessao";

/* ─── Respostas do IBGE ────────────────────────────────────────────────── */

interface MunicipioFalso {
  id: number;
  nome: string;
  uf: string;
  populacao: number;
  pibMilReais: number;
  empresas: number;
  setor: number;
  serieSetor?: [number, number, number];
}

export const MUNICIPIOS: MunicipioFalso[] = [
  {
    id: 3550308,
    nome: "São Paulo",
    uf: "SP",
    populacao: 11904961,
    pibMilReais: 1071000000,
    empresas: 1201528,
    setor: 264675,
    serieSetor: [258000, 261000, 264675],
  },
  {
    id: 3509502,
    nome: "Campinas",
    uf: "SP",
    populacao: 1223237,
    pibMilReais: 95000000,
    empresas: 118000,
    setor: 26000,
    serieSetor: [24800, 25400, 26000],
  },
  {
    id: 3543402,
    nome: "Ribeirão Preto",
    uf: "SP",
    populacao: 720116,
    pibMilReais: 48000000,
    empresas: 71000,
    setor: 16800,
    serieSetor: [16100, 16500, 16800],
  },
  {
    id: 3548708,
    nome: "Santos",
    uf: "SP",
    populacao: 418375,
    pibMilReais: 28000000,
    empresas: 38000,
    setor: 8900,
    serieSetor: [9100, 9000, 8900],
  },
  {
    id: 3552205,
    nome: "Sorocaba",
    uf: "SP",
    populacao: 723150,
    pibMilReais: 42000000,
    empresas: 62000,
    setor: 14200,
    serieSetor: [13400, 13800, 14200],
  },
];

function serieIbge(
  itens: { id: number; nome: string; uf: string }[],
  valor: (m: MunicipioFalso) => number | [number, number, number] | null,
) {
  return itens.map((i) => {
    const m = MUNICIPIOS.find((x) => x.id === i.id) as MunicipioFalso;
    const v = valor(m);
    const serie =
      v == null
        ? { "2024": "-" }
        : Array.isArray(v)
          ? { "2022": String(v[0]), "2023": String(v[1]), "2024": String(v[2]) }
          : { "2024": String(v) };
    return { localidade: { id: String(i.id), nome: `${i.nome} - ${i.uf}` }, serie };
  });
}

const agregado = (series: unknown[]) => [
  { id: "x", variavel: "v", unidade: "u", resultados: [{ classificacoes: [], series }] },
];

/**
 * Intercepta `fetch` e responde por PADRÃO DE URL, não por ordem de chamada.
 *
 * Responder por ordem tornaria o teste refém da sequência interna dos
 * módulos — mudar a ordem de dois `useAsync` quebraria testes sem que nada
 * tivesse quebrado de verdade.
 */
export function mockarFontes(opts: { falharEm?: RegExp } = {}) {
  const chamadas: string[] = [];

  const fetchFalso = vi.fn(async (entrada: RequestInfo | URL) => {
    const url = String(entrada);
    chamadas.push(url);

    if (opts.falharEm?.test(url)) {
      return new Response("erro simulado", { status: 500 });
    }

    const json = (corpo: unknown) =>
      new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    /* ── IBGE ── */
    if (url.includes("/localidades/estados/") && url.includes("/municipios")) {
      return json(MUNICIPIOS.map((m) => ({ id: m.id, nome: m.nome })));
    }
    if (url.includes("/localidades/estados")) {
      return json([
        { id: 35, sigla: "SP", nome: "São Paulo", regiao: { nome: "Sudeste" } },
        { id: 41, sigla: "PR", nome: "Paraná", regiao: { nome: "Sul" } },
      ]);
    }
    if (url.includes("/agregados/6579/")) {
      return json(agregado(serieIbge(MUNICIPIOS, (m) => m.populacao)));
    }
    if (url.includes("/agregados/5938/")) {
      return json(agregado(serieIbge(MUNICIPIOS, (m) => m.pibMilReais)));
    }
    if (url.includes("/agregados/9418/")) {
      /* Total (117897) vs. seção específica — o módulo pede os dois. */
      const total = url.includes("117897");
      const comSerie = url.includes("/periodos/all/");
      return json(
        agregado(
          serieIbge(MUNICIPIOS, (m) =>
            total ? m.empresas : comSerie ? (m.serieSetor ?? m.setor) : m.setor,
          ),
        ),
      );
    }

    /* ── BrasilAPI ── */
    if (url.includes("brasilapi.com.br/api/cnpj")) {
      const cnpj = url.split("/").pop() as string;
      return json({
        cnpj,
        razao_social: "EMPRESA DE TESTE S.A.",
        nome_fantasia: "Teste",
        cnae_fiscal: 4713004,
        cnae_fiscal_descricao: "Comércio varejista",
        cnaes_secundarios: [{ codigo: 4711302 }],
        codigo_porte: 5,
        natureza_juridica: "S.A.",
        capital_social: 5_000_000,
        data_inicio_atividade: "2005-03-10",
        situacao_cadastral: 2,
        descricao_situacao_cadastral: "ATIVA",
        municipio: "SAO PAULO",
        uf: "SP",
        codigo_municipio_ibge: 3550308,
        ddd_telefone_1: "1130001000",
        descricao_identificador_matriz_filial: "MATRIZ",
        qsa: [{ nome_socio: "Fulano" }],
      });
    }

    /* ── Backend ── */
    if (url.includes("/api/auth/me")) {
      /* Lê do localStorage em vez de fixar "admin": o provedor de sessão trata
         o SERVIDOR como fonte de verdade sobre papel (para um usuário
         rebaixado não continuar admin por causa do token guardado). Um mock
         que ignora isso faria todo teste rodar como admin, e o caminho do
         perfil `user` nunca seria exercitado. */
      const guardada = localStorage.getItem("vendalytics:sessao");
      const role = guardada ? (JSON.parse(guardada).role ?? "admin") : "admin";
      return json({ email: "admin@teste.com", name: "Admin", role });
    }
    if (url.includes("/api/usuarios")) {
      return json({
        usuarios: [
          {
            email: "admin@teste.com",
            nome: "Admin",
            role: "admin",
            filiais: [],
            criado_em: "2026-01-01T00:00:00Z",
            ultimo_acesso: null,
          },
        ],
      });
    }
    if (url.includes("/api/ia/")) {
      return json({ disponivel: false, motivo: "IA desligada no teste" });
    }

    return new Response("não mapeado no mock: " + url, { status: 404 });
  });

  vi.stubGlobal("fetch", fetchFalso);
  return { chamadas, fetchFalso };
}

/* ─── Provedores ───────────────────────────────────────────────────────── */

/** Sessão já autenticada — evita que todo teste passe pela tela de login. */
export function autenticar(role: "admin" | "user" = "admin") {
  localStorage.setItem(
    "vendalytics:sessao",
    JSON.stringify({ token: "t", email: "admin@teste.com", nome: "Admin", role }),
  );
}

function Envoltorio({ children }: { children: ReactNode }) {
  return (
    <AssetProvider>
      <ProvedorSessao>
        <ProvedorFiltros>{children}</ProvedorFiltros>
      </ProvedorSessao>
    </AssetProvider>
  );
}

export function renderizar(ui: ReactNode, opts?: Omit<RenderOptions, "wrapper">) {
  return render(<>{ui}</>, { wrapper: Envoltorio, ...opts });
}
