/**
 * svgSource.tsx — provedor de assets AUTORAL, em SVG vetorial.
 *
 * É o provedor padrão do produto. Vantagens que motivaram a escolha:
 * nítido em qualquer densidade de tela, ~0kb de rede, funciona offline, sem
 * chave de API, determinístico (o mesmo asset em todo build) e os ícones
 * herdam a cor do contexto via `currentColor` — coisa que um PNG gerado não
 * faz.
 *
 * Ícones, logo e ilustrações saem como nós React (vetor de verdade, colorável).
 * Texturas saem como data-URI, porque são consumidas em `background-image`
 * pelo Stitches.
 */
import type { ReactNode } from "react";
import type { AssetId, AssetSpec } from "./catalog";
import type { AssetSource, ResolvedAsset } from "./AssetProvider";

/* ─── Utilidades ───────────────────────────────────────────────────────── */

/** SVG → data-URI. `encodeURIComponent` em vez de base64: o payload fica
 *  menor e continua legível no DevTools. */
function dataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s{2,}/g, " ").trim())}`;
}

/** LCG determinístico — a mesma semente sempre desenha a mesma textura, então
 *  o visual não "pisca" entre renders nem entre builds. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/* ─── Marca ────────────────────────────────────────────────────────────── */

function LogoMark(): ReactNode {
  return (
    <svg viewBox="0 0 32 32" fill="none" width="100%" height="100%" role="presentation">
      <defs>
        <linearGradient id="va-logo-g" x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#22d3ee" />
          <stop offset="1" stopColor="#4f6ef7" />
        </linearGradient>
      </defs>
      {/* Hexágono: a "praça"/território que a plataforma indexa */}
      <path
        d="M16 1.7 28.4 8.85v14.3L16 30.3 3.6 23.15V8.85L16 1.7Z"
        stroke="url(#va-logo-g)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      {/* Barras de dados ascendentes = a seta de crescimento */}
      <rect x="10" y="18.5" width="2.6" height="5.5" rx="1.1" fill="url(#va-logo-g)" opacity="0.55" />
      <rect x="14.7" y="14.5" width="2.6" height="9.5" rx="1.1" fill="url(#va-logo-g)" opacity="0.8" />
      <rect x="19.4" y="9.6" width="2.6" height="14.4" rx="1.1" fill="url(#va-logo-g)" />
    </svg>
  );
}

/* ─── Ícones do menu (traço 1.5, grade 24) ─────────────────────────────── */

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  width: "100%",
  height: "100%",
  role: "presentation" as const,
};

function IconVendas(): ReactNode {
  return (
    <svg {...iconProps}>
      <path d="M3 20.5h18" />
      <path d="M6 20.5v-5.2M10.5 20.5v-8.4M15 20.5v-4.1M19.5 20.5v-10" />
      <path d="M5 10.8 10 7l4 3.2 5.4-6.3" opacity="0.55" />
      <circle cx="19.4" cy="3.9" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconGeomarketing(): ReactNode {
  return (
    <svg {...iconProps}>
      {/* Anéis de raio de atuação */}
      <ellipse cx="12" cy="18.6" rx="7.6" ry="2.7" opacity="0.35" />
      <ellipse cx="12" cy="18.6" rx="3.6" ry="1.3" opacity="0.6" />
      {/* Pino de praça */}
      <path d="M12 16.4c0 0-5-5.1-5-8.6a5 5 0 0 1 10 0c0 3.5-5 8.6-5 8.6Z" />
      <circle cx="12" cy="7.7" r="1.9" />
    </svg>
  );
}

function IconCopiloto(): ReactNode {
  return (
    <svg {...iconProps}>
      <path d="M20.4 13.6c0 3.5-3.6 6.3-8 6.3a9.7 9.7 0 0 1-2.6-.35L4.8 21l1.2-3.3A5.9 5.9 0 0 1 4.4 13.6c0-3.5 3.6-6.3 8-6.3s8 2.8 8 6.3Z" />
      <path d="m17.6 2.2.75 1.85 1.85.75-1.85.75-.75 1.85-.75-1.85L15 4.8l1.85-.75.75-1.85Z" fill="currentColor" stroke="none" />
      <circle cx="9.2" cy="13.6" r="1" fill="currentColor" stroke="none" opacity="0.6" />
      <circle cx="12.4" cy="13.6" r="1" fill="currentColor" stroke="none" opacity="0.8" />
      <circle cx="15.6" cy="13.6" r="1" fill="currentColor" stroke="none" opacity="0.6" />
    </svg>
  );
}

function IconMapa(): ReactNode {
  return (
    <svg {...iconProps}>
      {/* Mapa dobrado em três painéis */}
      <path d="M9 3.4 3 5.6v15l6-2.2 6 2.2 6-2.2v-15L15 5.6 9 3.4Z" />
      <path d="M9 3.4v15M15 5.6v15" opacity="0.45" />
      {/* Bolinhas de tamanhos diferentes — a metáfora do próprio módulo */}
      <circle cx="6.1" cy="10.4" r="1" fill="currentColor" stroke="none" opacity="0.65" />
      <circle cx="12" cy="9.2" r="2" fill="currentColor" stroke="none" />
      <circle cx="18" cy="13.4" r="1.4" fill="currentColor" stroke="none" opacity="0.8" />
      <circle cx="11.4" cy="15.4" r="0.85" fill="currentColor" stroke="none" opacity="0.5" />
    </svg>
  );
}

function IconTerritorio(): ReactNode {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      {/* As divisas do território */}
      <path d="M12 3v9l7.8 4.5M12 12 4.2 16.5" opacity="0.7" />
      {/* Uma sede por zona */}
      <circle cx="14.6" cy="7.6" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="16.2" cy="15" r="1.2" fill="currentColor" stroke="none" opacity="0.75" />
      <circle cx="7.8" cy="13.6" r="1.2" fill="currentColor" stroke="none" opacity="0.75" />
    </svg>
  );
}

/**
 * A lacuna, desenhada: três barras que existem e uma quarta que deveria
 * existir. O tracejado é a única forma honesta de representar ausência —
 * uma barra cheia num tom mais claro pareceria um dado a menos, não um
 * dado que falta.
 */
function IconVazios(): ReactNode {
  return (
    <svg {...iconProps}>
      <path d="M3 20h18" opacity="0.7" />
      <path d="M5.5 20v-5.5M10 20v-8.5M19 20v-6.5" />
      {/* O que deveria haver e não há. */}
      <path d="M14.5 20V6" strokeDasharray="2.4 2.2" />
      <path d="M12.6 8.2 14.5 6l1.9 2.2" opacity="0.75" />
    </svg>
  );
}

function IconPraca(): ReactNode {
  return (
    <svg {...iconProps}>
      <path d="M13.5 2.8H6.4A1.9 1.9 0 0 0 4.5 4.7v14.6a1.9 1.9 0 0 0 1.9 1.9h7.3" />
      <path d="M13.5 2.8 19.5 8.6v3.1" />
      <path d="M13.5 2.8v4.4a1.4 1.4 0 0 0 1.4 1.4h4.6" opacity="0.5" />
      <path d="M7.7 17.3v-2.6M10.4 17.3v-4.8" opacity="0.65" />
      {/* Lupa da análise */}
      <circle cx="16.6" cy="16.3" r="3.4" />
      <path d="m19.2 18.9 2.1 2.1" />
    </svg>
  );
}

function IconProspeccao(): ReactNode {
  return (
    <svg {...iconProps}>
      {/* Funil */}
      <path d="M3.4 4.6h17.2l-6.6 7.9v7.3l-4-2.3v-5L3.4 4.6Z" />
      {/* Contas entrando no topo */}
      <circle cx="7.6" cy="2.2" r="1.1" fill="currentColor" stroke="none" opacity="0.5" />
      <circle cx="12" cy="2.2" r="1.1" fill="currentColor" stroke="none" opacity="0.75" />
      <circle cx="16.4" cy="2.2" r="1.1" fill="currentColor" stroke="none" opacity="0.5" />
    </svg>
  );
}

function IconUsuarios(): ReactNode {
  return (
    <svg {...iconProps}>
      {/* Pessoa da frente */}
      <circle cx="9.2" cy="7.6" r="3.5" />
      <path d="M2.8 20.2a6.4 6.4 0 0 1 12.8 0" />
      {/* Pessoa de trás */}
      <path d="M15.6 4.5a3.5 3.5 0 0 1 0 6.2" opacity="0.55" />
      {/* Escudo de acesso */}
      <path d="M18.4 13.4l3.3 1.2v2.6c0 1.9-1.4 3.4-3.3 4-1.9-.6-3.3-2.1-3.3-4v-2.6l3.3-1.2Z" />
    </svg>
  );
}

function IconEnriquecimento(): ReactNode {
  return (
    <svg {...iconProps}>
      {/* Base de dados */}
      <ellipse cx="10.4" cy="5.6" rx="6.4" ry="2.6" />
      <path d="M4 5.6v9.3c0 1.4 2.9 2.6 6.4 2.6s6.4-1.2 6.4-2.6v-4.3" />
      <path d="M4 10.3c0 1.4 2.9 2.6 6.4 2.6 1.5 0 2.9-.2 4-.6" opacity="0.55" />
      {/* Faíscas do enriquecimento */}
      <path d="m18.9 3.2.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z" fill="currentColor" stroke="none" />
      <path d="m20.4 13.4.55 1.3 1.3.55-1.3.55-.55 1.3-.55-1.3-1.3-.55 1.3-.55.55-1.3Z" fill="currentColor" stroke="none" opacity="0.6" />
    </svg>
  );
}

/* ─── Ilustrações ──────────────────────────────────────────────────────── */

function IllustrationInsight(): ReactNode {
  const beams = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    const r0 = 34 + (i % 3) * 8;
    const r1 = 66 + (i % 4) * 6;
    return {
      x1: 80 + Math.cos(a) * r0,
      y1: 80 + Math.sin(a) * r0,
      x2: 80 + Math.cos(a) * r1,
      y2: 80 + Math.sin(a) * r1,
      o: 0.18 + (i % 4) * 0.12,
    };
  });
  return (
    <svg viewBox="0 0 160 160" fill="none" width="100%" height="100%" role="presentation">
      <defs>
        <radialGradient id="va-ins-core" cx="0.5" cy="0.5" r="0.5">
          <stop stopColor="#22d3ee" stopOpacity="0.85" />
          <stop offset="0.55" stopColor="#4f6ef7" stopOpacity="0.35" />
          <stop offset="1" stopColor="#4f6ef7" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="80" cy="80" r="52" fill="url(#va-ins-core)" />
      {beams.map((b, i) => (
        <line
          key={i}
          x1={b.x1}
          y1={b.y1}
          x2={b.x2}
          y2={b.y2}
          stroke="#22d3ee"
          strokeWidth="1.2"
          strokeLinecap="round"
          opacity={b.o}
        />
      ))}
      <circle cx="80" cy="80" r="26" stroke="#4f6ef7" strokeWidth="1.2" opacity="0.5" />
      <circle cx="80" cy="80" r="15" stroke="#22d3ee" strokeWidth="1.4" opacity="0.8" />
      <circle cx="80" cy="80" r="5.5" fill="#22d3ee" />
    </svg>
  );
}

function IllustrationEmpty(): ReactNode {
  const r = rng(7);
  const dots = Array.from({ length: 16 }, () => ({
    x: 28 + r() * 140,
    y: 24 + r() * 84,
    o: 0.1 + r() * 0.22,
  }));
  return (
    <svg viewBox="0 0 200 140" fill="none" width="100%" height="100%" role="presentation">
      <path d="M24 12v104h158" stroke="#94a3b8" strokeWidth="1.3" opacity="0.35" strokeLinecap="round" />
      {[38, 62, 86, 110].map((y) => (
        <line key={y} x1="24" y1={y} x2="182" y2={y} stroke="#94a3b8" strokeWidth="1" opacity="0.1" />
      ))}
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r="3" fill="#94a3b8" opacity={d.o} />
      ))}
      <circle cx="132" cy="60" r="20" stroke="#4f6ef7" strokeWidth="1.6" opacity="0.65" />
      <path d="m147 75 12 12" stroke="#4f6ef7" strokeWidth="1.6" strokeLinecap="round" opacity="0.65" />
    </svg>
  );
}

/* ─── Texturas (data-URI, consumidas em background-image) ──────────────── */

/** Curvas de nível topográficas — a metáfora de território do produto. */
function textureContour(): string {
  const r = rng(42);
  const rings: string[] = [];
  for (let k = 0; k < 9; k++) {
    const rad = 26 + k * 22;
    const pts: string[] = [];
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const wob = 1 + Math.sin(a * 3 + k) * 0.09 + Math.sin(a * 5 + k * 2) * 0.05;
      pts.push(`${(392 + Math.cos(a) * rad * wob * 1.25).toFixed(1)},${(100 + Math.sin(a) * rad * wob).toFixed(1)}`);
    }
    rings.push(
      `<polyline points="${pts.join(" ")}" fill="none" stroke="#4f6ef7" stroke-width="1" opacity="${(
        0.3 -
        k * 0.028
      ).toFixed(3)}"/>`,
    );
    void r;
  }
  return dataUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 200" width="480" height="200">
    <defs><linearGradient id="f" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#0f172a" stop-opacity="1"/>
      <stop offset="0.62" stop-color="#0f172a" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#0f172a" stop-opacity="0"/>
    </linearGradient>
    <mask id="m"><rect width="480" height="200" fill="url(#f)"/></mask></defs>
    <g mask="url(#m)" transform="scale(-1,1) translate(-480,0)">${rings.join("")}</g>
  </svg>`);
}

/** Malha de grafo — a metáfora de rede de contas/relacionamento. */
function textureMesh(): string {
  const r = rng(1337);
  const nodes = Array.from({ length: 22 }, () => ({ x: r() * 480, y: r() * 200 }));
  const edges: string[] = [];
  nodes.forEach((a, i) => {
    nodes.slice(i + 1).forEach((b) => {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < 92) {
        edges.push(
          `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(
            1,
          )}" stroke="#22d3ee" stroke-width="0.8" opacity="${(0.24 * (1 - d / 92)).toFixed(3)}"/>`,
        );
      }
    });
  });
  const dots = nodes
    .map((n) => `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="1.8" fill="#22d3ee" opacity="0.34"/>`)
    .join("");
  return dataUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 200" width="480" height="200">
    <defs><radialGradient id="g" cx="0.82" cy="0.16" r="0.7">
      <stop offset="0" stop-color="#4f6ef7" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#4f6ef7" stop-opacity="0"/>
    </radialGradient></defs>
    <rect width="480" height="200" fill="url(#g)"/>
    ${edges.join("")}${dots}
  </svg>`);
}

/** Grade técnica em perspectiva — a metáfora de plano cartesiano/dado. */
function textureGrid(): string {
  const v = Array.from({ length: 17 }, (_, i) => {
    const x = i * 30;
    return `<line x1="${x}" y1="0" x2="${x}" y2="200" stroke="#94a3b8" stroke-width="0.7"/>`;
  }).join("");
  const h = Array.from({ length: 8 }, (_, i) => {
    const y = i * 28;
    return `<line x1="0" y1="${y}" x2="480" y2="${y}" stroke="#94a3b8" stroke-width="0.7"/>`;
  }).join("");
  return dataUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 200" width="480" height="200">
    <defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <mask id="m"><rect width="480" height="200" fill="url(#f)"/></mask></defs>
    <g mask="url(#m)">${v}${h}</g>
  </svg>`);
}

