/**
 * App.tsx — a casca: grade de layout, roteamento e a fronteira de erro.
 *
 * O `ErrorBoundary` existe porque um módulo que estoura num render não pode
 * levar a plataforma inteira para a tela branca. Ele isola o conteúdo — a
 * navegação e os filtros continuam de pé, e o usuário troca de módulo em vez
 * de dar F5.
 */
import {
  Component,
  Suspense,
  lazy,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { styled } from "./stitches.config";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { Button, Card, Heading, Stack, Text } from "./components/primitives";
// `Text` também é usado pela tela de boot abaixo.
import { SkeletonKpis } from "./components/estados";
import { useRota } from "./app/rotas";
import { useSessao } from "./app/sessao";
import { Login } from "./components/Login";
import { Asset } from "./assets/AssetProvider";

/* ─── Módulos: todos por import dinâmico ───────────────────────────────────
 *
 * O usuário aterrissa em UM módulo. Estáticos, os nove desciam sempre, e as
 * bibliotecas pesadas vinham junto mesmo para quem nunca abriria a tela que
 * as usa:
 *
 *   Recharts (+ lodash, d3, decimal.js-light) .. 36% do bundle, 4 módulos usam
 *   Leaflet (+ markercluster, centroides) ...... 2 módulos usam
 *   Usuarios ................................... só admin abre
 *
 * Medido no bundle anterior: 756KB, dos quais ~900KB de fonte não-minificada
 * eram Recharts e suas dependências exclusivas — o app não importa lodash nem
 * d3 em lugar nenhum, elas entram de carona.
 *
 * Isso é seguro por causa da porta de login logo abaixo: enquanto a pessoa
 * digita a senha, os chunks do módulo inicial já estão descendo. Não há
 * cascata visível — e sem a porta haveria, o que é o motivo de esta decisão
 * não se aplicar a qualquer app.
 *
 * O `<Suspense>` que já envolve o conteúdo cuida do estado de carregamento.
 *
 * Cuidado ao mexer: um único `import` estático de módulo aqui em cima desfaz
 * tudo. Foi o que aconteceu quando o Planejamento de Território entrou
 * estático — 721KB viraram 1,12MB e o chunk do mapa caiu para 9KB, porque não
 * sobrou nada nele para separar.
 */
/* A FUNÇÃO é obrigatória: `import(...)` avaliado aqui dispararia na carga do
   módulo, os nove chunks desceriam juntos e o `Usuarios` voltaria a descer
   para quem não é admin. Adiada, cada um só sai quando a rota pede. */
const carregar = <K extends string>(
  abrir: () => Promise<Record<K, ComponentType>>,
  chave: K,
) => lazy(() => abrir().then((m) => ({ default: m[chave] })));

const InteligenciaVendas = carregar(() => import("./modules/InteligenciaVendas"), "InteligenciaVendas");
const Copiloto = carregar(() => import("./modules/Copiloto"), "Copiloto");
const Geomarketing = carregar(() => import("./modules/Geomarketing"), "Geomarketing");
const VaziosDeMercado = carregar(() => import("./modules/VaziosDeMercado"), "VaziosDeMercado");
const RelatorioPraca = carregar(() => import("./modules/RelatorioPraca"), "RelatorioPraca");
const Prospeccao = carregar(() => import("./modules/Prospeccao"), "Prospeccao");
const Enriquecimento = carregar(() => import("./modules/Enriquecimento"), "Enriquecimento");
const Usuarios = carregar(() => import("./modules/Usuarios"), "Usuarios");
const MapaTerritorial = carregar(() => import("./modules/MapaTerritorial"), "MapaTerritorial");
const PlanejamentoTerritorio = carregar(
  () => import("./modules/PlanejamentoTerritorio"),
  "PlanejamentoTerritorio",
);

const Shell = styled("div", {
  display: "grid",
  gridTemplateAreas: `"sidebar header" "sidebar main"`,
  gridTemplateColumns: "auto minmax(0, 1fr)",
  gridTemplateRows: "auto minmax(0, 1fr)",
  height: "100vh",
  width: "100%",
  overflow: "hidden",
});

const Main = styled("main", {
  gridArea: "main",
  overflowY: "auto",
  overflowX: "hidden",
  px: "$5",
  py: "$6",
  "@lg": { px: "$7" },
});

const Conteudo = styled("div", {
  width: "100%",
  maxWidth: "$containerMax",
  mx: "auto",
});

/* ─── Fronteira de erro ────────────────────────────────────────────────── */

class FronteiraErro extends Component<
  { children: ReactNode; chave: string },
  { erro: Error | null }
> {
  state = { erro: null as Error | null };

  static getDerivedStateFromError(erro: Error) {
    return { erro };
  }

  componentDidCatch(erro: Error, info: ErrorInfo) {
    console.error("[vendalytics] módulo quebrou no render:", erro, info.componentStack);
  }

  componentDidUpdate(anterior: { chave: string }) {
    /* Trocar de módulo limpa o erro — senão a fronteira ficaria "presa"
       mostrando a falha de uma tela que o usuário já deixou. */
    if (anterior.chave !== this.props.chave && this.state.erro) this.setState({ erro: null });
  }

  render() {
    if (this.state.erro) {
      return (
        <Card padding="lg" css={{ borderColor: "rgba(208,59,59,0.28)" }}>
          <Stack gap={4}>
            <Heading size="md" css={{ color: "#e56a6a" }}>
              Este módulo falhou ao renderizar
            </Heading>
            <Text size="sm">
              A navegação e os filtros continuam funcionando — troque de módulo ou recarregue.
            </Text>
            <Text size="xs" tone="muted" mono>
              {this.state.erro.message}
            </Text>
            <div>
              <Button variante="secundario" onClick={() => this.setState({ erro: null })}>
                Tentar renderizar de novo
              </Button>
            </div>
          </Stack>
        </Card>
      );
    }
    return this.props.children;
  }
}

/* ─── App ──────────────────────────────────────────────────────────────── */

/** Tela de boot. Existe para o caso específico do F5 com sessão válida: sem
 *  ela, o formulário de login pisca por um instante antes de a verificação
 *  contra `/api/auth/me` voltar, e o usuário acha que foi deslogado. */
const Booting = styled("div", {
  height: "100vh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "$4",
  backgroundColor: "$canvas",
});

export default function App() {
  const [rota, navegar] = useRota();
  const { estado, ehAdmin } = useSessao();

  if (estado.fase === "verificando") {
    return (
      <Booting>
        <Asset id="logo.mark" size={38} />
        <Text size="sm" tone="muted">
          Verificando sessão…
        </Text>
      </Booting>
    );
  }

  if (estado.fase === "anonimo") return <Login />;

  /* Rota de admin acessada por perfil `user` (link colado, hash editado à mão):
     cai no módulo padrão em vez de mostrar uma tela que o backend recusaria. */
  const rotaEfetiva = rota === "usuarios" && !ehAdmin ? "vendas" : rota;

  return (
    <Shell>
      <Sidebar rotaAtual={rotaEfetiva} aoNavegar={navegar} />
      <Header rota={rotaEfetiva} />
      <Main>
        <Conteudo>
          <FronteiraErro chave={rotaEfetiva}>
            <Suspense fallback={<SkeletonKpis />}>
              {rotaEfetiva === "vendas" && <InteligenciaVendas />}
              {rotaEfetiva === "copiloto" && <Copiloto />}
              {rotaEfetiva === "geomarketing" && <Geomarketing />}
              {rotaEfetiva === "mapa" && <MapaTerritorial />}
              {rotaEfetiva === "territorios" && <PlanejamentoTerritorio />}
              {rotaEfetiva === "vazios" && <VaziosDeMercado />}
              {rotaEfetiva === "praca" && <RelatorioPraca />}
              {rotaEfetiva === "prospeccao" && <Prospeccao />}
              {rotaEfetiva === "enriquecimento" && <Enriquecimento />}
              {rotaEfetiva === "usuarios" && <Usuarios />}
            </Suspense>
          </FronteiraErro>
        </Conteudo>
      </Main>
    </Shell>
  );
}
