/**
 * RelatorioPraca.tsx — o dossiê de uma praça.
 *
 * Estrutura da tela, na ordem em que a decisão é tomada:
 *   1. **quanto vale** — TAM, SAM, SOM (base real do IBGE × premissa sua);
 *   2. **como é** — população, PIB, empresas, densidade;
 *   3. **como se compara** — índice de saturação contra a mediana da UF, e a
 *      posição no ranking estadual;
 *   4. **do que é feita** — composição setorial real, das 21 seções CNAE;
 *   5. **o que isso significa** — a leitura escrita pelo motor de insights.
 *
 * Cada KPI carrega a etiqueta de procedência. Um TAM em reais é sempre "nº
 * de empresas do IBGE × ticket médio que VOCÊ arbitrou" — a tela nunca deixa
 * o usuário confundir a premissa dele com dado do IBGE.
 */
import { useMemo } from "react";
import { cargaNacional, municipiosDaUf, setoresDoMunicipio } from "../data/ibge";
import { SECOES } from "../data/cnae";
import { useAsync } from "../lib/useAsync";
import { moedaCompacta, num, numCompacto, pct } from "../lib/format";
import { analisarTerritorio, ranquear } from "../domain/territorio";
import { insightsDeCoberturaUf, insightsDeTerritorio } from "../domain/insights";
import { useFiltros } from "../app/filtros";
import { BarrasHorizontais, MolduraGrafico, type PontoBarra } from "../components/charts";
import { CardInsight, CardKpi, Secao } from "../components/cards";
import { AnaliseIA } from "../components/AnaliseIA";
import { EstadoErro, EstadoVazio, SkeletonGrafico, SkeletonKpis } from "../components/estados";
import { Badge, Card, Grid, Row, Stack, Text } from "../components/primitives";

const nomeSecao = (letra: string) => SECOES.find((s) => s.letra === letra);

const ROTULO_CLASSIFICACAO = {
  subexplorada: { texto: "Praça subexplorada", tone: "bom" },
  equilibrada: { texto: "Densidade na média da UF", tone: "neutro" },
  saturada: { texto: "Praça saturada", tone: "atencao" },
  indeterminada: { texto: "Sem comparação disponível", tone: "neutro" },
} as const;

