/**
 * Prospeccao.tsx — a carteira B2B, com Score ICP explicável.
 *
 * ── Carga ──────────────────────────────────────────────────────────────────
 * Os CNPJs vão para a BrasilAPI por um pool de concorrência 3 com
 * espaçamento, e a tabela preenche linha a linha em vez de segurar tudo até o
 * último. Um CNPJ que falha mostra o erro NA LINHA dele; os outros seguem.
 * É o comportamento que sobrevive ao rate limit de uma API pública.
 *
 * ── Explicabilidade ────────────────────────────────────────────────────────
 * Clicar numa linha abre a decomposição do score: cada fator, quanto valeu,
 * de quanto podia valer, e a frase que explica. Sem isso, o primeiro
 * vendedor que discordar de uma conta derruba a confiança na tela inteira.
 */
import { Fragment, useCallback, useMemo, useState } from "react";
import { styled } from "../stitches.config";
import {
  buscarLote,
  CARTEIRA_INICIAL,
  type Empresa,
  type ItemLote,
} from "../data/brasilapi";
import { SECOES } from "../data/cnae";
import { cnpjMascara, cnpjValido, moedaCompacta, num, pct, soDigitos, capitalizar, data } from "../lib/format";
import { calcularIcp, DESCRICAO_FAIXA, type FaixaIcp, type ResultadoIcp } from "../domain/icp";
import { insightsDeCarteira } from "../domain/insights";
import { useFiltros } from "../app/filtros";
import { useAsync } from "../lib/useAsync";
import { CardInsight, Secao } from "../components/cards";
import { EstadoErro, SkeletonTabela } from "../components/estados";
import { mensagemDeErro } from "../components/estados";
import {
  Badge,
  Button,
  Card,
  Grid,
  Input,
  Progresso,
  Row,
  Stack,
  Tabela,
  TabelaWrap,
  Td,
  Text,
  Th,
} from "../components/primitives";

/* ─── Apresentação do score ────────────────────────────────────────────── */

const TONE_FAIXA: Record<FaixaIcp, "bom" | "marca" | "atencao" | "critico"> = {
  A: "bom",
  B: "marca",
  C: "atencao",
  D: "critico",
};

const TONE_SITUACAO = {
  Ativa: "bom",
  Suspensa: "atencao",
  Inapta: "serio",
  Baixada: "critico",
  Nula: "critico",
  Desconhecida: "neutro",
} as const;

const TONE_PORTE = {
  "Médio/Grande": "marca",
  Pequeno: "acento",
  Micro: "neutro",
  MEI: "neutro",
  "Não informado": "neutro",
} as const;

/** Barra fina do score dentro da célula — magnitude legível sem sair da linha. */
const BarraScore = styled("span", {
  display: "inline-block",
  height: 4,
  width: 54,
  borderRadius: "$pill",
  backgroundColor: "rgba(148,163,184,0.16)",
  overflow: "hidden",
  flexShrink: 0,
  "& > i": { display: "block", height: "100%", borderRadius: "$pill" },
});

const COR_FAIXA: Record<FaixaIcp, string> = {
  A: "#0ca30c",
  B: "#4f6ef7",
  C: "#fab219",
  D: "#d03b3b",
};

const LinhaExpandida = styled("tr", {
  "& > td": { backgroundColor: "$surfaceSunken", padding: "0 !important" },
});

const BarraFator = styled("div", {
  height: 4,
  borderRadius: "$pill",
  backgroundColor: "rgba(148,163,184,0.14)",
  overflow: "hidden",
  "& > i": { display: "block", height: "100%", borderRadius: "$pill" },
});

const COR_SINAL = { positivo: "#0ca30c", neutro: "#64748b", negativo: "#d03b3b" } as const;

