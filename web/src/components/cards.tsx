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
        <Row gap={2} align="baseline" wrap>
          <Figura size={destaque ? "xl" : "lg"} tone={destaque ? "accent" : "primary"}>
            {valor}
          </Figura>
          {sufixo}
        </Row>
        {nota && (
          <Text size="sm" tone="secondary">
            {nota}
          </Text>
        )}
      </Stack>

      {metrica && (
        <div style={{ marginTop: 12 }}>
          <Procedencia
            tipo={metrica.procedencia}
            fonte={metrica.ano ? `${metrica.fonte} · ${metrica.ano}` : metrica.fonte}
          />
        </div>
      )}
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
