/**
 * MapaTerritorial.tsx — o Brasil inteiro, um ponto por município.
 *
 * É a mesma carga do Geomarketing (um setor CNAE nos 5.570 municípios, uma
 * requisição) vista geograficamente em vez de em ranking. As duas leituras se
 * complementam: o ranking responde "quais são as maiores praças", o mapa
 * responde "onde elas estão e o que tem em volta" — que é a pergunta de quem
 * desenha território de vendedor ou rota de distribuição.
 *
 * ── De onde vêm as coordenadas ────────────────────────────────────────────
 * De `data/centroides.json`, gerado da malha territorial oficial do IBGE pelo
 * script `scripts/gerar-centroides.mjs`. Não são coordenadas de terceiros nem
 * aproximação por capital: é o centroide de área do próprio polígono do
 * município. O script é versionado para poder ser auditado e regerado.
 *
 * ── O que a bolinha diz ───────────────────────────────────────────────────
 *   tamanho → volume da métrica escolhida (empresas do setor, população, PIB)
 *   cor     → Score de Atratividade, ou saturação — escolhido no painel
 *
 * As duas escalas de cor existem porque respondem a perguntas diferentes:
 * atratividade é "por onde começar" (sequencial, sem meio); saturação é "quão
 * disputada está" (divergente, com a mediana da UF no centro).
 */
import { useCallback, useMemo, useState } from "react";
import { styled } from "../stitches.config";
import { ufDoCodigo } from "../data/ibge";
import { SECOES } from "../data/cnae";
import dadosCentroides from "../data/centroides.json";
import { moedaCompacta, num, numCompacto, pct } from "../lib/format";
import { descreverCrescimento } from "../domain/crescimento";
import { DESCRICAO_FAIXA_ATRATIVIDADE } from "../domain/atratividade";
import { useUniverso } from "../app/useUniverso";
import { useFiltros } from "../app/filtros";
import { useRota } from "../app/rotas";
import {
  MapaBrasil,
  corDeAtratividade,
  corDeSaturacao,
  type PontoMapa,
} from "../components/MapaBrasil";
import { EstadoErro, LinhaCarregando } from "../components/estados";
import { Sparkline } from "../components/microvis";
import { Badge, Card, Row, Select, Stack, Text } from "../components/primitives";

/* O TypeScript infere `number[]` do JSON, não a tupla — então a leitura é
   feita por índice com verificação, em vez de um cast que só silencia o
   compilador sem garantir nada em tempo de execução. */
const CENTROIDES: Record<string, number[]> = dadosCentroides.centroides;

const nomeSecao = (letra: string) => SECOES.find((s) => s.letra === letra);

/* ─── Métrica que dimensiona a bolinha ─────────────────────────────────── */

type Metrica = "setor" | "empresas" | "populacao" | "pib";

const METRICAS: Record<Metrica, { rotulo: string; formatar: (v: number) => string }> = {
  setor: { rotulo: "Empresas do setor selecionado", formatar: numCompacto },
  empresas: { rotulo: "Todas as empresas do município", formatar: numCompacto },
  populacao: { rotulo: "População", formatar: numCompacto },
  pib: { rotulo: "PIB municipal", formatar: moedaCompacta },
};

/* ─── O que a COR representa ───────────────────────────────────────────── */

type Escala = "atratividade" | "saturacao";

const ESCALAS: Record<
  Escala,
  { rotulo: string; gradiente: string; extremos: string[]; explica: string }
> = {
  atratividade: {
    rotulo: "Score de Atratividade",
    /* Sequencial: o score não tem ponto médio com significado — 50 não é
       "neutro", é metade do caminho. Divergente inventaria um eixo. */
    gradiente: "linear-gradient(90deg, #182f5c 0%, #22d3ee 100%)",
    extremos: ["Baixa", "Alta"],
    explica:
      "Volume, crescimento, poder de compra, espaço competitivo e densidade — cada um como percentil entre os 5.570 municípios.",
  },
  saturacao: {
    rotulo: "Saturação da praça",
    /* Divergente: 1,00 (mediana da UF) é um meio com significado real. */
    gradiente: "linear-gradient(90deg, #3987e5 0%, #64748b 50%, #d03b3b 100%)",
    extremos: ["Subexplorada", "Mediana da UF", "Saturada"],
    explica: "Densidade de empresas por habitante comparada à mediana do próprio estado.",
  },
};

