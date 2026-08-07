/**
 * Enriquecimento.tsx — um CNPJ, tudo o que as fontes públicas sabem sobre ele.
 *
 * ── O que torna esta tela mais que um "consultar CNPJ" ─────────────────────
 * A BrasilAPI devolve `codigo_municipio_ibge` no cadastro da Receita. Esse
 * campo é a **chave de junção** com o Cadastro Central de Empresas do IBGE:
 * com ele, uma consulta de CNPJ deixa de ser uma ficha isolada e passa a vir
 * com o contexto da praça — quantas empresas existem lá, qual o PIB, qual a
 * densidade, qual a posição no ranking do estado.
 *
 * É a junção que um sistema de inteligência comercial de verdade faz e um
 * consultor de CNPJ não faz: a mesma empresa vale coisas diferentes numa
 * praça de 800 empresas e numa de 800 mil.
 */
import { useMemo, useState } from "react";
import { buscarCnpj } from "../data/brasilapi";
import { cargaNacional, municipiosDaUf, setoresDoMunicipio } from "../data/ibge";
import { SECOES } from "../data/cnae";
import { useAsync } from "../lib/useAsync";
import {
  capitalizar,
  cnpjMascara,
  cnpjValido,
  data,
  moeda,
  moedaCompacta,
  num,
  pct,
  soDigitos,
  telefone,
} from "../lib/format";
import { calcularIcp, DESCRICAO_FAIXA } from "../domain/icp";
import { densidadeDe } from "../domain/territorio";
import { BarrasHorizontais, MolduraGrafico, type PontoBarra } from "../components/charts";
import { CardKpi, Secao } from "../components/cards";
import { EstadoErro, EstadoVazio, SkeletonKpis } from "../components/estados";
import {
  Badge,
  Button,
  Card,
  Grid,
  Input,
  Row,
  Stack,
  Text,
} from "../components/primitives";

const nomeSecao = (letra: string) => SECOES.find((s) => s.letra === letra);

function Campo({ rotulo, valor, mono }: { rotulo: string; valor: string; mono?: boolean }) {
  return (
    <Stack gap={1}>
      <Text size="xs" overline>
        {rotulo}
      </Text>
      <Text size="base" tone="primary" mono={mono}>
        {valor}
      </Text>
    </Stack>
  );
}

