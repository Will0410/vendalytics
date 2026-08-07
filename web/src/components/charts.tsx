/**
 * charts.tsx — camada de visualização sobre o Recharts.
 *
 * Os módulos nunca montam um `<BarChart>` na mão. Passam dados e um rótulo,
 * e recebem um gráfico que já obedece às regras do sistema:
 *
 *   • **paleta validada** — as cores de série saem dos tokens `series1..8`,
 *     aprovados nos testes de contraste e de daltonismo contra a superfície
 *     #0f172a (ver o cabeçalho de stitches.config.ts);
 *   • **cor segue a entidade, não o rank** — filtrar séries não repinta as
 *     que sobraram;
 *   • **eixo único, sempre** — não existe gráfico de dois eixos Y aqui;
 *   • **grade e eixos recessivos**, marcas finas, ponta de dado arredondada
 *     em 4px ancorada na linha de base;
 *   • **tooltip por padrão** — um gráfico em HTML é interativo; ler valor
 *     exato passando o mouse é o mínimo;
 *   • **legenda a partir de 2 séries**; com uma série o título já a nomeia.
 */
import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
  Area,
  AreaChart,
} from "recharts";
import { styled, SERIES, theme } from "../stitches.config";
import { Card, Heading, Row, Stack, Text } from "./primitives";

const INK = {
  grade: "rgba(148,163,184,0.10)",
  eixo: "rgba(148,163,184,0.22)",
  rotulo: "#64748b",
  superficie: theme.colors.surface.value,
} as const;

const eixoBase = {
  stroke: INK.eixo,
  tick: { fill: INK.rotulo, fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: INK.eixo },
} as const;

/* ─── Moldura ──────────────────────────────────────────────────────────── */

