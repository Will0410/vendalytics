/**
 * cnae.ts — CNAE 2.0: do código fiscal para a seção econômica.
 *
 * A BrasilAPI devolve `cnae_fiscal` como número (ex.: 600001 = 0600-0/01,
 * "Extração de petróleo e gás natural"). Os dois primeiros dígitos do código
 * de 7 posições são a **divisão**, e as divisões se agrupam em 21 **seções**
 * (A–U). Essa é a estrutura oficial do IBGE, não um agrupamento inventado
 * aqui — os intervalos abaixo são a tabela da CNAE 2.0.
 *
 * É o que permite ao módulo de IA dizer "40% desta praça é Comércio" a partir
 * do CNAE cru de cada empresa, em vez de pedir ao usuário que classifique.
 */

export interface SecaoCnae {
  letra: string;
  nome: string;
  /** Rótulo curto para caber em badge e legenda de gráfico. */
  curto: string;
}

interface Faixa extends SecaoCnae {
  de: number;
  ate: number;
}

const FAIXAS: readonly Faixa[] = [
  { de: 1, ate: 3, letra: "A", nome: "Agricultura, pecuária, produção florestal, pesca e aquicultura", curto: "Agropecuária" },
  { de: 5, ate: 9, letra: "B", nome: "Indústrias extrativas", curto: "Extrativa" },
  { de: 10, ate: 33, letra: "C", nome: "Indústrias de transformação", curto: "Indústria" },
  { de: 35, ate: 35, letra: "D", nome: "Eletricidade e gás", curto: "Energia" },
  { de: 36, ate: 39, letra: "E", nome: "Água, esgoto, atividades de gestão de resíduos e descontaminação", curto: "Saneamento" },
  { de: 41, ate: 43, letra: "F", nome: "Construção", curto: "Construção" },
  { de: 45, ate: 47, letra: "G", nome: "Comércio; reparação de veículos automotores e motocicletas", curto: "Comércio" },
  { de: 49, ate: 53, letra: "H", nome: "Transporte, armazenagem e correio", curto: "Transporte" },
  { de: 55, ate: 56, letra: "I", nome: "Alojamento e alimentação", curto: "Alimentação" },
  { de: 58, ate: 63, letra: "J", nome: "Informação e comunicação", curto: "TI & Comunicação" },
  { de: 64, ate: 66, letra: "K", nome: "Atividades financeiras, de seguros e serviços relacionados", curto: "Financeiro" },
  { de: 68, ate: 68, letra: "L", nome: "Atividades imobiliárias", curto: "Imobiliário" },
  { de: 69, ate: 75, letra: "M", nome: "Atividades profissionais, científicas e técnicas", curto: "Serviços técnicos" },
  { de: 77, ate: 82, letra: "N", nome: "Atividades administrativas e serviços complementares", curto: "Adm. & Serviços" },
  { de: 84, ate: 84, letra: "O", nome: "Administração pública, defesa e seguridade social", curto: "Setor público" },
  { de: 85, ate: 85, letra: "P", nome: "Educação", curto: "Educação" },
  { de: 86, ate: 88, letra: "Q", nome: "Saúde humana e serviços sociais", curto: "Saúde" },
  { de: 90, ate: 93, letra: "R", nome: "Artes, cultura, esporte e recreação", curto: "Cultura & Lazer" },
  { de: 94, ate: 96, letra: "S", nome: "Outras atividades de serviços", curto: "Outros serviços" },
  { de: 97, ate: 97, letra: "T", nome: "Serviços domésticos", curto: "Serv. domésticos" },
  { de: 99, ate: 99, letra: "U", nome: "Organismos internacionais e outras instituições extraterritoriais", curto: "Extraterritorial" },
];

const DESCONHECIDA: SecaoCnae = { letra: "?", nome: "Atividade não classificada", curto: "Não classificado" };

/** Divisão (2 dígitos) a partir do CNAE fiscal em qualquer formato. */
export function divisaoCnae(cnae: number | string | null | undefined): number | null {
  if (cnae == null) return null;
  const digitos = String(cnae).replace(/\D/g, "");
  if (!digitos) return null;
  /* O código canônico tem 7 posições; a Receita entrega sem o zero à
     esquerda, então normalizar é obrigatório — sem isso 0600001 vira
     divisão 60 (telecom) em vez de 06 (extrativa). */
  const div = Number(digitos.padStart(7, "0").slice(0, 2));
  return Number.isFinite(div) ? div : null;
}

export function secaoDeCnae(cnae: number | string | null | undefined): SecaoCnae {
  const div = divisaoCnae(cnae);
  if (div == null) return DESCONHECIDA;
  return FAIXAS.find((f) => div >= f.de && div <= f.ate) ?? DESCONHECIDA;
}

export const SECOES: readonly SecaoCnae[] = FAIXAS.map(({ letra, nome, curto }) => ({
  letra,
  nome,
  curto,
}));

/**
 * Setores considerados de alta propensão para venda B2B recorrente.
 *
 * Isto é uma **heurística de produto**, não estatística: setores com volume
 * de transações, cadeia de fornecedores densa e ciclo de recompra curto
 * historicamente respondem melhor a prospecção ativa. Fica explícito aqui,
 * num só lugar, para o usuário poder discordar e trocar — e não escondido
 * dentro do cálculo do score.
 */
export const SECOES_ALTA_PROPENSAO = new Set(["C", "G", "F", "H", "I", "J", "M", "Q"]);