export function RelatorioPraca() {
  const { filtros, premissas } = useFiltros();

  const nacional = useAsync(() => cargaNacional(), []);
  const setores = useAsync(
    () => setoresDoMunicipio(filtros.municipioId as number),
    [filtros.municipioId],
    { habilitado: filtros.municipioId != null },
  );

  const paresDaUf = useMemo(
    () => (nacional.dado ? municipiosDaUf(nacional.dado, filtros.uf) : []),
    [nacional.dado, filtros.uf],
  );

  const municipio = useMemo(
    () => (filtros.municipioId ? (nacional.dado?.porId.get(filtros.municipioId) ?? null) : null),
    [nacional.dado, filtros.municipioId],
  );

  const analise = useMemo(
    () => (municipio ? analisarTerritorio(municipio, paresDaUf, premissas, setores.dado) : null),
    [municipio, paresDaUf, premissas, setores.dado],
  );

  /* Posição da praça no ranking estadual por nº de empresas. */
  const posicao = useMemo(() => {
    if (!municipio) return null;
    const ordenados = [...paresDaUf]
      .filter((m) => m.empresas)
      .sort((a, b) => (b.empresas?.valor ?? 0) - (a.empresas?.valor ?? 0));
    const i = ordenados.findIndex((m) => m.id === municipio.id);
    return i >= 0 ? { posicao: i + 1, total: ordenados.length } : null;
  }, [paresDaUf, municipio]);

  const rankingUf = useMemo<PontoBarra[]>(() => {
    const top = ranquear(paresDaUf, "empresas", 12);
    const lista = top.map((r) => ({
      rotulo: r.municipio.nome,
      rotuloCompleto: `${r.municipio.nome} — ${r.municipio.uf}`,
      valor: r.valor,
    }));

    /* Se a praça selecionada não está no top 12, ela entra no fim — comparar
       com os líderes só serve se a própria praça estiver no gráfico. */
    if (municipio && !top.some((r) => r.municipio.id === municipio.id) && municipio.empresas) {
      lista.push({
        rotulo: municipio.nome,
        rotuloCompleto: `${municipio.nome} — ${municipio.uf} (praça selecionada)`,
        valor: municipio.empresas.valor,
      });
    }
    return lista;
  }, [paresDaUf, municipio]);

  const composicao = useMemo<PontoBarra[]>(() => {
    if (!setores.dado) return [];
    return setores.dado.slice(0, 12).map((s) => ({
      rotulo: nomeSecao(s.secao)?.curto ?? s.secao,
      rotuloCompleto: nomeSecao(s.secao)?.nome ?? s.secao,
      valor: s.empresas,
    }));
  }, [setores.dado]);

  const insights = useMemo(() => {
    const saida = [];
    if (analise) saida.push(...insightsDeTerritorio(analise, paresDaUf, setores.dado));
    if (paresDaUf.length) saida.push(...insightsDeCoberturaUf(filtros.uf, paresDaUf));
    return saida;
  }, [analise, paresDaUf, setores.dado, filtros.uf]);

  /* O payload mandado ao modelo: exatamente os números que a tela mostra,
     nada além. Se um valor não está aqui, o modelo é instruído a dizer que
     não está disponível em vez de estimar. */
  const fatosParaIA = useMemo(() => {
    if (!analise) return null;
    return {
      municipio: analise.municipio.nome,
      uf: analise.municipio.uf,
      codigo_ibge: analise.municipio.id,
      populacao: analise.populacao.valor,
      populacao_ano: analise.populacao.ano,
      pib_total_reais: analise.pib.valor,
      pib_ano: analise.pib.ano,
      pib_per_capita_reais: analise.pibPerCapita.valor,
      empresas_total: analise.empresas.valor,
      empresas_ano: analise.empresas.ano,
      densidade_empresas_por_1000_hab: analise.densidade.valor,
      indice_saturacao_vs_mediana_da_uf: analise.indiceSaturacao.valor,
      classificacao_da_praca: analise.classificacao,
      posicao_no_ranking_da_uf: posicao
        ? `${posicao.posicao}ª de ${posicao.total}`
        : null,
      composicao_setorial: (setores.dado ?? []).slice(0, 6).map((x) => ({
        secao: `${x.secao} — ${nomeSecao(x.secao)?.nome ?? x.secao}`,
        empresas: x.empresas,
      })),
      tam_reais: analise.tam.valor,
      sam_reais: analise.sam.valor,
      som_reais: analise.som.valor,
      premissas_do_usuario: {
        ticket_medio_anual_reais: premissas.ticketMedioAnual,
        share_alvo: premissas.shareAlvo,
        secoes_cnae_alvo: premissas.secoesAlvo,
      },
      fonte: "IBGE — CEMPRE 9418/2585, PIB 5938/37, população 6579/9324",
    };
  }, [analise, posicao, setores.dado, premissas]);

  if (nacional.erro) return <EstadoErro erro={nacional.erro} aoTentar={nacional.recarregar} />;

  if (!filtros.municipioId) {
    return (
      <EstadoVazio
        titulo="Escolha uma praça"
        descricao={
          nacional.carregando
            ? "Carregando os 5.570 municípios do Brasil a partir do IBGE…"
            : `Selecione um município de ${filtros.uf} no filtro do cabeçalho para abrir o relatório completo: TAM, SAM, SOM, densidade empresarial, índice de saturação e composição setorial.`
        }
      />
    );
  }

  if (nacional.carregando || !analise) return <SkeletonKpis quantidade={4} />;

  const classificacao = ROTULO_CLASSIFICACAO[analise.classificacao];
  const totalSetores = setores.dado?.reduce((s, x) => s + x.empresas, 0) ?? null;

  return (
    <Stack gap={7}>
      {/* ─── Identificação ──────────────────────────────────────────── */}
      <Row justify="between" align="center" gap={4} wrap>
        <Row gap={3} align="baseline" wrap>
          <Text size="xl" tone="primary" weight="bold">
            {analise.municipio.nome}
          </Text>
          <Badge tone="neutro" tamanho="md">
            {analise.municipio.uf}
          </Badge>
          <Text size="sm" tone="muted" mono>
            IBGE {analise.municipio.id}
          </Text>
        </Row>
        <Row gap={2} wrap>
          <Badge tone={classificacao.tone} tamanho="md">
            {classificacao.texto}
          </Badge>
          {posicao && (
            <Badge tone="marca" tamanho="md">
              {posicao.posicao}ª de {num(posicao.total)} praças em {filtros.uf}
            </Badge>
          )}
        </Row>
      </Row>

      {/* ─── Mercado endereçável ────────────────────────────────────── */}
      <Secao
        titulo="Mercado endereçável"
        descricao="Base de empresas real do IBGE, convertida em reais pelas premissas comerciais do cabeçalho"
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
                  ? `${num(analise.empresasAlvo.valor)} empresas nas ${filtros.secoes.length} seções-alvo`
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

      {/* ─── Perfil da praça ────────────────────────────────────────── */}
      <Secao titulo="Perfil da praça" descricao="Todos os números desta faixa vêm direto do IBGE">
        <Grid cols="auto">
          <CardKpi
            rotulo="População"
            valor={num(analise.populacao.valor)}
            metrica={analise.populacao}
            textura="texture.grid"
          />
          <CardKpi
            rotulo="PIB municipal"
            valor={moedaCompacta(analise.pib.valor)}
            metrica={analise.pib}
            textura="texture.contour"
          />
          <CardKpi
            rotulo="PIB per capita"
            valor={moedaCompacta(analise.pibPerCapita.valor)}
            metrica={analise.pibPerCapita}
            textura="texture.grid"
          />
          <CardKpi
            rotulo="Empresas ativas"
            valor={num(analise.empresas.valor)}
            metrica={analise.empresas}
            textura="texture.mesh"
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
            textura="texture.contour"
          />
          <CardKpi
            rotulo="Índice de saturação"
            valor={num(analise.indiceSaturacao.valor, 2)}
            metrica={analise.indiceSaturacao}
            textura="texture.mesh"
            nota="1,00 = exatamente a mediana da UF"
          />
        </Grid>
      </Secao>

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
            destaque={analise.municipio.nome}
          />
        </MolduraGrafico>
      </Grid>

      {/* ─── Insights ───────────────────────────────────────────────── */}
      {insights.length > 0 && (
        <Secao
          titulo="Inteligência Analítica"
          descricao="O que os números desta praça dizem, com a evidência de cada afirmação"
        >
          <AnaliseIA
            contexto={`Relatório de Praça — ${analise.municipio.nome}/${analise.municipio.uf}`}
            fatos={fatosParaIA}
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
