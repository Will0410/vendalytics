/**
 * microvis.tsx — visualizações do tamanho de uma palavra.
 *
 * Sparkline, barra de percentil e selo de tendência. Todas existem pelo mesmo
 * motivo: um KPI isolado ("1.201.528 empresas") não informa nada até o leitor
 * saber se isso é muito, se está subindo, e como se compara com os pares. Abrir
 * um gráfico separado para cada uma dessas três perguntas quebraria a leitura;
 * elas cabem na própria linha do número.
 *
 * Sem eixo, sem grade, sem legenda: em 22 pixels de altura, cada um desses
 * elementos custa mais do que entrega. O valor exato vive no tooltip e na
 * tabela.
 */
import { styled } from "../stitches.config";
import type { PontoSerie, Tendencia } from "../domain/crescimento";
import { ROTULO_TENDENCIA, TOM_TENDENCIA } from "../domain/crescimento";
import { Badge, Row, Text } from "./primitives";

/* ─── Sparkline ────────────────────────────────────────────────────────── */

const CORES = {
  sobe: "#0ca30c",
  desce: "#d03b3b",
  plano: "#64748b",
} as const;

export function Sparkline({
  serie,
  largura = 68,
  altura = 22,
  titulo,
}: {
  serie: PontoSerie[] | undefined;
  largura?: number;
  altura?: number;
  titulo?: string;
}) {
  /* Menos de dois pontos não é uma tendência — é um ponto. Reservar o espaço
     mantém o alinhamento da coluna sem desenhar uma linha que mente. */
  if (!serie || serie.length < 2) {
    return <span style={{ display: "inline-block", width: largura, height: altura }} aria-hidden />;
  }

  const valores = serie.map((p) => p.valor);
  const min = Math.min(...valores);
  const max = Math.max(...valores);
  const amplitude = max - min;

  const pad = 2;
  const x = (i: number) => pad + (i / (serie.length - 1)) * (largura - pad * 2);
  /* Série constante desenha no meio, em vez de dividir por zero e sumir. */
  const y = (v: number) =>
    amplitude === 0
      ? altura / 2
      : altura - pad - ((v - min) / amplitude) * (altura - pad * 2);

  const pontos = serie.map((p, i) => `${x(i).toFixed(1)},${y(p.valor).toFixed(1)}`);
  const primeiro = valores[0] as number;
  const ultimo = valores[valores.length - 1] as number;
  const cor = ultimo > primeiro ? CORES.sobe : ultimo < primeiro ? CORES.desce : CORES.plano;

  const rotulo =
    titulo ??
    serie.map((p) => `${p.ano}: ${p.valor.toLocaleString("pt-BR")}`).join(" · ");

  return (
    <svg
      width={largura}
      height={altura}
      viewBox={`0 0 ${largura} ${altura}`}
      fill="none"
      role="img"
      aria-label={rotulo}
      style={{ display: "block", flexShrink: 0 }}
    >
      <title>{rotulo}</title>
      {/* Área sob a linha: dá peso visual sem competir com o número ao lado */}
      <polygon
        points={`${pad},${altura - pad} ${pontos.join(" ")} ${largura - pad},${altura - pad}`}
        fill={cor}
        opacity={0.14}
      />
      <polyline
        points={pontos.join(" ")}
        stroke={cor}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Só o último ponto é marcado — é o valor que o número ao lado mostra */}
      <circle cx={x(serie.length - 1)} cy={y(ultimo)} r={2.2} fill={cor} />
    </svg>
  );
}

/* ─── Selo de tendência ────────────────────────────────────────────────── */

export function SeloTendencia({
  tendencia,
  detalhe,
}: {
  tendencia: Tendencia;
  detalhe?: string;
}) {
  if (tendencia === "indefinida") return null;
  /* Seta + palavra: a direção nunca depende só da cor. */
  const seta =
    tendencia === "acelerando" || tendencia === "crescendo"
      ? "↑"
      : tendencia === "encolhendo"
        ? "↓"
        : "→";
  return (
    <Badge tone={TOM_TENDENCIA[tendencia]} title={detalhe}>
      {seta} {ROTULO_TENDENCIA[tendencia]}
    </Badge>
  );
}