function DetalheScore({ icp, empresa }: { icp: ResultadoIcp; empresa: Empresa }) {
  return (
    <Stack gap={4} css={{ padding: "$5" }}>
      <Row justify="between" align="start" gap={4} wrap>
        <Stack gap={1}>
          <Text size="xs" overline>
            Decomposição do Score ICP
          </Text>
          <Text size="sm" tone="muted">
            {icp.desqualificada
              ? icp.motivoDesqualificacao
              : `${icp.score} de 100 pontos · ${DESCRICAO_FAIXA[icp.faixa]}`}
          </Text>
        </Stack>
        <Row gap={2} wrap>
          {empresa.telefone && <Badge tone="neutro">{empresa.telefone}</Badge>}
          {empresa.email && <Badge tone="neutro">{empresa.email}</Badge>}
          {empresa.naturezaJuridica && <Badge tone="neutro">{empresa.naturezaJuridica}</Badge>}
        </Row>
      </Row>

      <Grid cols="3">
        {icp.fatores.map((f) => (
          <Stack key={f.rotulo} gap={2}>
            <Row justify="between" align="baseline" gap={2}>
              <Text size="sm" tone="primary" weight="medium">
                {f.rotulo}
              </Text>
              <Text size="sm" tone="muted" mono>
                {f.maximo > 0 ? `${f.pontos}/${f.maximo}` : "pré-requisito"}
              </Text>
            </Row>
            {f.maximo > 0 && (
              <BarraFator>
                <i
                  style={{
                    width: `${Math.max(2, (f.pontos / f.maximo) * 100)}%`,
                    background: COR_SINAL[f.sinal],
                  }}
                />
              </BarraFator>
            )}
            <Text size="xs" tone="muted">
              {f.detalhe}
            </Text>
          </Stack>
        ))}
      </Grid>

      <Row gap={5} wrap css={{ borderTop: "1px solid $border", paddingTop: "$4" }}>
        <Stack gap={1}>
          <Text size="xs" overline>
            Endereço
          </Text>
          <Text size="sm">
            {capitalizar(empresa.endereco)} · {capitalizar(empresa.bairro)} ·{" "}
            {capitalizar(empresa.municipio)}/{empresa.uf}
          </Text>
        </Stack>
        <Stack gap={1}>
          <Text size="xs" overline>
            Abertura
          </Text>
          <Text size="sm">{data(empresa.dataAbertura)}</Text>
        </Stack>
        <Stack gap={1}>
          <Text size="xs" overline>
            Capital social
          </Text>
          <Text size="sm">{moedaCompacta(empresa.capitalSocial)}</Text>
        </Stack>
        <Stack gap={1}>
          <Text size="xs" overline>
            Quadro societário
          </Text>
          <Text size="sm">{empresa.socios} sócios registrados</Text>
        </Stack>
        <Stack gap={1}>
          <Text size="xs" overline>
            CNAE principal
          </Text>
          <Text size="sm">{empresa.cnaeDescricao ?? "—"}</Text>
        </Stack>
      </Row>
    </Stack>
  );
}

/* ─── Ordenação ────────────────────────────────────────────────────────── */

type Coluna = "razaoSocial" | "cnpj" | "cnae" | "porte" | "local" | "score";

const ORDEM_PORTE: Record<Empresa["porte"], number> = {
  "Médio/Grande": 4,
  Pequeno: 3,
  Micro: 2,
  "Não informado": 1,
  MEI: 0,
};

/* ─── Módulo ───────────────────────────────────────────────────────────── */

interface Linha {
  item: ItemLote;
  icp: ResultadoIcp | null;
}

