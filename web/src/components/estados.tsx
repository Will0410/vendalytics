/**
 * estados.tsx — os três estados que toda tela que fala com a rede precisa
 * ter: carregando, vazio e erro.
 *
 * Ficam num arquivo só porque a consistência aqui importa mais que a
 * proximidade: um erro que aparece diferente em cada módulo faz o usuário
 * achar que quebrou de um jeito novo cada vez.
 *
 * O skeleton reproduz a FORMA do conteúdo que vai chegar (um card de KPI, uma
 * linha de tabela), não um retângulo genérico. É o que evita o salto de
 * layout quando o dado chega.
 */
import type { ReactNode } from "react";
import { styled } from "../stitches.config";
import { ApiError } from "../lib/http";
import { Asset } from "../assets/AssetProvider";
import { Button, Card, Grid, Heading, Row, Skeleton, Stack, Text } from "./primitives";

/* ─── Carregando ───────────────────────────────────────────────────────── */

export function SkeletonKpis({ quantidade = 4 }: { quantidade?: number }) {
  return (
    <Grid cols="auto">
      {Array.from({ length: quantidade }, (_, i) => (
        <Card key={i} padding="md">
          <Stack gap={3}>
            <Skeleton forma="texto" css={{ width: "44%" }} />
            <Skeleton forma="figura" css={{ width: "62%" }} />
            <Skeleton forma="texto" css={{ width: "80%", height: 9 }} />
          </Stack>
        </Card>
      ))}
    </Grid>
  );
}

export function SkeletonGrafico({ altura = 300 }: { altura?: number }) {
  return (
    <Stack gap={4}>
      <Skeleton forma="titulo" css={{ width: 200 }} />
      <Skeleton forma="bloco" css={{ height: altura }} />
    </Stack>
  );
}

export function SkeletonTabela({ linhas = 8, colunas = 6 }: { linhas?: number; colunas?: number }) {
  return (
    <Stack gap={3} css={{ padding: "$4" }}>
      <Row gap={4}>
        {Array.from({ length: colunas }, (_, i) => (
          <Skeleton key={i} forma="texto" css={{ flex: i === 0 ? 2.4 : 1, height: 9 }} />
        ))}
      </Row>
      {Array.from({ length: linhas }, (_, l) => (
        <Row key={l} gap={4} css={{ opacity: 1 - l * 0.07 }}>
          {Array.from({ length: colunas }, (_, c) => (
            <Skeleton key={c} forma="texto" css={{ flex: c === 0 ? 2.4 : 1, height: 14 }} />
          ))}
        </Row>
      ))}
    </Stack>
  );
}

const PontoPulsante = styled("span", {
  display: "inline-block",
  size: 6,
  borderRadius: "$pill",
  backgroundColor: "$accent",
  "@motion": {
    animation: "pulsar 1.2s ease-in-out infinite",
  },
  "@keyframes pulsar": {
    "0%, 100%": { opacity: 0.25, transform: "scale(0.8)" },
    "50%": { opacity: 1, transform: "scale(1)" },
  },
});

export function LinhaCarregando({ texto }: { texto: string }) {
  return (
    <Row gap={2} align="center">
      <PontoPulsante />
      <Text size="sm" tone="muted">
        {texto}
      </Text>
    </Row>
  );
}

/* ─── Erro ─────────────────────────────────────────────────────────────── */

/** Traduz qualquer coisa que caiu num `catch` para uma frase útil. */
export function mensagemDeErro(erro: unknown): { titulo: string; detalhe: string } {
  if (erro instanceof ApiError) {
    return {
      titulo: erro.amigavel,
      detalhe: erro.status ? `HTTP ${erro.status} · ${erro.url}` : erro.url,
    };
  }
  if (erro instanceof Error) return { titulo: "Falha ao carregar", detalhe: erro.message };
  return { titulo: "Falha ao carregar", detalhe: String(erro) };
}

export function EstadoErro({
  erro,
  aoTentar,
  compacto = false,
}: {
  erro: unknown;
  aoTentar?: () => void;
  compacto?: boolean;
}) {
  const { titulo, detalhe } = mensagemDeErro(erro);

  return (
    <Card
      padding={compacto ? "sm" : "lg"}
      css={{ borderColor: "rgba(208,59,59,0.28)", backgroundColor: "rgba(208,59,59,0.05)" }}
    >
      <Row gap={4} align="start" justify="between" wrap>
        <Stack gap={2} css={{ flex: 1, minWidth: 220 }}>
          <Row gap={2} align="center">
            {/* Ícone + rótulo: a cor nunca carrega o significado sozinha */}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <circle cx="8" cy="8" r="7" stroke="#e56a6a" strokeWidth="1.4" />
              <path d="M8 4.6v4.2" stroke="#e56a6a" strokeWidth="1.6" strokeLinecap="round" />
              <circle cx="8" cy="11.4" r="0.9" fill="#e56a6a" />
            </svg>
            <Heading size="sm" css={{ color: "#e56a6a" }}>
              {titulo}
            </Heading>
          </Row>
          <Text size="sm" tone="muted" mono css={{ wordBreak: "break-all" }}>
            {detalhe}
          </Text>
        </Stack>
        {aoTentar && (
          <Button variante="secundario" tamanho="sm" onClick={aoTentar}>
            Tentar de novo
          </Button>
        )}
      </Row>
    </Card>
  );
}

/* ─── Vazio ────────────────────────────────────────────────────────────── */

export function EstadoVazio({
  titulo,
  descricao,
  acao,
}: {
  titulo: string;
  descricao: string;
  acao?: ReactNode;
}) {
  return (
    <Stack gap={4} align="center" css={{ py: "$10", textAlign: "center" }}>
      <Asset id="illustration.empty" size={180} />
      <Stack gap={2} align="center" css={{ maxWidth: 420 }}>
        <Heading size="md">{titulo}</Heading>
        <Text size="md">{descricao}</Text>
      </Stack>
      {acao}
    </Stack>
  );
}

/* ─── Rótulo de procedência ────────────────────────────────────────────── */

/**
 * A etiqueta que diz se o número é do IBGE ou fruto de uma premissa do
 * usuário. Aparece em todo KPI de valor monetário.
 *
 * O ponto colorido vem sempre acompanhado do texto — em nenhum lugar a
 * procedência é comunicada só pela cor.
 */
const PontoProcedencia = styled("span", {
  display: "inline-block",
  size: 6,
  borderRadius: "$pill",
  flexShrink: 0,
  variants: {
    tipo: {
      real: { backgroundColor: "$good" },
      derivado: { backgroundColor: "$accent" },
      premissa: { backgroundColor: "$warning" },
    },
  },
});

const ROTULO_PROCEDENCIA = {
  real: "dado IBGE",
  derivado: "calculado",
  premissa: "premissa sua",
} as const;

export function Procedencia({
  tipo,
  fonte,
}: {
  tipo: "real" | "derivado" | "premissa";
  fonte: string;
}) {
  return (
    <Row gap={2} align="center" title={fonte}>
      <PontoProcedencia tipo={tipo} />
      <Text size="xs" tone="muted" clamp={1}>
        {ROTULO_PROCEDENCIA[tipo]} · {fonte}
      </Text>
    </Row>
  );
}
