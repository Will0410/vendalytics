/**
 * stitches.config.ts — Design System da Vendalytics.
 *
 * Fonte única de verdade visual: paleta corporativa (slate + navy #0f172a),
 * tipografia Inter, escala modular de espaçamento. Nenhum componente escreve
 * hex cru — tudo passa por token. Trocar a marca é trocar este arquivo.
 *
 * ── Paleta de séries de gráfico ─────────────────────────────────────────────
 * `series1..8` NÃO foram escolhidos por gosto. São validados contra a
 * superfície real dos cards (#0f172a) nos seis testes de acessibilidade de
 * dataviz — banda de luminosidade, piso de croma, separação para daltonismo
 * (protan/deutan/tritan), piso de visão normal e contraste. Resultado medido:
 *
 *   pior par adjacente CVD  ΔE 8.4 (protan, series4↔series3)   [alvo ≥ 8]
 *   pior par adjacente normal ΔE 19.3 (series5↔series4)        [piso ≥ 15]
 *   contraste vs #0f172a     todos ≥ 3:1
 *
 * Formas que comparam todos os pares entre si (scatter, bubble) usam no
 * máximo os 3 primeiros slots — só eles passam no teste all-pairs (pior CVD
 * ΔE 9.4). Acima de 3 séries em scatter: agregue em "Outros" ou facete.
 *
 * Reordenar ou re-tonalizar estes valores exige rodar o validador de novo. A
 * ordem é o mecanismo de segurança, não decoração.
 */
import { createStitches } from "@stitches/react";

export const {
  styled,
  css,
  globalCss,
  keyframes,
  getCssText,
  theme,
  createTheme,
  config,
} = createStitches({
  theme: {
    colors: {
      /* ── Superfícies (navy corporativo) ── */
      canvas: "#080d18", // plano da página, mais fundo que o card
      surface: "#0f172a", // superfície primária — o navy da marca
      surfaceRaised: "#141f38", // cards elevados, popovers
      surfaceSunken: "#0b1120", // trilhos, inputs, áreas recuadas
      surfaceHover: "#1b2842",
      sidebar: "#0a1120",

      /* ── Slate: hierarquia de texto e traço ── */
      slate50: "#f8fafc",
      slate200: "#e2e8f0",
      slate300: "#cbd5e1",
      slate400: "#94a3b8",
      slate500: "#64748b",
      slate600: "#475569",
      slate700: "#334155",
      slate800: "#1e293b",
      slate900: "#0f172a",

      textPrimary: "#f1f5f9",
      textSecondary: "#94a3b8",
      textMuted: "#64748b",
      textInverse: "#0f172a",

      /* ── Traço ── */
      border: "rgba(148,163,184,0.14)",
      borderStrong: "rgba(148,163,184,0.26)",
      borderFocus: "#4f6ef7",
      gridline: "rgba(148,163,184,0.10)",
      axis: "rgba(148,163,184,0.22)",

      /* ── Marca: índigo primário, ciano de apoio ── */
      brand: "#4f6ef7",
      brandHover: "#6480f9",
      brandActive: "#3f5be0",
      brandSubtle: "rgba(79,110,247,0.12)",
      brandBorder: "rgba(79,110,247,0.34)",
      accent: "#22d3ee",
      accentSubtle: "rgba(34,211,238,0.12)",

      /* ── Séries de gráfico (validadas — ver cabeçalho) ── */
      series1: "#3987e5", // azul
      series2: "#d95926", // laranja
      series3: "#199e70", // verde-água
      series4: "#c98500", // amarelo
      series5: "#d55181", // magenta
      series6: "#008300", // verde
      series7: "#9085e9", // violeta
      series8: "#e66767", // vermelho

      /* ── Rampa sequencial (azul, clara→escura) ──
         Para magnitude contínua: heatmap, choropleth, ranking.
         Em superfície escura não descer abaixo do passo 600. */
      seq100: "#cde2fb",
      seq250: "#86b6ef",
      seq400: "#3987e5",
      seq500: "#256abf",
      seq600: "#184f95",

      /* ── Status (reservados — nunca viram "série 9") ── */
      good: "#0ca30c",
      goodSubtle: "rgba(12,163,12,0.14)",
      warning: "#fab219",
      warningSubtle: "rgba(250,178,25,0.14)",
      serious: "#ec835a",
      seriousSubtle: "rgba(236,131,90,0.14)",
      critical: "#d03b3b",
      criticalSubtle: "rgba(208,59,59,0.14)",
      neutralSubtle: "rgba(148,163,184,0.12)",
    },

    /* Escala modular de espaçamento, base 4px */
    space: {
      1: "4px",
      2: "8px",
      3: "12px",
      4: "16px",
      5: "20px",
      6: "24px",
      7: "32px",
      8: "40px",
      9: "48px",
      10: "64px",
      11: "80px",
      12: "96px",
    },

    sizes: {
      sidebar: "252px",
      sidebarCollapsed: "72px",
      header: "68px",
      containerMax: "1560px",
    },

    fonts: {
      sans: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
      mono: "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
    },

    /* Escala tipográfica modular (~1.2) */
    fontSizes: {
      xs: "11px",
      sm: "12px",
      md: "13px",
      base: "14px",
      lg: "16px",
      xl: "19px",
      "2xl": "23px",
      "3xl": "28px",
      "4xl": "34px",
      "5xl": "44px",
    },

    fontWeights: {
      regular: "400",
      medium: "500",
      semibold: "600",
      bold: "700",
      extrabold: "800",
    },

    lineHeights: {
      tight: "1.15",
      snug: "1.3",
      normal: "1.5",
      relaxed: "1.65",
    },

    letterSpacings: {
      tighter: "-0.02em",
      tight: "-0.011em",
      normal: "0",
      wide: "0.04em",
      wider: "0.09em",
    },

    radii: {
      sm: "5px",
      md: "8px",
      lg: "12px",
      xl: "16px",
      "2xl": "22px",
      pill: "999px",
    },

    shadows: {
      sm: "0 1px 2px rgba(2,6,23,0.4)",
      md: "0 4px 14px -4px rgba(2,6,23,0.6)",
      lg: "0 18px 40px -14px rgba(2,6,23,0.75)",
      glow: "0 0 0 1px rgba(79,110,247,0.32), 0 12px 34px -12px rgba(79,110,247,0.4)",
      focus: "0 0 0 3px rgba(79,110,247,0.34)",
    },

    transitions: {
      fast: "120ms cubic-bezier(0.4,0,0.2,1)",
      base: "180ms cubic-bezier(0.4,0,0.2,1)",
      slow: "320ms cubic-bezier(0.16,1,0.3,1)",
    },

    zIndices: {
      base: "1",
      sticky: "50",
      dropdown: "100",
      overlay: "200",
      toast: "300",
    },
  },

  media: {
    sm: "(min-width: 640px)",
    md: "(min-width: 900px)",
    lg: "(min-width: 1200px)",
    xl: "(min-width: 1500px)",
    motion: "(prefers-reduced-motion: no-preference)",
    reduceMotion: "(prefers-reduced-motion: reduce)",
  },

  utils: {
    /* Atalhos direcionais — evitam repetir 4 propriedades em cada componente */
    px: (v: string | number) => ({ paddingLeft: v, paddingRight: v }),
    py: (v: string | number) => ({ paddingTop: v, paddingBottom: v }),
    mx: (v: string | number) => ({ marginLeft: v, marginRight: v }),
    my: (v: string | number) => ({ marginTop: v, marginBottom: v }),
    size: (v: string | number) => ({ width: v, height: v }),

    /* Truncamento em N linhas */
    lineClamp: (n: number) => ({
      display: "-webkit-box",
      WebkitLineClamp: n,
      WebkitBoxOrient: "vertical" as const,
      overflow: "hidden",
    }),
  },
});

