/**
 * insights.ts — o motor da "Inteligência Analítica".
 *
 * Lê o JSON que voltou do IBGE e da BrasilAPI e escreve, em português, o que
 * ele significa comercialmente.
 *
 * ── Regras que este motor obedece ──────────────────────────────────────────
 * 1. **Toda frase carrega o número que a sustenta.** Não existe "o mercado
 *    parece aquecido"; existe "2.908.372 empresas de Comércio no Brasil, das
 *    quais 27,3% em SP". O usuário confere.
 * 2. **Nada é dito sem o dado.** Se a quebra setorial não carregou, o insight
 *    de composição não sai — some, em vez de sair com hipótese.
 * 3. **Amostra é rotulada como amostra.** Um padrão visto em 12 CNPJs vale
 *    como sinal da carteira carregada, nunca como característica da praça;
 *    a `confianca` desce e o texto diz "na carteira carregada".
 *
 * O que isto NÃO é: um LLM. É um conjunto de regras determinísticas — mesma
 * entrada, mesma saída, sempre. Para um painel que sustenta decisão de
 * investimento em praça, é a propriedade certa: um texto que muda a cada F5
 * não é auditável.
 */
import type { Empresa } from "../data/brasilapi";
import type { MetricasLocalidade, SetorLocalidade } from "../data/ibge";
import { SECOES, type SecaoCnae } from "../data/cnae";
import { calcularIcp } from "./icp";
import { concentracao, densidadeDe, type AnaliseTerritorio } from "./territorio";
import { num, numCompacto, moedaCompacta, pct } from "../lib/format";

export type Severidade = "oportunidade" | "atencao" | "risco" | "neutro";
export type Confianca = "alta" | "media" | "baixa";

export interface Insight {
  id: string;
  titulo: string;
  texto: string;
  /** Os números por trás da frase — vai para a linha de rodapé do card. */
  evidencia: string;
  severidade: Severidade;
  confianca: Confianca;
}

const nomeSecao = (letra: string): SecaoCnae =>
  SECOES.find((s) => s.letra === letra) ?? { letra, nome: letra, curto: letra };

/* ─── Território ───────────────────────────────────────────────────────── */

