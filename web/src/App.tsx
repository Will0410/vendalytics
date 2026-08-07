/**
 * App.tsx — a casca: grade de layout, roteamento e a fronteira de erro.
 *
 * O `ErrorBoundary` existe porque um módulo que estoura num render não pode
 * levar a plataforma inteira para a tela branca. Ele isola o conteúdo — a
 * navegação e os filtros continuam de pé, e o usuário troca de módulo em vez
 * de dar F5.
 */
import { Component, Suspense, type ErrorInfo, type ReactNode } from "react";
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
import { InteligenciaVendas } from "./modules/InteligenciaVendas";
import { Geomarketing } from "./modules/Geomarketing";
import { RelatorioPraca } from "./modules/RelatorioPraca";
import { Prospeccao } from "./modules/Prospeccao";
import { Enriquecimento } from "./modules/Enriquecimento";
import { Usuarios } from "./modules/Usuarios";

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
              {rotaEfetiva === "geomarketing" && <Geomarketing />}
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
