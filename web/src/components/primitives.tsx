/**
 * primitives.tsx — os componentes-base do design system.
 *
 * Tudo aqui é `styled` do Stitches com `variants`. A regra: um componente
 * nunca recebe cor ou espaçamento por prop solta — recebe uma *variant*
 * nomeada, que resolve para token. É o que impede a interface de derivar em
 * 14 tons de cinza levemente diferentes ao longo do projeto.
 */
import { styled, animations } from "../stitches.config";

/* ─── Layout ───────────────────────────────────────────────────────────── */

export const Stack = styled("div", {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  variants: {
    gap: {
      0: { gap: 0 },
      1: { gap: "$1" }, 2: { gap: "$2" }, 3: { gap: "$3" }, 4: { gap: "$4" },
      5: { gap: "$5" }, 6: { gap: "$6" }, 7: { gap: "$7" }, 8: { gap: "$8" },
    },
    align: {
      start: { alignItems: "flex-start" },
      center: { alignItems: "center" },
      end: { alignItems: "flex-end" },
      stretch: { alignItems: "stretch" },
    },
  },
  defaultVariants: { gap: 4 },
});

export const Row = styled("div", {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  minWidth: 0,
  variants: {
    gap: {
      0: { gap: 0 }, 1: { gap: "$1" }, 2: { gap: "$2" }, 3: { gap: "$3" },
      4: { gap: "$4" }, 5: { gap: "$5" }, 6: { gap: "$6" }, 7: { gap: "$7" },
    },
    justify: {
      start: { justifyContent: "flex-start" },
      between: { justifyContent: "space-between" },
      center: { justifyContent: "center" },
      end: { justifyContent: "flex-end" },
    },
    align: {
      start: { alignItems: "flex-start" },
      center: { alignItems: "center" },
      end: { alignItems: "flex-end" },
      baseline: { alignItems: "baseline" },
    },
    wrap: { true: { flexWrap: "wrap" } },
  },
  defaultVariants: { gap: 3 },
});

export const Grid = styled("div", {
  display: "grid",
  gap: "$4",
  minWidth: 0,
  variants: {
    cols: {
      auto: { gridTemplateColumns: "repeat(auto-fit, minmax(272px, 1fr))" },
      autoLg: { gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))" },
      2: { gridTemplateColumns: "1fr", "@md": { gridTemplateColumns: "repeat(2, minmax(0,1fr))" } },
      3: {
        gridTemplateColumns: "1fr",
        "@md": { gridTemplateColumns: "repeat(2, minmax(0,1fr))" },
        "@lg": { gridTemplateColumns: "repeat(3, minmax(0,1fr))" },
      },
      4: {
        gridTemplateColumns: "repeat(2, minmax(0,1fr))",
        "@md": { gridTemplateColumns: "repeat(2, minmax(0,1fr))" },
        "@lg": { gridTemplateColumns: "repeat(4, minmax(0,1fr))" },
      },
      "2-1": {
        gridTemplateColumns: "1fr",
        "@lg": { gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr)" },
      },
      "1-2": {
        gridTemplateColumns: "1fr",
        "@lg": { gridTemplateColumns: "minmax(0,1fr) minmax(0,2fr)" },
      },
    },
  },
  defaultVariants: { cols: "auto" },
});

/* ─── Tipografia ───────────────────────────────────────────────────────── */

