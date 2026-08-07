/**
 * Sidebar.tsx — navegação lateral B2B.
 *
 * Escura, fixa, com os cinco módulos e o estado das fontes no rodapé. A
 * marcação usa `<nav>` + `aria-current="page"` para o leitor de tela anunciar
 * onde o usuário está; o destaque visual (barra à esquerda + fundo) é reforço,
 * não a única indicação.
 *
 * Colapsa para 72px em telas médias. Nesse estado os rótulos somem e sobra o
 * ícone com `title` — o menu não pode comer 250px de uma tela de 1280 que
 * precisa mostrar tabela densa.
 */
import { styled } from "../stitches.config";
import { Asset } from "../assets/AssetProvider";
import { ROTAS, type RotaId } from "../app/rotas";
import { useSessao } from "../app/sessao";
import { Badge, Button, Row, Stack, Text } from "./primitives";

const Aside = styled("aside", {
  gridArea: "sidebar",
  display: "flex",
  flexDirection: "column",
  backgroundColor: "$sidebar",
  borderRight: "1px solid $border",
  width: "$sidebarCollapsed",
  transition: "width $slow",
  overflow: "hidden",
  "@lg": { width: "$sidebar" },
});

const Marca = styled("div", {
  display: "flex",
  alignItems: "center",
  gap: "$3",
  height: "$header",
  px: "$5",
  borderBottom: "1px solid $border",
  flexShrink: 0,
});

const MarcaTexto = styled("div", {
  display: "none",
  minWidth: 0,
  "@lg": { display: "block" },
});

const Nav = styled("nav", {
  display: "flex",
  flexDirection: "column",
  gap: "$1",
  padding: "$3",
  flex: 1,
  overflowY: "auto",
});

const Item = styled("a", {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: "$3",
  height: 42,
  px: "$3",
  borderRadius: "$md",
  color: "$textMuted",
  cursor: "pointer",
  transition: "background-color $fast, color $fast",
  flexShrink: 0,
  "&:hover": { backgroundColor: "$surfaceHover", color: "$textPrimary" },
  "@media (max-width: 1199px)": { justifyContent: "center", px: 0 },
  variants: {
    ativo: {
      true: {
        backgroundColor: "$brandSubtle",
        color: "$textPrimary",
        /* Barra de 3px à esquerda — a segunda pista visual, além do fundo */
        "&::before": {
          content: '""',
          position: "absolute",
          left: 0,
          top: 9,
          bottom: 9,
          width: 3,
          borderRadius: "0 3px 3px 0",
          backgroundImage: "linear-gradient(180deg, $colors$accent, $colors$brand)",
        },
      },
    },
  },
});

const Rotulo = styled("span", {
  display: "none",
  fontSize: "$md",
  fontWeight: "$medium",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  "@lg": { display: "block" },
});

const Rodape = styled("div", {
  display: "none",
  padding: "$4",
  borderTop: "1px solid $border",
  flexShrink: 0,
  "@lg": { display: "block" },
});

const PontoFonte = styled("span", {
  display: "inline-block",
  size: 6,
  borderRadius: "$pill",
  backgroundColor: "$good",
  flexShrink: 0,
});

export function Sidebar({
  rotaAtual,
  aoNavegar,
}: {
  rotaAtual: RotaId;
  aoNavegar: (r: RotaId) => void;
}) {
  const { sessao, ehAdmin, sair } = useSessao();

  return (
    <Aside>
      <Marca>
        <Asset id="logo.mark" size={30} />
        <MarcaTexto>
          <Text
            size="lg"
            tone="primary"
            weight="bold"
            css={{ letterSpacing: "$tighter", lineHeight: 1.1 }}
          >
            Vendalytics
          </Text>
          <Text size="xs" tone="muted" css={{ letterSpacing: "$wide" }}>
            SALES INTELLIGENCE
          </Text>
        </MarcaTexto>
      </Marca>

      <Nav aria-label="Módulos da plataforma">
        {/* A rota de administração some do menu para quem não é admin. É
            cortesia de interface — quem garante o bloqueio é o backend, que
            responde 403 em /api/usuarios para perfil `user`. */}
        {ROTAS.filter((r) => !r.somenteAdmin || ehAdmin).map((r) => (
          <Item
            key={r.id}
            href={`#/${r.id}`}
            ativo={r.id === rotaAtual}
            aria-current={r.id === rotaAtual ? "page" : undefined}
            title={r.titulo}
            onClick={(e) => {
              e.preventDefault();
              aoNavegar(r.id);
            }}
          >
            <Asset id={r.icone} size={20} />
            <Rotulo>{r.titulo}</Rotulo>
          </Item>
        ))}
      </Nav>

      <Rodape>
        <Stack gap={4}>
          {sessao && (
            <Stack gap={2}>
              <Text size="xs" overline>
                Sessão
              </Text>
              <Row justify="between" gap={2}>
                <Stack gap={0} css={{ minWidth: 0 }}>
                  <Text size="sm" tone="primary" weight="medium" clamp={1}>
                    {sessao.nome}
                  </Text>
                  <Text size="xs" tone="muted" clamp={1} title={sessao.email}>
                    {sessao.email}
                  </Text>
                </Stack>
                <Badge tone={ehAdmin ? "marca" : "neutro"}>
                  {ehAdmin ? "admin" : "user"}
                </Badge>
              </Row>
              <Button variante="secundario" tamanho="sm" largura="cheia" onClick={sair}>
                Sair
              </Button>
            </Stack>
          )}

          <Stack gap={2}>
          <Text size="xs" overline>
            Fontes conectadas
          </Text>
          <Row gap={2} align="center">
            <PontoFonte />
            <Text size="xs" tone="muted">
              IBGE · SIDRA + Localidades
            </Text>
          </Row>
          <Row gap={2} align="center">
            <PontoFonte />
            <Text size="xs" tone="muted">
              Receita Federal · via BrasilAPI
            </Text>
          </Row>
          </Stack>
        </Stack>
      </Rodape>
    </Aside>
  );
}
