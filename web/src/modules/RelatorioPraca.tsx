/**
 * RelatorioPraca.tsx — o dossiê de uma praça.
 *
 * Ordem da tela = ordem da decisão:
 *   1. **vale a pena?** — Score de Atratividade, com a conta aberta;
 *   2. **quanto vale** — TAM, SAM, SOM (base real do IBGE × premissa sua);
 *   3. **como é e como se compara** — perfil com percentil contra os pares;
 *   4. **para onde vai** — a série 2022–2024 do setor;
 *   5. **onde mais existe assim** — praças de perfil econômico semelhante;
 *   6. **o que isso significa** — leitura determinística e a redação da IA.
 *
 * Cada KPI carrega a etiqueta de procedência. Um TAM em reais é sempre "nº de
 * empresas do IBGE × ticket médio que VOCÊ arbitrou" — a tela nunca deixa o
 * usuário confundir a própria premissa com dado do IBGE.
 */
import { useMemo } from "react";
import { styled } from "../stitches.config";
import { setoresDoMunicipio } from "../data/ibge";
import { SECOES } from "../data/cnae";
import { useAsync } from "../lib/useAsync";
import { moedaCompacta, num, numCompacto, pct } from "../lib/format";
import { analisarTerritorio, ranquear } from "../domain/territorio";
import { descreverCrescimento } from "../domain/crescimento";
import { DESCRICAO_FAIXA_ATRATIVIDADE } from "../domain/atratividade";
import { pracasSemelhantes } from "../domain/similaridade";
import { insightsDeCoberturaUf, insightsDeTerritorio } from "../domain/insights";
import { useFiltros } from "../app/filtros";
import { useRota } from "../app/rotas";
import { percentilDe, posicaoDe, useUniverso } from "../app/useUniverso";
import { BarrasHorizontais, MolduraGrafico, type PontoBarra } from "../components/charts";
import { CardInsight, CardKpi, Secao } from "../components/cards";
import { AnaliseIA } from "../components/AnaliseIA";
import { Ancora, SeloTendencia, Sparkline, Trilha } from "../components/microvis";
import { EstadoErro, EstadoVazio, SkeletonGrafico, SkeletonKpis } from "../components/estados";
import { Badge, Card, Grid, Row, Stack, Text } from "../components/primitives";

const nomeSecao = (letra: string) => SECOES.find((s) => s.letra === letra);

const ROTULO_CLASSIFICACAO = {
  subexplorada: { texto: "Praça subexplorada", tone: "bom" },
  equilibrada: { texto: "Densidade na média da UF", tone: "neutro" },
  saturada: { texto: "Praça saturada", tone: "atencao" },
  indeterminada: { texto: "Sem comparação disponível", tone: "neutro" },
} as const;

const TOM_FAIXA = { A: "bom", B: "marca", C: "atencao", D: "critico" } as const;
const COR_SINAL = { positivo: "#0ca30c", neutro: "#64748b", negativo: "#d03b3b" } as const;

const BarraFator = styled("div", {
  height: 4,
  borderRadius: "$pill",
  backgroundColor: "rgba(148,163,184,0.14)",
  overflow: "hidden",
  "& > i": { display: "block", height: "100%", borderRadius: "$pill" },
});

const LinhaSemelhante = styled("button", {
  display: "flex",
  alignItems: "center",
  gap: "$3",
  width: "100%",
  px: "$3",
  py: "$3",
  border: 0,
  borderBottom: "1px solid $border",
  background: "transparent",
  cursor: "pointer",
  textAlign: "left",
  color: "$textSecondary",
  "&:last-child": { borderBottom: 0 },
  "&:hover": { backgroundColor: "$surfaceHover", color: "$textPrimary" },
});