export function insightsDeTerritorio(
  analise: AnaliseTerritorio,
  paresDaUf: MetricasLocalidade[],
  setores: SetorLocalidade[] | null,
): Insight[] {
  const saida: Insight[] = [];
  const m = analise.municipio;

  /* 1. Saturação relativa aos pares da UF */
  if (analise.indiceSaturacao.valor != null) {
    const i = analise.indiceSaturacao.valor;
    const desvio = pct(Math.abs(i - 1) * 100, 0);

    if (analise.classificacao === "subexplorada") {
      saida.push({
        id: "praca-subexplorada",
        titulo: "Praça subexplorada",
        texto:
          `${m.nome} tem densidade empresarial ${desvio} abaixo da mediana de ${m.uf}. ` +
          `Menos empresas por habitante costuma significar menos concorrência instalada — ` +
          `praça candidata a entrada com esforço comercial menor por conta ganha.`,
        evidencia: `Índice ${i.toFixed(2)} (1,00 = mediana da UF) · ${num(
          analise.densidade.valor,
          1,
        )} empresas por 1.000 hab · base: ${paresDaUf.length} municípios de ${m.uf}`,
        severidade: "oportunidade",
        confianca: "alta",
      });
    } else if (analise.classificacao === "saturada") {
      saida.push({
        id: "praca-saturada",
        titulo: "Praça densa e disputada",
        texto:
          `${m.nome} tem densidade empresarial ${desvio} acima da mediana de ${m.uf}. ` +
          `Mercado maduro: o volume existe, mas a entrada tende a exigir diferenciação ` +
          `de proposta, não só cobertura.`,
        evidencia: `Índice ${i.toFixed(2)} (1,00 = mediana da UF) · ${num(
          analise.densidade.valor,
          1,
        )} empresas por 1.000 hab · base: ${paresDaUf.length} municípios de ${m.uf}`,
        severidade: "atencao",
        confianca: "alta",
      });
    }
  }

  /* 2. Porte médio do tecido empresarial */
  if (analise.pibPorEmpresa.valor != null) {
    const paresPib = paresDaUf
      .filter((p) => p.pibTotal && p.empresas && p.empresas.valor > 0)
      .map((p) => (p.pibTotal as { valor: number }).valor / (p.empresas as { valor: number }).valor);
    const medianaPares =
      paresPib.length > 0 ? [...paresPib].sort((a, b) => a - b)[Math.floor(paresPib.length / 2)] : null;

    if (medianaPares && medianaPares > 0) {
      const razao = analise.pibPorEmpresa.valor / medianaPares;
      if (razao >= 1.25 || razao <= 0.75) {
        const acima = razao >= 1.25;
        saida.push({
          id: "porte-tecido",
          titulo: acima ? "Tecido empresarial de porte acima da média" : "Tecido pulverizado",
          texto: acima
            ? `Cada empresa de ${m.nome} responde por ${moedaCompacta(
                analise.pibPorEmpresa.valor,
              )} de PIB, ${pct((razao - 1) * 100, 0)} acima da mediana da UF. ` +
              `Menos contas, cada uma maior — favorece venda consultiva com ticket alto.`
            : `Cada empresa de ${m.nome} responde por ${moedaCompacta(
                analise.pibPorEmpresa.valor,
              )} de PIB, ${pct((1 - razao) * 100, 0)} abaixo da mediana da UF. ` +
              `Base pulverizada — favorece canal, autoatendimento e ticket menor com volume.`,
          evidencia: `PIB ÷ empresas = ${moedaCompacta(
            analise.pibPorEmpresa.valor,
          )} · mediana da UF ${moedaCompacta(medianaPares)}`,
          severidade: "neutro",
          confianca: "alta",
        });
      }
    }
  }

  /* 3. Composição setorial real da praça (só com a quebra CNAE carregada) */
  if (setores && setores.length > 0) {
    const total = setores.reduce((s, x) => s + x.empresas, 0);
    const lider = setores[0];
    if (lider && total > 0) {
      const share = (lider.empresas / total) * 100;
      const top3 = setores.slice(0, 3);
      const shareTop3 = (top3.reduce((s, x) => s + x.empresas, 0) / total) * 100;

      saida.push({
        id: "composicao-setorial",
        titulo: `${nomeSecao(lider.secao).curto} lidera a praça`,
        texto:
          `${pct(share, 1)} das empresas de ${m.nome} são de ${nomeSecao(lider.secao).nome.toLowerCase()}. ` +
          `Os três maiores setores concentram ${pct(shareTop3, 1)} do tecido local` +
          `${shareTop3 > 60 ? " — praça economicamente concentrada, o que amplifica o efeito de uma campanha bem segmentada." : ", distribuição relativamente equilibrada entre setores."}`,
        evidencia:
          `${num(lider.empresas)} de ${num(total)} empresas · top 3: ` +
          top3.map((s) => `${nomeSecao(s.secao).curto} ${pct((s.empresas / total) * 100, 0)}`).join(", ") +
          ` · IBGE CEMPRE ${lider.ano}`,
        severidade: "neutro",
        confianca: "alta",
      });
    }
  }

  /* 4. Tamanho do SAM em relação à UF */
  if (analise.sam.valor != null && analise.empresasAlvo.valor != null) {
    saida.push({
      id: "dimensionamento",
      titulo: "Dimensionamento do alvo",
      texto:
        `Dentro das seções-alvo, ${m.nome} tem ${num(analise.empresasAlvo.valor)} empresas endereçáveis. ` +
        `Ao ticket médio arbitrado, isso é ${moedaCompacta(analise.sam.valor)} de SAM e ` +
        `${moedaCompacta(analise.som.valor)} de SOM no share alvo definido.`,
      evidencia:
        `Base de empresas: IBGE (real). Ticket médio e share alvo: premissas suas — ` +
        `mudá-las no cabeçalho recalcula estes dois valores.`,
      severidade: "neutro",
      confianca: "media",
    });
  }

  return saida;
}

