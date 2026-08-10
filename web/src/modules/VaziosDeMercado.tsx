/**
 * VaziosDeMercado.tsx — onde falta empresa que deveria existir.
 *
 * Os outros módulos respondem "onde está o mercado hoje": contam empresas,
 * calculam densidade, ordenam por atratividade. Este responde a pergunta
 * seguinte, que é a que gera visita: **onde o mercado ainda não está, mas as
 * condições para ele existir já estão.**
 *
 * A conta em uma frase: o modelo estima quantas empresas do setor um município
 * deveria ter, dados seu tamanho e seu poder de compra, e mostra quem está
 * abaixo disso. A validação, o que ela cobre e o que ela não cobre estão em
 * `domain/vazios.ts` — e a tela repete os números principais, porque um
 * indicador preditivo sem a acurácia ao lado vira promessa.
 */
import { useMemo } from "react";
import { SECOES } from "../data/cnae";
import { useFiltros } from "../app/filtros";
import { useUniverso } from "../app/useUniverso";
import { num, numCompacto } from "../lib/format";
import { mapearVazios, validadoPara, SETORES_VALIDADOS } from "../domain/vazios";
import { BarrasHorizontais, Dispersao, MolduraGrafico } from "../components/charts";
import { CardKpi, Secao } from "../components/cards";
import { EstadoErro, SkeletonGrafico, SkeletonKpis, SkeletonTabela } from "../components/estados";
import {
  Badge,
  Card,
  Chip,
  Grid,
  Heading,
  Row,
  Stack,
  Tabela,
  TabelaWrap,
  Td,
  Text,
  Th,
} from "../components/primitives";

const nomeSecao = (letra: string) => SECOES.find((s) => s.letra === letra);

/** Quantos municípios a tabela mostra. Além disso ninguém lê. */
const NO_RANKING = 25;

