/**
 * catalog.ts — o catálogo de assets visuais do produto.
 *
 * Cada asset é declarado UMA vez aqui, com o prompt que o descreve. Os
 * componentes pedem o asset pelo id (`<Asset id="icon.geomarketing" />`) e
 * nunca sabem de onde a imagem veio.
 *
 * Isso é o que torna a troca de provedor barata: o `SvgSource` desenha o
 * asset em SVG vetorial (default — offline, sem chave, nítido em qualquer
 * densidade), e o `NanoBananaSource` manda exatamente o mesmo `prompt` para
 * o modelo de imagem do Gemini. Trocar um pelo outro é uma linha no
 * `main.tsx`; nenhum componente muda.
 */

export type AssetKind = "logo" | "icon" | "texture" | "illustration";

export interface AssetSpec {
  id: string;
  kind: AssetKind;
  /** Descrição usada como prompt pelo provedor generativo e como documentação
   *  do que o SVG autoral precisa representar. */
  prompt: string;
  /** Proporção nativa — o provedor generativo usa para pedir o tamanho certo. */
  width: number;
  height: number;
  /** Texto alternativo. Assets puramente decorativos usam "" (aria-hidden). */
  alt: string;
}

const spec = (s: AssetSpec) => s;

export const ASSETS = {
  /* ── Marca ───────────────────────────────────────────────────────────── */
  "logo.mark": spec({
    id: "logo.mark",
    kind: "logo",
    prompt:
      "Logo símbolo minimalista para plataforma B2B de inteligência de vendas. " +
      "Um hexágono geométrico contendo uma seta ascendente formada por barras de " +
      "dados. Traço fino, degradê índigo (#4f6ef7) para ciano (#22d3ee), fundo " +
      "transparente, estilo corporativo enterprise, vetorial, sem texto.",
    width: 32,
    height: 32,
    alt: "Vendalytics",
  }),

  /* ── Ícones do menu lateral ──────────────────────────────────────────── */
  "icon.vendas": spec({
    id: "icon.vendas",
    kind: "icon",
    prompt:
      "Ícone de linha para 'Inteligência de Vendas': gráfico de barras ascendente " +
      "com uma linha de tendência e um ponto de destaque. Traço 1.5px, cantos " +
      "arredondados, monocromático, grade 24x24, estilo enterprise.",
    width: 24,
    height: 24,
    alt: "",
  }),
  "icon.geomarketing": spec({
    id: "icon.geomarketing",
    kind: "icon",
    prompt:
      "Ícone de linha para 'Geomarketing': globo/mapa estilizado com um pino de " +
      "localização e anéis de raio concêntricos. Traço 1.5px, cantos arredondados, " +
      "monocromático, grade 24x24, estilo enterprise.",
    width: 24,
    height: 24,
    alt: "",
  }),
  "icon.copiloto": spec({
    id: "icon.copiloto",
    kind: "icon",
    prompt:
      "Ícone de linha para 'Copiloto de IA': balão de conversa com faíscas de " +
      "dados saindo dele. Traço 1.5px, cantos arredondados, monocromático, " +
      "grade 24x24, estilo enterprise.",
    width: 24,
    height: 24,
    alt: "",
  }),
  "icon.mapa": spec({
    id: "icon.mapa",
    kind: "icon",
    prompt:
      "Ícone de linha para 'Mapa Territorial': mapa dobrado em perspectiva com " +
      "pontos de dados de tamanhos diferentes distribuídos sobre ele. Traço " +
      "1.5px, cantos arredondados, monocromático, grade 24x24, estilo enterprise.",
    width: 24,
    height: 24,
    alt: "",
  }),
  "icon.territorio": spec({
    id: "icon.territorio",
    kind: "icon",
    prompt:
      "Ícone de linha para 'Planejamento de Território': mapa dividido em " +
      "setores/zonas por linhas radiais, com um pino em cada zona. Traço " +
      "1.5px, cantos arredondados, monocromático, grade 24x24.",
    width: 24,
    height: 24,
    alt: "",
  }),
  "icon.vazios": spec({
    id: "icon.vazios",
    kind: "icon",
    prompt:
      "Ícone de linha para 'Vazios de Mercado': três barras sólidas e uma " +
      "quarta apenas contornada em tracejado, mais alta que as demais — a " +
      "altura que deveria existir e não existe. Traço 1.5px, cantos " +
      "arredondados, monocromático, grade 24x24, estilo enterprise.",
    width: 24,
    height: 24,
    alt: "",
  }),
  "icon.praca": spec({
    id: "icon.praca",
    kind: "icon",
    prompt:
      "Ícone de linha para 'Relatório de Praça': documento com um gráfico de " +
      "território dentro e uma lupa. Traço 1.5px, cantos arredondados, " +
      "monocromático, grade 24x24, estilo enterprise.",
    width: 24,
    height: 24,
    alt: "",
  }),
  "icon.prospeccao": spec({
    id: "icon.prospeccao",
    kind: "icon",
    prompt:
      "Ícone de linha para 'Prospecção B2B': funil de vendas com nós de empresas " +
      "entrando no topo. Traço 1.5px, cantos arredondados, monocromático, " +
      "grade 24x24, estilo enterprise.",
    width: 24,
    height: 24,
    alt: "",
  }),
  "icon.usuarios": spec({
    id: "icon.usuarios",
    kind: "icon",
    prompt:
      "Ícone de linha para 'Usuários': duas silhuetas de pessoa sobrepostas com " +
      "um pequeno escudo de acesso. Traço 1.5px, cantos arredondados, " +
      "monocromático, grade 24x24, estilo enterprise.",
    width: 24,
    height: 24,
    alt: "",
  }),
  "icon.enriquecimento": spec({
    id: "icon.enriquecimento",
    kind: "icon",
    prompt:
      "Ícone de linha para 'Enriquecimento de Dados': base de dados cilíndrica " +
      "com faíscas/estrelas de dados agregados ao redor. Traço 1.5px, cantos " +
      "arredondados, monocromático, grade 24x24, estilo enterprise.",
    width: 24,
    height: 24,
    alt: "",
  }),

  /* ── Backgrounds premium dos cards ───────────────────────────────────── */
  "texture.contour": spec({
    id: "texture.contour",
    kind: "texture",
    prompt:
      "Textura de fundo abstrata e MUITO sutil para card de dashboard escuro: " +
      "linhas de contorno topográfico finas em índigo translúcido sobre navy " +
      "#0f172a, esmaecendo para a direita. Opacidade baixa, sem foco, sem texto, " +
      "aspecto premium de software enterprise.",
    width: 480,
    height: 200,
    alt: "",
  }),
  "texture.mesh": spec({
    id: "texture.mesh",
    kind: "texture",
    prompt:
      "Textura de fundo abstrata e sutil para card de dashboard escuro: malha de " +
      "rede/grafo com nós conectados em ciano translúcido sobre navy #0f172a, " +
      "com um brilho radial suave no canto superior direito. Opacidade baixa, " +
      "sem texto.",
    width: 480,
    height: 200,
    alt: "",
  }),
  "texture.grid": spec({
    id: "texture.grid",
    kind: "texture",
    prompt:
      "Textura de fundo abstrata e sutil para card de dashboard escuro: grade " +
      "de perspectiva técnica com linhas finas em slate translúcido sobre navy " +
      "#0f172a, esmaecendo para baixo. Opacidade muito baixa, sem texto.",
    width: 480,
    height: 200,
    alt: "",
  }),

  /* ── Ilustrações analíticas ──────────────────────────────────────────── */
  "illustration.insight": spec({
    id: "illustration.insight",
    kind: "illustration",
    prompt:
      "Ilustração analítica compacta para o painel de IA: um núcleo luminoso " +
      "índigo/ciano com feixes de dados convergindo de várias direções, sobre " +
      "navy escuro. Estilo linha fina, geométrico, enterprise, sem texto, sem " +
      "personagens.",
    width: 160,
    height: 160,
    alt: "",
  }),
  "illustration.empty": spec({
    id: "illustration.empty",
    kind: "illustration",
    prompt:
      "Ilustração de estado vazio para dashboard B2B escuro: um plano " +
      "cartesiano vazio com pontos de dados esmaecidos e uma lupa. Linha fina, " +
      "slate translúcido, geométrico, sem texto, sem personagens.",
    width: 200,
    height: 140,
    alt: "",
  }),
} as const;

export type AssetId = keyof typeof ASSETS;

export function getSpec(id: AssetId): AssetSpec {
  return ASSETS[id];
}