/** Slots de série na ordem de atribuição. Índice fixo: a cor segue a
 *  entidade, nunca o rank — filtrar séries não pode repintar as que ficam. */
export const SERIES = [
  theme.colors.series1.value,
  theme.colors.series2.value,
  theme.colors.series3.value,
  theme.colors.series4.value,
  theme.colors.series5.value,
  theme.colors.series6.value,
  theme.colors.series7.value,
  theme.colors.series8.value,
] as const;

/** Rampa sequencial para magnitude contínua (clara→escura). */
export const SEQUENTIAL = [
  theme.colors.seq100.value,
  theme.colors.seq250.value,
  theme.colors.seq400.value,
  theme.colors.seq500.value,
  theme.colors.seq600.value,
] as const;

const spin = keyframes({
  to: { transform: "rotate(360deg)" },
});

const shimmer = keyframes({
  "0%": { backgroundPosition: "-420px 0" },
  "100%": { backgroundPosition: "420px 0" },
});

const fadeUp = keyframes({
  from: { opacity: 0, transform: "translateY(6px)" },
  to: { opacity: 1, transform: "none" },
});

export const animations = { spin, shimmer, fadeUp };

export const globalStyles = globalCss({
  "*, *::before, *::after": { boxSizing: "border-box" },

  "html, body, #root": { height: "100%" },

  body: {
    margin: 0,
    fontFamily: "$sans",
    fontSize: "$base",
    lineHeight: "$normal",
    color: "$textPrimary",
    backgroundColor: "$canvas",
    WebkitFontSmoothing: "antialiased",
    MozOsxFontSmoothing: "grayscale",
    textRendering: "optimizeLegibility",
  },

  "h1, h2, h3, h4, p, figure": { margin: 0 },
  "ul, ol": { margin: 0, padding: 0, listStyle: "none" },

  button: { fontFamily: "inherit", fontSize: "inherit" },
  "input, select, textarea": { fontFamily: "inherit", fontSize: "inherit" },

  a: { color: "inherit", textDecoration: "none" },

  /* Foco visível apenas por teclado — o anel nunca aparece no clique de mouse */
  ":focus-visible": {
    outline: "2px solid $colors$brand",
    outlineOffset: "2px",
    borderRadius: "$sm",
  },

  /* Barra de rolagem no tom da superfície */
  "::-webkit-scrollbar": { width: 10, height: 10 },
  "::-webkit-scrollbar-track": { background: "transparent" },
  "::-webkit-scrollbar-thumb": {
    background: "$slate700",
    borderRadius: "$pill",
    border: "2px solid $colors$canvas",
  },
  "::-webkit-scrollbar-thumb:hover": { background: "$slate600" },

  /* Respeita a preferência do sistema — sem exceção */
  "@media (prefers-reduced-motion: reduce)": {
    "*, *::before, *::after": {
      animationDuration: "0.01ms !important",
      animationIterationCount: "1 !important",
      transitionDuration: "0.01ms !important",
    },
  },
});
