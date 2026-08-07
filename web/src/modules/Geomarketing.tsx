/**
 * Geomarketing.tsx — onde as empresas do setor estão, no Brasil inteiro.
 *
 * A requisição central é `municipiosDoSetor`: **uma seção CNAE nos 5.570
 * municípios do país, numa chamada só** (~680KB). É o que permite responder
 * "onde estão os comércios do Brasil" sem 5.570 requisições.
 *
 * Duas leituras diferentes do mesmo dado, lado a lado:
 *   • o **ranking** mostra volume — onde há mais empresas;
 *   • a **curva de cobertura** mostra esforço — quantas praças é preciso
 *     cobrir para alcançar 80% do setor.
 * Ranking sozinho leva a operação a São Paulo e para por aí. A curva é o que
 * revela se o mercado é concentrado ou uma cauda longa cara de atender.
 */
import { useMemo, useState } from "react";
import {
  cargaNacional,
  municipiosDaUf,
  municipiosDoSetor,
  setoresDoBrasil,
} from "../data/ibge";
import { SECOES } from "../data/cnae";
import { useAsync } from "../lib/useAsync";
import { num, numCompacto, pct } from "../lib/format";
import { densidadeDe, mediana } from "../domain/territorio";
import { insightsDeCoberturaUf, insightsNacionais } from "../domain/insights";
import { useFiltros } from "../app/filtros";
import {
  AreaAcumulada,
  BarrasHorizontais,
  Dispersao,
  MolduraGrafico,
  type PontoBarra,
  type PontoDispersao,
} from "../components/charts";
import { CardInsight, CardKpi, Secao } from "../components/cards";
import { AnaliseIA } from "../components/AnaliseIA";
import { EstadoErro, LinhaCarregando, SkeletonGrafico, SkeletonKpis } from "../components/estados";
import { Badge, Card, Chip, Grid, Row, Stack, Text } from "../components/primitives";

const nomeSecao = (letra: string) => SECOES.find((s) => s.letra === letra);

