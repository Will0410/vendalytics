/**
 * Header.tsx — barra superior com os filtros globais.
 *
 * Todos os filtros ficam numa linha só, acima do conteúdo — nunca dentro de
 * um card ou flutuando ao lado de um gráfico específico. É o que deixa claro
 * que eles valem para a tela inteira.
 *
 * A lista de UFs vem do IBGE (`/localidades/estados`), não de um array
 * escrito à mão: é uma requisição pequena, cacheada por 30 dias, e mantém a
 * promessa de que nada aqui é dado inventado.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { styled } from "../stitches.config";
import { listarUfs, listarMunicipios } from "../data/ibge";
import { SECOES } from "../data/cnae";
import { useAsync } from "../lib/useAsync";
import { limparCache } from "../lib/cache";
import { FAIXAS_TICKET, ROTULO_RISCO, useFiltros, type Risco } from "../app/filtros";
import { ROTAS, type RotaId } from "../app/rotas";
import { Badge, Button, Chip, Heading, Input, Row, Select, Stack, Text } from "./primitives";

const Barra = styled("header", {
  gridArea: "header",
  display: "flex",
  flexDirection: "column",
  gap: "$3",
  px: "$5",
  py: "$3",
  backgroundColor: "rgba(8,13,24,0.86)",
  backdropFilter: "blur(12px)",
  borderBottom: "1px solid $border",
  position: "sticky",
  top: 0,
  zIndex: "$sticky",
});

const Filtros = styled("div", {
  display: "flex",
  alignItems: "flex-end",
  gap: "$3",
  flexWrap: "wrap",
});

const Campo = styled("div", {
  display: "flex",
  flexDirection: "column",
  gap: "$1",
  minWidth: 0,
  variants: {
    largura: {
      sm: { width: 96 },
      md: { width: 168 },
      lg: { width: 208 },
      xl: { width: 236 },
    },
  },
});

const MiniRotulo = styled("span", {
  fontSize: "$xs",
  fontWeight: "$semibold",
  textTransform: "uppercase",
  letterSpacing: "$wider",
  color: "$textMuted",
  /* Trunca em vez de vazar. Com `nowrap` sozinho, um rótulo mais largo que o
     campo invade o campo vizinho — foi o que aconteceu com "FATURAMENTO
     ESTIMADO POR CLIENTE" colando em "APETITE DE RISCO". */
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: "100%",
});

/* ─── Seletor múltiplo de CNAE ─────────────────────────────────────────── */

const Popover = styled("div", {
  position: "absolute",
  top: "calc(100% + 6px)",
  left: 0,
  zIndex: "$dropdown",
  width: 340,
  maxHeight: 380,
  overflowY: "auto",
  padding: "$3",
  backgroundColor: "$surfaceRaised",
  border: "1px solid $borderStrong",
  borderRadius: "$lg",
  boxShadow: "$lg",
});

const OpcaoSecao = styled("label", {
  display: "flex",
  alignItems: "center",
  gap: "$3",
  px: "$2",
  py: "$2",
  borderRadius: "$sm",
  cursor: "pointer",
  fontSize: "$md",
  color: "$textSecondary",
  "&:hover": { backgroundColor: "$surfaceHover", color: "$textPrimary" },
  "& input": { accentColor: "#4f6ef7", cursor: "pointer", size: 14, flexShrink: 0 },
});

const Gatilho = styled("button", {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "$2",
  height: 36,
  px: "$3",
  width: "100%",
  backgroundColor: "$surfaceSunken",
  color: "$textPrimary",
  border: "1px solid $border",
  borderRadius: "$md",
  fontSize: "$base",
  cursor: "pointer",
  transition: "border-color $fast",
  "&:hover": { borderColor: "$borderStrong" },
  variants: { aberto: { true: { borderColor: "$brand", boxShadow: "$focus" } } },
});

