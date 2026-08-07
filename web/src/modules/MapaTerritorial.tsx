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
 *   cor     → saturação da praça contra a mediana da própria UF
 *
 * Comparar com a mediana estadual, e não com um corte absoluto, é o que faz a
 * leitura valer no país inteiro: 30 empresas por mil habitantes é denso no
 * Maranhão e ralo em Santa Catarina.
 */
import { useCallback, useMemo, useState } from "react";
import { styled } from "../stitches.config";
import { cargaNacional, municipiosDoSetor, ufDoCodigo } from "../data/ibge";
import { SECOES } from "../data/cnae";
import dadosCentroides from "../data/centroides.json";
import { useAsync } from "../lib/useAsync";
import { moedaCompacta, num, numCompacto, pct } from "../lib/format";
import { densidadeDe, mediana } from "../domain/territorio";
import { useFiltros } from "../app/filtros";
import { useRota } from "../app/rotas";
import { MapaBrasil, corDeSaturacao, type PontoMapa } from "../components/MapaBrasil";
import { EstadoErro, LinhaCarregando } from "../components/estados";
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
  minWidth: 128,
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

const Gradiente = styled("div", {
  height: 8,
  borderRadius: "$pill",
  /* Os mesmos três polos de `corDeSaturacao` — a legenda não pode divergir
     da escala que pinta as bolinhas. */
  backgroundImage: "linear-gradient(90deg, #3987e5 0%, #64748b 50%, #d03b3b 100%)",
});

