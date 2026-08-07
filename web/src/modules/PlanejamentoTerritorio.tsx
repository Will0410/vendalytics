/**
 * PlanejamentoTerritorio.tsx — "tenho N vendedores, onde coloco cada um?"
 *
 * O restante da plataforma responde *onde está o mercado*. Esta tela responde
 * *como dividi-lo* — que é a decisão seguinte, e a que nenhuma ferramenta
 * brasileira resolve direito hoje.
 *
 * ── Por que o teto de 8 territórios ───────────────────────────────────────
 * Não é limitação do algoritmo, é da leitura. A paleta de séries do produto
 * tem 8 slots validados contra a superfície do mapa nos testes de daltonismo
 * e contraste (ver o cabeçalho de stitches.config.ts). O nono território
 * exigiria uma cor gerada na hora — que romperia a garantia de que dois
 * territórios vizinhos são distinguíveis por quem tem protanopia.
 *
 * Um mapa com 12 territórios onde três parecem iguais é pior que um mapa com
 * 8 corretos. Acima disso, o caminho é recortar por UF e planejar por região.
 *
 * ── A leitura honesta do resultado ────────────────────────────────────────
 * O painel mostra o **desequilíbrio** sempre, não só quando é bom. Um plano
 * com 40% de diferença entre o maior e o menor território precisa ser
 * mostrado como tal — esconder isso faria o usuário dividir comissão em cima
 * de um desenho que a própria ferramenta sabe estar torto.
 */
import { useMemo, useState } from "react";
import { styled, SERIES } from "../stitches.config";
import { ufDoCodigo } from "../data/ibge";
import { SECOES } from "../data/cnae";
import dadosCentroides from "../data/centroides.json";
import { moedaCompacta, num, numCompacto, pct } from "../lib/format";
import { planejarTerritorios } from "../domain/territorios";
import { useFiltros } from "../app/filtros";
import { useRota } from "../app/rotas";
import { useUniverso } from "../app/useUniverso";
import { MapaBrasil, type PontoMapa } from "../components/MapaBrasil";
import { Secao } from "../components/cards";
import { EstadoErro, LinhaCarregando, SkeletonKpis } from "../components/estados";
import {
  Badge,
  Button,
  Card,
  Chip,
  Grid,
  Row,
  Select,
  Stack,
  Tabela,
  TabelaWrap,
  Td,
  Text,
  Th,
} from "../components/primitives";

const CENTROIDES: Record<string, number[]> = dadosCentroides.centroides;
const nomeSecao = (letra: string) => SECOES.find((s) => s.letra === letra);

const MAX_TERRITORIOS = 8;

const Palco = styled("div", {
  position: "relative",
  width: "100%",
  height: "calc(100vh - 340px)",
  minHeight: 460,
});

const Faixa = styled("span", {
  display: "inline-block",
  width: 12,
  height: 12,
  borderRadius: 3,
  flexShrink: 0,
});

const LinhaSede = styled("button", {
  border: 0,
  background: "transparent",
  padding: 0,
  font: "inherit",
  color: "inherit",
  cursor: "pointer",
  textAlign: "left",
  "&:hover": { textDecoration: "underline" },
});