function SeletorCnae() {
  const { filtros, alternarSecao, limparSecoes } = useFiltros();
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const caixa = useRef<HTMLDivElement>(null);

  /* Fecha ao clicar fora e no Esc — sem isso o popover fica preso aberto
     quando o usuário desiste, que é o defeito clássico deste componente. */
  useEffect(() => {
    if (!aberto) return;
    const aoClicar = (e: MouseEvent) => {
      if (caixa.current && !caixa.current.contains(e.target as Node)) setAberto(false);
    };
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAberto(false);
    };
    document.addEventListener("mousedown", aoClicar);
    document.addEventListener("keydown", aoTeclar);
    return () => {
      document.removeEventListener("mousedown", aoClicar);
      document.removeEventListener("keydown", aoTeclar);
    };
  }, [aberto]);

  const filtradas = useMemo(() => {
    const q = busca.trim().toLocaleLowerCase("pt-BR");
    if (!q) return SECOES;
    return SECOES.filter(
      (s) =>
        s.nome.toLocaleLowerCase("pt-BR").includes(q) ||
        s.curto.toLocaleLowerCase("pt-BR").includes(q),
    );
  }, [busca]);

  const n = filtros.secoes.length;
  const resumo =
    n === 0
      ? "Todos os setores"
      : n === 1
        ? (SECOES.find((s) => s.letra === filtros.secoes[0])?.curto ?? "1 setor")
        : `${n} setores`;

  return (
    <Campo largura="xl" css={{ position: "relative" }} ref={caixa}>
      <MiniRotulo>CNAE · Setor-alvo</MiniRotulo>
      <Gatilho aberto={aberto} onClick={() => setAberto((a) => !a)} aria-expanded={aberto}>
        <Row gap={2} css={{ minWidth: 0 }}>
          <Text size="base" tone={n ? "primary" : "muted"} clamp={1}>
            {resumo}
          </Text>
          {n > 1 && (
            <Badge tone="marca" tamanho="sm">
              {n}
            </Badge>
          )}
        </Row>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path
            d="M3 4.5 6 7.5 9 4.5"
            stroke="#94a3b8"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </Gatilho>

      {aberto && (
        <Popover role="dialog" aria-label="Selecionar seções CNAE">
          <Stack gap={3}>
            <Input
              largura="cheia"
              tamanho="sm"
              placeholder="Buscar setor…"
              value={busca}
              autoFocus
              onChange={(e) => setBusca(e.currentTarget.value)}
            />
            <Row justify="between">
              <Text size="xs" tone="muted">
                {n === 0 ? "Nenhum filtro — considera todos" : `${n} selecionados`}
              </Text>
              {n > 0 && (
                <Button variante="fantasma" tamanho="sm" onClick={limparSecoes}>
                  Limpar
                </Button>
              )}
            </Row>
            <Stack gap={0}>
              {filtradas.map((s) => (
                <OpcaoSecao key={s.letra}>
                  <input
                    type="checkbox"
                    checked={filtros.secoes.includes(s.letra)}
                    onChange={() => alternarSecao(s.letra)}
                  />
                  <Row gap={2} css={{ minWidth: 0 }}>
                    <Badge tone="neutro" tamanho="sm">
                      {s.letra}
                    </Badge>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{s.curto}</span>
                  </Row>
                </OpcaoSecao>
              ))}
              {filtradas.length === 0 && (
                <Text size="sm" tone="muted" css={{ padding: "$3" }}>
                  Nenhuma seção corresponde a “{busca}”.
                </Text>
              )}
            </Stack>
          </Stack>
        </Popover>
      )}
    </Campo>
  );
}

/* ─── Cabeçalho ────────────────────────────────────────────────────────── */