/* ─── Layout ───────────────────────────────────────────────────────────── */

const Palco = styled("div", {
  position: "relative",
  width: "100%",
  /* O mapa quer altura. Descontar o cabeçalho e o respiro do Main dá uma tela
     cheia de verdade sem forçar rolagem na página. */
  height: "calc(100vh - 210px)",
  minHeight: 520,
});

/** Painéis sobrepostos ao mapa: translúcidos com blur, para o mapa continuar
 *  legível por baixo em vez de virar uma faixa morta. */
const sobreposto = {
  backgroundColor: "rgba(11,17,32,0.86)",
  backdropFilter: "blur(14px)",
  border: "1px solid $borderStrong",
  borderRadius: "$lg",
  boxShadow: "$lg",
} as const;

const FaixaKpis = styled("div", {
  ...sobreposto,
  position: "absolute",
  top: "$4",
  left: "$4",
  zIndex: 500, // acima dos painéis do Leaflet (400)
  display: "flex",
  padding: "$3 $2",
  maxWidth: "calc(100% - 380px)",
  overflowX: "auto",
});

const Kpi = styled("div", {
  px: "$4",
  minWidth: 124,
  borderRight: "1px solid $border",
  "&:last-child": { borderRight: 0 },
});

const Painel = styled("div", {
  ...sobreposto,
  position: "absolute",
  top: "$4",
  right: "$4",
  bottom: "$4",
  zIndex: 500,
  width: 316,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
});

const PainelTopo = styled("div", {
  padding: "$4",
  borderBottom: "1px solid $border",
  flexShrink: 0,
});

const PainelRolagem = styled("div", {
  padding: "$4",
  overflowY: "auto",
  flex: 1,
});

/** A legenda recebe o gradiente da escala ATIVA. Legenda que não bate com o
 *  desenho é pior que legenda nenhuma. */
const Gradiente = styled("div", {
  height: 8,
  borderRadius: "$pill",
});

const LinhaTop = styled("button", {
  display: "flex",
  alignItems: "center",
  gap: "$2",
  width: "100%",
  px: "$2",
  py: "$2",
  border: 0,
  borderRadius: "$sm",
  background: "transparent",
  cursor: "pointer",
  textAlign: "left",
  color: "$textSecondary",
  "&:hover": { backgroundColor: "$surfaceHover", color: "$textPrimary" },
});

const Bolinha = styled("span", {
  size: 10,
  borderRadius: "$pill",
  flexShrink: 0,
});

/* ─── Módulo ───────────────────────────────────────────────────────────── */

