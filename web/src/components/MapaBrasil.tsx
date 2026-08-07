/**
 * MapaBrasil.tsx — a cola com o Leaflet.
 *
 * ── Por que Leaflet imperativo, e não react-leaflet ────────────────────────
 * São 5.570 marcadores com agrupamento, legenda de cor contínua e popup
 * customizado. O `react-leaflet` reconciliaria isso a cada render, e o
 * agrupamento (plugin imperativo por natureza) precisaria de um wrapper
 * adicional preso à versão certa dos dois. Aqui o mapa é criado uma vez, os
 * marcadores são reconstruídos só quando os dados mudam de verdade, e o React
 * cuida do resto da tela. Duas dependências em vez de quatro, e controle
 * total sobre o desenho.
 *
 * ── Escala de raio: área proporcional, não raio proporcional ──────────────
 * `raio ∝ √valor`. Se o raio fosse proporcional ao valor, um município com o
 * dobro de empresas apareceria com QUATRO vezes a área — o olho lê área, não
 * raio, e o mapa exageraria as capitais numa ordem de grandeza. Esse é o erro
 * clássico de mapa de bolhas.
 *
 * ── Escala de cor: divergente, com cinza no meio ──────────────────────────
 * O índice de saturação tem um ponto médio com significado (1,00 = mediana da
 * UF), então a codificação certa é divergente: um polo frio para "abaixo da
 * mediana", um quente para "acima", cinza neutro no centro.
 *
 * Deliberadamente NÃO é verde→amarelo→vermelho. Essa rampa põe uma cor
 * saturada (amarelo) no ponto que deveria ler como "nada acontecendo", e
 * verde↔vermelho é justamente o par que protanopia e deuteranopia confundem —
 * ~8% dos homens leriam oportunidade e saturação como a mesma coisa. Azul↔
 * vermelho separa nos três tipos de daltonismo. E a cor nunca carrega o
 * significado sozinha: o popup diz a classificação por extenso.
 */
import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import { styled } from "../stitches.config";

/* ─── Contrato ─────────────────────────────────────────────────────────── */

export interface PontoMapa {
  id: number;
  nome: string;
  uf: string;
  lat: number;
  lon: number;
  /** Valor que dimensiona a bolinha (nº de empresas do setor). */
  valor: number;
  /** Cor já resolvida pelo módulo. O mapa desenha, não interpreta — assim
   *  trocar a escala (saturação ↔ atratividade) não toca nesta camada. */
  cor: string;
  /** Linhas exibidas no popup, na ordem. */
  detalhes: { rotulo: string; valor: string }[];
  classificacao: string;
}

/* ─── Cor ──────────────────────────────────────────────────────────────── */

const FRIO = [57, 135, 229] as const; // #3987e5 — subexplorada
const NEUTRO = [100, 116, 139] as const; // slate 500 — na mediana
const QUENTE = [208, 59, 59] as const; // #d03b3b — saturada
const SEM_DADO = "#475569";