export const Text = styled("p", {
  margin: 0,
  color: "$textSecondary",
  fontSize: "$base",
  lineHeight: "$normal",
  minWidth: 0,
  variants: {
    size: {
      xs: { fontSize: "$xs" }, sm: { fontSize: "$sm" }, md: { fontSize: "$md" },
      base: { fontSize: "$base" }, lg: { fontSize: "$lg" }, xl: { fontSize: "$xl" },
    },
    tone: {
      primary: { color: "$textPrimary" },
      secondary: { color: "$textSecondary" },
      muted: { color: "$textMuted" },
      brand: { color: "$brand" },
      accent: { color: "$accent" },
      good: { color: "$good" },
      warning: { color: "$warning" },
      critical: { color: "$critical" },
    },
    weight: {
      regular: { fontWeight: "$regular" }, medium: { fontWeight: "$medium" },
      semibold: { fontWeight: "$semibold" }, bold: { fontWeight: "$bold" },
    },
    /* Rótulo de eixo/seção: caixa alta, tracking aberto, tamanho mínimo. */
    overline: {
      true: {
        textTransform: "uppercase",
        letterSpacing: "$wider",
        fontSize: "$xs",
        fontWeight: "$semibold",
        color: "$textMuted",
      },
    },
    mono: { true: { fontFamily: "$mono", fontVariantNumeric: "tabular-nums" } },
    clamp: { 1: { lineClamp: 1 }, 2: { lineClamp: 2 }, 3: { lineClamp: 3 } },
  },
  defaultVariants: { size: "base", tone: "secondary" },
});

export const Heading = styled("h2", {
  margin: 0,
  color: "$textPrimary",
  fontWeight: "$semibold",
  letterSpacing: "$tight",
  lineHeight: "$snug",
  variants: {
    size: {
      sm: { fontSize: "$base" },
      md: { fontSize: "$lg" },
      lg: { fontSize: "$xl" },
      xl: { fontSize: "$2xl", letterSpacing: "$tighter" },
      "2xl": { fontSize: "$3xl", letterSpacing: "$tighter", fontWeight: "$bold" },
    },
  },
  defaultVariants: { size: "md" },
});

/** Número grande de KPI. Figuras proporcionais (não tabulares): o valor é
 *  lido sozinho, não alinhado em coluna. */
export const Figura = styled("div", {
  color: "$textPrimary",
  fontWeight: "$bold",
  letterSpacing: "$tighter",
  lineHeight: "$tight",
  variants: {
    size: {
      md: { fontSize: "$2xl" },
      lg: { fontSize: "$3xl" },
      xl: { fontSize: "$4xl" },
      hero: { fontSize: "$5xl", fontWeight: "$extrabold" },
    },
    tone: {
      primary: { color: "$textPrimary" },
      brand: { color: "$brand" },
      accent: { color: "$accent" },
      good: { color: "$good" },
      warning: { color: "$warning" },
      critical: { color: "$critical" },
    },
  },
  defaultVariants: { size: "lg", tone: "primary" },
});

/* ─── Superfícies ──────────────────────────────────────────────────────── */

export const Card = styled("section", {
  position: "relative",
  backgroundColor: "$surface",
  border: "1px solid $border",
  borderRadius: "$xl",
  overflow: "hidden",
  minWidth: 0,
  /* O ::before é reservado para a textura do AssetProvider; o conteúdo
     precisa ficar acima dele. */
  "& > *": { position: "relative", zIndex: 1 },
  variants: {
    padding: {
      none: { padding: 0 },
      sm: { padding: "$4" },
      md: { padding: "$5" },
      lg: { padding: "$6" },
    },
    tone: {
      base: {},
      raised: { backgroundColor: "$surfaceRaised", boxShadow: "$md" },
      sunken: { backgroundColor: "$surfaceSunken" },
      /* Destaque de marca — o card "principal" de cada tela, um por vez. */
      brand: {
        borderColor: "$brandBorder",
        backgroundImage:
          "linear-gradient(160deg, rgba(79,110,247,0.10) 0%, rgba(15,23,42,0) 58%)",
      },
    },
    interativo: {
      true: {
        cursor: "pointer",
        transition: "border-color $base, transform $base, box-shadow $base",
        "&:hover": {
          borderColor: "$borderStrong",
          transform: "translateY(-1px)",
          boxShadow: "$md",
        },
        "&:active": { transform: "none" },
      },
    },
  },
  defaultVariants: { padding: "md", tone: "base" },
});