export function PlanejamentoTerritorio() {
  const { filtros, definir } = useFiltros();
  const [, navegar] = useRota();

  const setor = filtros.secoes[0] ?? "G";
  const { universo, carregando, refinando, erro, recarregar } = useUniverso(setor);

  const [quantidade, setQuantidade] = useState(4);
  const [escopo, setEscopo] = useState<"uf" | "brasil">("uf");

  const pracasDoEscopo = useMemo(
    () =>
      escopo === "brasil"
        ? universo.pracas
        : universo.pracas.filter((p) => (p.uf || ufDoCodigo(p.id)) === filtros.uf),
    [universo.pracas, escopo, filtros.uf],
  );

  const plano = useMemo(
    () =>
      planejarTerritorios(
        pracasDoEscopo,
        (id) => {
          const c = CENTROIDES[String(id)];
          return c && c[0] != null && c[1] != null ? [c[0], c[1]] : null;
        },
        { quantidade },
      ),
    [pracasDoEscopo, quantidade],
  );

  /** Município → índice do território, para colorir o mapa. */
  const territorioDe = useMemo(() => {
    const m = new Map<number, number>();
    plano?.territorios.forEach((t) => t.pracas.forEach((p) => m.set(p.id, t.indice)));
    return m;
  }, [plano]);

  const pontos = useMemo<PontoMapa[]>(() => {
    if (!plano) return [];
    const saida: PontoMapa[] = [];

    for (const p of pracasDoEscopo) {
      const c = CENTROIDES[String(p.id)];
      const lat = c?.[0];
      const lon = c?.[1];
      const t = territorioDe.get(p.id);
      if (lat == null || lon == null || t == null) continue;

      const terr = plano.territorios[t];
      saida.push({
        id: p.id,
        nome: p.nome,
        uf: p.uf || ufDoCodigo(p.id),
        lat,
        lon,
        valor: p.setor ?? 0,
        cor: SERIES[t % SERIES.length] as string,
        classificacao: `Território ${t + 1} · sede em ${terr?.sede.nome ?? "—"}`,
        detalhes: [
          { rotulo: `Empresas de ${nomeSecao(setor)?.curto ?? setor}`, valor: num(p.setor) },
          { rotulo: "Score de Atratividade", valor: `${p.atratividade.score} / 100` },
          { rotulo: "População", valor: num(p.populacao) },
          { rotulo: "PIB per capita", valor: moedaCompacta(p.pibPerCapita) },
        ],
      });
    }
    return saida;
  }, [plano, pracasDoEscopo, territorioDe, setor]);

  const abrirPraca = (id: number) => {
    const p = universo.porId.get(id);
    if (!p) return;
    definir("uf", p.uf || ufDoCodigo(p.id));
    definir("municipioId", id);
    setTimeout(() => navegar("praca"), 0);
  };

  if (erro) return <EstadoErro erro={erro} aoTentar={recarregar} />;
  if (carregando) return <SkeletonKpis quantidade={4} />;

  const desequilibrioOk = (plano?.desequilibrio ?? 1) <= 0.25;

  return (
    <Stack gap={6}>
      {/* ─── Controles ──────────────────────────────────────────────── */}
      <Card padding="md">
        <Row justify="between" align="end" gap={5} wrap>
          <Stack gap={2}>
            <Text size="xs" overline>
              Quantos vendedores / territórios
            </Text>
            <Row gap={2} wrap>
              {Array.from({ length: MAX_TERRITORIOS }, (_, i) => i + 1).map((n) => (
                <Chip key={n} ativo={n === quantidade} onClick={() => setQuantidade(n)}>
                  {n}
                </Chip>
              ))}
            </Row>
          </Stack>

          <Stack gap={2} css={{ minWidth: 200 }}>
            <Text size="xs" overline>
              Área a dividir
            </Text>
            <Select
              largura="cheia"
              tamanho="sm"
              value={escopo}
              onChange={(e) => setEscopo(e.currentTarget.value as "uf" | "brasil")}
            >
              <option value="uf">Somente {filtros.uf}</option>
              <option value="brasil">Brasil inteiro</option>
            </Select>
          </Stack>

          <Row gap={3} align="center" wrap>
            {refinando && <LinhaCarregando texto="série histórica" />}
            <Badge tone="acento" tamanho="md">
              {nomeSecao(setor)?.curto ?? setor}
            </Badge>
            {plano && (
              <Badge tone={desequilibrioOk ? "bom" : "atencao"} tamanho="md">
                Desequilíbrio {pct(plano.desequilibrio * 100, 0)}
              </Badge>
            )}
          </Row>
        </Row>
      </Card>

      {!plano ? (
        <Card padding="lg">
          <Text size="sm" tone="muted">
            Não há praças suficientes com empresas deste setor em {filtros.uf} para dividir em{" "}
            {quantidade} territórios. Escolha menos territórios, outro setor, ou o Brasil inteiro.
          </Text>
        </Card>
      ) : (
        <>
          <Palco>
            <MapaBrasil
              pontos={pontos}
              aoAbrirPraca={abrirPraca}
              formatarValor={numCompacto}
              folgaDireita={24}
              folgaTopo={24}
            />
          </Palco>

          {/* ─── Quadro comparativo ─────────────────────────────────── */}
          <Secao
            titulo="Territórios propostos"
            descricao={`${num(plano.pracasAtendidas)} praças com mercado, divididas por proximidade geográfica e equilibradas por potencial. Clique numa sede para abrir o Relatório de Praça.`}
          >
            <Card padding="none">
              <TabelaWrap>
                <Tabela>
                  <thead>
                    <tr>
                      <Th>Território</Th>
                      <Th>Sede sugerida</Th>
                      <Th alinhamento="direita">Praças</Th>
                      <Th alinhamento="direita">Mercado (empresas)</Th>
                      <Th alinhamento="direita">Fatia</Th>
                      <Th alinhamento="direita">População</Th>
                      <Th alinhamento="direita">Score médio</Th>
                      <Th alinhamento="direita">Raio</Th>
                      <Th alinhamento="direita">Dist. média</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {plano.territorios.map((t) => (
                      <tr key={t.indice}>
                        <Td>
                          <Row gap={2}>
                            <Faixa
                              css={{ backgroundColor: SERIES[t.indice % SERIES.length] as string }}
                            />
                            <Text size="md" tone="primary" weight="medium">
                              {t.indice + 1}
                            </Text>
                          </Row>
                        </Td>
                        <Td enfase="forte">
                          <LinhaSede
                            onClick={() => abrirPraca(t.sede.id)}
                            title="Abrir Relatório de Praça"
                          >
                            {t.sede.nome}
                            <Text as="span" size="xs" tone="muted">
                              {" "}
                              {t.sede.uf}
                            </Text>
                          </LinhaSede>
                        </Td>
                        <Td alinhamento="direita">{num(t.pracas.length)}</Td>
                        <Td alinhamento="direita" enfase="forte">
                          {num(t.mercado)}
                        </Td>
                        <Td alinhamento="direita">
                          {pct((t.mercado / plano.mercadoTotal) * 100, 1)}
                        </Td>
                        <Td alinhamento="direita">{numCompacto(t.populacao)}</Td>
                        <Td alinhamento="direita">{t.scoreMedio}</Td>
                        <Td alinhamento="direita">{num(t.raioKm)} km</Td>
                        <Td alinhamento="direita">{num(t.distanciaMediaKm)} km</Td>
                      </tr>
                    ))}
                  </tbody>
                </Tabela>
              </TabelaWrap>
            </Card>

            <Row justify="between" gap={4} wrap>
              <Text size="xs" tone="muted" css={{ maxWidth: "72ch", lineHeight: "$normal" }}>
                <strong>Raio</strong> é a maior distância em linha reta da sede até uma praça do
                território; <strong>distância média</strong> é ponderada pelo mercado — mais
                próxima do deslocamento real do vendedor. Nenhuma das duas é tempo de viagem:
                isso exigiria um motor de rotas sobre a malha viária.
              </Text>
              <Button
                variante="secundario"
                tamanho="sm"
                onClick={() => {
                  /* CSV do plano — é o formato que entra em reunião e em
                     planilha de comissão, que é onde esta decisão termina. */
                  const linhas = [
                    ["territorio", "sede", "uf", "municipio", "uf_municipio", "empresas_setor", "score"],
                    ...plano.territorios.flatMap((t) =>
                      t.pracas.map((p) => [
                        String(t.indice + 1),
                        t.sede.nome,
                        t.sede.uf,
                        p.nome,
                        p.uf,
                        String(p.setor ?? ""),
                        String(p.atratividade.score),
                      ]),
                    ),
                  ];
                  const csv = linhas
                    .map((l) => l.map((c) => `"${c.replace(/"/g, '""')}"`).join(";"))
                    .join("\n");
                  const url = URL.createObjectURL(
                    new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `territorios-${setor}-${escopo === "uf" ? filtros.uf : "BR"}-${quantidade}.csv`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Baixar CSV do plano
              </Button>
            </Row>
          </Secao>

          {/* ─── Composição de cada território ──────────────────────── */}
          <Secao
            titulo="Principais praças de cada território"
            descricao="As 5 maiores por mercado, dentro de cada divisão"
          >
            <Grid cols="auto">
              {plano.territorios.map((t) => (
                <Card key={t.indice} padding="md">
                  <Stack gap={3}>
                    <Row gap={2} align="center">
                      <Faixa
                        css={{ backgroundColor: SERIES[t.indice % SERIES.length] as string }}
                      />
                      <Text size="md" tone="primary" weight="semibold">
                        Território {t.indice + 1}
                      </Text>
                      <Badge tone="neutro">{num(t.pracas.length)} praças</Badge>
                    </Row>
                    <Stack gap={2}>
                      {t.pracas.slice(0, 5).map((p) => (
                        <Row key={p.id} justify="between" gap={3}>
                          <LinhaSede onClick={() => abrirPraca(p.id)}>
                            <Text size="sm" clamp={1}>
                              {p.nome}
                              <Text as="span" size="xs" tone="muted">
                                {" "}
                                {p.uf}
                              </Text>
                            </Text>
                          </LinhaSede>
                          <Text size="sm" tone="primary" mono>
                            {numCompacto(p.setor)}
                          </Text>
                        </Row>
                      ))}
                      {t.pracas.length > 5 && (
                        <Text size="xs" tone="muted">
                          + {num(t.pracas.length - 5)} praças menores
                        </Text>
                      )}
                    </Stack>
                  </Stack>
                </Card>
              ))}
            </Grid>
          </Secao>

          {!desequilibrioOk && (
            <Card padding="md" css={{ borderColor: "rgba(250,178,25,0.34)" }}>
              <Text size="sm" tone="warning">
                O maior território tem {pct(plano.desequilibrio * 100, 0)} mais mercado que o menor.
                Acontece quando uma praça sozinha concentra fatia grande demais — dividir mais o
                mercado exigiria quebrar a compacidade geográfica, e um vendedor cruzando o estado
                custa mais do que o desequilíbrio corrige. Recortar por UF costuma resolver melhor
                que aumentar o número de territórios.
              </Text>
            </Card>
          )}
        </>
      )}
    </Stack>
  );
}