export function Prospeccao() {
  const { filtros, pisoScore } = useFiltros();

  const [extras, setExtras] = useState<string[]>([]);
  const [entrada, setEntrada] = useState("");
  const [progresso, setProgresso] = useState({ feitos: 0, total: 0 });
  const [expandida, setExpandida] = useState<string | null>(null);
  const [ordem, setOrdem] = useState<{ coluna: Coluna; asc: boolean }>({
    coluna: "score",
    asc: false,
  });

  const cnpjs = useMemo(() => [...CARTEIRA_INICIAL, ...extras], [extras]);

  const carteira = useAsync(
    (signal) => {
      setProgresso({ feitos: 0, total: cnpjs.length });
      return buscarLote(cnpjs, {
        signal,
        limite: 3,
        aoProgredir: (feitos, total) => setProgresso({ feitos, total }),
      });
    },
    [cnpjs],
  );

  const linhas = useMemo<Linha[]>(
    () =>
      (carteira.dado ?? []).map((item) => ({
        item,
        icp: item.empresa ? calcularIcp(item.empresa) : null,
      })),
    [carteira.dado],
  );

  /* Os filtros do cabeçalho valem aqui também: seção CNAE e apetite de risco. */
  const filtradas = useMemo(() => {
    return linhas.filter(({ item, icp }) => {
      if (!item.empresa) return true; // linhas com erro permanecem visíveis
      if (filtros.secoes.length && !filtros.secoes.includes(item.empresa.secao.letra)) return false;
      if (icp && icp.score < pisoScore) return false;
      return true;
    });
  }, [linhas, filtros.secoes, pisoScore]);

  const ordenadas = useMemo(() => {
    const dir = ordem.asc ? 1 : -1;
    return [...filtradas].sort((a, b) => {
      /* Linhas com erro sempre no fim: não competem por ordenação porque não
         têm os campos pelos quais se ordena. */
      if (!a.item.empresa && !b.item.empresa) return 0;
      if (!a.item.empresa) return 1;
      if (!b.item.empresa) return -1;

      const ea = a.item.empresa;
      const eb = b.item.empresa;

      switch (ordem.coluna) {
        case "razaoSocial":
          return dir * ea.razaoSocial.localeCompare(eb.razaoSocial, "pt-BR");
        case "cnpj":
          return dir * ea.cnpj.localeCompare(eb.cnpj);
        case "cnae":
          return dir * ea.secao.curto.localeCompare(eb.secao.curto, "pt-BR");
        case "porte":
          return dir * (ORDEM_PORTE[ea.porte] - ORDEM_PORTE[eb.porte]);
        case "local":
          return dir * `${ea.uf}${ea.municipio}`.localeCompare(`${eb.uf}${eb.municipio}`, "pt-BR");
        case "score":
          return dir * ((a.icp?.score ?? 0) - (b.icp?.score ?? 0));
      }
    });
  }, [filtradas, ordem]);

  const empresas = useMemo(
    () => linhas.map((l) => l.item.empresa).filter((e): e is Empresa => e != null),
    [linhas],
  );

  const insights = useMemo(() => insightsDeCarteira(empresas), [empresas]);

  const adicionar = useCallback(() => {
    const d = soDigitos(entrada);
    if (!cnpjValido(d) || cnpjs.includes(d)) return;
    setExtras((e) => [...e, d]);
    setEntrada("");
  }, [entrada, cnpjs]);

  const ordenarPor = (coluna: Coluna) =>
    setOrdem((o) => (o.coluna === coluna ? { coluna, asc: !o.asc } : { coluna, asc: false }));

  const seta = (coluna: Coluna) =>
    ordem.coluna === coluna ? (ordem.asc ? " ↑" : " ↓") : "";

  const entradaValida = cnpjValido(soDigitos(entrada));
  const entradaJaExiste = cnpjs.includes(soDigitos(entrada));

  const resumo = useMemo(() => {
    const ok = linhas.filter((l) => l.item.empresa).length;
    const falhas = linhas.length - ok;
    const medio = empresas.length
      ? linhas.reduce((s, l) => s + (l.icp?.score ?? 0), 0) / empresas.length
      : 0;
    return { ok, falhas, medio };
  }, [linhas, empresas]);

  return (
    <Stack gap={7}>
      {/* ─── Barra de ações ─────────────────────────────────────────── */}
      <Card padding="md">
        <Stack gap={4}>
          <Row justify="between" align="end" gap={4} wrap>
            <Stack gap={1}>
              <Text size="xs" overline>
                Carteira de prospecção
              </Text>
              <Text size="sm" tone="muted">
                Cadastro público da Receita Federal, consultado ao vivo via BrasilAPI
              </Text>
            </Stack>

            <Row gap={2} align="end">
              <Stack gap={1}>
                <Text size="xs" overline>
                  Adicionar CNPJ
                </Text>
                <Row gap={2}>
                  <Input
                    mono
                    tamanho="md"
                    placeholder="00.000.000/0001-00"
                    value={entrada}
                    css={{ width: 190 }}
                    onChange={(e) => setEntrada(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && entradaValida && !entradaJaExiste) adicionar();
                    }}
                  />
                  <Button
                    variante="primario"
                    onClick={adicionar}
                    disabled={!entradaValida || entradaJaExiste}
                    title={
                      !entrada
                        ? "Informe um CNPJ"
                        : !entradaValida
                          ? "Dígito verificador inválido — não vale gastar cota da API"
                          : entradaJaExiste
                            ? "Este CNPJ já está na carteira"
                            : "Consultar na BrasilAPI"
                    }
                  >
                    Consultar
                  </Button>
                </Row>
              </Stack>
            </Row>
          </Row>

          {/* Validação local antes da rede: o dígito verificador é checado
              aqui para não queimar cota com número que a fonte recusaria. */}
          {entrada && !entradaValida && (
            <Text size="sm" tone="warning">
              Dígito verificador inválido — a consulta não será enviada.
            </Text>
          )}
          {entradaJaExiste && (
            <Text size="sm" tone="muted">
              Este CNPJ já está na carteira.
            </Text>
          )}

          {carteira.carregando && progresso.total > 0 && (
            <Stack gap={2}>
              <Row justify="between">
                <Text size="sm" tone="muted">
                  Consultando a Receita Federal — {progresso.feitos} de {progresso.total} CNPJs
                </Text>
                <Text size="sm" tone="muted" mono>
                  {pct((progresso.feitos / progresso.total) * 100, 0)}
                </Text>
              </Row>
              <Progresso>
                <i style={{ width: `${(progresso.feitos / progresso.total) * 100}%` }} />
              </Progresso>
              <Text size="xs" tone="muted">
                Concorrência limitada a 3 requisições simultâneas com espaçamento — a BrasilAPI é
                pública e limita por IP.
              </Text>
            </Stack>
          )}

          {!carteira.carregando && carteira.dado && (
            <Row gap={3} wrap>
              <Badge tone="marca" tamanho="md">
                {resumo.ok} contas carregadas
              </Badge>
              {resumo.falhas > 0 && (
                <Badge tone="critico" tamanho="md">
                  {resumo.falhas} com falha
                </Badge>
              )}
              <Badge tone="neutro" tamanho="md">
                Score ICP médio {num(resumo.medio, 1)}
              </Badge>
              {(filtros.secoes.length > 0 || pisoScore > 0) && (
                <Badge tone="acento" tamanho="md">
                  {ordenadas.length} após filtros do cabeçalho
                </Badge>
              )}
            </Row>
          )}
        </Stack>
      </Card>

      {/* ─── Tabela ─────────────────────────────────────────────────── */}
      {carteira.erro ? (
        <EstadoErro erro={carteira.erro} aoTentar={carteira.recarregar} />
      ) : (
        <Card padding="none">
          {carteira.carregando && !carteira.dado ? (
            <SkeletonTabela linhas={10} colunas={6} />
          ) : (
            <TabelaWrap>
              <Tabela>
                <thead>
                  <tr>
                    <Th ordenavel onClick={() => ordenarPor("razaoSocial")}>
                      Razão Social{seta("razaoSocial")}
                    </Th>
                    <Th ordenavel onClick={() => ordenarPor("cnpj")}>
                      CNPJ{seta("cnpj")}
                    </Th>
                    <Th ordenavel onClick={() => ordenarPor("cnae")}>
                      CNAE Principal{seta("cnae")}
                    </Th>
                    <Th ordenavel onClick={() => ordenarPor("porte")}>
                      Porte{seta("porte")}
                    </Th>
                    <Th ordenavel onClick={() => ordenarPor("local")}>
                      Localização{seta("local")}
                    </Th>
                    <Th>Situação</Th>
                    <Th ordenavel alinhamento="direita" onClick={() => ordenarPor("score")}>
                      Score ICP{seta("score")}
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {ordenadas.map(({ item, icp }) => {
                    const e = item.empresa;

                    if (!e) {
                      const { titulo } = mensagemDeErro(item.erro);
                      return (
                        <tr key={item.cnpj}>
                          <Td enfase="fraca" mono>
                            {cnpjMascara(item.cnpj)}
                          </Td>
                          <Td colSpan={6}>
                            <Row gap={2}>
                              <Badge tone="critico">Falha na consulta</Badge>
                              <Text size="sm" tone="muted">
                                {titulo}
                              </Text>
                            </Row>
                          </Td>
                        </tr>
                      );
                    }

                    const aberta = expandida === e.cnpj;

                    /* Fragment COM chave: a linha e o painel expandido são
                       dois irmãos vindos de um `map`, então a chave precisa
                       ficar no fragmento, não nos filhos. */
                    return (
                      <Fragment key={e.cnpj}>
                        <tr
                          onClick={() => setExpandida(aberta ? null : e.cnpj)}
                          style={{ cursor: "pointer" }}
                        >
                          <Td enfase="forte">
                            <Stack gap={1}>
                              <Row gap={2}>
                                <span
                                  style={{
                                    display: "inline-block",
                                    transform: aberta ? "rotate(90deg)" : "none",
                                    transition: "transform 120ms",
                                    color: "#64748b",
                                    fontSize: 10,
                                  }}
                                >
                                  ▶
                                </span>
                                <span
                                  style={{
                                    maxWidth: 260,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    display: "block",
                                  }}
                                  title={e.razaoSocial}
                                >
                                  {capitalizar(e.razaoSocial)}
                                </span>
                              </Row>
                              {e.nomeFantasia && (
                                <Text size="xs" tone="muted" css={{ paddingLeft: 18 }}>
                                  {capitalizar(e.nomeFantasia)}
                                </Text>
                              )}
                            </Stack>
                          </Td>

                          <Td mono>{cnpjMascara(e.cnpj)}</Td>

                          <Td>
                            <Row gap={2}>
                              <Badge tone="neutro" title={e.secao.nome}>
                                {e.secao.letra}
                              </Badge>
                              <span
                                style={{
                                  maxWidth: 190,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  display: "block",
                                }}
                                title={e.cnaeDescricao ?? undefined}
                              >
                                {e.cnaeDescricao ?? e.secao.curto}
                              </span>
                            </Row>
                          </Td>

                          <Td>
                            <Badge tone={TONE_PORTE[e.porte]}>{e.porte}</Badge>
                          </Td>

                          <Td>
                            {capitalizar(e.municipio)}/{e.uf}
                            {!e.matriz && (
                              <Badge tone="neutro" css={{ marginLeft: 6 }}>
                                Filial
                              </Badge>
                            )}
                          </Td>

                          <Td>
                            <Badge tone={TONE_SITUACAO[e.situacao]}>{e.situacao}</Badge>
                          </Td>

                          <Td alinhamento="direita">
                            <Row gap={2} justify="end">
                              <BarraScore>
                                <i
                                  style={{
                                    width: `${Math.max(2, icp?.score ?? 0)}%`,
                                    background: COR_FAIXA[icp?.faixa ?? "D"],
                                  }}
                                />
                              </BarraScore>
                              <Text size="md" tone="primary" weight="semibold" mono>
                                {icp?.score ?? 0}
                              </Text>
                              <Badge
                                tone={TONE_FAIXA[icp?.faixa ?? "D"]}
                                title={DESCRICAO_FAIXA[icp?.faixa ?? "D"]}
                              >
                                {icp?.faixa ?? "D"}
                              </Badge>
                            </Row>
                          </Td>
                        </tr>

                        {aberta && icp && (
                          <LinhaExpandida>
                            <td colSpan={7}>
                              <DetalheScore icp={icp} empresa={e} />
                            </td>
                          </LinhaExpandida>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </Tabela>
            </TabelaWrap>
          )}

          {!carteira.carregando && ordenadas.length === 0 && (
            <Stack gap={2} css={{ padding: "$8", textAlign: "center" }}>
              <Text size="md" tone="primary">
                Nenhuma conta passa nos filtros atuais.
              </Text>
              <Text size="sm" tone="muted">
                Afrouxe o apetite de risco ou remova o filtro de CNAE no cabeçalho.
              </Text>
            </Stack>
          )}
        </Card>
      )}

      {/* ─── Legenda de faixas ──────────────────────────────────────── */}
      <Row gap={4} wrap>
        {(["A", "B", "C", "D"] as FaixaIcp[]).map((f) => (
          <Row key={f} gap={2}>
            <Badge tone={TONE_FAIXA[f]}>{f}</Badge>
            <Text size="xs" tone="muted">
              {DESCRICAO_FAIXA[f]}
            </Text>
          </Row>
        ))}
        <Text size="xs" tone="muted">
          Clique numa linha para abrir a decomposição do score.
        </Text>
      </Row>

      {/* ─── Insights ───────────────────────────────────────────────── */}
      {insights.length > 0 && (
        <Secao
          titulo="Inteligência Analítica"
          descricao="Leitura da carteira carregada — composição, aderência ao ICP e lacunas de acionabilidade"
        >
          <Grid cols="2">
            {insights.map((i) => (
              <CardInsight key={i.id} insight={i} />
            ))}
          </Grid>
        </Secao>
      )}

      <Text size="xs" tone="muted">
        Seções CNAE disponíveis para filtro no cabeçalho:{" "}
        {SECOES.map((s) => s.curto).join(" · ")}
      </Text>
    </Stack>
  );
}