export function MapaTerritorial() {
  const { filtros, definir, alternarSecao } = useFiltros();
  const [, navegar] = useRota();

  const [setorManual, setSetorManual] = useState<string | null>(null);
  const [metrica, setMetrica] = useState<Metrica>("setor");
  const [escala, setEscala] = useState<Escala>("atratividade");

  const setor = setorManual ?? filtros.secoes[0] ?? "G";
  const { universo, carregando, erro, recarregar } = useUniverso(setor);

  /* O universo já traz métrica, crescimento e score prontos; aqui só sobra
     escolher o que dimensiona e o que colore. */
  const pontos = useMemo<PontoMapa[]>(() => {
    const saida: PontoMapa[] = [];

    for (const p of universo.pracas) {
      const coord = CENTROIDES[String(p.id)];
      const lat = coord?.[0];
      const lon = coord?.[1];
      if (lat == null || lon == null) continue;

      const valor =
        metrica === "setor"
          ? p.setor
          : metrica === "empresas"
            ? p.empresasTotal
            : metrica === "populacao"
              ? p.populacao
              : p.pibTotal;

      /* Sem valor na métrica escolhida, o município não vira bolinha. Desenhar
         um ponto mínimo afirmaria "aqui é quase zero", que é diferente de
         "o IBGE não publica isto aqui". */
      if (valor == null || valor <= 0) continue;

      const classificacao =
        escala === "atratividade"
          ? `${DESCRICAO_FAIXA_ATRATIVIDADE[p.atratividade.faixa]} · score ${p.atratividade.score}`
          : p.saturacao == null
            ? "Sem comparação disponível"
            : p.saturacao >= 1.2
              ? "Praça saturada — mercado disputado"
              : p.saturacao <= 0.8
                ? "Praça subexplorada — concorrência menor"
                : "Densidade na mediana da UF";

      saida.push({
        id: p.id,
        nome: p.nome,
        uf: p.uf || ufDoCodigo(p.id),
        lat,
        lon,
        valor,
        cor:
          escala === "atratividade"
            ? corDeAtratividade(p.atratividade.score)
            : corDeSaturacao(p.saturacao),
        classificacao,
        detalhes: [
          { rotulo: "Score de Atratividade", valor: `${p.atratividade.score} / 100` },
          { rotulo: `Empresas de ${nomeSecao(setor)?.curto ?? setor}`, valor: num(p.setor) },
          {
            rotulo: "Crescimento do setor",
            valor:
              p.crescimento.cagr == null
                ? "—"
                : `${p.crescimento.cagr >= 0 ? "+" : ""}${num(p.crescimento.cagr, 1)}% a.a.`,
          },
          { rotulo: "Todas as empresas", valor: num(p.empresasTotal) },
          { rotulo: "População", valor: num(p.populacao) },
          { rotulo: "PIB per capita", valor: moedaCompacta(p.pibPerCapita) },
          { rotulo: "Densidade / 1.000 hab", valor: num(p.densidade, 1) },
        ],
      });
    }

    return saida;
  }, [universo.pracas, metrica, escala, setor]);

  /* O Top 10 acompanha a escala: colorindo por atratividade, ranquear por
     volume mostraria uma lista que não explica as cores do mapa. */
  const top10 = useMemo(() => {
    return pontos
      .map((pt) => ({ pt, praca: universo.porId.get(pt.id) }))
      .sort((a, b) =>
        escala === "atratividade"
          ? (b.praca?.atratividade.score ?? 0) - (a.praca?.atratividade.score ?? 0)
          : b.pt.valor - a.pt.valor,
      )
      .slice(0, 10);
  }, [pontos, universo.porId, escala]);

  const totalSetor = useMemo(
    () => universo.pracas.reduce((s, p) => s + (p.setor ?? 0), 0),
    [universo.pracas],
  );

  /**
   * Crescimento nacional do setor.
   *
   * Soma a série de todas as praças e mede a variação do AGREGADO, em vez de
   * tirar a média dos percentuais municipais. A média daria o mesmo peso a São
   * Paulo e a um município de 300 empresas — e o país inteiro passaria a ser
   * descrito pelo comportamento das cidades pequenas, que são a maioria.
   */
  const crescimentoNacional = useMemo(() => {
    const porAno = new Map<number, number>();
    for (const p of universo.pracas) {
      for (const ponto of p.crescimento.serie) {
        porAno.set(ponto.ano, (porAno.get(ponto.ano) ?? 0) + ponto.valor);
      }
    }
    const serie = [...porAno.entries()]
      .map(([ano, valor]) => ({ ano, valor }))
      .sort((a, b) => a.ano - b.ano);
    if (serie.length < 2) return null;

    const primeiro = serie[0] as { ano: number; valor: number };
    const ultimo = serie[serie.length - 1] as { ano: number; valor: number };
    const anos = ultimo.ano - primeiro.ano;
    const cagr =
      primeiro.valor > 0 && anos > 0
        ? (Math.pow(ultimo.valor / primeiro.valor, 1 / anos) - 1) * 100
        : null;
    return { serie, cagr };
  }, [universo.pracas]);

  const para80 = useMemo(() => {
    if (!totalSetor) return null;
    const ordenado = universo.pracas.map((p) => p.setor ?? 0).sort((a, b) => b - a);
    let acumulado = 0;
    for (let i = 0; i < ordenado.length; i++) {
      acumulado += ordenado[i] as number;
      if (acumulado / totalSetor >= 0.8) return i + 1;
    }
    return null;
  }, [universo.pracas, totalSetor]);

  const abrirPraca = useCallback(
    (municipioId: number) => {
      const p = universo.porId.get(municipioId);
      if (!p) return;
      definir("uf", p.uf || ufDoCodigo(p.id));
      definir("municipioId", municipioId);
      /* Um tique depois: o efeito que grava os filtros na URL precisa rodar
         antes de `navegar`, que lê a query atual para preservá-la. */
      setTimeout(() => navegar("praca"), 0);
    },
    [universo.porId, definir, navegar],
  );

  const formatar = METRICAS[metrica].formatar;
  const conf = ESCALAS[escala];
  const lider = top10[0];

  if (erro) return <EstadoErro erro={erro} aoTentar={recarregar} />;

  return (
    <Stack gap={4}>
      <Palco>
        <MapaBrasil pontos={pontos} aoAbrirPraca={abrirPraca} formatarValor={formatar} />

        {/* ── KPIs ── */}
        <FaixaKpis>
          <Kpi>
            <Text size="xs" overline>
              Praças no mapa
            </Text>
            <Text size="lg" tone="primary" weight="bold">
              {carregando ? "—" : num(pontos.length)}
            </Text>
          </Kpi>
          <Kpi>
            <Text size="xs" overline>
              {nomeSecao(setor)?.curto ?? setor} no Brasil
            </Text>
            <Row gap={2} align="center">
              <Text size="lg" tone="accent" weight="bold">
                {carregando ? "—" : num(totalSetor)}
              </Text>
              <Sparkline serie={crescimentoNacional?.serie} largura={42} altura={18} />
            </Row>
          </Kpi>
          <Kpi>
            <Text size="xs" overline>
              Crescimento do setor
            </Text>
            <Text
              size="lg"
              weight="bold"
              tone={
                crescimentoNacional?.cagr == null
                  ? "primary"
                  : crescimentoNacional.cagr >= 0
                    ? "good"
                    : "critical"
              }
            >
              {carregando || crescimentoNacional?.cagr == null
                ? "—"
                : `${crescimentoNacional.cagr >= 0 ? "+" : ""}${num(crescimentoNacional.cagr, 1)}% a.a.`}
            </Text>
          </Kpi>
          <Kpi>
            <Text size="xs" overline>
              Praças p/ cobrir 80%
            </Text>
            <Text size="lg" tone="primary" weight="bold">
              {carregando ? "—" : num(para80)}
            </Text>
          </Kpi>
          <Kpi>
            <Text size="xs" overline>
              {escala === "atratividade" ? "Mais atrativa" : "Líder"}
            </Text>
            <Text size="lg" tone="primary" weight="bold" clamp={1}>
              {carregando || !lider ? "—" : `${lider.pt.nome}/${lider.pt.uf}`}
            </Text>
          </Kpi>
        </FaixaKpis>

        {/* ── Camadas ── */}
        <Painel>
          <PainelTopo>
            <Stack gap={4}>
              <Row justify="between" align="center">
                <Text size="xs" overline>
                  Camadas
                </Text>
                {carregando && <LinhaCarregando texto="carregando" />}
              </Row>

              <Stack gap={2}>
                <Text size="xs" tone="muted">
                  Setor CNAE
                </Text>
                <Select
                  largura="cheia"
                  tamanho="sm"
                  value={setor}
                  onChange={(e) => {
                    const letra = e.currentTarget.value;
                    setSetorManual(letra);
                    if (!filtros.secoes.includes(letra)) alternarSecao(letra);
                  }}
                >
                  {SECOES.map((s) => (
                    <option key={s.letra} value={s.letra}>
                      {s.curto}
                    </option>
                  ))}
                </Select>
              </Stack>

              <Stack gap={2}>
                <Text size="xs" tone="muted">
                  Tamanho da bolinha
                </Text>
                <Select
                  largura="cheia"
                  tamanho="sm"
                  value={metrica}
                  onChange={(e) => setMetrica(e.currentTarget.value as Metrica)}
                >
                  {(Object.keys(METRICAS) as Metrica[]).map((m) => (
                    <option key={m} value={m}>
                      {METRICAS[m].rotulo}
                    </option>
                  ))}
                </Select>
              </Stack>

              <Stack gap={2}>
                <Text size="xs" tone="muted">
                  Cor da bolinha
                </Text>
                <Select
                  largura="cheia"
                  tamanho="sm"
                  value={escala}
                  onChange={(e) => setEscala(e.currentTarget.value as Escala)}
                >
                  {(Object.keys(ESCALAS) as Escala[]).map((k) => (
                    <option key={k} value={k}>
                      {ESCALAS[k].rotulo}
                    </option>
                  ))}
                </Select>
              </Stack>
            </Stack>
          </PainelTopo>

          <PainelRolagem>
            <Stack gap={5}>
              {/* ── Legenda ── */}
              <Stack gap={2}>
                <Text size="xs" overline>
                  Cor · {conf.rotulo}
                </Text>
                <Gradiente css={{ backgroundImage: conf.gradiente }} />
                <Row justify="between">
                  {conf.extremos.map((e) => (
                    <Text key={e} size="xs" tone="muted">
                      {e}
                    </Text>
                  ))}
                </Row>
                <Text size="xs" tone="muted" css={{ lineHeight: "$normal" }}>
                  {conf.explica} O tamanho da bolinha é proporcional à <strong>área</strong>, não
                  ao raio.
                </Text>
              </Stack>

              {/* ── Top 10 ── */}
              <Stack gap={2}>
                <Text size="xs" overline>
                  Top 10 por {escala === "atratividade" ? "atratividade" : "volume"}
                </Text>
                {carregando ? (
                  <Text size="sm" tone="muted">
                    Carregando o IBGE…
                  </Text>
                ) : (
                  <Stack gap={0}>
                    {top10.map((x, i) => (
                      <LinhaTop
                        key={x.pt.id}
                        onClick={() => abrirPraca(x.pt.id)}
                        title={
                          x.praca
                            ? descreverCrescimento(x.praca.crescimento)
                            : "Abrir Relatório de Praça"
                        }
                      >
                        <Text size="xs" tone="muted" mono css={{ width: 14 }}>
                          {i + 1}
                        </Text>
                        <Bolinha css={{ backgroundColor: x.pt.cor }} />
                        <Text size="sm" clamp={1} css={{ flex: 1 }}>
                          {x.pt.nome}
                          <Text as="span" size="xs" tone="muted">
                            {" "}
                            {x.pt.uf}
                          </Text>
                        </Text>
                        <Sparkline serie={x.praca?.crescimento.serie} largura={38} altura={16} />
                        <Text size="sm" tone="primary" weight="medium" mono>
                          {escala === "atratividade"
                            ? (x.praca?.atratividade.score ?? 0)
                            : formatar(x.pt.valor)}
                        </Text>
                      </LinhaTop>
                    ))}
                  </Stack>
                )}
              </Stack>
            </Stack>
          </PainelRolagem>
        </Painel>
      </Palco>

      {/* ── Rodapé de procedência ── */}
      <Card padding="sm" tone="sunken">
        <Row justify="between" gap={4} wrap>
          <Text size="xs" tone="muted">
            Coordenadas: malha territorial municipal do IBGE (centroide de área).{" "}
            {dadosCentroides._gerado_em && `Gerada em ${dadosCentroides._gerado_em}.`} Métricas:
            CEMPRE 9418/2585 (série 2022–2024), PIB 5938/37, população 6579/9324.
          </Text>
          <Row gap={2}>
            <Badge tone="neutro">{num(pontos.length)} de 5.570 municípios com dado</Badge>
            {totalSetor > 0 && metrica === "setor" && escala === "saturacao" && (
              <Badge tone="acento">
                {pct((top10.reduce((s, x) => s + x.pt.valor, 0) / totalSetor) * 100, 1)} nas 10
                maiores
              </Badge>
            )}
          </Row>
        </Row>
      </Card>
    </Stack>
  );
}
