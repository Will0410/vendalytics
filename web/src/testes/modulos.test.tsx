/**
 * modulos.test.tsx — módulos inteiros montados, com as fontes mockadas.
 *
 * Cobre a classe de bug que os testes de unidade não alcançam: interação
 * entre React e estado que sobrevive ao ciclo de vida. Foi de onde vieram
 * três dos quatro defeitos que chegaram em produção neste projeto.
 *
 * Todos rodam sob **StrictMode**, de propósito — é a montagem dupla que
 * expõe efeito com limpeza mal feita, e foi ela que quebrou tanto o cache
 * (AbortSignal compartilhado) quanto o enquadramento do mapa (ref
 * sobrevivendo ao objeto).
 */
import { StrictMode } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { autenticar, mockarFontes, renderizar } from "./ambiente";
import { RelatorioPraca } from "../modules/RelatorioPraca";
import { Usuarios } from "../modules/Usuarios";
import { Prospeccao } from "../modules/Prospeccao";
import { VaziosDeMercado } from "../modules/VaziosDeMercado";

beforeEach(() => {
  autenticar();
  mockarFontes();
  /* Todo teste começa apontando para São Paulo — os módulos leem o filtro. */
  window.location.hash = "#/praca?uf=SP&mun=3550308&cnae=G";
});

/* ─── Relatório de Praça ───────────────────────────────────────────────── */

describe("Relatório de Praça", () => {
  it("carrega o IBGE e mostra o dossiê da praça", async () => {
    renderizar(
      <StrictMode>
        <RelatorioPraca />
      </StrictMode>,
    );

    /* `findAllByText`: "São Paulo" aparece na trilha E no título. Consulta
       singular estouraria por múltiplos — e o erro pareceria falha do módulo. */
    await waitFor(
      () => expect(screen.getAllByText("São Paulo").length).toBeGreaterThan(0),
      { timeout: 5000 },
    );

    /* Números REAIS vindos do mock, com a forma real da API do IBGE. */
    expect(await screen.findByText("1.201.528")).toBeInTheDocument(); // empresas
    expect(screen.getByText("11.904.961")).toBeInTheDocument(); // população
    expect(screen.getByText(/Score de Atratividade/i)).toBeInTheDocument();
    expect(screen.getByText(/Como este score foi formado/i)).toBeInTheDocument();
  });

  /* REGRESSÃO — StrictMode. O cache compartilhado recebia o AbortSignal do
     componente; a limpeza da 1ª montagem abortava a promise que a 2ª ia
     reaproveitar, e a tela morria com "signal is aborted without reason". */
  it("sobrevive à montagem dupla do StrictMode", async () => {
    renderizar(
      <StrictMode>
        <RelatorioPraca />
      </StrictMode>,
    );

    await waitFor(
      () => expect(screen.getAllByText("São Paulo").length).toBeGreaterThan(0),
      { timeout: 5000 },
    );

    expect(screen.queryByText(/falhou ao renderizar/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/aborted/i)).not.toBeInTheDocument();
  });

  it("mostra erro acionável quando o IBGE cai, sem tela branca", async () => {
    vi.unstubAllGlobals();
    mockarFontes({ falharEm: /agregados/ });

    renderizar(<RelatorioPraca />);

    await waitFor(
      () => expect(screen.getByText(/fonte pública está instável/i)).toBeInTheDocument(),
      { timeout: 8000 },
    );
    expect(screen.getByRole("button", { name: /tentar de novo/i })).toBeInTheDocument();
  });

  it("pede uma praça quando nenhuma está selecionada", async () => {
    window.location.hash = "#/praca?uf=SP&cnae=G";
    renderizar(<RelatorioPraca />);
    expect(await screen.findByText(/Escolha uma praça/i)).toBeInTheDocument();
  });
});

/* ─── Usuários ─────────────────────────────────────────────────────────── */

describe("Usuários", () => {
  /* REGRESSÃO — o bug do `currentTarget`.
     O React anula `currentTarget` assim que o handler retorna, e um updater
     funcional roda DEPOIS disso. Ler o evento de dentro do updater lançava
     "Cannot read properties of null (reading 'value')" na PRIMEIRA TECLA, e
     o formulário inteiro desmontava na fronteira de erro. */
  it("digitar nos campos não derruba o formulário", async () => {
    const usuario = userEvent.setup();
    renderizar(
      <StrictMode>
        <Usuarios />
      </StrictMode>,
    );

    const email = await screen.findByLabelText(/e-mail/i);
    const nome = await screen.findByLabelText(/^nome$/i);

    await usuario.type(email, "novo@empresa.com");
    await usuario.type(nome, "Pessoa Nova");

    expect(email).toHaveValue("novo@empresa.com");
    expect(nome).toHaveValue("Pessoa Nova");
    /* O campo seguinte só continua no DOM se o primeiro não derrubou a tela —
       era exatamente assim que o bug se manifestava. */
    expect(screen.getByLabelText(/senha inicial/i)).toBeInTheDocument();
  });

  it("gera senha forte e trocável", async () => {
    const usuario = userEvent.setup();
    renderizar(<Usuarios />);

    const senha = (await screen.findByLabelText(/senha inicial/i)) as HTMLInputElement;
    const primeira = senha.value;

    expect(primeira.length).toBeGreaterThanOrEqual(16);
    /* Sem caracteres que se confundem ao transcrever da tela. */
    expect(primeira).not.toMatch(/[IlO01]/);

    await usuario.click(screen.getByRole("button", { name: /^gerar$/i }));
    expect(senha.value).not.toBe(primeira);
  });

  it("usuário comum não vê a administração, mas troca a própria senha", async () => {
    autenticar("user");
    renderizar(<Usuarios />);

    expect(await screen.findByText(/Minha conta/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nova conta de acesso/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/senha atual/i)).toBeInTheDocument();
  });
});

