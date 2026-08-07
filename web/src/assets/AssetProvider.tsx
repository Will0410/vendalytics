/**
 * AssetProvider.tsx — a costura entre "o componente quer um asset" e "alguém
 * produz esse asset".
 *
 * O componente escreve `<Asset id="icon.geomarketing" />` e pronto. Quem
 * desenha — SVG autoral, Nano Banana (Gemini), ou um CDN amanhã — é decidido
 * uma única vez na raiz da app. Trocar o provedor não toca em componente
 * nenhum; é essa a razão desta camada existir.
 *
 * O provedor pode ser assíncrono (o generativo é), então todo consumo passa
 * por um estado de carregamento explícito — nunca um salto de layout quando
 * a imagem chega.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getSpec, type AssetId, type AssetSpec } from "./catalog";
import { svgSource } from "./svgSource";
import { styled, animations } from "../stitches.config";

/* ─── Contrato ─────────────────────────────────────────────────────────── */

export type ResolvedAsset =
  | { kind: "node"; node: ReactNode }
  | { kind: "url"; url: string }
  | { kind: "missing"; reason: string };

export interface AssetSource {
  name: string;
  resolve(spec: AssetSpec): ResolvedAsset | Promise<ResolvedAsset>;
}

/**
 * Encadeia provedores: o primeiro que resolver ganha, e um erro/`missing` do
 * primário cai no seguinte. É o que garante que a interface NUNCA fica sem
 * asset — se a chave do Gemini expirar ou a rede cair, o SVG autoral assume
 * e o usuário não vê buraco.
 */
export function fallbackChain(...sources: AssetSource[]): AssetSource {
  return {
    name: sources.map((s) => s.name).join(" → "),
    async resolve(spec) {
      let ultimoMotivo = "nenhum provedor configurado";
      for (const source of sources) {
        try {
          const r = await source.resolve(spec);
          if (r.kind !== "missing") return r;
          ultimoMotivo = r.reason;
        } catch (e) {
          ultimoMotivo = e instanceof Error ? e.message : String(e);
        }
      }
      return { kind: "missing", reason: ultimoMotivo };
    },
  };
}

/* ─── Contexto ─────────────────────────────────────────────────────────── */

const AssetContext = createContext<AssetSource>(svgSource);

export function AssetProvider({
  source = svgSource,
  children,
}: {
  source?: AssetSource;
  children: ReactNode;
}) {
  return <AssetContext.Provider value={source}>{children}</AssetContext.Provider>;
}

/* ─── Hook ─────────────────────────────────────────────────────────────── */

type AssetState = { status: "pending" } | { status: "ready"; asset: ResolvedAsset };

/** Cache de módulo: um asset já resolvido nunca é pedido duas vezes, mesmo
 *  que 40 cards peçam a mesma textura. Chave = provedor + id, porque trocar
 *  de provedor precisa invalidar. */
const resolved = new Map<string, ResolvedAsset>();

export function useAsset(id: AssetId): AssetState {
  const source = useContext(AssetContext);
  const chave = `${source.name}::${id}`;

  const [state, setState] = useState<AssetState>(() => {
    const hit = resolved.get(chave);
    if (hit) return { status: "ready", asset: hit };
    /* Provedor síncrono (o SVG autoral) resolve já no primeiro render — sem
       flash de skeleton para o caso mais comum. */
    const r = source.resolve(getSpec(id));
    if (!(r instanceof Promise)) {
      resolved.set(chave, r);
      return { status: "ready", asset: r };
    }
    return { status: "pending" };
  });

  useEffect(() => {
    const hit = resolved.get(chave);
    if (hit) {
      setState({ status: "ready", asset: hit });
      return;
    }
    let vivo = true;
    Promise.resolve(source.resolve(getSpec(id)))
      .then((asset) => {
        resolved.set(chave, asset);
        if (vivo) setState({ status: "ready", asset });
      })
      .catch((e: unknown) => {
        const asset: ResolvedAsset = {
          kind: "missing",
          reason: e instanceof Error ? e.message : String(e),
        };
        if (vivo) setState({ status: "ready", asset });
      });
    return () => {
      vivo = false;
    };
  }, [chave, id, source]);

  return state;
}

/** URL de uma textura para uso em `background-image`. `null` enquanto carrega
 *  ou se o provedor não tem o asset — o chamador degrada para fundo liso, que
 *  já é um estado visual válido. */
export function useAssetUrl(id: AssetId): string | null {
  const state = useAsset(id);
  if (state.status !== "ready") return null;
  return state.asset.kind === "url" ? state.asset.url : null;
}

/* ─── Componente ───────────────────────────────────────────────────────── */

const Slot = styled("span", {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  lineHeight: 0,
  "& > svg, & > img": { display: "block", width: "100%", height: "100%" },
});

const SlotSkeleton = styled("span", {
  display: "inline-block",
  flexShrink: 0,
  borderRadius: "$sm",
  background:
    "linear-gradient(90deg, rgba(148,163,184,0.06) 0%, rgba(148,163,184,0.16) 50%, rgba(148,163,184,0.06) 100%)",
  backgroundSize: "420px 100%",
  "@motion": { animation: `${animations.shimmer} 1.5s linear infinite` },
});

export function Asset({
  id,
  size,
  className,
}: {
  id: AssetId;
  /** Lado em px. Omitido, usa o tamanho nativo declarado no catálogo. */
  size?: number;
  className?: string;
}) {
  const spec = getSpec(id);
  const state = useAsset(id);
  const w = size ?? spec.width;
  const h = size ? Math.round((spec.height / spec.width) * size) : spec.height;

  if (state.status === "pending") {
    return <SlotSkeleton css={{ width: w, height: h }} aria-hidden />;
  }

  const { asset } = state;

  if (asset.kind === "node") {
    return (
      <Slot
        className={className}
        css={{ width: w, height: h }}
        aria-hidden={spec.alt === "" ? true : undefined}
        role={spec.alt ? "img" : undefined}
        aria-label={spec.alt || undefined}
      >
        {asset.node}
      </Slot>
    );
  }

  if (asset.kind === "url") {
    return (
      <Slot className={className} css={{ width: w, height: h }}>
        <img src={asset.url} alt={spec.alt} width={w} height={h} loading="lazy" decoding="async" />
      </Slot>
    );
  }

  /* Asset ausente não pode virar erro de tela — some silenciosamente e
     reserva o espaço, para o layout não pular. */
  if (import.meta.env.DEV) {
    console.warn(`[asset] "${id}" indisponível: ${asset.reason}`);
  }
  return <Slot css={{ width: w, height: h }} aria-hidden />;
}

/** Hook usado pelos cards para aplicar textura de fundo via Stitches.
 *  Devolve o objeto `css` pronto — ou `{}` enquanto não há textura. */
export function useBackdrop(
  id: AssetId,
  opts: { opacity?: number; position?: string; size?: string } = {},
) {
  const url = useAssetUrl(id);
  const { opacity = 1, position = "right center", size = "cover" } = opts;
  return useMemo(() => {
    if (!url) return {};
    return {
      "&::before": {
        content: '""',
        position: "absolute" as const,
        inset: 0,
        backgroundImage: `url("${url}")`,
        backgroundRepeat: "no-repeat",
        backgroundPosition: position,
        backgroundSize: size,
        opacity,
        pointerEvents: "none" as const,
        borderRadius: "inherit",
      },
    };
  }, [url, opacity, position, size]);
}
