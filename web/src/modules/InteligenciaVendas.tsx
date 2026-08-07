/**
 * InteligenciaVendas.tsx — o mercado brasileiro inteiro, por setor.
 *
 * Responde à pergunta que abre qualquer planejamento comercial: *quantas
 * empresas do meu setor existem no Brasil, e onde elas estão?*
 *
 * Todos os números vêm do Cadastro Central de Empresas do IBGE (agregado
 * 9418, variável 2585), com a quebra pelas 21 seções da CNAE 2.0. São 4
 * requisições no total — a matriz setor × 27 UFs cabe em 73KB.
 */
import { useMemo, useState } from "react";
import {
  cargaEstadual,
  divisoesDoComercio,
  setoresDoBrasil,
  setoresPorUf,
  type SetorLocalidade,
} from "../data/ibge";
import { SECOES } from "../data/cnae";
import { useAsync } from "../lib/useAsync";
import { num, numCompacto, pct, moedaCompacta } from "../lib/format";
import { insightsNacionais } from "../domain/insights";
import { useFiltros } from "../app/filtros";
import { BarrasHorizontais, MolduraGrafico, type PontoBarra } from "../components/charts";
import { CardInsight, CardKpi, Secao } from "../components/cards";
import { AnaliseIA } from "../components/AnaliseIA";
import { EstadoErro, SkeletonGrafico, SkeletonKpis } from "../components/estados";
import { Badge, Card, Chip, Grid, Row, Stack, Text } from "../components/primitives";

const nomeSecao = (letra: string) => SECOES.find((s) => s.letra === letra);