export const Divider = styled("hr", {
  border: 0,
  borderTop: "1px solid $border",
  margin: 0,
  width: "100%",
  variants: { vertical: { true: { width: 0, height: "100%", borderTop: 0, borderLeft: "1px solid $border" } } },
});

/* ─── Badge ────────────────────────────────────────────────────────────── */

/**
 * Badge de estado.
 *
 * As variantes de status usam os tokens reservados (`good`/`warning`/
 * `serious`/`critical`), que nunca são reutilizados como cor de série de
 * gráfico. E carregam sempre um rótulo textual — a cor reforça, nunca
 * carrega sozinha o significado.
 */
export const Badge = styled("span", {
  display: "inline-flex",
  alignItems: "center",
  gap: "$1",
  px: "$2",
  py: "2px",
  borderRadius: "$sm",
  fontSize: "$xs",
  fontWeight: "$semibold",
  letterSpacing: "$tight",
  whiteSpace: "nowrap",
  border: "1px solid transparent",
  lineHeight: 1.5,
  variants: {
    tone: {
      neutro: { backgroundColor: "$neutralSubtle", color: "$slate300", borderColor: "$border" },
      marca: { backgroundColor: "$brandSubtle", color: "#93a6fb", borderColor: "$brandBorder" },
      acento: { backgroundColor: "$accentSubtle", color: "$accent", borderColor: "rgba(34,211,238,0.3)" },
      bom: { backgroundColor: "$goodSubtle", color: "#3fce3f", borderColor: "rgba(12,163,12,0.34)" },
      atencao: { backgroundColor: "$warningSubtle", color: "$warning", borderColor: "rgba(250,178,25,0.34)" },
      serio: { backgroundColor: "$seriousSubtle", color: "$serious", borderColor: "rgba(236,131,90,0.34)" },
      critico: { backgroundColor: "$criticalSubtle", color: "#e56a6a", borderColor: "rgba(208,59,59,0.4)" },
    },
    solido: {
      true: { borderColor: "transparent" },
    },
    tamanho: {
      sm: { fontSize: "$xs", px: "$2", py: "1px" },
      md: { fontSize: "$sm", px: "$3", py: "3px" },
    },
  },
  compoundVariants: [
    { tone: "marca", solido: true, css: { backgroundColor: "$brand", color: "#fff" } },
    { tone: "bom", solido: true, css: { backgroundColor: "$good", color: "#042404" } },
    { tone: "atencao", solido: true, css: { backgroundColor: "$warning", color: "#2b1d00" } },
    { tone: "critico", solido: true, css: { backgroundColor: "$critical", color: "#fff" } },
  ],
  defaultVariants: { tone: "neutro", tamanho: "sm" },
});

/* ─── Controles ────────────────────────────────────────────────────────── */

export const Button = styled("button", {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "$2",
  border: "1px solid transparent",
  borderRadius: "$md",
  fontWeight: "$medium",
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background-color $fast, border-color $fast, color $fast, opacity $fast",
  "&:disabled": { opacity: 0.45, cursor: "not-allowed" },
  variants: {
    variante: {
      primario: {
        backgroundColor: "$brand",
        color: "#fff",
        "&:hover:not(:disabled)": { backgroundColor: "$brandHover" },
        "&:active:not(:disabled)": { backgroundColor: "$brandActive" },
      },
      secundario: {
        backgroundColor: "$surfaceRaised",
        color: "$textPrimary",
        borderColor: "$border",
        "&:hover:not(:disabled)": { backgroundColor: "$surfaceHover", borderColor: "$borderStrong" },
      },
      fantasma: {
        backgroundColor: "transparent",
        color: "$textSecondary",
        "&:hover:not(:disabled)": { backgroundColor: "$surfaceHover", color: "$textPrimary" },
      },
      perigo: {
        backgroundColor: "transparent",
        color: "#e56a6a",
        borderColor: "rgba(208,59,59,0.4)",
        "&:hover:not(:disabled)": { backgroundColor: "$criticalSubtle" },
      },
    },
    tamanho: {
      sm: { fontSize: "$sm", px: "$3", height: 30 },
      md: { fontSize: "$base", px: "$4", height: 36 },
      lg: { fontSize: "$lg", px: "$5", height: 44 },
    },
    largura: { cheia: { width: "100%" } },
  },
  defaultVariants: { variante: "secundario", tamanho: "md" },
});