export function Geomarketing() {
  const { filtros, alternarSecao } = useFiltros();
  const [focoManual, setFocoManual] = useState<string | null>(null);

  const brasil = useAsync(() => setoresDoBrasil(), []);
  const setor = focoManual ?? filtros.secoes[0] ?? "G";

  /* ~680KB por setor. Só dispara quando há setor definido, e o cache impede
     recarregar ao voltar para a tela. */
  const municipios = useAsync(() => municipiosDoSetor(setor), [setor]);
  const nacional = useAsync(() => cargaNacional(), []);

  const totalSetor = useMemo(
    () => municipios.dado?.reduce((s, m) => s + (m.empresas?.valor ?? 0), 0) ?? null,
    [municipios.dado],
  );

  /* ─── Ranking nacional ──────────────────────────────────────────── */
  const ranking = useMemo<PontoBarra[]>(() => {
    if (!municipios.dado) return [];
    return municipios.dado.slice(0, 15).map((m) => ({
      rotulo: `${m.nome}/${m.uf}`,
      rotuloCompleto: `${m.nome} — ${m.uf}`,
      valor: m.empresas?.valor ?? 0,
    }));
  }, [municipios.dado]);

  /* ─── Curva de cobertura ────────────────────────────────────────── */
  const curva = useMemo(() => {
    if (!municipios.dado || !totalSetor) return { pontos: [], para80: null as number | null };

    const pontos: { x: number; y: number; rotuloCompleto: string }[] = [];
    let acumulado = 0;
    let para80: number | null = null;

    municipios.dado.forEach((m, i) => {
      acumulado += m.empresas?.valor ?? 0;
      const pctAcum = (acumulado / totalSetor) * 100;
      if (para80 === null && pctAcum >= 80) para80 = i + 1;

      /* Amostrar a curva: 5.570 pontos no SVG travariam o hover sem
         acrescentar informação nenhuma — a curva é suave. */
      if (i < 60 || i % 25 === 0 || i === municipios.dado!.length - 1) {
        pontos.push({
          x: i + 1,
          y: pctAcum,
          rotuloCompleto: `${i + 1} municípios · ${m.nome}/${m.uf}`,
        });
      }
    });

    return { pontos, para80 };
  }, [municipios.dado, totalSetor]);

  /* ─── Dispersão da UF selecionada ───────────────────────────────── */
  const dispersao = useMemo(() => {
    if (!nacional.dado) return { pontos: [] as PontoDispersao[], medX: undefined, medY: undefined };

    const daUf = municipiosDaUf(nacional.dado, filtros.uf);
    const pontos: PontoDispersao[] = [];

    for (const m of daUf) {
      const d = densidadeDe(m);
      const pibPc =
        m.pibTotal && m.populacao && m.populacao.valor > 0
          ? m.pibTotal.valor / m.populacao.valor
          : null;
      if (d == null || pibPc == null) continue;
      pontos.push({
        x: pibPc,
        y: d,
        z: m.populacao?.valor ?? 0,
        rotuloCompleto: m.nome,
        destacado: m.id === filtros.municipioId,
      });
    }

    return {
      pontos,
      medX: mediana(pontos.map((p) => p.x)) ?? undefined,
      medY: mediana(pontos.map((p) => p.y)) ?? undefined,
    };
  }, [nacional.dado, filtros.uf, filtros.municipioId]);

  const municipiosDaUfSelecionada = useMemo(
    () => (nacional.dado ? municipiosDaUf(nacional.dado, filtros.uf) : []),
    [nacional.dado, filtros.uf],
  );

  const insights = useMemo(() => {
    const saida = [];
    if (brasil.dado && municipios.dado)
      saida.push(...insightsNacionais(brasil.dado, setor, municipios.dado));
    if (municipiosDaUfSelecionada.length)
      saida.push(...insightsDeCoberturaUf(filtros.uf, municipiosDaUfSelecionada));
    return saida;
  }, [brasil.dado, municipios.dado, setor, municipiosDaUfSelecionada, filtros.uf]);

  const fatosParaIA = useMemo(() => {
    if (!municipios.dado || !totalSetor) return null;
    return {
      setor: `${setor} — ${nomeSecao(setor)?.nome ?? setor}`,
      total_de_empresas_do_setor_no_brasil: totalSetor,
      municipios_com_presenca: municipios.dado.filter((m) => m.empresas).length,
      municipios_avaliados: municipios.dado.length,
      municipios_para_cobrir_80_por_cento: curva.para80,
      top_15_pracas: municipios.dado.slice(0, 15).map((m) => ({
        municipio: `${m.nome}/${m.uf}`,
        empresas: m.empresas?.valor ?? null,
      })),
      uf_em_analise: filtros.uf,
      municipios_da_uf_avaliados: municipiosDaUfSelecionada.length,
      fonte: "IBGE — CEMPRE agregado 9418/2585, nível municipal (N6)",
    };
  }, [municipios.dado, totalSetor, curva.para80, setor, filtros.uf, municipiosDaUfSelecionada]);

  const comValor = municipios.dado?.filter((m) => m.empresas).length ?? 0;
  const ano = municipios.dado?.[0]?.empresas?.ano;

  return (
    <Stack gap={7}>
      {/* ─── Seletor de setor ───────────────────────────────────────── */}
      <Card padding="md">
        <Stack gap={3}>
          <Row justify="between" align="center" gap={4} wrap>
            <Stack gap={1}>
              <Text size="xs" overline>
                Setor analisado
              </Text>
              <Text size="sm" tone="muted">
                Uma requisição traz este setor nos 5.570 municípios do Brasil
              </Text>
            </Stack>
            {municipios.carregando && <LinhaCarregando texto="Consultando o IBGE…" />}
          </Row>
          <Row gap={2} wrap>
            {SECOES.map((s) => (
              <Chip
                key={s.letra}
                ativo={s.letra === setor}
                title={s.nome}
                onClick={() => {
                  setFocoManual(s.letra);
                  if (!filtros.secoes.includes(s.letra)) alternarSecao(s.letra);
                }}
              >
                {s.curto}
              </Chip>
            ))}
          </Row>
        </Stack>
      </Card>

      {municipios.erro ? (
        <EstadoErro erro={municipios.erro} aoTentar={municipios.recarregar} />
      ) : (
        <>
          {/* ─── KPIs ──────────────────────────────────────────────── */}
          {municipios.carregando ? (
            <SkeletonKpis quantidade={4} />
          ) : (
            <Grid cols="auto">
              <CardKpi
                rotulo={`Empresas de ${nomeSecao(setor)?.curto ?? setor} no Brasil`}
                valor={num(totalSetor)}
                destaque
                textura="texture.mesh"
                metrica={{
                  valor: totalSetor,
                  procedencia: "real",
                  fonte: "IBGE · CEMPRE 9418/2585, seção CNAE",
                  ano,
                }}
              />
              <CardKpi
                rotulo="Municípios com presença"
                valor={num(comValor)}
                textura="texture.grid"
                nota={`de ${num(municipios.dado?.length)} municípios do país`}
                metrica={{
                  valor: comValor,
                  procedencia: "real",
                  fonte: "municípios com valor publicado pelo IBGE",
                }}
              />
              <CardKpi
                rotulo="Praças para cobrir 80%"
                valor={num(curva.para80)}
                textura="texture.contour"
                nota={
                  curva.para80 && municipios.dado
                    ? `${pct((curva.para80 / municipios.dado.length) * 100, 1)} das praças concentram 80% do setor`
                    : undefined
                }
                metrica={{
                  valor: curva.para80,
                  procedencia: "derivado",
                  fonte: "curva acumulada sobre o ranking do IBGE",
                }}
              />
              <CardKpi
                rotulo="Líder nacional"
                valor={
                  municipios.dado?.[0]
                    ? `${numCompacto(municipios.dado[0].empresas?.valor)}`
                    : "—"
                }
                textura="texture.mesh"
                nota={
                  municipios.dado?.[0]
                    ? `${municipios.dado[0].nome}/${municipios.dado[0].uf}${
                        totalSetor
                          ? ` · ${pct(((municipios.dado[0].empresas?.valor ?? 0) / totalSetor) * 100, 1)} do país`
                          : ""
                      }`
                    : undefined
                }
                metrica={{ valor: null, procedencia: "real", fonte: "IBGE · CEMPRE", ano }}
              />
            </Grid>
          )}

          {/* ─── Ranking + curva ───────────────────────────────────── */}
          <Grid cols="2">
            {municipios.carregando ? (
              <Card padding="md">
                <SkeletonGrafico altura={420} />
              </Card>
            ) : (
              <MolduraGrafico
                titulo="Top 15 praças do setor no Brasil"
                subtitulo={`${nomeSecao(setor)?.nome ?? setor}`}
                fonte={`IBGE · agregado 9418, nível municipal (N6) · referência ${ano}`}
                altura={420}
              >
                <BarrasHorizontais
                  dados={ranking}
                  formatar={numCompacto}
                  larguraRotulo={150}
                  detalheTooltip={(p) =>
                    totalSetor ? `${pct((Number(p.valor) / totalSetor) * 100, 2)} do total nacional` : null
                  }
                />
              </MolduraGrafico>
            )}

            {municipios.carregando ? (
              <Card padding="md">
                <SkeletonGrafico altura={420} />
              </Card>
            ) : (
              <MolduraGrafico
                titulo="Curva de cobertura"
                subtitulo="Quantos municípios é preciso atender para alcançar X% do setor"
                fonte="Curva acumulada sobre o ranking municipal do IBGE"
                altura={420}
                acoes={
                  curva.para80 != null && (
                    <Badge tone="acento" tamanho="md">
                      80% em {num(curva.para80)} praças
                    </Badge>
                  )
                }
              >
                <AreaAcumulada
                  dados={curva.pontos}
                  nomeX="Municípios ordenados por volume de empresas"
                  formatarY={(v) => `${Math.round(v)}%`}
                  marcos={[
                    { y: 50, rotulo: "50%" },
                    { y: 80, rotulo: "80%" },
                  ]}
                />
              </MolduraGrafico>
            )}
          </Grid>

          {/* ─── Dispersão da UF ───────────────────────────────────── */}
          <Secao
            titulo={`Perfil das praças de ${filtros.uf}`}
            descricao="Riqueza por habitante contra densidade empresarial — o tamanho da bolha é a população"
          >
            {nacional.erro ? (
              <EstadoErro erro={nacional.erro} aoTentar={nacional.recarregar} />
            ) : nacional.carregando ? (
              <Card padding="md">
                <SkeletonGrafico altura={420} />
              </Card>
            ) : (
              <MolduraGrafico
                titulo="Quadrantes de atratividade"
                subtitulo="As linhas tracejadas são as medianas da UF — o quadrante superior direito reúne praças ricas e densas"
                fonte={`${dispersao.pontos.length} municípios de ${filtros.uf} com PIB e população publicados · IBGE`}
                altura={420}
              >
                <Dispersao
                  dados={dispersao.pontos}
                  nomeX="PIB per capita"
                  nomeY="Empresas por 1.000 hab"
                  formatarX={(v) => `R$ ${numCompacto(v)}`}
                  formatarY={(v) => v.toFixed(1)}
                  linhaMediaX={dispersao.medX}
                  linhaMediaY={dispersao.medY}
                />
              </MolduraGrafico>
            )}
          </Secao>

          {/* ─── Insights ──────────────────────────────────────────── */}
          {insights.length > 0 && (
            <Secao
              titulo="Inteligência Analítica"
              descricao="Leitura do ranking e da curva de cobertura, com as evidências numéricas"
            >
              <AnaliseIA
                contexto={`Geomarketing — setor ${nomeSecao(setor)?.nome ?? setor} no Brasil`}
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
        </>
      )}
    </Stack>
  );
}