const LinhaTop = styled("button", {
  display: "flex",
  alignItems: "center",
  gap: "$3",
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

  const setor = setorManual ?? filtros.secoes[0] ?? "G";

  const doSetor = useAsync(() => municipiosDoSetor(setor), [setor]);
  const nacional = useAsync(() => cargaNacional(), []);

  /* ── Monta os pontos ── */
  const pontos = useMemo<PontoMapa[]>(() => {
    if (!doSetor.dado || !nacional.dado) return [];

    /* Mediana de densidade por UF, calculada uma vez — sem isto, cada um dos
       5.570 municípios varreria os pares do próprio estado. */
    const porUf = new Map<string, number[]>();
    for (const m of nacional.dado.municipios) {
      const d = densidadeDe(m);
      if (d == null) continue;
      const uf = m.uf || ufDoCodigo(m.id);
      const lista = porUf.get(uf) ?? [];
      lista.push(d);
      porUf.set(uf, lista);
    }
    const medianaPorUf = new Map<string, number>();
    for (const [uf, ds] of porUf) {
      const med = mediana(ds);
      if (med && med > 0) medianaPorUf.set(uf, med);
    }

    const empresasDoSetor = new Map(
      doSetor.dado.map((m) => [m.id, m.empresas?.valor ?? null]),
    );

    const saida: PontoMapa[] = [];

    for (const m of nacional.dado.municipios) {
      const coord = CENTROIDES[String(m.id)];
      const lat = coord?.[0];
      const lon = coord?.[1];
      if (lat == null || lon == null) continue;

      const doSetorAqui = empresasDoSetor.get(m.id) ?? null;
      const valor =
        metrica === "setor"
          ? doSetorAqui
          : metrica === "empresas"
            ? (m.empresas?.valor ?? null)
            : metrica === "populacao"
              ? (m.populacao?.valor ?? null)
              : (m.pibTotal?.valor ?? null);

      /* Sem valor na métrica escolhida, o município não vira bolinha. Desenhar
         um ponto mínimo afirmaria "aqui é quase zero", que é diferente de
         "o IBGE não publica isto aqui". */
      if (valor == null || valor <= 0) continue;

      const uf = m.uf || ufDoCodigo(m.id);
      const densidade = densidadeDe(m);
      const med = medianaPorUf.get(uf);
      const saturacao = densidade != null && med ? densidade / med : null;

      const classificacao =
        saturacao == null
          ? "Sem comparação disponível"
          : saturacao >= 1.2
            ? "Praça saturada — mercado disputado"
            : saturacao <= 0.8
              ? "Praça subexplorada — concorrência menor"
              : "Densidade na mediana da UF";

      saida.push({
        id: m.id,
        nome: m.nome,
        uf,
        lat,
        lon,
        valor,
        saturacao,
        classificacao,
        detalhes: [
          {
            rotulo: `Empresas de ${nomeSecao(setor)?.curto ?? setor}`,
            valor: num(doSetorAqui),
          },
          { rotulo: "Todas as empresas", valor: num(m.empresas?.valor) },
          { rotulo: "População", valor: num(m.populacao?.valor) },
          { rotulo: "PIB municipal", valor: moedaCompacta(m.pibTotal?.valor) },
          { rotulo: "Densidade / 1.000 hab", valor: num(densidade, 1) },
          { rotulo: "Índice de saturação", valor: num(saturacao, 2) },
        ],
      });
    }

    return saida;
  }, [doSetor.dado, nacional.dado, metrica, setor]);

  const top10 = useMemo(
    () => [...pontos].sort((a, b) => b.valor - a.valor).slice(0, 10),
    [pontos],
  );

  const totalSetor = useMemo(
    () => doSetor.dado?.reduce((s, m) => s + (m.empresas?.valor ?? 0), 0) ?? null,
    [doSetor.dado],
  );

  const para80 = useMemo(() => {
    if (!doSetor.dado || !totalSetor) return null;
    let acumulado = 0;
    for (let i = 0; i < doSetor.dado.length; i++) {
      acumulado += doSetor.dado[i]?.empresas?.valor ?? 0;
      if (acumulado / totalSetor >= 0.8) return i + 1;
    }
    return null;
  }, [doSetor.dado, totalSetor]);

  /** Leva a praça clicada para o Relatório, com o contexto de filtro junto. */
  const abrirPraca = useCallback(
    (municipioId: number) => {
      const p = pontos.find((x) => x.id === municipioId);
      if (!p) return;
      definir("uf", p.uf);
      definir("municipioId", municipioId);
      /* Um tique depois: o efeito que grava os filtros na URL precisa rodar
         antes de `navegar`, que lê a query atual para preservá-la. */
      setTimeout(() => navegar("praca"), 0);
    },
    [pontos, definir, navegar],
  );

  const formatar = METRICAS[metrica].formatar;
  const carregando = doSetor.carregando || nacional.carregando;
  const erro = doSetor.erro ?? nacional.erro;

  if (erro) {
    return (
      <EstadoErro
        erro={erro}
        aoTentar={() => {
          doSetor.recarregar();
          nacional.recarregar();
        }}
      />
    );
  }

  const lider = top10[0];

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
            <Text size="lg" tone="accent" weight="bold">
              {carregando ? "—" : num(totalSetor)}
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
              Líder
            </Text>
            <Text size="lg" tone="primary" weight="bold" clamp={1}>
              {carregando || !lider ? "—" : `${lider.nome}/${lider.uf}`}
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
            </Stack>
          </PainelTopo>

          <PainelRolagem>
            <Stack gap={5}>
              {/* ── Legenda ── */}
              <Stack gap={2}>
                <Text size="xs" overline>
                  Cor · saturação da praça
                </Text>
                <Gradiente />
                <Row justify="between">
                  <Text size="xs" tone="muted">
                    Subexplorada
                  </Text>
                  <Text size="xs" tone="muted">
                    Mediana da UF
                  </Text>
                  <Text size="xs" tone="muted">
                    Saturada
                  </Text>
                </Row>
                <Text size="xs" tone="muted" css={{ lineHeight: "$normal" }}>
                  Densidade de empresas por habitante comparada à mediana do próprio estado. O
                  tamanho da bolinha é proporcional à <strong>área</strong>, não ao raio.
                </Text>
              </Stack>

              {/* ── Top 10 ── */}
              <Stack gap={2}>
                <Text size="xs" overline>
                  Top 10 praças
                </Text>
                {carregando ? (
                  <Text size="sm" tone="muted">
                    Carregando o IBGE…
                  </Text>
                ) : (
                  <Stack gap={0}>
                    {top10.map((p, i) => (
                      <LinhaTop key={p.id} onClick={() => abrirPraca(p.id)} title="Abrir Relatório de Praça">
                        <Text size="xs" tone="muted" mono css={{ width: 16 }}>
                          {i + 1}
                        </Text>
                        <Bolinha css={{ backgroundColor: corDeSaturacao(p.saturacao) }} />
                        <Text size="sm" clamp={1} css={{ flex: 1 }}>
                          {p.nome}
                          <Text as="span" size="xs" tone="muted">
                            {" "}
                            {p.uf}
                          </Text>
                        </Text>
                        <Text size="sm" tone="primary" weight="medium" mono>
                          {formatar(p.valor)}
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
            CEMPRE 9418/2585, PIB 5938/37, população 6579/9324.
          </Text>
          <Row gap={2}>
            <Badge tone="neutro">{num(pontos.length)} de 5.570 municípios com dado</Badge>
            {totalSetor != null && pontos.length > 0 && metrica === "setor" && (
              <Badge tone="acento">
                {pct((top10.reduce((s, p) => s + p.valor, 0) / totalSetor) * 100, 1)} nas 10
                maiores
              </Badge>
            )}
          </Row>
        </Row>
      </Card>
    </Stack>
  );
}