export function RelatorioPraca() {
  const { filtros, premissas, definir } = useFiltros();
  const [, navegar] = useRota();

  const setorAlvo = filtros.secoes[0] ?? "G";
  const { universo, carregando, erro, recarregar } = useUniverso(setorAlvo);

  const setores = useAsync(
    () => setoresDoMunicipio(filtros.municipioId as number),
    [filtros.municipioId],
    { habilitado: filtros.municipioId != null },
  );

  const praca = filtros.municipioId ? (universo.porId.get(filtros.municipioId) ?? null) : null;

  const paresDaUf = useMemo(
    () => universo.pracas.filter((p) => p.uf === filtros.uf),
    [universo.pracas, filtros.uf],
  );

  const analise = useMemo(
    () =>
      praca
        ? analisarTerritorio(
            praca.bruto,
            paresDaUf.map((p) => p.bruto),
            premissas,
            setores.dado,
          )
        : null,
    [praca, paresDaUf, premissas, setores.dado],
  );

  /* Âncoras: percentil e posição da praça contra os pares do próprio estado.
     É o que transforma "1.201.528 empresas" em "a maior de 645". */
  const ancoras = useMemo(() => {
    if (!praca || paresDaUf.length < 2) return null;
    const col = (ler: (p: (typeof paresDaUf)[number]) => number | null) => paresDaUf.map(ler);
    const par = (v: number | null, vals: (number | null)[]) => ({
      pct: percentilDe(v, vals),
      pos: posicaoDe(v, vals),
    });
    return {
      universo: `${num(paresDaUf.length)} municípios de ${filtros.uf}`,
      setor: par(praca.setor, col((p) => p.setor)),
      empresas: par(praca.empresasTotal, col((p) => p.empresasTotal)),
      populacao: par(praca.populacao, col((p) => p.populacao)),
      pibPerCapita: par(praca.pibPerCapita, col((p) => p.pibPerCapita)),
      densidade: par(praca.densidade, col((p) => p.densidade)),
      atratividade: par(
        praca.atratividade.score,
        col((p) => p.atratividade.score),
      ),
    };
  }, [praca, paresDaUf, filtros.uf]);

  const semelhantes = useMemo(
    () => (praca ? pracasSemelhantes(praca.id, universo.paraSimilaridade, 6) : []),
    [praca, universo.paraSimilaridade],
  );

  const rankingUf = useMemo<PontoBarra[]>(() => {
    const top = ranquear(
      paresDaUf.map((p) => p.bruto),
      "empresas",
      12,
    );
    const lista = top.map((r) => ({
      rotulo: r.municipio.nome,
      rotuloCompleto: `${r.municipio.nome} — ${r.municipio.uf}`,
      valor: r.valor,
    }));
    if (praca && !top.some((r) => r.municipio.id === praca.id) && praca.empresasTotal) {
      lista.push({
        rotulo: praca.nome,
        rotuloCompleto: `${praca.nome} — ${praca.uf} (praça selecionada)`,
        valor: praca.empresasTotal,
      });
    }
    return lista;
  }, [paresDaUf, praca]);

  const composicao = useMemo<PontoBarra[]>(
    () =>
      (setores.dado ?? []).slice(0, 12).map((s) => ({
        rotulo: nomeSecao(s.secao)?.curto ?? s.secao,
        rotuloCompleto: nomeSecao(s.secao)?.nome ?? s.secao,
        valor: s.empresas,
      })),
    [setores.dado],
  );

  const insights = useMemo(() => {
    const saida = [];
    if (analise)
      saida.push(
        ...insightsDeTerritorio(
          analise,
          paresDaUf.map((p) => p.bruto),
          setores.dado,
        ),
      );
    if (paresDaUf.length)
      saida.push(
        ...insightsDeCoberturaUf(
          filtros.uf,
          paresDaUf.map((p) => p.bruto),
        ),
      );
    return saida;
  }, [analise, paresDaUf, setores.dado, filtros.uf]);

  const fatosParaIA = useMemo(() => {
    if (!analise || !praca) return null;
    return {
      municipio: praca.nome,
      uf: praca.uf,
      codigo_ibge: praca.id,
      score_de_atratividade: praca.atratividade.score,
      faixa: praca.atratividade.faixa,
      fatores_do_score: praca.atratividade.fatores.map((f) => ({
        fator: f.rotulo,
        pontos: f.pontos,
        de: f.maximo,
        detalhe: f.detalhe,
      })),
      populacao: analise.populacao.valor,
      pib_total_reais: analise.pib.valor,
      pib_per_capita_reais: analise.pibPerCapita.valor,
      empresas_total: analise.empresas.valor,
      empresas_do_setor: praca.setor,
      setor: `${setorAlvo} — ${nomeSecao(setorAlvo)?.nome}`,
      serie_do_setor: praca.crescimento.serie,
      crescimento_do_setor_ao_ano_pct: praca.crescimento.cagr,
      tendencia: praca.crescimento.tendencia,
      densidade_por_1000_hab: analise.densidade.valor,
      indice_saturacao_vs_mediana_da_uf: analise.indiceSaturacao.valor,
      posicao_no_ranking_da_uf: ancoras?.empresas.pos
        ? `${ancoras.empresas.pos.posicao}ª de ${ancoras.empresas.pos.total}`
        : null,
      pracas_de_perfil_semelhante: semelhantes.slice(0, 5).map((s) => ({
        municipio: `${s.entrada.nome}/${s.entrada.uf}`,
        similaridade_pct: s.similaridade,
      })),
      tam_reais: analise.tam.valor,
      sam_reais: analise.sam.valor,
      som_reais: analise.som.valor,
      premissas_do_usuario: {
        ticket_medio_anual_reais: premissas.ticketMedioAnual,
        share_alvo: premissas.shareAlvo,
        secoes_cnae_alvo: premissas.secoesAlvo,
      },
      fonte: "IBGE — CEMPRE 9418/2585 (série 2022–2024), PIB 5938/37, população 6579/9324",
    };
  }, [analise, praca, setorAlvo, ancoras, semelhantes, premissas]);

  if (erro) return <EstadoErro erro={erro} aoTentar={recarregar} />;

  if (!filtros.municipioId) {
    return (
      <EstadoVazio
        titulo="Escolha uma praça"
        descricao={
          carregando
            ? "Carregando os 5.570 municípios do Brasil a partir do IBGE…"
            : `Selecione um município de ${filtros.uf} no filtro do cabeçalho para abrir o dossiê: Score de Atratividade, TAM/SAM/SOM, crescimento do setor e praças de perfil semelhante.`
        }
      />
    );
  }

  if (carregando || !analise || !praca) return <SkeletonKpis quantidade={4} />;

  const classificacao = ROTULO_CLASSIFICACAO[analise.classificacao];
  const totalSetores = setores.dado?.reduce((s, x) => s + x.empresas, 0) ?? null;
  const cresc = praca.crescimento;
  const descCresc = descreverCrescimento(cresc);

  return (
    <Stack gap={7}>
      <Trilha
        degraus={[
          { rotulo: "Brasil", aoIr: () => navegar("vendas") },
          { rotulo: filtros.uf, aoIr: () => navegar("geomarketing") },
          { rotulo: praca.nome },
        ]}
      />

      {/* ─── Score de Atratividade ──────────────────────────────────── */}
      <Card padding="lg" tone="brand">
        <Grid cols="1-2">
          <Stack gap={4}>
            <Stack gap={2}>
              <Row gap={3} align="baseline" wrap>
                <Text size="xl" tone="primary" weight="bold">
                  {praca.nome}
                </Text>
                <Badge tone="neutro" tamanho="md">
                  {praca.uf}
                </Badge>
                <Text size="sm" tone="muted" mono>
                  IBGE {praca.id}
                </Text>
              </Row>
              <Row gap={2} wrap>
                <Badge tone={classificacao.tone}>{classificacao.texto}</Badge>
                <SeloTendencia tendencia={cresc.tendencia} detalhe={descCresc} />
              </Row>
            </Stack>

            <Stack gap={0}>
              <Text size="xs" overline>
                Score de Atratividade
              </Text>
              <Row gap={3} align="baseline">
                <Text
                  tone="accent"
                  weight="bold"
                  css={{ fontSize: "$5xl", lineHeight: 1, letterSpacing: "$tighter" }}
                >
                  {praca.atratividade.score}
                </Text>
                <Badge tone={TOM_FAIXA[praca.atratividade.faixa]} tamanho="md">
                  Faixa {praca.atratividade.faixa}
                </Badge>
              </Row>
              <Text size="sm" tone="muted">
                {DESCRICAO_FAIXA_ATRATIVIDADE[praca.atratividade.faixa]}
              </Text>
            </Stack>

            {ancoras?.atratividade.pct != null && (
              <Ancora
                percentil={ancoras.atratividade.pct}
                posicao={ancoras.atratividade.pos?.posicao ?? null}
                total={ancoras.atratividade.pos?.total ?? null}
                universo={ancoras.universo}
              />
            )}
          </Stack>

          {/* A conta aberta — o score nunca aparece sozinho */}
          <Stack gap={3}>
            <Text size="xs" overline>
              Como este score foi formado
            </Text>
            <Grid cols="2">
              {praca.atratividade.fatores.map((f) => (
                <Stack key={f.rotulo} gap={1}>
                  <Row justify="between" align="baseline" gap={2}>
                    <Text size="sm" tone="primary" weight="medium">
                      {f.rotulo}
                    </Text>
                    <Text size="sm" tone="muted" mono>
                      {f.pontos.toFixed(1).replace(".", ",")}/{f.maximo}
                    </Text>
                  </Row>
                  <BarraFator>
                    <i
                      style={{
                        width: `${Math.max(2, (f.pontos / f.maximo) * 100)}%`,
                        background: COR_SINAL[f.sinal],
                      }}
                    />
                  </BarraFator>
                  <Text size="xs" tone="muted">
                    {f.detalhe}
                  </Text>
                </Stack>
              ))}
            </Grid>
            <Text size="xs" tone="muted">
              Cada componente é o percentil da praça entre os 5.570 municípios, ponderado pelos
              pesos fixos do produto. Não é modelo treinado — é soma ponderada de sinais reais,
              com a conta à mostra.
            </Text>
          </Stack>
        </Grid>
      </Card>

      {/* ─── Mercado endereçável ────────────────────────────────────── */}
      <Secao
        titulo="Mercado endereçável"
        descricao="Base de empresas real do IBGE, convertida em reais pelas premissas do cabeçalho"
      >
        <Grid cols="3">
          <CardKpi
            rotulo="TAM · mercado total"
            valor={moedaCompacta(analise.tam.valor)}
            metrica={analise.tam}
            destaque
            textura="texture.mesh"
            nota={`${num(analise.empresas.valor)} empresas na praça`}
          />
          <CardKpi
            rotulo="SAM · mercado servível"
            valor={moedaCompacta(analise.sam.valor)}
            metrica={analise.sam}
            textura="texture.contour"
            nota={
              analise.empresasAlvo.valor != null
                ? filtros.secoes.length
                  ? `${num(analise.empresasAlvo.valor)} empresas nas seções-alvo`
                  : "Sem filtro de CNAE — igual ao TAM"
                : "Selecione seções CNAE no cabeçalho"
            }
          />
          <CardKpi
            rotulo="SOM · mercado obtenível"
            valor={moedaCompacta(analise.som.valor)}
            metrica={analise.som}
            textura="texture.grid"
            nota={`${pct(filtros.shareAlvo * 100, 0)} de share alvo sobre o SAM`}
          />
        </Grid>
      </Secao>

      {/* ─── Perfil, com âncora e tendência ─────────────────────────── */}
      <Secao
        titulo="Perfil da praça"
        descricao={`Todos os números vêm do IBGE. A barra sob cada valor mostra a posição entre os ${num(paresDaUf.length)} municípios de ${filtros.uf}.`}
      >
        <Grid cols="auto">
          <CardKpi
            rotulo={`Empresas de ${nomeSecao(setorAlvo)?.curto ?? setorAlvo}`}
            valor={num(praca.setor)}
            textura="texture.mesh"
            serie={cresc.serie}
            tendencia={cresc.tendencia}
            detalheTendencia={descCresc}
            percentil={ancoras?.setor.pct ?? null}
            posicao={ancoras?.setor.pos?.posicao ?? null}
            totalUniverso={ancoras?.setor.pos?.total ?? null}
            universo={ancoras?.universo}
            metrica={{
              valor: praca.setor,
              procedencia: "real",
              fonte: "IBGE · CEMPRE 9418/2585, série anual",
              ano: universo.anoReferencia ?? undefined,
            }}
          />
          <CardKpi
            rotulo="Empresas ativas (todas)"
            valor={num(analise.empresas.valor)}
            metrica={analise.empresas}
            textura="texture.contour"
            percentil={ancoras?.empresas.pct ?? null}
            posicao={ancoras?.empresas.pos?.posicao ?? null}
            totalUniverso={ancoras?.empresas.pos?.total ?? null}
            universo={ancoras?.universo}
          />
          <CardKpi
            rotulo="População"
            valor={num(analise.populacao.valor)}
            metrica={analise.populacao}
            textura="texture.grid"
            percentil={ancoras?.populacao.pct ?? null}
            posicao={ancoras?.populacao.pos?.posicao ?? null}
            totalUniverso={ancoras?.populacao.pos?.total ?? null}
            universo={ancoras?.universo}
          />
          <CardKpi
            rotulo="PIB per capita"
            valor={moedaCompacta(analise.pibPerCapita.valor)}
            metrica={analise.pibPerCapita}
            textura="texture.contour"
            percentil={ancoras?.pibPerCapita.pct ?? null}
            posicao={ancoras?.pibPerCapita.pos?.posicao ?? null}
            totalUniverso={ancoras?.pibPerCapita.pos?.total ?? null}
            universo={ancoras?.universo}
          />
          <CardKpi
            rotulo="Densidade empresarial"
            valor={num(analise.densidade.valor, 1)}
            sufixo={
              <Text size="sm" tone="muted">
                por 1.000 hab
              </Text>
            }
            metrica={analise.densidade}
            textura="texture.mesh"
            percentil={ancoras?.densidade.pct ?? null}
            posicao={ancoras?.densidade.pos?.posicao ?? null}
            totalUniverso={ancoras?.densidade.pos?.total ?? null}
            universo={ancoras?.universo}
          />
          <CardKpi
            rotulo="Índice de saturação"
            valor={num(analise.indiceSaturacao.valor, 2)}
            metrica={analise.indiceSaturacao}
            textura="texture.grid"
            nota="1,00 = exatamente a mediana da UF"
          />
        </Grid>
      </Secao>

      {/* ─── Praças semelhantes ─────────────────────────────────────── */}
      {semelhantes.length > 0 && (
        <Secao
          titulo="Praças de perfil semelhante"
          descricao="Municípios com porte, poder de compra, densidade, peso e crescimento do setor parecidos — a pergunta de expansão que o ranking por volume não responde"
        >
          <Card padding="none">
            {semelhantes.map((s) => (
              <LinhaSemelhante
                key={s.entrada.id}
                onClick={() => {
                  definir("uf", s.entrada.uf);
                  definir("municipioId", s.entrada.id);
                }}
                title={`Abrir o relatório de ${s.entrada.nome}`}
              >
                <Badge
                  tone={s.similaridade >= 70 ? "bom" : s.similaridade >= 50 ? "marca" : "neutro"}
                >
                  {s.similaridade}%
                </Badge>
                <Stack gap={0} css={{ flex: 1, minWidth: 0 }}>
                  <Text size="base" tone="primary" weight="medium" clamp={1}>
                    {s.entrada.nome}
                    <Text as="span" size="sm" tone="muted">
                      {" "}
                      {s.entrada.uf}
                    </Text>
                  </Text>
                  <Text size="xs" tone="muted" clamp={1}>
                    Parecidas em: {s.maisParecidas.map((d) => d.rotulo.toLowerCase()).join(", ")}
                    {s.maiorDiferenca && ` · difere em ${s.maiorDiferenca.rotulo.toLowerCase()}`}
                  </Text>
                </Stack>
                <Stack gap={0} align="end">
                  <Text size="sm" tone="primary" mono>
                    {numCompacto(universo.porId.get(s.entrada.id)?.setor ?? null)}
                  </Text>
                  <Text size="xs" tone="muted">
                    do setor
                  </Text>
                </Stack>
                <Sparkline
                  serie={universo.porId.get(s.entrada.id)?.crescimento.serie}
                  largura={54}
                />
              </LinhaSemelhante>
            ))}
          </Card>
          <Text size="xs" tone="muted">
            Similaridade por distância padronizada (z-score) em 6 dimensões econômicas. Não inclui
            a composição setorial completa — o IBGE só publica essa quebra município a município,
            o que exigiria 5.570 requisições.
          </Text>
        </Secao>
      )}

      {/* ─── Composição e ranking ───────────────────────────────────── */}
      <Grid cols="2">
        {setores.erro ? (
          <EstadoErro erro={setores.erro} aoTentar={setores.recarregar} />
        ) : setores.carregando ? (
          <Card padding="md">
            <SkeletonGrafico altura={380} />
          </Card>
        ) : composicao.length > 0 ? (
          <MolduraGrafico
            titulo="Composição setorial da praça"
            subtitulo="As 12 maiores seções CNAE 2.0 deste município"
            fonte={`IBGE · agregado 9418 em N6 · ${num(totalSetores)} empresas classificadas`}
            altura={380}
          >
            <BarrasHorizontais
              dados={composicao}
              formatar={numCompacto}
              larguraRotulo={128}
              detalheTooltip={(p) =>
                totalSetores ? `${pct((Number(p.valor) / totalSetores) * 100, 1)} da praça` : null
              }
            />
          </MolduraGrafico>
        ) : (
          <Card padding="lg">
            <Text size="sm" tone="muted">
              O IBGE não publica a quebra setorial deste município — valores suprimidos por sigilo
              estatístico. O total de empresas continua disponível acima.
            </Text>
          </Card>
        )}

        <MolduraGrafico
          titulo={`Ranking de ${filtros.uf} por nº de empresas`}
          subtitulo="A praça selecionada aparece destacada em ciano"
          fonte={`${num(paresDaUf.length)} municípios de ${filtros.uf} · IBGE`}
          altura={380}
        >
          <BarrasHorizontais
            dados={rankingUf}
            formatar={numCompacto}
            larguraRotulo={128}
            destaque={praca.nome}
          />
        </MolduraGrafico>
      </Grid>

      {/* ─── Inteligência ───────────────────────────────────────────── */}
      {insights.length > 0 && (
        <Secao
          titulo="Inteligência Analítica"
          descricao="O que os números desta praça dizem, com a evidência de cada afirmação"
        >
          <AnaliseIA
            contexto={`Relatório de Praça — ${praca.nome}/${praca.uf}, setor ${nomeSecao(setorAlvo)?.nome}`}
            fatos={fatosParaIA}
            pronto={fatosParaIA != null}
          />
          <Grid cols="2">
            {insights.map((i) => (
              <CardInsight key={i.id} insight={i} />
            ))}
          </Grid>
        </Secao>
      )}
    </Stack>
  );
}