export function MolduraGrafico({
  titulo,
  subtitulo,
  fonte,
  acoes,
  children,
  altura = 300,
}: {
  titulo: string;
  subtitulo?: string;
  /** Procedência do dado. Sempre visível — não é rodapé decorativo. */
  fonte?: string;
  acoes?: ReactNode;
  children: ReactNode;
  altura?: number;
}) {
  return (
    <Card padding="md">
      <Stack gap={4}>
        <Row justify="between" align="start" gap={4} wrap>
          <Stack gap={1} css={{ minWidth: 0 }}>
            <Heading size="sm">{titulo}</Heading>
            {subtitulo && (
              <Text size="sm" tone="muted">
                {subtitulo}
              </Text>
            )}
          </Stack>
          {acoes}
        </Row>

        <div style={{ width: "100%", height: altura }}>{children}</div>

        {fonte && (
          <Text size="xs" tone="muted">
            {fonte}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

/* ─── Tooltip ──────────────────────────────────────────────────────────── */

const CaixaTooltip = styled("div", {
  backgroundColor: "$surfaceRaised",
  border: "1px solid $borderStrong",
  borderRadius: "$md",
  boxShadow: "$lg",
  padding: "$3",
  minWidth: 150,
  maxWidth: 300,
});

interface ItemTooltip {
  name?: string | number;
  value?: number | string;
  color?: string;
  payload?: Record<string, unknown>;
}

function ConteudoTooltip({
  active,
  payload,
  label,
  formatar,
  rotuloDe,
}: {
  active?: boolean;
  payload?: ItemTooltip[];
  label?: string | number;
  formatar: (v: number) => string;
  rotuloDe?: (p: Record<string, unknown>) => ReactNode;
}) {
  if (!active || !payload?.length) return null;
  const primeiro = payload[0];

  return (
    <CaixaTooltip>
      <Stack gap={2}>
        <Text size="sm" tone="primary" weight="semibold">
          {primeiro?.payload?.rotuloCompleto != null
            ? String(primeiro.payload.rotuloCompleto)
            : String(label ?? "")}
        </Text>
        {payload.map((p, i) => (
          <Row key={i} gap={2} justify="between">
            <Row gap={2}>
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: p.color,
                  flexShrink: 0,
                }}
              />
              <Text size="sm" tone="secondary">
                {String(p.name ?? "")}
              </Text>
            </Row>
            <Text size="sm" tone="primary" weight="semibold" mono>
              {typeof p.value === "number" ? formatar(p.value) : String(p.value ?? "—")}
            </Text>
          </Row>
        ))}
        {rotuloDe && primeiro?.payload && (
          <Text size="xs" tone="muted">
            {rotuloDe(primeiro.payload)}
          </Text>
        )}
      </Stack>
    </CaixaTooltip>
  );
}

/* ─── Barras horizontais (ranking e composição) ────────────────────────── */

export interface PontoBarra {
  rotulo: string;
  valor: number;
  /** Nome completo para o tooltip, quando o rótulo do eixo é abreviado. */
  rotuloCompleto?: string;
  /** Índice de slot de série, quando cada barra é uma entidade distinta. */
  slot?: number;
  detalhe?: string;
}

/**
 * Ranking com uma série. Sem legenda de propósito — o título nomeia a série,
 * e uma legenda de item único é ruído.
 *
 * `destaque` pinta uma barra específica no acento da marca: é como a praça
 * selecionada aparece dentro do ranking do estado sem precisar de uma
 * segunda série.
 */
export function BarrasHorizontais({
  dados,
  formatar,
  cor = SERIES[0],
  destaque,
  larguraRotulo = 130,
  detalheTooltip,
}: {
  dados: PontoBarra[];
  formatar: (v: number) => string;
  cor?: string;
  destaque?: string;
  larguraRotulo?: number;
  detalheTooltip?: (p: Record<string, unknown>) => ReactNode;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={dados} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }}>
        {/* Só as linhas verticais: as horizontais duplicariam a informação que
            a própria barra já dá. */}
        <CartesianGrid horizontal={false} stroke={INK.grade} />
        <XAxis type="number" {...eixoBase} tickFormatter={(v: number) => formatar(v)} />
        <YAxis
          type="category"
          dataKey="rotulo"
          width={larguraRotulo}
          {...eixoBase}
          axisLine={false}
          tick={{ fill: "#94a3b8", fontSize: 11 }}
        />
        <Tooltip
          cursor={{ fill: "rgba(148,163,184,0.06)" }}
          content={
            <ConteudoTooltip formatar={formatar} rotuloDe={detalheTooltip} /> as unknown as never
          }
        />
        <Bar dataKey="valor" name="Empresas" radius={[0, 4, 4, 0]} maxBarSize={18} isAnimationActive={false}>
          {dados.map((d, i) => (
            <Cell
              key={i}
              fill={d.slot != null ? (SERIES[d.slot % SERIES.length] as string) : cor}
              /* Anel de 2px na cor da superfície separa barras adjacentes sem
                 inventar uma cor de borda. */
              stroke={destaque && d.rotulo === destaque ? theme.colors.accent.value : "none"}
              strokeWidth={destaque && d.rotulo === destaque ? 2 : 0}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ─── Barras verticais agrupadas ───────────────────────────────────────── */

export interface SerieBarra {
  chave: string;
  nome: string;
  /** Slot fixo da paleta. Fixo = a cor segue a entidade, não a posição. */
  slot: number;
}

export function BarrasVerticais({
  dados,
  series,
  formatar,
}: {
  dados: Record<string, string | number>[];
  series: SerieBarra[];
  formatar: (v: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={dados} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
        <CartesianGrid vertical={false} stroke={INK.grade} />
        <XAxis dataKey="rotulo" {...eixoBase} interval={0} />
        <YAxis {...eixoBase} tickFormatter={(v: number) => formatar(v)} />
        <Tooltip
          cursor={{ fill: "rgba(148,163,184,0.06)" }}
          content={<ConteudoTooltip formatar={formatar} /> as unknown as never}
        />
        {/* Legenda a partir de 2 séries; com 1 o título já nomeia. */}
        {series.length > 1 && (
          <Legend
            wrapperStyle={{ fontSize: 12, color: INK.rotulo, paddingTop: 8 }}
            iconType="circle"
            iconSize={8}
          />
        )}
        {series.map((s) => (
          <Bar
            key={s.chave}
            dataKey={s.chave}
            name={s.nome}
            fill={SERIES[s.slot % SERIES.length]}
            radius={[4, 4, 0, 0]}
            maxBarSize={30}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ─── Dispersão ────────────────────────────────────────────────────────── */

export interface PontoDispersao {
  x: number;
  y: number;
  z?: number;
  rotuloCompleto: string;
  destacado?: boolean;
}

/**
 * Dispersão com UMA série.
 *
 * Formas que comparam todos os pares entre si (dispersão, bolha) só passam
 * nos pisos de daltonismo com até 3 slots de cor. Aqui é uma série só, e a
 * distinção do ponto selecionado é feita por **anel + tamanho**, não por uma
 * segunda cor — sobra margem de acessibilidade.
 */
export function Dispersao({
  dados,
  nomeX,
  nomeY,
  formatarX,
  formatarY,
  linhaMediaX,
  linhaMediaY,
}: {
  dados: PontoDispersao[];
  nomeX: string;
  nomeY: string;
  formatarX: (v: number) => string;
  formatarY: (v: number) => string;
  linhaMediaX?: number;
  linhaMediaY?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ScatterChart margin={{ top: 12, right: 20, bottom: 20, left: 8 }}>
        <CartesianGrid stroke={INK.grade} />
        <XAxis
          type="number"
          dataKey="x"
          name={nomeX}
          {...eixoBase}
          tickFormatter={(v: number) => formatarX(v)}
          label={{
            value: nomeX,
            position: "insideBottom",
            offset: -12,
            fill: INK.rotulo,
            fontSize: 11,
          }}
        />
        <YAxis
          type="number"
          dataKey="y"
          name={nomeY}
          {...eixoBase}
          tickFormatter={(v: number) => formatarY(v)}
          label={{
            value: nomeY,
            angle: -90,
            position: "insideLeft",
            fill: INK.rotulo,
            fontSize: 11,
            style: { textAnchor: "middle" },
          }}
        />
        <ZAxis type="number" dataKey="z" range={[36, 320]} />

        {/* Medianas: dividem o plano nos 4 quadrantes de leitura. */}
        {linhaMediaX != null && (
          <ReferenceLine x={linhaMediaX} stroke={INK.eixo} strokeDasharray="4 4" />
        )}
        {linhaMediaY != null && (
          <ReferenceLine y={linhaMediaY} stroke={INK.eixo} strokeDasharray="4 4" />
        )}

        <Tooltip
          cursor={{ strokeDasharray: "3 3", stroke: INK.eixo }}
          content={
            (
              <ConteudoTooltip
                formatar={formatarY}
                rotuloDe={(p) =>
                  `${nomeX}: ${formatarX(Number(p.x))} · ${nomeY}: ${formatarY(Number(p.y))}`
                }
              />
            ) as unknown as never
          }
        />
        <Scatter data={dados} fill={SERIES[0]} isAnimationActive={false}>
          {dados.map((d, i) => (
            <Cell
              key={i}
              fill={d.destacado ? theme.colors.accent.value : SERIES[0]}
              fillOpacity={d.destacado ? 1 : 0.62}
              /* Anel de 2px na cor da superfície, para pontos sobrepostos não
                 virarem uma mancha só. */
              stroke={d.destacado ? theme.colors.accent.value : INK.superficie}
              strokeWidth={2}
            />
          ))}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  );
}

/* ─── Área acumulada (curva de cobertura) ──────────────────────────────── */

export function AreaAcumulada({
  dados,
  nomeX,
  formatarY,
  marcos = [],
}: {
  dados: { x: number; y: number; rotuloCompleto?: string }[];
  nomeX: string;
  formatarY: (v: number) => string;
  marcos?: { y: number; rotulo: string }[];
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={dados} margin={{ top: 8, right: 16, bottom: 20, left: 4 }}>
        <defs>
          <linearGradient id="va-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES[0]} stopOpacity={0.34} />
            <stop offset="100%" stopColor={SERIES[0]} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={INK.grade} />
        <XAxis
          dataKey="x"
          type="number"
          {...eixoBase}
          tickFormatter={(v: number) => v.toLocaleString("pt-BR")}
          label={{
            value: nomeX,
            position: "insideBottom",
            offset: -12,
            fill: INK.rotulo,
            fontSize: 11,
          }}
        />
        <YAxis
          {...eixoBase}
          domain={[0, 100]}
          tickFormatter={(v: number) => formatarY(v)}
        />
        {marcos.map((m) => (
          <ReferenceLine
            key={m.rotulo}
            y={m.y}
            stroke={INK.eixo}
            strokeDasharray="4 4"
            label={{ value: m.rotulo, fill: INK.rotulo, fontSize: 10, position: "insideTopRight" }}
          />
        ))}
        <Tooltip content={<ConteudoTooltip formatar={formatarY} /> as unknown as never} />
        <Area
          type="monotone"
          dataKey="y"
          name="Cobertura acumulada"
          stroke={SERIES[0]}
          strokeWidth={2}
          fill="url(#va-area)"
          isAnimationActive={false}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