/* ─── Âncora de percentil ──────────────────────────────────────────────── */

const Trilho = styled("div", {
  position: "relative",
  height: 3,
  borderRadius: "$pill",
  backgroundColor: "rgba(148,163,184,0.16)",
  width: "100%",
});

const Preenchido = styled("i", {
  display: "block",
  height: "100%",
  borderRadius: "$pill",
  backgroundImage: "linear-gradient(90deg, $colors$brand, $colors$accent)",
});

const Mediana = styled("span", {
  position: "absolute",
  top: -2,
  left: "50%",
  width: 1,
  height: 7,
  backgroundColor: "$slate600",
});

/**
 * "Onde esta praça está em relação às outras" — a informação que falta em todo
 * KPI absoluto. O traço no meio é a mediana do universo comparado: sem ele o
 * usuário não teria referência para saber se 60% é bom.
 */
export function Ancora({
  percentil,
  posicao,
  total,
  universo,
}: {
  /** 0–100. `null` some, em vez de mostrar uma barra vazia enganosa. */
  percentil: number | null;
  posicao?: number | null;
  total?: number | null;
  /** Contra quem está comparando — "265 municípios de SP". */
  universo: string;
}) {
  if (percentil == null) return null;

  return (
    <div>
      <Row justify="between" gap={2} css={{ marginBottom: 3 }}>
        <Text size="xs" tone="muted">
          {posicao != null && total != null
            ? `${posicao.toLocaleString("pt-BR")}ª de ${total.toLocaleString("pt-BR")}`
            : `Supera ${Math.round(percentil)}%`}
        </Text>
        <Text size="xs" tone="muted">
          {universo}
        </Text>
      </Row>
      <Trilho title={`Percentil ${Math.round(percentil)} — o traço marca a mediana`}>
        <Preenchido css={{ width: `${Math.max(2, Math.min(100, percentil))}%` }} />
        <Mediana />
      </Trilho>
    </div>
  );
}

/* ─── Trilha de navegação ──────────────────────────────────────────────── */

const Passo = styled("button", {
  border: 0,
  background: "transparent",
  padding: 0,
  font: "inherit",
  color: "$textMuted",
  cursor: "pointer",
  whiteSpace: "nowrap",
  "&:hover": { color: "$textPrimary", textDecoration: "underline" },
  variants: {
    atual: {
      true: {
        color: "$textPrimary",
        fontWeight: "$medium",
        cursor: "default",
        "&:hover": { textDecoration: "none" },
      },
    },
  },
});

export interface DegrauTrilha {
  rotulo: string;
  /** Ausente = degrau atual, não clicável. */
  aoIr?: () => void;
}

/** Brasil → UF → município. Torna explícito o nível de recorte em que o
 *  usuário está — sem isso, as telas parecem soltas em vez de encadeadas. */
export function Trilha({ degraus }: { degraus: DegrauTrilha[] }) {
  return (
    <Row gap={2} align="center" wrap aria-label="Nível de análise">
      {degraus.map((d, i) => (
        <Row key={`${d.rotulo}-${i}`} gap={2} align="center">
          {i > 0 && (
            <Text size="sm" tone="muted" aria-hidden>
              ›
            </Text>
          )}
          <Passo
            atual={!d.aoIr}
            onClick={d.aoIr}
            disabled={!d.aoIr}
            aria-current={!d.aoIr ? "page" : undefined}
          >
            <Text as="span" size="sm" tone={d.aoIr ? "muted" : "primary"}>
              {d.rotulo}
            </Text>
          </Passo>
        </Row>
      ))}
    </Row>
  );
}
