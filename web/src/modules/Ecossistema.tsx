/**
 * Ecossistema.tsx — quais praças já têm os pré-requisitos do seu cliente.
 *
 * Todos os outros módulos tratam cada atividade econômica como uma coluna
 * independente: contam, ordenam, comparam. Este parte de outra premissa, da
 * economia da complexidade: **atividades não aparecem em qualquer lugar.
 * Aparecem onde as capacidades vizinhas já existem.**
 *
 * A tela responde uma pergunta só, e é a que gera visita: escolhida a
 * atividade do seu cliente, quais municípios ainda NÃO a têm mas já têm o
 * entorno que ela exige.
 *
 * O método, a validação e o que ele não cobre estão em `domain/ecossistema.ts`
 * e em `docs/espaco-de-atividades.md`.
 */
import { useMemo, useState } from "react";
import { cargaNacional } from "../data/ibge";
import { useAsync } from "../lib/useAsync";
import { num } from "../lib/format";
import {
  AUC_MINIMO,
  aucDe,
  calcularProntidao,
  divisoes,
  divisoesValidadas,
  indiceDoCodigo,
  popularidadeDe,
  validadaPara,
} from "../domain/ecossistema";
import { BarrasHorizontais, MolduraGrafico } from "../components/charts";
import { CardKpi, Secao } from "../components/cards";
import { EstadoErro, SkeletonKpis, SkeletonTabela } from "../components/estados";
import {
  Badge,
  Card,
  Grid,
  Heading,
  Label,
  Row,
  Select,
  Stack,
  Tabela,
  TabelaWrap,
  Td,
  Text,
  Th,
} from "../components/primitives";

/** Fabricação de máquinas e equipamentos — exemplo bom de abrir a tela. */
const PADRAO = "28";
const NO_RANKING = 25;