export function InteligenciaVendas() {
  const { filtros, alternarSecao } = useFiltros();

  const brasil = useAsync(() => setoresDoBrasil(), []);
  const porUf = useAsync(() => setoresPorUf(), []);
  const estados = useAsync(() => cargaEstadual(), []);
  const comercio = useAsync(() => divisoesDoComercio(), []);

  /* O setor em foco é o primeiro do filtro de CNAE; sem filtro, o maior do
     país. Assim a tela nunca abre sem um recorte, e o recorte é o do usuário
     quando ele tem um. */
  const [focoManual, setFocoManual] = useState<string | null>(null);
  const setorFoco =
    focoManual ?? filtros.secoes[0] ?? (brasil.dado?.[0]?.secao as string | undefined) ?? null;

  const total = useMemo(
    () => brasil.dado?.reduce((s, x) => s + x.empresas, 0) ?? null,
    [brasil.dado],
  );

  const dadosSetores = useMemo<PontoBarra[]>(() => {
    if (!brasil.dado) return [];
    return brasil.dado.map((s) => ({
      rotulo: nomeSecao(s.secao)?.curto ?? s.secao,
      rotuloCompleto: nomeSecao(s.secao)?.nome ?? s.secao,
      valor: s.empresas,
      detalhe: s.secao,
    }));
  }, [brasil.dado]);

  /* Distribuição do setor em foco pelas 27 UFs. */
  const dadosUf = useMemo<PontoBarra[]>(() => {
    if (!porUf.dado || !estados.dado || !setorFoco) return [];
    const nomePorId = new Map(estados.dado.map((e) => [e.id, e]));
    const linhas: PontoBarra[] = [];

    for (const [idUf, setores] of porUf.dado) {
      const alvo = setores.find((s) => s.secao === setorFoco);
      if (!alvo) continue;
      const uf = nomePorId.get(idUf);
      linhas.push({
        rotulo: uf?.uf ?? String(idUf),
        rotuloCompleto: uf?.nome ?? String(idUf),
        valor: alvo.empresas,
      });
    }
    return linhas.sort((a, b) => b.valor - a.valor).slice(0, 15);
  }, [porUf.dado, estados.dado, setorFoco]);

  const dadosComercio = useMemo<PontoBarra[]>(() => {
    if (!comercio.dado) return [];
    const nomes: Record<string, string> = {
      "45": "Veículos e motos",
      "46": "Atacado",
      "47": "Varejo",
    };
    return comercio.dado.map((d, i) => ({
      rotulo: nomes[d.divisao] ?? d.divisao,
      rotuloCompleto: `Divisão ${d.divisao} — ${nomes[d.divisao] ?? ""}`,
      valor: d.empresas,
      slot: i,
    }));
  }, [comercio.dado]);

  const setorEmFoco: SetorLocalidade | undefined = brasil.dado?.find((s) => s.secao === setorFoco);

  const insights = useMemo(
    () => (brasil.dado ? insightsNacionais(brasil.dado, null, null) : []),
    [brasil.dado],
  );

  const fatosParaIA = useMemo(() => {
    if (!brasil.dado || !total) return null;
    return {
      escopo: "Brasil inteiro",
      total_de_empresas_no_pais: total,
      ano_de_referencia: brasil.dado[0]?.ano,
      empresas_por_secao_cnae: brasil.dado.map((s) => ({
        secao: `${s.secao} — ${nomeSecao(s.secao)?.nome ?? s.secao}`,
        empresas: s.empresas,
      })),
      comercio_por_divisao: comercio.dado ?? null,
      setor_em_foco: setorFoco
        ? { secao: setorFoco, nome: nomeSecao(setorFoco)?.nome, empresas: setorEmFoco?.empresas }
        : null,
      distribuicao_do_setor_por_uf: dadosUf.map((d) => ({ uf: d.rotulo, empresas: d.valor })),
      premissa_do_usuario: { ticket_medio_anual_reais: filtros.ticketMedioAnual },
      fonte: "IBGE — Cadastro Central de Empresas, agregado 9418, variável 2585",
    };
  }, [brasil.dado, total, comercio.dado, setorFoco, setorEmFoco, dadosUf, filtros.ticketMedioAnual]);

  if (brasil.erro) return <EstadoErro erro={brasil.erro} aoTentar={brasil.recarregar} />;

  const ano = brasil.dado?.[0]?.ano;

  return (
    <Stack gap={7}>
      {/* ─── KPIs nacionais ─────────────────────────────────────────── */}
      <Secao
        titulo="Panorama nacional"
        descricao={
          ano
            ? `Cadastro Central de Empresas do IBGE, referência ${ano} — todas as empresas e organizações formalizadas no Brasil`
            : "Carregando o Cadastro Central de Empresas do IBGE"
        }
      >
        {brasil.carregando ? (
          <SkeletonKpis quantidade={4} />
        ) : (
          <Grid cols="auto">
            <CardKpi
              rotulo="Empresas no Brasil"
              valor={num(total)}
              destaque
              textura="texture.mesh"
              nota="Todas as seções CNAE somadas"
              metrica={{
                valor: total,
                procedencia: "real",
                fonte: "IBGE · CEMPRE 9418/2585",
                ano,
              }}
            />
            <CardKpi
              rotulo="Comércio (seção G)"
              valor={num(brasil.dado?.find((s) => s.secao === "G")?.empresas)}
              textura="texture.contour"
              nota={
                total
                  ? `${pct(((brasil.dado?.find((s) => s.secao === "G")?.empresas ?? 0) / total) * 100, 1)} de todas as empresas do país`
                  : undefined
              }
              metrica={{
                valor: null,
                procedencia: "real",
                fonte: "Comércio e reparação de veículos — CNAE seção G",
                ano,
              }}
            />
            <CardKpi
              rotulo="Comércio varejista"
              valor={num(comercio.dado?.find((d) => d.divisao === "47")?.empresas)}
              carregando={comercio.carregando}
              textura="texture.grid"
              nota="Divisão 47 — a maior divisão isolada do país"
              metrica={{ valor: null, procedencia: "real", fonte: "IBGE · CNAE divisão 47", ano }}
            />
            <CardKpi
              rotulo="Mercado endereçável do setor em foco"
              valor={
                setorEmFoco ? moedaCompacta(setorEmFoco.empresas * filtros.ticketMedioAnual) : "—"
              }
              textura="texture.mesh"
              nota={
                setorEmFoco
                  ? `${num(setorEmFoco.empresas)} empresas de ${nomeSecao(setorFoco ?? "")?.curto}`
                  : undefined
              }
              metrica={{
                valor: null,
                procedencia: "premissa",
                fonte: "empresas do IBGE × ticket médio arbitrado por você",
              }}
            />
          </Grid>
        )}
      </Secao>

      {/* ─── Composição setorial ────────────────────────────────────── */}
      <Grid cols="2-1">
        {brasil.carregando ? (
          <Card padding="md">
            <SkeletonGrafico altura={480} />
          </Card>
        ) : (
          <MolduraGrafico
            titulo="As 21 seções da economia brasileira"
            subtitulo="Número de empresas e organizações formalizadas, por seção CNAE 2.0"
            fonte={`IBGE · Cadastro Central de Empresas, agregado 9418, variável 2585 · referência ${ano}`}
            altura={480}
          >
            <BarrasHorizontais
              dados={dadosSetores}
              formatar={numCompacto}
              larguraRotulo={124}
              destaque={setorFoco ? (nomeSecao(setorFoco)?.curto ?? undefined) : undefined}
              detalheTooltip={(p) =>
                total ? `${pct((Number(p.valor) / total) * 100, 2)} do total nacional` : null
              }
            />
          </MolduraGrafico>
        )}

        <Stack gap={4}>
          {comercio.carregando ? (
            <Card padding="md">
              <SkeletonGrafico altura={180} />
            </Card>
          ) : comercio.erro ? (
            <EstadoErro erro={comercio.erro} aoTentar={comercio.recarregar} compacto />
          ) : (
            <MolduraGrafico
              titulo="Onde está o Comércio brasileiro"
              subtitulo="Seção G aberta nas suas três divisões"
              fonte="IBGE · CNAE 2.0 divisões 45, 46 e 47"
              altura={180}
            >
              <BarrasHorizontais dados={dadosComercio} formatar={numCompacto} larguraRotulo={110} />
            </MolduraGrafico>
          )}

          <Card padding="md">
            <Stack gap={3}>
              <Text size="xs" overline>
                Setor em foco
              </Text>
              <Text size="sm" tone="muted">
                Define o recorte dos gráficos por UF e do Geomarketing. Clicar aqui também aplica o
                setor ao filtro global de CNAE.
              </Text>
              <Row gap={2} wrap>
                {SECOES.map((s) => (
                  <Chip
                    key={s.letra}
                    ativo={s.letra === setorFoco}
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
        </Stack>
      </Grid>

      {/* ─── Setor por UF ───────────────────────────────────────────── */}
      <Secao
        titulo="Distribuição estadual"
        descricao={
          setorFoco
            ? `${nomeSecao(setorFoco)?.nome} — as 15 UFs com mais empresas do setor`
            : "Selecione um setor acima"
        }
        acoes={
          setorEmFoco && (
            <Row gap={2}>
              <Badge tone="marca" tamanho="md">
                {num(setorEmFoco.empresas)} empresas no país
              </Badge>
            </Row>
          )
        }
      >
        {porUf.erro ? (
          <EstadoErro erro={porUf.erro} aoTentar={porUf.recarregar} />
        ) : porUf.carregando || estados.carregando ? (
          <Card padding="md">
            <SkeletonGrafico altura={400} />
          </Card>
        ) : (
          <MolduraGrafico
            titulo={`${nomeSecao(setorFoco ?? "")?.curto ?? "Setor"} por unidade da federação`}
            subtitulo="Uma única requisição traz a matriz completa de 21 setores × 27 UFs"
            fonte={`IBGE · agregado 9418 em nível N3 · referência ${ano}`}
            altura={400}
          >
            <BarrasHorizontais dados={dadosUf} formatar={numCompacto} larguraRotulo={54} />
          </MolduraGrafico>
        )}
      </Secao>

      {/* ─── Inteligência Analítica ─────────────────────────────────── */}
      {insights.length > 0 && (
        <Secao
          titulo="Inteligência Analítica"
          descricao="Leitura automática do JSON que voltou do IBGE — cada frase traz o número que a sustenta"
        >
          <AnaliseIA
            contexto="Panorama nacional de empresas por setor CNAE"
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