const controleBase = {
  backgroundColor: "$surfaceSunken",
  color: "$textPrimary",
  border: "1px solid $border",
  borderRadius: "$md",
  height: 36,
  px: "$3",
  fontSize: "$base",
  transition: "border-color $fast, box-shadow $fast",
  minWidth: 0,
  "&:hover:not(:disabled)": { borderColor: "$borderStrong" },
  "&:focus": { outline: "none", borderColor: "$brand", boxShadow: "$focus" },
  "&:disabled": { opacity: 0.5, cursor: "not-allowed" },
} as const;

export const Select = styled("select", {
  ...controleBase,
  cursor: "pointer",
  appearance: "none",
  /* Seta desenhada em SVG inline — sem dependência e herda o tom do tema. */
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='%2394a3b8' stroke-width='1.5' stroke-linecap='round'%3E%3Cpath d='M3 4.5 6 7.5 9 4.5'/%3E%3C/svg%3E\")",
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 10px center",
  backgroundSize: "12px",
  paddingRight: "$7",
  "& option": { backgroundColor: "#0b1120", color: "#f1f5f9" },
  variants: {
    tamanho: {
      sm: { height: 30, fontSize: "$sm" },
      md: { height: 36 },
    },
    largura: { cheia: { width: "100%" } },
  },
});

export const Input = styled("input", {
  ...controleBase,
  "&::placeholder": { color: "$textMuted" },
  variants: {
    tamanho: { sm: { height: 30, fontSize: "$sm" }, md: { height: 36 } },
    largura: { cheia: { width: "100%" } },
    mono: { true: { fontFamily: "$mono", letterSpacing: "0.02em" } },
  },
});

export const Label = styled("label", {
  display: "block",
  fontSize: "$xs",
  fontWeight: "$semibold",
  textTransform: "uppercase",
  letterSpacing: "$wider",
  color: "$textMuted",
  marginBottom: "$2",
});

/* ─── Carregamento ─────────────────────────────────────────────────────── */

export const Skeleton = styled("div", {
  borderRadius: "$sm",
  background:
    "linear-gradient(90deg, rgba(148,163,184,0.05) 0%, rgba(148,163,184,0.14) 50%, rgba(148,163,184,0.05) 100%)",
  backgroundSize: "420px 100%",
  "@motion": { animation: `${animations.shimmer} 1.5s linear infinite` },
  variants: {
    linha: {
      true: { height: 12 },
    },
    forma: {
      texto: { height: 12, borderRadius: "$pill" },
      titulo: { height: 20, borderRadius: "$sm" },
      figura: { height: 34, borderRadius: "$sm" },
      bloco: { height: 120, borderRadius: "$md" },
      circulo: { borderRadius: "$pill" },
    },
  },
  defaultVariants: { forma: "texto" },
});

/** Barra de progresso — usada na carga em lote de CNPJs. */
export const Progresso = styled("div", {
  position: "relative",
  height: 4,
  width: "100%",
  borderRadius: "$pill",
  backgroundColor: "rgba(148,163,184,0.14)",
  overflow: "hidden",
  "& > i": {
    display: "block",
    height: "100%",
    borderRadius: "$pill",
    backgroundImage: "linear-gradient(90deg, $colors$brand, $colors$accent)",
    transition: "width $base",
  },
});

/* ─── Tabela ───────────────────────────────────────────────────────────── */