export function Enriquecimento() {
  const [entrada, setEntrada] = useState("");
  const [consultado, setConsultado] = useState<string | null>(null);

  const empresa = useAsync(
    () => buscarCnpj(consultado as string),
    [consultado],
    { habilitado: consultado != null },
  );

  const nacional = useAsync(() => cargaNacional(), []);

  const municipioIbge = empresa.dado?.municipioIbgeId ?? null;

  const setores = useAsync(
    () => setoresDoMunicipio(municipioIbge as number),
    [municipioIbge],
    { habilitado: municipioIbge != null },
  );

  /* A junção: código IBGE do cadastro da Receita → métricas da praça. */
  const praca = useMemo(
    () => (municipioIbge ? (nacional.dado?.porId.get(municipioIbge) ?? null) : null),
    [nacional.dado, municipioIbge],
  );

  const posicaoNaUf = useMemo(() => {
    if (!praca || !nacional.dado) return null;
    const pares = municipiosDaUf(nacional.dado, praca.uf)
      .filter((m) => m.empresas)
      .sort((a, b) => (b.empresas?.valor ?? 0) - (a.empresas?.valor ?? 0));
    const i = pares.findIndex((m) => m.id === praca.id);
    return i >= 0 ? { posicao: i + 1, total: pares.length } : null;
  }, [praca, nacional.dado]);

  const icp = useMemo(() => (empresa.dado ? calcularIcp(empresa.dado) : null), [empresa.dado]);

  const composicao = useMemo<PontoBarra[]>(() => {
    if (!setores.dado) return [];
    return setores.dado.slice(0, 10).map((s) => ({
      rotulo: nomeSecao(s.secao)?.curto ?? s.secao,
      rotuloCompleto: nomeSecao(s.secao)?.nome ?? s.secao,
      valor: s.empresas,
      /* Destaca a seção da própria empresa consultada dentro da praça. */
      slot: s.secao === empresa.dado?.secao.letra ? 2 : undefined,
    }));
  }, [setores.dado, empresa.dado]);

  const valida = cnpjValido(soDigitos(entrada));

  return (
    <Stack gap={7}>
      <Card padding="md">
        <Row justify="between" align="end" gap={4} wrap>
          <Stack gap={1}>
            <Text size="xs" overline>
              Consulta de CNPJ
            </Text>
            <Text size="sm" tone="muted">
              Cadastro da Receita Federal cruzado com o Cadastro Central de Empresas do IBGE
            </Text>
          </Stack>
          <Row gap={2}>
            <Input
              mono
              placeholder="00.000.000/0001-00"
              value={entrada}
              css={{ width: 210 }}
              onChange={(e) => setEntrada(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valida) setConsultado(soDigitos(entrada));
              }}
            />
            <Button
              variante="primario"
              disabled={!valida}
              onClick={() => setConsultado(soDigitos(entrada))}
              title={valida ? "Consultar" : "Dígito verificador inválido"}
            >
              Enriquecer
            </Button>
          </Row>
        </Row>
        {entrada && !valida && (
          <Text size="sm" tone="warning" css={{ marginTop: "$3" }}>
            Dígito verificador inválido — a consulta não será enviada à BrasilAPI.
          </Text>
        )}
      </Card>

      {!consultado ? (
        <EstadoVazio
          titulo="Informe um CNPJ"
          descricao="A ficha traz razão social, CNAE, porte, capital, quadro societário e situação cadastral — e junta a isso o contexto da praça onde a empresa está: número de empresas, PIB, densidade e posição no ranking do estado."
          acao={
            <Row gap={2} wrap justify="center">
              {["33000167000101", "47960950000121", "07526557000100"].map((c) => (
                <Button
                  key={c}
                  variante="secundario"
                  tamanho="sm"
                  onClick={() => {
                    setEntrada(cnpjMascara(c));
                    setConsultado(c);
                  }}
                >
                  {cnpjMascara(c)}
                </Button>
              ))}
            </Row>
          }
        />
      ) : empresa.erro ? (
        <EstadoErro erro={empresa.erro} aoTentar={empresa.recarregar} />
      ) : empresa.carregando || !empresa.dado || !icp ? (
        <SkeletonKpis quantidade={4} />
      ) : (
        <>
          {/* ─── Identificação ──────────────────────────────────────── */}
          <Card padding="lg" tone="brand">
            <Stack gap={4}>
              <Row justify="between" align="start" gap={4} wrap>
                <Stack gap={2} css={{ minWidth: 0 }}>
                  <Text size="xl" tone="primary" weight="bold">
                    {capitalizar(empresa.dado.razaoSocial)}
                  </Text>
                  {empresa.dado.nomeFantasia && (
                    <Text size="md">{capitalizar(empresa.dado.nomeFantasia)}</Text>
                  )}
                  <Row gap={2} wrap>
                    <Badge tone="neutro" tamanho="md">
                      {cnpjMascara(empresa.dado.cnpj)}
                    </Badge>
                    <Badge
                      tone={empresa.dado.situacao === "Ativa" ? "bom" : "critico"}
                      tamanho="md"
                    >
                      {empresa.dado.situacao}
                    </Badge>
                    <Badge tone="marca" tamanho="md">
                      {empresa.dado.matriz ? "Matriz" : "Filial"}
                    </Badge>
                    <Badge tone="acento" tamanho="md" title={empresa.dado.secao.nome}>
                      {empresa.dado.secao.curto}
                    </Badge>
                  </Row>
                </Stack>

                <Stack gap={1} align="end">
                  <Text size="xs" overline>
                    Score ICP
                  </Text>
                  <Row gap={2} align="baseline">
                    <Text
                      size="xl"
                      tone="primary"
                      weight="bold"
                      css={{ fontSize: "$4xl", lineHeight: 1 }}
                    >
                      {icp.score}
                    </Text>
                    <Badge tone={icp.faixa === "A" ? "bom" : icp.faixa === "D" ? "critico" : "marca"} tamanho="md">
                      Faixa {icp.faixa}
                    </Badge>
                  </Row>
                  <Text size="sm" tone="muted">
                    {icp.desqualificada ? icp.motivoDesqualificacao : DESCRICAO_FAIXA[icp.faixa]}
                  </Text>
                </Stack>
              </Row>
            </Stack>
          </Card>

          {/* ─── Ficha cadastral ────────────────────────────────────── */}
          <Secao
            titulo="Cadastro na Receita Federal"
            descricao="Dados públicos, retornados pela BrasilAPI sem transformação além de formatação"
          >
            <Card padding="lg">
              <Grid cols="3">
                <Campo rotulo="CNAE principal" valor={`${empresa.dado.cnaeCodigo ?? "—"} · ${empresa.dado.cnaeDescricao ?? "—"}`} />
                <Campo rotulo="Natureza jurídica" valor={empresa.dado.naturezaJuridica ?? "—"} />
                <Campo rotulo="Porte" valor={empresa.dado.porte} />
                <Campo rotulo="Capital social" valor={moeda(empresa.dado.capitalSocial)} />
                <Campo rotulo="Início de atividade" valor={data(empresa.dado.dataAbertura)} />
                <Campo rotulo="CNAEs secundários" valor={num(empresa.dado.cnaesSecundarios)} />
                <Campo
                  rotulo="Endereço"
                  valor={`${capitalizar(empresa.dado.endereco)} · ${capitalizar(empresa.dado.bairro)}`}
                />
                <Campo
                  rotulo="Município / UF"
                  valor={`${capitalizar(empresa.dado.municipio)} / ${empresa.dado.uf}`}
                />
                <Campo rotulo="CEP" valor={empresa.dado.cep ?? "—"} mono />
                <Campo rotulo="Telefone" valor={telefone(empresa.dado.telefone)} mono />
                <Campo rotulo="E-mail" valor={empresa.dado.email ?? "—"} />
                <Campo rotulo="Sócios no quadro" valor={num(empresa.dado.socios)} />
                <Campo
                  rotulo="Simples Nacional"
                  valor={empresa.dado.simples == null ? "—" : empresa.dado.simples ? "Optante" : "Não optante"}
                />
                <Campo
                  rotulo="MEI"
                  valor={empresa.dado.mei == null ? "—" : empresa.dado.mei ? "Sim" : "Não"}
                />
                <Campo rotulo="Código IBGE do município" valor={String(municipioIbge ?? "—")} mono />
              </Grid>
            </Card>
          </Secao>

          {/* ─── Contexto da praça (a junção) ───────────────────────── */}
          <Secao
            titulo="Contexto da praça"
            descricao={
              municipioIbge
                ? `Junção pelo código IBGE ${municipioIbge}, presente no cadastro da Receita — mesma empresa vale coisas diferentes conforme o mercado ao redor`
                : "A Receita não informou o código IBGE do município desta empresa — sem ele não há como cruzar com o CEMPRE"
            }
          >
            {nacional.erro ? (
              <EstadoErro erro={nacional.erro} aoTentar={nacional.recarregar} />
            ) : nacional.carregando ? (
              <SkeletonKpis quantidade={4} />
            ) : praca ? (
              <Grid cols="auto">
                <CardKpi
                  rotulo="Empresas na praça"
                  valor={num(praca.empresas?.valor)}
                  textura="texture.mesh"
                  destaque
                  metrica={{
                    valor: praca.empresas?.valor ?? null,
                    procedencia: "real",
                    fonte: "IBGE · CEMPRE 9418/2585",
                    ano: praca.empresas?.ano,
                  }}
                  nota={
                    posicaoNaUf
                      ? `${posicaoNaUf.posicao}ª maior de ${num(posicaoNaUf.total)} praças em ${praca.uf}`
                      : undefined
                  }
                />
                <CardKpi
                  rotulo="População"
                  valor={num(praca.populacao?.valor)}
                  textura="texture.grid"
                  metrica={{
                    valor: praca.populacao?.valor ?? null,
                    procedencia: "real",
                    fonte: "IBGE · estimativa populacional",
                    ano: praca.populacao?.ano,
                  }}
                />
                <CardKpi
                  rotulo="PIB municipal"
                  valor={moedaCompacta(praca.pibTotal?.valor)}
                  textura="texture.contour"
                  metrica={{
                    valor: praca.pibTotal?.valor ?? null,
                    procedencia: "real",
                    fonte: "IBGE · PIB dos Municípios",
                    ano: praca.pibTotal?.ano,
                  }}
                />
                <CardKpi
                  rotulo="Densidade empresarial"
                  valor={num(densidadeDe(praca), 1)}
                  sufixo={
                    <Text size="sm" tone="muted">
                      por 1.000 hab
                    </Text>
                  }
                  textura="texture.mesh"
                  metrica={{
                    valor: densidadeDe(praca),
                    procedencia: "derivado",
                    fonte: "empresas ÷ população, ambos do IBGE",
                  }}
                />
              </Grid>
            ) : (
              <Card padding="lg">
                <Text size="sm" tone="muted">
                  Município não localizado na carga do IBGE.
                </Text>
              </Card>
            )}
          </Secao>

          {/* ─── Onde a empresa se encaixa ──────────────────────────── */}
          {composicao.length > 0 && (
            <MolduraGrafico
              titulo={`Composição setorial de ${capitalizar(empresa.dado.municipio)}`}
              subtitulo={`A barra destacada é ${nomeSecao(empresa.dado.secao.letra)?.curto} — o setor desta empresa`}
              fonte={`IBGE · agregado 9418 em nível municipal${
                setores.dado?.[0] ? ` · referência ${setores.dado[0].ano}` : ""
              }`}
              altura={340}
              acoes={(() => {
                const total = setores.dado?.reduce((s, x) => s + x.empresas, 0) ?? 0;
                const daSecao =
                  setores.dado?.find((s) => s.secao === empresa.dado?.secao.letra)?.empresas ?? 0;
                return total > 0 ? (
                  <Badge tone="acento" tamanho="md">
                    {pct((daSecao / total) * 100, 1)} da praça é do mesmo setor
                  </Badge>
                ) : null;
              })()}
            >
              <BarrasHorizontais
                dados={composicao}
                formatar={(v) => num(v)}
                larguraRotulo={128}
              />
            </MolduraGrafico>
          )}
        </>
      )}
    </Stack>
  );
}