/* ─── Prospecção ───────────────────────────────────────────────────────── */

describe("Prospecção B2B", () => {
  it("carrega a carteira e calcula o Score ICP de cada conta", async () => {
    renderizar(
      <StrictMode>
        <Prospeccao />
      </StrictMode>,
    );

    await waitFor(
      () => expect(screen.getByText(/contas carregadas/i)).toBeInTheDocument(),
      { timeout: 15000 },
    );

    expect(screen.getAllByText(/Score ICP médio/i).length).toBeGreaterThan(0);
    /* `capitalizar()` transforma "EMPRESA DE TESTE S.A." — a preposição fica
       minúscula, então a asserção precisa ser insensível a caixa. */
    expect(screen.getAllByText(/empresa de teste/i).length).toBeGreaterThan(0);
  });

  it("recusa CNPJ com dígito verificador inválido antes de ir à rede", async () => {
    /* Barrar aqui evita queimar cota da BrasilAPI com número que ela
       recusaria de qualquer forma. */
    const usuario = userEvent.setup();
    const { fetchFalso } = mockarFontes();
    renderizar(<Prospeccao />);

    const campo = await screen.findByPlaceholderText(/00\.000\.000/);
    await usuario.type(campo, "11111111111111");

    expect(await screen.findByText(/Dígito verificador inválido/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /consultar/i })).toBeDisabled();

    const consultas = fetchFalso.mock.calls.filter((c) =>
      String(c[0]).includes("11111111111111"),
    );
    expect(consultas).toHaveLength(0);
  });
});

/* ─── Vazios de Mercado ────────────────────────────────────────────────── */

describe("Vazios de Mercado", () => {
  /* O caminho feliz com números reais está em `domain/vazios.validacao.test.ts`,
     que roda o modelo sobre o conjunto de 4.979 municípios da pesquisa. Aqui o
     que importa são os dois ramos que só existem na tela: o portão de setor e
     o estado de amostra insuficiente. */

  it("BLOQUEIA setor não validado em vez de mostrar números", async () => {
    /* A decisão de produto mais importante do módulo. O modelo roda em
       qualquer seção CNAE e devolve números de aparência idêntica; foi o teste
       fora da amostra que reprovou Construção (rho = +0,040). */
    window.location.hash = "#/vazios?uf=SP&cnae=F";

    renderizar(
      <StrictMode>
        <VaziosDeMercado />
      </StrictMode>,
    );

    expect(await screen.findByText(/não foi validado/i)).toBeInTheDocument();
    expect(screen.getByText(/\+0,040/)).toBeInTheDocument();
    expect(screen.getByText(/mercado local/i)).toBeInTheDocument();

    /* E nenhuma lacuna na tela — nem tabela, nem ranking. */
    expect(screen.queryByText(/Onde ir primeiro/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/maiores lacunas/i)).not.toBeInTheDocument();
  });

  it("oferece os setores validados como saída", async () => {
    window.location.hash = "#/vazios?uf=SP&cnae=F";
    renderizar(<VaziosDeMercado />);

    await screen.findByText(/não foi validado/i);
    expect(screen.getByText(/Setores validados/i)).toBeInTheDocument();
  });

  it("diz que faltou dado em vez de mostrar zeros", async () => {
    /* O mock tem 5 municípios e o modelo exige 50. Sem este ramo a tela
       mostrava "0 municípios", "0,0% da variação" e elasticidades "0,00" numa
       tabela vazia: não quebra, mas parece quebrada, e o usuário não tem como
       saber que o problema é falta de dado e não erro de cálculo. */
    window.location.hash = "#/vazios?uf=SP&cnae=G";

    renderizar(
      <StrictMode>
        <VaziosDeMercado />
      </StrictMode>,
    );

    expect(
      await screen.findByText(/Dados insuficientes/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText("0,0%")).not.toBeInTheDocument();
    expect(screen.queryByText(/falhou ao renderizar/i)).not.toBeInTheDocument();
  });
});