/* ─── O provedor ───────────────────────────────────────────────────────── */

const NODES: Partial<Record<AssetId, () => ReactNode>> = {
  "logo.mark": LogoMark,
  "icon.vendas": IconVendas,
  "icon.geomarketing": IconGeomarketing,
  "icon.copiloto": IconCopiloto,
  "icon.mapa": IconMapa,
  "icon.territorio": IconTerritorio,
  "icon.vazios": IconVazios,
  "icon.praca": IconPraca,
  "icon.prospeccao": IconProspeccao,
  "icon.usuarios": IconUsuarios,
  "icon.enriquecimento": IconEnriquecimento,
  "illustration.insight": IllustrationInsight,
  "illustration.empty": IllustrationEmpty,
};

/** Texturas são geradas uma vez por sessão — o data-URI é estável, então
 *  memoizar evita recriar a string a cada render de card. */
const TEXTURE_CACHE = new Map<AssetId, string>();
const TEXTURE_FACTORIES: Partial<Record<AssetId, () => string>> = {
  "texture.contour": textureContour,
  "texture.mesh": textureMesh,
  "texture.grid": textureGrid,
};

export const svgSource: AssetSource = {
  name: "svg-autoral",
  /** Síncrono por construção: nada aqui vai à rede, então não existe estado
   *  de carregamento para o consumidor tratar. */
  resolve(spec: AssetSpec): ResolvedAsset {
    const id = spec.id as AssetId;

    const node = NODES[id];
    if (node) return { kind: "node", node: node() };

    const factory = TEXTURE_FACTORIES[id];
    if (factory) {
      let uri = TEXTURE_CACHE.get(id);
      if (!uri) {
        uri = factory();
        TEXTURE_CACHE.set(id, uri);
      }
      return { kind: "url", url: uri };
    }

    return { kind: "missing", reason: `sem desenho SVG para "${spec.id}"` };
  },
};