/* ─── Ranking / concentração dentro da UF ──────────────────────────────── */

export function insightsDeCoberturaUf(
  uf: string,
  municipios: MetricasLocalidade[],
): Insight[] {
  const saida: Insight[] = [];

  const conc = concentracao(municipios, "empresas", 5);
  if (conc) {
    const top5 = [...municipios]
      .filter((m) => m.empresas)
      .sort((a, b) => (b.empresas?.valor ?? 0) - (a.empresas?.valor ?? 0))
      .slice(0, 5);

    saida.push({
      id: "concentracao-uf",
      titulo:
        conc.pctNosTop >= 50
          ? "Mercado concentrado em poucas praças"
          : "Mercado distribuído no estado",
      texto:
        `Os 5 maiores municípios de ${uf} concentram ${pct(conc.pctNosTop, 1)} das empresas do estado` +
        (conc.pctNosTop >= 50
          ? `. Cobertura direta nessas praças alcança a maior parte do mercado com equipe enxuta.`
          : `, distribuídas entre ${num(municipios.length)} municípios. Cobrir o estado exige canal indireto ou territórios amplos.`),
      evidencia:
        `${numCompacto(conc.nosTop)} de ${numCompacto(conc.total)} empresas · ` +
        top5.map((m) => m.nome).join(", "),
      severidade: conc.pctNosTop >= 50 ? "oportunidade" : "atencao",
      confianca: "alta",
    });
  }

  /* Praças densas fora das capitais — o achado que o ranking por volume esconde */
  const comDensidade = municipios
    .map((m) => ({ m, d: densidadeDe(m), pop: m.populacao?.valor ?? 0 }))
    .filter((x): x is { m: MetricasLocalidade; d: number; pop: number } => x.d != null);

  const medias = comDensidade.filter((x) => x.pop >= 20_000 && x.pop <= 200_000);
  if (medias.length >= 5) {
    const melhores = [...medias].sort((a, b) => b.d - a.d).slice(0, 3);
    const primeira = melhores[0];
    if (primeira) {
      saida.push({
        id: "densas-medio-porte",
        titulo: "Praças médias com densidade alta",
        texto:
          `Entre os municípios de 20 a 200 mil habitantes de ${uf}, ${primeira.m.nome} tem a maior ` +
          `densidade empresarial: ${num(primeira.d, 1)} empresas por 1.000 habitantes. ` +
          `Praças assim raramente aparecem no ranking por volume absoluto, mas oferecem ` +
          `mercado real com concorrência menos instalada que a capital.`,
        evidencia:
          melhores.map((x) => `${x.m.nome} ${num(x.d, 1)}/1k`).join(" · ") +
          ` · ${medias.length} municípios nessa faixa de população`,
        severidade: "oportunidade",
        confianca: "alta",
      });
    }
  }

  return saida;
}

/* ─── Carteira de prospecção (amostra de CNPJs) ────────────────────────── */