function misturar(a: readonly number[], b: readonly number[], t: number): string {
  const c = a.map((v, i) => Math.round(v + ((b[i] as number) - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Índice de saturação → cor divergente. A faixa 0,5–1,5 cobre a esmagadora
 *  maioria das praças; fora dela satura no polo, sem inventar tom novo. */
export function corDeSaturacao(indice: number | null): string {
  if (indice == null || !Number.isFinite(indice)) return SEM_DADO;
  if (indice <= 1) {
    const t = Math.min(1, Math.max(0, (indice - 0.5) / 0.5));
    return misturar(FRIO, NEUTRO, t);
  }
  const t = Math.min(1, Math.max(0, (indice - 1) / 0.5));
  return misturar(NEUTRO, QUENTE, t);
}

/**
 * Score de Atratividade (0–100) → cor.
 *
 * Aqui a escala é SEQUENCIAL, não divergente, e a diferença não é estética: o
 * score não tem ponto médio com significado — 50 não é "neutro", é só metade
 * do caminho. Usar divergente inventaria um eixo que o dado não tem.
 *
 * Um só matiz, do escuro (baixa) ao claro (alta), sobre o fundo escuro do
 * mapa: mais atrativo lê como mais luminoso, que é a direção intuitiva.
 */
const ATRAT_BAIXA = [24, 47, 92] as const; // azul quase apagado
const ATRAT_ALTA = [34, 211, 238] as const; // ciano da marca

export function corDeAtratividade(score: number | null): string {
  if (score == null || !Number.isFinite(score)) return SEM_DADO;
  return misturar(ATRAT_BAIXA, ATRAT_ALTA, Math.min(1, Math.max(0, score / 100)));
}

/* ─── Raio ─────────────────────────────────────────────────────────────── */

const RAIO_MIN = 3.5;
const RAIO_MAX = 26;

function raioDe(valor: number, maximo: number): number {
  if (!(maximo > 0) || !(valor > 0)) return RAIO_MIN;
  return RAIO_MIN + (RAIO_MAX - RAIO_MIN) * Math.sqrt(valor / maximo);
}

/* ─── Popup ────────────────────────────────────────────────────────────── */

/** Escapa antes de entrar no HTML do popup. Os nomes vêm da API do IBGE —
 *  é dado externo, e dado externo nunca entra em innerHTML sem passar aqui. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function htmlDoPopup(p: PontoMapa): string {
  const linhas = p.detalhes
    .map(
      (d) =>
        `<div class="va-linha"><span>${esc(d.rotulo)}</span><b>${esc(d.valor)}</b></div>`,
    )
    .join("");

  return `<div class="va-popup">
    <div class="va-cab">
      <span class="va-mun">${esc(p.nome)}</span><span class="va-uf">${esc(p.uf)}</span>
    </div>
    <div class="va-classe" style="color:${p.cor}">${esc(p.classificacao)}</div>
    <div class="va-linhas">${linhas}</div>
    <button class="va-btn" data-municipio="${p.id}">Abrir Relatório de Praça</button>
  </div>`;
}

/* ─── Estilo ───────────────────────────────────────────────────────────── */

const Moldura = styled("div", {
  position: "relative",
  width: "100%",
  height: "100%",
  borderRadius: "$xl",
  overflow: "hidden",
  border: "1px solid $border",
  backgroundColor: "$surfaceSunken",

  "& .leaflet-container": {
    width: "100%",
    height: "100%",
    background: "#0b1120",
    fontFamily: "$sans",
    outline: "none",
  },

  /* Os controles padrão do Leaflet são claros e destoam do tema. */
  "& .leaflet-bar a": {
    backgroundColor: "#141f38",
    color: "#f1f5f9",
    border: "1px solid rgba(148,163,184,0.2)",
    "&:hover": { backgroundColor: "#1b2842" },
  },
  "& .leaflet-control-attribution": {
    background: "rgba(11,17,32,0.82)",
    color: "#64748b",
    fontSize: 10,
    "& a": { color: "#94a3b8" },
  },

  /* ── Popup ── */
  "& .leaflet-popup-content-wrapper": {
    background: "#141f38",
    color: "#f1f5f9",
    border: "1px solid rgba(148,163,184,0.26)",
    borderRadius: 12,
    boxShadow: "0 18px 40px -14px rgba(2,6,23,0.75)",
  },
  "& .leaflet-popup-content": { margin: 0, width: "auto !important" },
  "& .leaflet-popup-tip": { background: "#141f38" },
  "& .leaflet-popup-close-button": { color: "#64748b !important", padding: "6px 8px 0 0 !important" },

  "& .va-popup": { padding: "14px 16px 16px", minWidth: 244 },
  "& .va-cab": { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 },
  "& .va-mun": { fontSize: 16, fontWeight: 700, letterSpacing: "-0.011em" },
  "& .va-uf": {
    fontSize: 11,
    fontWeight: 600,
    color: "#94a3b8",
    border: "1px solid rgba(148,163,184,0.24)",
    borderRadius: 5,
    padding: "1px 6px",
  },
  "& .va-classe": { fontSize: 12, fontWeight: 600, marginBottom: 12 },
  "& .va-linhas": { display: "flex", flexDirection: "column", gap: 7, marginBottom: 14 },
  "& .va-linha": {
    display: "flex",
    justifyContent: "space-between",
    gap: 16,
    fontSize: 12.5,
    color: "#94a3b8",
    "& b": { color: "#f1f5f9", fontWeight: 600, fontVariantNumeric: "tabular-nums" },
  },
  "& .va-btn": {
    width: "100%",
    height: 34,
    border: 0,
    borderRadius: 8,
    background: "#4f6ef7",
    color: "#fff",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "$sans",
    "&:hover": { background: "#6480f9" },
  },

  /* ── Agrupamentos ── */
  "& .va-cluster": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "999px",
    color: "#e8edf7",
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    border: "1.5px solid rgba(232,237,247,0.5)",
    boxShadow: "0 0 0 6px rgba(79,110,247,0.10)",
    background: "rgba(79,110,247,0.82)",
  },
});

/* ─── Componente ───────────────────────────────────────────────────────── */

/** Enquadramento inicial: o Brasil continental inteiro. */
const BRASIL: L.LatLngBoundsExpression = [
  [-34.2, -74.5],
  [5.6, -33.5],
];

/**
 * Enquadramento a partir dos PONTOS, não do país.
 *
 * Fixar o Brasil inteiro parecia razoável até um módulo desenhar só São Paulo:
 * o resultado era o estado inteiro espremido no meio da tela, com metade do
 * mapa ocupada pelo Atlântico e pela África. O enquadramento tem que seguir o
 * dado que está na tela.
 *
 * Sem pontos, volta para o Brasil — é o estado de carregamento, e mostrar o
 * país é melhor que mostrar o mundo.
 */
function limitesDe(pontos: PontoMapa[]): L.LatLngBoundsExpression {
  if (pontos.length === 0) return BRASIL;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of pontos) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  /* Um ponto só (ou todos no mesmo lugar) daria caixa de área zero, e o
     Leaflet responderia com o zoom máximo. A folga evita isso. */
  const folga = 0.4;
  return [
    [minLat - folga, minLon - folga],
    [maxLat + folga, maxLon + folga],
  ];
}

export function MapaBrasil({
  pontos,
  aoAbrirPraca,
  formatarValor,
  /** Espaço à direita ocupado por painel sobreposto, em px. */
  folgaDireita = 336,
  /** Espaço no topo ocupado pela faixa de KPIs, em px. */
  folgaTopo = 74,
}: {
  pontos: PontoMapa[];
  aoAbrirPraca: (municipioId: number) => void;
  formatarValor: (v: number) => string;
  folgaDireita?: number;
  folgaTopo?: number;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapaRef = useRef<L.Map | null>(null);
  const grupoRef = useRef<L.MarkerClusterGroup | null>(null);
  /** Assinatura do último enquadramento aplicado — evita reposicionar o mapa
   *  a cada mudança de métrica, que jogaria fora o zoom do usuário. */
  const enquadradoRef = useRef<string>("");

  /* O callback muda de identidade a cada render; guardá-lo numa ref evita
     recriar 5.570 marcadores só porque o pai renderizou. */
  const abrirRef = useRef(aoAbrirPraca);
  abrirRef.current = aoAbrirPraca;
  const formatarRef = useRef(formatarValor);
  formatarRef.current = formatarValor;

  const maximo = useMemo(() => pontos.reduce((m, p) => Math.max(m, p.valor), 0), [pontos]);

  /* ── Cria o mapa uma vez ── */
  useEffect(() => {
    if (!elRef.current || mapaRef.current) return;

    const mapa = L.map(elRef.current, {
      /* Desligado aqui e recriado embaixo à esquerda: no canto padrão
         (superior esquerdo) os botões ficam por cima da faixa de KPIs. */
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true, // canvas em vez de SVG: 5.570 círculos em DOM travam o pan
      minZoom: 3,
      maxZoom: 14,
      worldCopyJump: false,
    });
    L.control.zoom({ position: "bottomleft" }).addTo(mapa);

    /* View inicial OBRIGATÓRIA. Sem centro e zoom válidos o Leaflet não sabe
       quais tiles pedir e o container fica em branco — foi exatamente o que
       aconteceu quando este `fitBounds` foi removido em favor do
       enquadramento por dados: os dados só chegam no efeito seguinte, e até
       lá o mapa não existia de fato. O reenquadramento pelos pontos acontece
       depois, por cima deste. */
    mapa.fitBounds(BRASIL);
    /* A assinatura de enquadramento descreve ESTE mapa. Zerá-la aqui é o que
       impede o bug do StrictMode: o efeito monta duas vezes, a 1ª montagem
       enquadra e guarda a assinatura, a limpeza destrói o mapa, e a 2ª criaria
       um mapa novo que a guarda "já enquadrei isso" deixaria parado no Brasil.
       A ref não pode sobreviver ao mapa que ela descreve. */
    enquadradoRef.current = "";


    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · limites e dados: IBGE',
      subdomains: "abcd",
      maxZoom: 20,
    }).addTo(mapa);

    /* Delegação: o popup é recriado pelo Leaflet a cada abertura, então o
       listener vive no container e não no botão. */
    const aoClicar = (e: Event) => {
      const alvo = (e.target as HTMLElement)?.closest?.("[data-municipio]");
      if (!alvo) return;
      const id = Number(alvo.getAttribute("data-municipio"));
      if (Number.isFinite(id)) abrirRef.current(id);
    };
    mapa.getContainer().addEventListener("click", aoClicar);

    mapaRef.current = mapa;

    return () => {
      mapa.getContainer().removeEventListener("click", aoClicar);
      mapa.remove();
      mapaRef.current = null;
      grupoRef.current = null;
      enquadradoRef.current = "";
    };
  }, []);

  /* ── Redesenha os marcadores quando os dados mudam ── */
  useEffect(() => {
    const mapa = mapaRef.current;
    if (!mapa) return;

    if (grupoRef.current) {
      mapa.removeLayer(grupoRef.current);
      grupoRef.current = null;
    }
    if (pontos.length === 0) return;

    const grupo = L.markerClusterGroup({
      chunkedLoading: true, // fatia a inserção: a aba não congela com 5.570 pontos
      maxClusterRadius: 46,
      spiderfyOnMaxZoom: false,
      disableClusteringAtZoom: 9,
      showCoverageOnHover: false,
      iconCreateFunction: (cluster) => {
        const n = cluster.getChildCount();
        const lado = n < 100 ? 34 : n < 1000 ? 42 : 50;
        const fonte = n < 100 ? 12 : n < 1000 ? 12.5 : 13;
        return L.divIcon({
          html: `<div class="va-cluster" style="width:${lado}px;height:${lado}px;font-size:${fonte}px">${
            n >= 1000 ? `${(n / 1000).toFixed(1).replace(".", ",")}k` : n
          }</div>`,
          className: "",
          iconSize: L.point(lado, lado),
        });
      },
    });

    for (const p of pontos) {
      const marcador = L.circleMarker([p.lat, p.lon], {
        radius: raioDe(p.valor, maximo),
        fillColor: p.cor,
        fillOpacity: 0.68,
        /* Anel na cor do fundo: bolinhas sobrepostas continuam contáveis em
           vez de virarem uma mancha só. */
        color: "#0b1120",
        weight: 1,
        opacity: 0.9,
      });

      marcador.bindPopup(htmlDoPopup(p), { closeButton: true, autoPan: true, maxWidth: 320 });
      marcador.bindTooltip(`${p.nome}/${p.uf} · ${formatarRef.current(p.valor)}`, {
        direction: "top",
        offset: L.point(0, -4),
        opacity: 0.94,
      });
      /* O tooltip é a prévia; o popup é o detalhe. Deixar os dois abertos ao
         mesmo tempo empilha duas caixas escuras uma sobre a outra. */
      marcador.on("popupopen", () => marcador.closeTooltip());
      grupo.addLayer(marcador);
    }

    grupo.addTo(mapa);
    grupoRef.current = grupo;

    /* Reenquadra só quando a REGIÃO coberta muda — trocar a métrica que
       dimensiona a bolinha não deve mexer no zoom que o usuário ajustou. */
    const assinatura = JSON.stringify(limitesDe(pontos));
    if (assinatura !== enquadradoRef.current) {
      enquadradoRef.current = assinatura;
      mapa.fitBounds(limitesDe(pontos), {
        paddingTopLeft: L.point(16, folgaTopo),
        paddingBottomRight: L.point(folgaDireita, 24),
      });
    }
  }, [pontos, maximo, folgaTopo, folgaDireita]);

  return <Moldura ref={elRef} />;
}