/** Envelope com rolagem própria — a tabela densa nunca empurra a página
 *  para o lado, ela rola dentro do próprio card. */
export const TabelaWrap = styled("div", {
  width: "100%",
  overflowX: "auto",
  overscrollBehaviorX: "contain",
});

export const Tabela = styled("table", {
  width: "100%",
  borderCollapse: "separate",
  borderSpacing: 0,
  fontSize: "$md",
  "& th, & td": { textAlign: "left", whiteSpace: "nowrap" },
  "& thead th": {
    position: "sticky",
    top: 0,
    zIndex: 2,
    backgroundColor: "$surface",
    color: "$textMuted",
    fontSize: "$xs",
    fontWeight: "$semibold",
    textTransform: "uppercase",
    letterSpacing: "$wide",
    py: "$3",
    px: "$3",
    borderBottom: "1px solid $border",
  },
  "& tbody td": {
    py: "$3",
    px: "$3",
    borderBottom: "1px solid $border",
    color: "$textSecondary",
    verticalAlign: "middle",
  },
  "& tbody tr:last-child td": { borderBottom: 0 },
  "& tbody tr": { transition: "background-color $fast" },
  "& tbody tr:hover td": { backgroundColor: "rgba(148,163,184,0.05)" },
  variants: {
    /* Colunas numéricas alinham à direita com figuras tabulares — é o que
       permite comparar magnitude varrendo a coluna com o olho. */
    numerica: { true: {} },
  },
});

export const Td = styled("td", {
  variants: {
    alinhamento: {
      esquerda: { textAlign: "left" },
      direita: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
      centro: { textAlign: "center" },
    },
    enfase: {
      forte: { color: "$textPrimary !important", fontWeight: "$medium" },
      fraca: { color: "$textMuted !important" },
    },
    /* Documento, código, identificador: fonte mono com figuras tabulares,
       para 14 dígitos de CNPJ alinharem verticalmente entre linhas. */
    mono: { true: { fontFamily: "$mono", fontVariantNumeric: "tabular-nums", fontSize: "$sm" } },
  },
});

export const Th = styled("th", {
  variants: {
    alinhamento: {
      esquerda: { textAlign: "left" },
      direita: { textAlign: "right" },
      centro: { textAlign: "center" },
    },
    ordenavel: {
      true: {
        cursor: "pointer",
        userSelect: "none",
        "&:hover": { color: "$textSecondary" },
      },
    },
  },
});

/* ─── Diversos ─────────────────────────────────────────────────────────── */

export const Chip = styled("button", {
  display: "inline-flex",
  alignItems: "center",
  gap: "$2",
  px: "$3",
  height: 28,
  borderRadius: "$pill",
  border: "1px solid $border",
  backgroundColor: "transparent",
  color: "$textSecondary",
  fontSize: "$sm",
  fontWeight: "$medium",
  cursor: "pointer",
  transition: "all $fast",
  "&:hover": { borderColor: "$borderStrong", color: "$textPrimary" },
  variants: {
    ativo: {
      true: {
        backgroundColor: "$brandSubtle",
        borderColor: "$brandBorder",
        color: "#a3b3fc",
      },
    },
  },
});

/** Faixa fina de cor à esquerda de um card — usada nos insights para dar o
 *  tom (oportunidade/atenção/risco) sem pintar o card inteiro. */
export const Faixa = styled("div", {
  position: "absolute",
  left: 0,
  top: 0,
  bottom: 0,
  width: 3,
  zIndex: 2,
  variants: {
    tone: {
      oportunidade: { backgroundColor: "$good" },
      atencao: { backgroundColor: "$warning" },
      risco: { backgroundColor: "$critical" },
      neutro: { backgroundColor: "$slate600" },
    },
  },
  defaultVariants: { tone: "neutro" },
});

export const Pontinho = styled("span", {
  display: "inline-block",
  size: 8,
  borderRadius: "$pill",
  flexShrink: 0,
});
