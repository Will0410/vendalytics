/**
 * cards.tsx — KPI e Insight, os dois cards que aparecem em todos os módulos.
 *
 * O KPI usa a textura do `AssetProvider` como fundo (`useBackdrop`). É aqui
 * que a camada de assets encosta na interface: o card não sabe se aquela
 * textura foi desenhada em SVG ou gerada pelo Nano Banana — pede pelo id e
 * recebe um `background-image`.
 */
import type { ReactNode } from "react";
import { styled } from "../stitches.config";
import { useBackdrop } from "../assets/AssetProvider";
import type { AssetId } from "../assets/catalog";
import type { Insight } from "../domain/insights";
import type { Metrica } from "../domain/territorio";
import type { PontoSerie, Tendencia } from "../domain/crescimento";
import { Ancora, SeloTendencia, Sparkline } from "./microvis";
import { Badge, Card, Faixa, Figura, Row, Skeleton, Stack, Text } from "./primitives";
import { Procedencia } from "./estados";

/* ─── KPI ──────────────────────────────────────────────────────────────── */

const CorpoKpi = styled(Card, {
  minHeight: 132,
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
});

export function CardKpi({
  rotulo,
  valor,
  metrica,
  sufixo,
  textura = "texture.contour",
  destaque,
  carregando,
  nota,
  serie,
  tendencia,
  detalheTendencia,
  percentil,
  posicao,
  totalUniverso,
  universo,
}: {
  rotulo: string;
  /** Já formatado. O card não formata — quem sabe a unidade é o módulo. */
  valor: string;
  /** Traz a procedência e a fonte para a etiqueta do rodapé. */
  metrica?: Metrica;
  sufixo?: ReactNode;
  textura?: AssetId;
  destaque?: boolean;
  carregando?: boolean;
  nota?: string;
  /** Série anual — vira sparkline ao lado do número. */
  serie?: PontoSerie[];
  tendencia?: Tendencia;
  detalheTendencia?: string;
  /** 0–100. Responde "isso é muito?", que o valor absoluto sozinho não responde. */
  percentil?: number | null;
  posicao?: number | null;
  totalUniverso?: number | null;
  /** Contra quem o percentil compara — "645 municípios de SP". */
  universo?: string;
}) {
  /* A textura só cobre o card com opacidade baixa: precisa ler como
     acabamento, não competir com o número. */
  const backdrop = useBackdrop(textura, { opacity: destaque ? 0.5 : 0.32, position: "right center" });

  if (carregando) {
    return (
      <CorpoKpi padding="md">
        <Stack gap={3}>
          <Skeleton forma="texto" css={{ width: "48%" }} />
          <Skeleton forma="figura" css={{ width: "66%" }} />
          <Skeleton forma="texto" css={{ width: "84%", height: 9 }} />
        </Stack>
      </CorpoKpi>
    );
  }

  return (
    <CorpoKpi padding="md" tone={destaque ? "brand" : "base"} css={backdrop}>
      <Stack gap={2}>
        <Text size="xs" overline>
          {rotulo}
        </Text>

        <Row gap={3} justify="between" align="end">
          <Row gap={2} align="baseline" wrap css={{ minWidth: 0 }}>
            <Figura size={destaque ? "xl" : "lg"} tone={destaque ? "accent" : "primary"}>
              {valor}
            </Figura>
            {sufixo}
          </Row>
          {/* A tendência fica colada no número: é a mesma informação vista no
              tempo, não um dado à parte. */}
          <Sparkline serie={serie} titulo={detalheTendencia} />
        </Row>

        {(nota || tendencia) && (
          <Row gap={2} align="center" wrap>
            {tendencia && <SeloTendencia tendencia={tendencia} detalhe={detalheTendencia} />}
            {nota && (
              <Text size="sm" tone="secondary">
                {nota}
              </Text>
            )}
          </Row>
        )}
      </Stack>

      <Stack gap={3} css={{ marginTop: "$3" }}>
        {percentil != null && universo && (
          <Ancora
            percentil={percentil}
            posicao={posicao ?? null}
            total={totalUniverso ?? null}
            universo={universo}
          />
        )}
        {metrica && (
          <Procedencia
            tipo={metrica.procedencia}
            fonte={metrica.ano ? `${metrica.fonte} · ${metrica.ano}` : metrica.fonte}
          />
        )}
      </Stack>
    </CorpoKpi>
  );
}

/* ─── Insight ──────────────────────────────────────────────────────────── */

const SEVERIDADE_BADGE = {
  oportunidade: { tone: "bom", rotulo: "Oportunidade" },
  atencao: { tone: "atencao", rotulo: "Atenção" },
  risco: { tone: "critico", rotulo: "Risco" },
  neutro: { tone: "neutro", rotulo: "Leitura" },
} as const;

const CONFIANCA_ROTULO = {
  alta: "Confiança alta",
  media: "Confiança média",
  baixa: "Amostra pequena",
} as const;

const CorpoInsight = styled(Card, {
  paddingLeft: "calc($5 + 3px)",
});

export function CardInsight({ insight }: { insight: Insight }) {
  const sev = SEVERIDADE_BADGE[insight.severidade];

  return (
    <CorpoInsight padding="md">
      <Faixa tone={insight.severidade} />
      <Stack gap={3}>
        <Row justify="between" align="start" gap={3} wrap>
          <Text size="lg" tone="primary" weight="semibold" css={{ lineHeight: "$snug" }}>
            {insight.titulo}
          </Text>
          <Row gap={2}>
            {/* Ícone + rótulo textual: a severidade nunca é só a cor. */}
            <Badge tone={sev.tone}>{sev.rotulo}</Badge>
            <Badge tone="neutro" title="Quanto o dado por trás desta leitura sustenta a conclusão">
              {CONFIANCA_ROTULO[insight.confianca]}
            </Badge>
          </Row>
        </Row>

        <Text size="base" css={{ lineHeight: "$relaxed" }}>
          {insight.texto}
        </Text>

        <Text size="xs" tone="muted" mono css={{ lineHeight: "$normal" }}>
          {insight.evidencia}
        </Text>
      </Stack>
    </CorpoInsight>
  );
}

/* ─── Seção ────────────────────────────────────────────────────────────── */

export function Secao({
  titulo,
  descricao,
  acoes,
  children,
}: {
  titulo: string;
  descricao?: string;
  acoes?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack gap={4} as="section">
      <Row justify="between" align="end" gap={4} wrap>
        <Stack gap={1} css={{ minWidth: 0 }}>
          <Text size="xs" overline>
            {titulo}
          </Text>
          {descricao && (
            <Text size="sm" tone="muted">
              {descricao}
            </Text>
          )}
        </Stack>
        {acoes}
      </Row>
      {children}
    </Stack>
  );
}