export function Header({ rota }: { rota: RotaId }) {
  const { filtros, definir } = useFiltros();
  const def = ROTAS.find((r) => r.id === rota);

  const ufs = useAsync(() => listarUfs(), []);
  const municipios = useAsync(() => listarMunicipios(filtros.uf), [filtros.uf]);

  /* Praça e Geomarketing operam sobre um município; Vendas é nacional. */
  const mostraMunicipio = rota === "praca" || rota === "geomarketing";

  return (
    <Barra>
      <Row justify="between" align="center" gap={4} wrap>
        <Stack gap={1} css={{ minWidth: 0 }}>
          <Heading size="lg">{def?.titulo ?? "Vendalytics"}</Heading>
          <Text size="sm" tone="muted" clamp={1}>
            {def?.descricao}
          </Text>
        </Stack>

        <Row gap={2}>
          <Badge tone="acento" tamanho="md">
            Dados públicos ao vivo
          </Badge>
          <Button
            variante="fantasma"
            tamanho="sm"
            title="Descarta o cache local e refaz as chamadas ao IBGE e à BrasilAPI"
            onClick={() => {
              limparCache();
              window.location.reload();
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
              <path
                d="M12 7a5 5 0 1 1-1.5-3.6M12 1.5V4.5H9"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Recarregar fontes
          </Button>
        </Row>
      </Row>

      <Filtros>
        <Campo largura="sm">
          <MiniRotulo>UF</MiniRotulo>
          <Select
            largura="cheia"
            value={filtros.uf}
            disabled={ufs.carregando}
            onChange={(e) => definir("uf", e.currentTarget.value)}
          >
            {ufs.dado
              ? ufs.dado.map((u) => (
                  <option key={u.sigla} value={u.sigla}>
                    {u.sigla}
                  </option>
                ))
              : /* Sem a lista ainda, mantém a seleção atual visível em vez de
                   piscar um select vazio. */
                <option value={filtros.uf}>{filtros.uf}</option>}
          </Select>
        </Campo>

        {mostraMunicipio && (
          <Campo largura="lg">
            <MiniRotulo>Município</MiniRotulo>
            <Select
              largura="cheia"
              value={filtros.municipioId ?? ""}
              disabled={municipios.carregando}
              onChange={(e) =>
                definir("municipioId", e.currentTarget.value ? Number(e.currentTarget.value) : null)
              }
            >
              <option value="">
                {municipios.carregando ? "Carregando…" : `Todo o estado (${filtros.uf})`}
              </option>
              {municipios.dado?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nome}
                </option>
              ))}
            </Select>
          </Campo>
        )}

        <SeletorCnae />

        <Campo largura="xl">
          <MiniRotulo title="Receita anual esperada por cliente — a premissa que converte nº de empresas em reais de TAM">
            Faturamento estimado
          </MiniRotulo>
          <Select
            largura="cheia"
            value={filtros.ticketMedioAnual}
            onChange={(e) => definir("ticketMedioAnual", Number(e.currentTarget.value))}
          >
            {FAIXAS_TICKET.map((f) => (
              <option key={f.valor} value={f.valor}>
                {f.rotulo}
              </option>
            ))}
          </Select>
        </Campo>

        <Campo largura="lg">
          <MiniRotulo>Risco</MiniRotulo>
          <Select
            largura="cheia"
            value={filtros.risco}
            onChange={(e) => definir("risco", e.currentTarget.value as Risco)}
          >
            {(Object.keys(ROTULO_RISCO) as Risco[]).map((r) => (
              <option key={r} value={r}>
                {ROTULO_RISCO[r]}
              </option>
            ))}
          </Select>
        </Campo>

        <Campo largura="md">
          <MiniRotulo>Share alvo</MiniRotulo>
          <Row gap={2}>
            {[0.01, 0.03, 0.08, 0.15].map((s) => (
              <Chip
                key={s}
                ativo={filtros.shareAlvo === s}
                onClick={() => definir("shareAlvo", s)}
                title={`Assumir ${(s * 100).toFixed(0)}% de participação alcançável`}
              >
                {(s * 100).toFixed(0)}%
              </Chip>
            ))}
          </Row>
        </Campo>
      </Filtros>
    </Barra>
  );
}