export function insightsDeCarteira(empresas: Empresa[]): Insight[] {
  if (empresas.length === 0) return [];
  const saida: Insight[] = [];
  const n = empresas.length;

  /* Amostra pequena descreve a carteira, não a praça. A confiança acompanha. */
  const confianca: Confianca = n >= 50 ? "media" : "baixa";

  /* 1. Concentração setorial da carteira */
  const porSecao = new Map<string, number>();
  for (const e of empresas) porSecao.set(e.secao.letra, (porSecao.get(e.secao.letra) ?? 0) + 1);
  const ordenado = [...porSecao.entries()].sort((a, b) => b[1] - a[1]);
  const lider = ordenado[0];

  if (lider) {
    const [letra, qtd] = lider;
    const share = (qtd / n) * 100;
    saida.push({
      id: "carteira-setor",
      titulo: `Concentração em ${nomeSecao(letra).curto}`,
      texto:
        `${pct(share, 0)} das ${n} empresas da carteira carregada são de ` +
        `${nomeSecao(letra).nome.toLowerCase()}` +
        (share >= 40
          ? `. Concentração alta: uma mudança regulatória ou de ciclo nesse setor atinge boa parte do pipeline de uma vez.`
          : `, distribuídas em ${ordenado.length} seções CNAE distintas — carteira diversificada.`),
      evidencia:
        ordenado
          .slice(0, 4)
          .map(([l, q]) => `${nomeSecao(l).curto} ${q}`)
          .join(" · ") + ` · classificação por CNAE fiscal da Receita`,
      severidade: share >= 40 ? "atencao" : "neutro",
      confianca,
    });
  }

  /* 2. Distribuição de ICP */
  const scores = empresas.map((e) => calcularIcp(e));
  const faixaA = scores.filter((s) => s.faixa === "A").length;
  const desqualificadas = scores.filter((s) => s.desqualificada).length;
  const medio = scores.reduce((s, x) => s + x.score, 0) / n;

  saida.push({
    id: "carteira-icp",
    titulo:
      faixaA / n >= 0.4 ? "Carteira aderente ao ICP" : "Aderência ao ICP abaixo do ideal",
    texto:
      `Score ICP médio de ${num(medio, 1)} pontos. ` +
      `${faixaA} de ${n} contas estão na faixa A (75+), prontas para contato prioritário` +
      (desqualificadas > 0
        ? `, e ${desqualificadas} ${desqualificadas === 1 ? "está desqualificada" : "estão desqualificadas"} por situação cadastral não-ativa.`
        : `. Nenhuma conta desqualificada por situação cadastral.`),
    evidencia: `Faixas: A ${faixaA} · B ${scores.filter((s) => s.faixa === "B").length} · C ${scores.filter((s) => s.faixa === "C").length} · D ${scores.filter((s) => s.faixa === "D").length}`,
    severidade: faixaA / n >= 0.4 ? "oportunidade" : "atencao",
    confianca,
  });

  /* 3. Acionabilidade — o gargalo operacional que ninguém mede */
  const semContato = empresas.filter((e) => !e.telefone && !e.email).length;
  if (semContato > 0) {
    saida.push({
      id: "carteira-contato",
      titulo: "Lacuna de acionabilidade",
      texto:
        `${semContato} de ${n} ${semContato === 1 ? "conta não tem" : "contas não têm"} telefone nem e-mail ` +
        `no cadastro público. Score alto sem canal de contato não vira reunião — ` +
        `estas exigem enriquecimento antes de entrar em cadência.`,
      evidencia: `${pct((semContato / n) * 100, 0)} da carteira sem canal público · fonte: cadastro da Receita via BrasilAPI`,
      severidade: semContato / n >= 0.3 ? "risco" : "atencao",
      confianca: "alta",
    });
  }

  /* 4. Dispersão geográfica */
  const porUf = new Map<string, number>();
  for (const e of empresas) porUf.set(e.uf, (porUf.get(e.uf) ?? 0) + 1);
  const ufsOrdenadas = [...porUf.entries()].sort((a, b) => b[1] - a[1]);
  const ufLider = ufsOrdenadas[0];

  if (ufLider && porUf.size > 1) {
    saida.push({
      id: "carteira-geo",
      titulo: "Dispersão geográfica da carteira",
      texto:
        `${pct((ufLider[1] / n) * 100, 0)} das contas estão em ${ufLider[0]}, ` +
        `e a carteira toca ${porUf.size} ${porUf.size === 1 ? "UF" : "UFs"}. ` +
        (porUf.size >= 4
          ? `Cobertura dispersa: avalie se a estrutura de atendimento acompanha essa amplitude.`
          : `Concentração geográfica favorece visita presencial e densidade de rota.`),
      evidencia: ufsOrdenadas.map(([uf, q]) => `${uf} ${q}`).join(" · "),
      severidade: "neutro",
      confianca: "alta",
    });
  }

  return saida;
}