export function VaziosDeMercado() {
  const { filtros, alternarSecao } = useFiltros();
  const setor = filtros.secoes[0] ?? "G";
  const habilitado = validadoPara(setor);

  /* O universo carrega de qualquer forma: trocar de setor não deve refazer a
     carga nacional, e o cache cuida disso. */
  const { universo, carregando, erro } = useUniverso(setor);

  const resultado = useMemo(() => {
    if (!habilitado || universo.pracas.length === 0) return null;
    return mapearVazios(
      universo.pracas.map((p) => ({
        id: p.id,
        populacao: p.populacao,
        pibPerCapita: p.pibPerCapita,
        empresas: p.setor,
      })),
    );
  }, [habilitado, universo.pracas]);

  /* ─── Setor sem validação ──────────────────────────────────────────────
     Esta é a decisão de produto mais importante do módulo. O modelo roda em
     qualquer setor e devolve números de aparência idêntica; o teste fora da
     amostra é que reprovou Construção (rho = +0,040, sinal trocado, contra
     -0,225 no Comércio). Entregar o número assim mesmo seria vender um
     indicador que não indica nada. */
  if (!habilitado) {
    return (
      <Stack gap={6}>
        <Cabecalho setor={setor} />
        <Card padding="lg">
          <Stack gap={4}>
            <Heading size="md">
              O indicador não foi validado para {nomeSecao(setor)?.nome ?? setor}
            </Heading>
            <Text size="sm">
              O modelo pressupõe <strong>equilíbrio de mercado local</strong> — que a
              empresa se instala onde está a demanda que ela atende. Isso vale para
              comércio e indústria de transformação, e não vale para setores em que a
              sede é indiferente ao local de operação: uma construtora sediada em São
              Paulo constrói na Bahia.
            </Text>
            <Text size="sm">
              Testado fora da amostra, ajustando em 2013 e conferindo contra o
              crescimento de 2015 a 2020, a Construção deu <strong>ρ = +0,040</strong> —
              sinal nulo e trocado. O número existiria e não significaria nada, então
              ele não é oferecido.
            </Text>
            <Row gap={3} css={{ flexWrap: "wrap", alignItems: "center" }}>
              <Text size="sm" tone="muted">
                Setores validados:
              </Text>
              {SETORES_VALIDADOS.map((letra) => (
                <Chip key={letra} onClick={() => alternarSecao(letra)}>
                  {letra} — {nomeSecao(letra)?.nome ?? letra}
                </Chip>
              ))}
            </Row>
          </Stack>
        </Card>
      </Stack>
    );
  }

  if (erro) return <EstadoErro erro={erro} />;

  if (carregando || !resultado) {
    return (
      <Stack gap={6}>
        <Cabecalho setor={setor} />
        <SkeletonKpis />
        <SkeletonGrafico />
        <SkeletonTabela linhas={10} colunas={6} />
      </Stack>
    );
  }

  /* Amostra insuficiente para ajustar. Sem este ramo a tela mostrava
     "0 municípios", "0,0% da variação" e elasticidades "0,00" numa tabela
     vazia — não quebra, mas parece quebrada, e o usuário não tem como saber
     que o problema é falta de dado e não erro de cálculo. */
  if (resultado.amostra === 0) {
    return (
      <Stack gap={6}>
        <Cabecalho setor={setor} />
        <Card padding="lg">
          <Stack gap={3}>
            <Heading size="md">Dados insuficientes para ajustar o modelo</Heading>
            <Text size="sm">
              O modelo precisa de pelo menos 50 municípios com 20 ou mais empresas de{" "}
              {nomeSecao(setor)?.nome ?? setor}, além de população e PIB conhecidos. O
              recorte atual não chega lá.
            </Text>
          </Stack>
        </Card>
      </Stack>
    );
  }

  const { vazios, amostra, r2, coeficientes, conformal, sustentaveis } = resultado;

  /**
   * Quem entra no ranking: só quem tem lacuna SUSTENTÁVEL.
   *
   * O critério não é mais o percentil do resíduo — aquilo era um corte
   * arbitrário meu, e um município no percentil 76 não é materialmente
   * diferente de um no 74. O corte agora é o intervalo conformal: entra quem
   * está abaixo do PISO do próprio intervalo de 90%, ou seja, quem o modelo
   * não consegue explicar como "está dentro do previsto".
   *
   * Isso encolhe muito a lista — na amostra de validação, de 4.979 para ~330 —
   * e é o número honesto. Um modelo que explica ~5% da variação do crescimento
   * não tem direito de afirmar lacuna em milhares de lugares.
   *
   * Entre os que entram, a lacuna absoluta ORDENA: o resíduo sozinho entregava
   * o topo a Santana do Mundaú/AL, 6 mil habitantes, faltando 8 comércios —
   * verdade estatística, inútil como rota de vendedor.
   */
  const maioresLacunas = vazios
    .filter((v) => v.sustentavel)
    .sort((a, b) => b.lacuna - a.lacuna)
    .slice(0, NO_RANKING);

  const barras = maioresLacunas.slice(0, 12).map((v) => {
    const p = universo.porId.get(v.id);
    return {
      rotulo: p ? `${p.nome}/${p.uf}` : String(v.id),
      rotuloCompleto: p ? `${p.nome} — ${p.uf}` : String(v.id),
      valor: Math.round(v.lacuna),
      detalhe: `${num(Math.round(v.observado))} hoje, ${num(Math.round(v.esperado))} esperadas`,
    };
  });

  /* A dispersão é a prova visual: cada ponto é um município, a diagonal é o
     equilíbrio. Quem está abaixo dela tem menos empresa do que seu porte e sua
     renda pedem. Amostrada para não desenhar 5 mil pontos. */
  const pontos = vazios
    .filter((_, i) => i % Math.max(1, Math.floor(vazios.length / 900)) === 0)
    .map((v) => ({
      x: v.esperado,
      y: v.observado,
      rotuloCompleto: (() => {
        const p = universo.porId.get(v.id);
        return p ? `${p.nome}/${p.uf}: ${num(Math.round(v.observado))} de ${num(Math.round(v.esperado))}` : "";
      })(),
      destacado: v.percentil > 95,
    }));

  const totalFaltante = maioresLacunas.reduce((s, v) => s + Math.max(0, v.lacuna), 0);

  return (
    <Stack gap={6}>
      <Cabecalho setor={setor} />

      <Grid cols="4">
        <CardKpi
          rotulo="Lacunas sustentáveis"
          valor={num(sustentaveis)}
          nota={`de ${num(amostra)} municípios — o resto cabe no intervalo`}
          destaque
        />
        <CardKpi
          rotulo="Explicação do modelo"
          valor={`${(r2 * 100).toFixed(1)}%`}
          nota="da variação em nº de empresas"
        />
        <CardKpi
          rotulo="Elasticidade da população"
          valor={coeficientes.populacao.toFixed(2)}
          nota="1,0 = empresas crescem junto com gente"
        />
        <CardKpi
          rotulo="Cobertura do intervalo"
          valor={conformal ? `${(conformal.cobertura * 100).toFixed(0)}%` : "—"}
          nota={conformal ? `calibrado em ${num(conformal.n)} municípios` : "amostra insuficiente"}
        />
      </Grid>

      <Secao
        titulo="As maiores lacunas do país"
        descricao={`Municípios no quartil mais desabastecido, ordenados por quantas empresas de ${nomeSecao(setor)?.nome ?? setor} faltam para chegar ao previsto pelo porte e pela renda`}
      >
        <MolduraGrafico
          titulo="Empresas faltando"
          subtitulo={`As 12 maiores em volume — as ${NO_RANKING} praças da tabela somam ${num(Math.round(totalFaltante))} empresas faltando`}
          fonte="IBGE — CEMPRE 9418/2585, população 6579/9324, PIB 5938/37"
        >
          <BarrasHorizontais
            dados={barras}
            formatar={(v) => num(v)}
            larguraRotulo={168}
            detalheTooltip={(p) => (p.detalhe as string) ?? null}
          />
        </MolduraGrafico>
      </Secao>

      <Secao
        titulo="Esperado contra observado"
        descricao="Cada ponto é um município. A diagonal é o equilíbrio: abaixo dela há menos empresa do que o porte e a renda pedem"
      >
        <MolduraGrafico
          titulo="Ajuste do modelo"
          subtitulo={`${num(amostra)} municípios`}
          fonte="IBGE — CEMPRE 9418/2585, população 6579/9324, PIB 5938/37"
        >
          <Dispersao
            dados={pontos}
            nomeX="Empresas esperadas"
            nomeY="Empresas observadas"
            formatarX={(v) => numCompacto(v)}
            formatarY={(v) => numCompacto(v)}
          />
        </MolduraGrafico>
      </Secao>

      <Secao
        titulo="Onde ir primeiro"
        descricao="Só municípios abaixo do piso do próprio intervalo de 90% — ordenados pelo tamanho da lacuna"
      >
        <TabelaWrap>
          <Tabela>
            <thead>
              <tr>
                <Th>Município</Th>
                <Th>UF</Th>
                <Th alinhamento="direita">Hoje</Th>
                <Th alinhamento="direita">Esperado</Th>
                <Th alinhamento="direita">Intervalo 90%</Th>
                <Th alinhamento="direita">Lacuna</Th>
                <Th alinhamento="direita">População</Th>
                <Th alinhamento="direita">PIB per capita</Th>
                <Th>Prioridade</Th>
              </tr>
            </thead>
            <tbody>
              {maioresLacunas.map((v) => {
                const p = universo.porId.get(v.id);
                return (
                  <tr key={v.id}>
                    <Td>{p?.nome ?? v.id}</Td>
                    <Td>{p?.uf ?? "—"}</Td>
                    <Td alinhamento="direita">{num(Math.round(v.observado))}</Td>
                    <Td alinhamento="direita">{num(Math.round(v.esperado))}</Td>
                    <Td alinhamento="direita">
                      <Text size="xs" tone="muted" mono>
                        {v.esperadoMin == null
                          ? "—"
                          : `${numCompacto(v.esperadoMin)}–${numCompacto(v.esperadoMax as number)}`}
                      </Text>
                    </Td>
                    <Td alinhamento="direita">
                      <strong>+{num(Math.round(v.lacuna))}</strong>
                    </Td>
                    <Td alinhamento="direita">{p?.populacao ? numCompacto(p.populacao) : "—"}</Td>
                    <Td alinhamento="direita">
                      {p?.pibPerCapita ? `R$ ${numCompacto(p.pibPerCapita)}` : "—"}
                    </Td>
                    <Td>
                      <Badge tone={v.percentil > 98 ? "acento" : "neutro"}>
                        {v.percentil.toFixed(0)}º percentil
                      </Badge>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Tabela>
        </TabelaWrap>
      </Secao>

      <ComoLer />
    </Stack>
  );
}

function Cabecalho({ setor }: { setor: string }) {
  return (
    <Stack gap={2}>
      <Row gap={3} css={{ alignItems: "center", flexWrap: "wrap" }}>
        <Heading size="lg">Vazios de Mercado</Heading>
        <Badge tone="neutro">
          {setor} — {nomeSecao(setor)?.nome ?? setor}
        </Badge>
      </Row>
      <Text size="sm" tone="muted">
        Onde falta empresa que deveria existir, segundo o porte e o poder de compra do
        município
      </Text>
    </Stack>
  );
}

/**
 * O rodapé honesto.
 *
 * Existe porque este é o único módulo da plataforma que faz uma afirmação
 * sobre o FUTURO. Todos os outros descrevem o presente e não podem estar
 * "errados" — no máximo desatualizados. Um número preditivo sem a acurácia ao
 * lado é uma promessa, e quem usa precisa saber que ela é modesta.
 */
function ComoLer() {
  return (
    <Card padding="lg">
      <Stack gap={4}>
        <Heading size="md">Como este número foi medido</Heading>
        <Text size="sm">
          O modelo foi ajustado com dados de <strong>2013</strong> e conferido contra o
          crescimento de <strong>2015 a 2020</strong> em 4.979 municípios. Nenhum dado da
          janela de validação entrou no ajuste.
        </Text>
        <Grid cols="3">
          <Stack gap={1}>
            <Text size="xs" tone="muted">
              Correlação com crescimento futuro
            </Text>
            <Text size="lg" mono>
              ρ = −0,23
            </Text>
          </Stack>
          <Stack gap={1}>
            <Text size="xs" tone="muted">
              Densidade pura, para comparação
            </Text>
            <Text size="lg" mono tone="muted">
              ρ = −0,15
            </Text>
          </Stack>
          <Stack gap={1}>
            <Text size="xs" tone="muted">
              Estabilidade entre 2013 e 2015
            </Text>
            <Text size="lg" mono>
              ρ = +0,91
            </Text>
          </Stack>
        </Grid>
        <Text size="sm">
          <strong>O que isso permite:</strong> priorizar. Os 10% mais desabastecidos
          cresceram cerca de <strong>17 pontos percentuais</strong> a mais que os 10% mais
          saturados ao longo de cinco anos. E o desequilíbrio é estrutural (ρ = +0,91
          entre dois anos), então ele não desaparece antes de a operação chegar lá.
        </Text>
        <Text size="sm" tone="muted">
          <strong>O que isso não permite:</strong> prever um município específico. ρ =
          −0,23 explica cerca de 5% da variação. Isto ordena praças; não afirma o que vai
          acontecer em uma delas. Serve para decidir a sequência da rota, não para
          substituir a visita.
        </Text>
        <Heading size="md" css={{ marginTop: "$3" }}>Por que a lista é curta</Heading>
        <Text size="sm">
          Cada município recebe um <strong>intervalo com cobertura garantida</strong>
          {" "}(predição conformal): se pedimos 90%, ao menos 90% dos casos caem dentro —
          e isso foi <strong>medido</strong>, não suposto. Na amostra de validação, a
          cobertura empírica saiu em 89,8% para um nominal de 90%.
        </Text>
        <Text size="sm">
          A regra de corte vem daí, e não de um limiar escolhido a dedo:{" "}
          <strong>se o observado cabe dentro do intervalo, não há como afirmar que falta
          empresa</strong> — o município está dentro do que o modelo consegue prever. Só
          entra no ranking quem fica abaixo do piso do próprio intervalo.
        </Text>
        <Text size="sm" tone="muted">
          Isso descarta cerca de 90% dos municípios, e é o número honesto. A banda de 90%
          equivale a um fator de aproximadamente 2 para cada lado; com um intervalo
          desses, afirmar lacuna para quem está perto do esperado seria inventar
          precisão que o modelo não tem.
        </Text>
      </Stack>
    </Card>
  );
}