export function Ecossistema() {
  const [codigo, setCodigo] = useState(PADRAO);
  const nacional = useAsync(() => cargaNacional(), []);

  const indice = indiceDoCodigo(codigo);
  const habilitado = indice >= 0 && validadaPara(indice);

  const resultado = useMemo(
    () => (habilitado ? calcularProntidao(indice) : null),
    [habilitado, indice],
  );

  const seletor = (
    <Stack gap={2} css={{ maxWidth: 620 }}>
      <Label htmlFor="atividade">Atividade do seu cliente (divisão CNAE)</Label>
      <Select id="atividade" value={codigo} onChange={(e) => setCodigo(e.target.value)}>
        <optgroup label="Validadas — ordenadas pela acurácia medida">
          {divisoesValidadas().map(({ divisao }) => (
            <option key={divisao.codigo} value={divisao.codigo}>
              {divisao.codigo} — {divisao.nome} (AUC {divisao.auc?.toFixed(2)})
            </option>
          ))}
        </optgroup>
        <optgroup label="Sem validação — o indicador não se sustenta nestas">
          {divisoes()
            .map((d, i) => ({ d, i }))
            .filter(({ i }) => !validadaPara(i))
            .map(({ d }) => (
              <option key={d.codigo} value={d.codigo}>
                {d.codigo} — {d.nome}
              </option>
            ))}
        </optgroup>
      </Select>
    </Stack>
  );

  if (nacional.erro) return <EstadoErro erro={nacional.erro} />;

  /* ─── Divisão sem validação ────────────────────────────────────────────
     O método roda em qualquer divisão e devolve números de aparência
     idêntica. O AUC medido é que separa: 0,878 em descontaminação, 0,394 em
     serviços de escritório. Entregar as duas do mesmo jeito seria vender
     ruído com a mesma cara de sinal. */
  if (!habilitado) {
    const d = divisoes()[indice];
    const auc = indice >= 0 ? aucDe(indice) : null;
    return (
      <Stack gap={6}>
        <Cabecalho />
        {seletor}
        <Card padding="lg">
          <Stack gap={4}>
            <Heading size="md">
              O indicador não se sustenta em {d ? `${d.codigo} — ${d.nome}` : "nesta divisão"}
            </Heading>
            <Text size="sm">
              Medido fora da amostra — rede construída com o CEMPRE de 2013, conferida
              contra o que apareceu até 2020 —, esta divisão obteve{" "}
              <strong>AUC {auc === null ? "insuficiente para medir" : auc.toFixed(3)}</strong>,
              abaixo do piso de {AUC_MINIMO.toFixed(2)}. Metade das vezes acertaria por
              acaso.
            </Text>
            <Text size="sm">
              Há um padrão nisso: a rede prevê atividades que exigem{" "}
              <strong>capacidade específica</strong> e falha nas que apenas acompanham
              população. Todo município tem varejo, escola e prefeitura na medida da sua
              gente, sem precisar de ecossistema industrial nenhum.
            </Text>
            <Text size="sm" tone="muted">
              As {divisoesValidadas().length} divisões validadas estão no topo do seletor,
              ordenadas pela acurácia medida.
            </Text>
          </Stack>
        </Card>
      </Stack>
    );
  }

  if (nacional.carregando || !resultado) {
    return (
      <Stack gap={6}>
        <Cabecalho />
        {seletor}
        <SkeletonKpis />
        <SkeletonTabela linhas={10} colunas={5} />
      </Stack>
    );
  }

  const { divisao, popularidade, prontos, jaTem, ano } = resultado;
  const topo = prontos.slice(0, NO_RANKING);
  const nomeDe = (id: number) => {
    const m = nacional.dado?.porId.get(id);
    return m ? `${m.nome}/${m.uf}` : String(id);
  };

  const barras = topo.slice(0, 12).map((p) => ({
    rotulo: nomeDe(p.municipioId),
    rotuloCompleto: nomeDe(p.municipioId),
    valor: Math.round(p.densidade * 100),
    detalhe: `já tem: ${p.vizinhas.map((v) => v.codigo).join(", ")}`,
  }));

  return (
    <Stack gap={6}>
      <Cabecalho />
      {seletor}

      <Grid cols="4">
        <CardKpi
          rotulo="Praças sem a atividade"
          valor={num(prontos.length)}
          nota={`${num(jaTem)} já têm vantagem comparativa`}
        />
        <CardKpi
          rotulo="Presença no país"
          valor={`${(popularidade * 100).toFixed(0)}%`}
          nota="dos municípios têm vantagem nesta divisão"
        />
        <CardKpi
          rotulo="Acurácia medida"
          valor={`AUC ${divisao.auc?.toFixed(2)}`}
          nota="fora da amostra, 2013 → 2020"
        />
        <CardKpi
          rotulo="Melhor prontidão"
          valor={`${((topo[0]?.densidade ?? 0) * 100).toFixed(0)}%`}
          nota="do entorno da atividade já dominado"
        />
      </Grid>

      <Secao
        titulo="As praças mais preparadas"
        descricao={`Municípios que ainda não têm vantagem comparativa em ${divisao.nome}, ordenados por quanto do entorno da atividade já dominam`}
      >
        <MolduraGrafico
          titulo="Prontidão do entorno"
          subtitulo="Percentual das capacidades vizinhas que o município já possui"
          fonte={`IBGE — CEMPRE ${ano}, CNAE 2.0 nível divisão. Rede de proximidade em scripts/gerar-espaco-cnae.py`}
        >
          <BarrasHorizontais
            dados={barras}
            formatar={(v) => `${v}%`}
            larguraRotulo={168}
            detalheTooltip={(p) => (p.detalhe as string) ?? null}
          />
        </MolduraGrafico>
      </Secao>

      <Secao
        titulo="Por que cada uma"
        descricao="As capacidades já presentes que mais puxam a atividade — é o argumento, não só o número"
      >
        <TabelaWrap>
          <Tabela>
            <thead>
              <tr>
                <Th>Município</Th>
                <Th alinhamento="direita">Prontidão do entorno</Th>
                <Th>Já tem estas capacidades vizinhas</Th>
              </tr>
            </thead>
            <tbody>
              {topo.map((p) => (
                <tr key={p.municipioId}>
                  <Td>{nomeDe(p.municipioId)}</Td>
                  <Td alinhamento="direita">
                    <strong>{(p.densidade * 100).toFixed(0)}%</strong>
                  </Td>
                  <Td>
                    <Row gap={2} css={{ flexWrap: "wrap" }}>
                      {p.vizinhas.map((v) => (
                        <Badge key={v.codigo} tone="neutro">
                          {v.codigo} {v.nome.slice(0, 28)}
                        </Badge>
                      ))}
                    </Row>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Tabela>
        </TabelaWrap>
      </Secao>

      <ComoLer indice={indice} />
    </Stack>
  );
}

function Cabecalho() {
  return (
    <Stack gap={2}>
      <Heading size="lg">Ecossistema</Heading>
      <Text size="sm" tone="muted">
        Atividades econômicas não aparecem em qualquer lugar — aparecem onde as
        capacidades vizinhas já existem. Esta tela mostra quais praças já têm o entorno
        do seu cliente
      </Text>
    </Stack>
  );
}

/**
 * O rodapé honesto, como no módulo de Vazios.
 *
 * Este é o segundo módulo da plataforma que afirma algo sobre o FUTURO. A
 * acurácia fica na tela porque um número preditivo sem ela é promessa — e
 * porque aqui há uma armadilha específica a declarar: a rede sozinha PERDE
 * para a referência ingênua.
 */
function ComoLer({ indice }: { indice: number }) {
  return (
    <Card padding="lg">
      <Stack gap={4}>
        <Heading size="md">Como este número foi medido</Heading>
        <Text size="sm">
          A rede de proximidade entre atividades foi construída com o CEMPRE de{" "}
          <strong>2013</strong> e conferida contra quais divisões efetivamente apareceram
          em cada município até <strong>2020</strong>. Metade dos municípios ficou fora —
          inclusive da construção da rede, senão o conjunto de teste já teria visto a
          própria coocorrência.
        </Text>
        <Grid cols="3">
          <Stack gap={1}>
            <Text size="xs" tone="muted">
              Esta divisão
            </Text>
            <Text size="lg" mono>
              AUC {aucDe(indice)?.toFixed(3)}
            </Text>
          </Stack>
          <Stack gap={1}>
            <Text size="xs" tone="muted">
              Presença no país
            </Text>
            <Text size="lg" mono tone="muted">
              {(popularidadeDe(indice) * 100).toFixed(0)}%
            </Text>
          </Stack>
          <Stack gap={1}>
            <Text size="xs" tone="muted">
              Divisões validadas
            </Text>
            <Text size="lg" mono>
              {divisoesValidadas().length} de 87
            </Text>
          </Stack>
        </Grid>
        <Text size="sm">
          <strong>A armadilha que este módulo quase caiu:</strong> sozinha, a rede perde
          para a referência ingênua — prever pela simples frequência da atividade dá AUC
          0,7185 contra 0,7100 da rede. O que a salva é carregar informação{" "}
          <strong>independente</strong>: controlando por faixa de frequência, a rede vence
          em todas, e as duas juntas chegam a <strong>0,7549</strong>.
        </Text>
        <Text size="sm" tone="muted">
          <strong>O que isso não permite:</strong> afirmar que a atividade vai abrir em um
          município específico. Isto ordena candidatas por preparo do ecossistema; a
          decisão continua sendo de quem visita.
        </Text>
      </Stack>
    </Card>
  );
}