/* ─── Panorama nacional por setor ──────────────────────────────────────── */

export function insightsNacionais(
  setoresBrasil: SetorLocalidade[],
  setorFoco: string | null,
  municipiosDoSetor: MetricasLocalidade[] | null,
): Insight[] {
  const saida: Insight[] = [];
  const total = setoresBrasil.reduce((s, x) => s + x.empresas, 0);

  if (setoresBrasil.length > 0 && total > 0) {
    const lider = setoresBrasil[0] as SetorLocalidade;
    saida.push({
      id: "brasil-composicao",
      titulo: `${nomeSecao(lider.secao).curto} é o maior setor do país`,
      texto:
        `O Brasil tem ${num(total)} empresas e organizações registradas no CEMPRE. ` +
        `${nomeSecao(lider.secao).nome} responde por ${num(lider.empresas)} delas — ` +
        `${pct((lider.empresas / total) * 100, 1)} de tudo que existe formalizado no país.`,
      evidencia: `IBGE · Cadastro Central de Empresas, agregado 9418, variável 2585, ${lider.ano}`,
      severidade: "neutro",
      confianca: "alta",
    });
  }

  if (setorFoco && municipiosDoSetor && municipiosDoSetor.length > 0) {
    const totalSetor = municipiosDoSetor.reduce((s, m) => s + (m.empresas?.valor ?? 0), 0);
    const top10 = municipiosDoSetor.slice(0, 10);
    const shareTop10 = (top10.reduce((s, m) => s + (m.empresas?.valor ?? 0), 0) / totalSetor) * 100;
    const primeiro = top10[0];

    if (primeiro && totalSetor > 0) {
      saida.push({
        id: "setor-concentracao-nacional",
        titulo: `Onde está ${nomeSecao(setorFoco).curto} no Brasil`,
        texto:
          `${num(totalSetor)} empresas do setor, espalhadas por ${num(municipiosDoSetor.length)} municípios. ` +
          `${primeiro.nome} (${primeiro.uf}) lidera com ${num(primeiro.empresas?.valor)} — ` +
          `${pct(((primeiro.empresas?.valor ?? 0) / totalSetor) * 100, 1)} do total nacional. ` +
          `Os 10 maiores municípios somam ${pct(shareTop10, 1)}.`,
        evidencia: top10
          .slice(0, 5)
          .map((m) => `${m.nome}/${m.uf} ${numCompacto(m.empresas?.valor)}`)
          .join(" · "),
        severidade: shareTop10 >= 40 ? "oportunidade" : "neutro",
        confianca: "alta",
      });
    }

    /* A cauda longa: quantos municípios são necessários para chegar a 80% */
    let acumulado = 0;
    let municipiosPara80 = 0;
    for (const m of municipiosDoSetor) {
      acumulado += m.empresas?.valor ?? 0;
      municipiosPara80++;
      if (acumulado / totalSetor >= 0.8) break;
    }

    if (municipiosPara80 > 0) {
      saida.push({
        id: "setor-cauda-longa",
        titulo: "Curva de cobertura do setor",
        texto:
          `Bastam ${num(municipiosPara80)} municípios para cobrir 80% das empresas de ` +
          `${nomeSecao(setorFoco).curto} no Brasil — ` +
          `${pct((municipiosPara80 / municipiosDoSetor.length) * 100, 1)} do total de praças. ` +
          `Os outros ${num(municipiosDoSetor.length - municipiosPara80)} respondem pelos 20% restantes.`,
        evidencia: `Curva acumulada sobre ${num(municipiosDoSetor.length)} municípios · IBGE CEMPRE`,
        severidade: "oportunidade",
        confianca: "alta",
      });
    }
  }

  return saida;
}
