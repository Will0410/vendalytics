/**
 * format.ts — formatação pt-BR.
 *
 * Centralizado porque formatação inconsistente é o jeito mais rápido de uma
 * interface analítica perder credibilidade: R$ 1.2M num card e R$ 1.234.567
 * no card ao lado fazem o usuário duvidar dos dois.
 *
 * Convenção do produto: **ausência de dado é "—", nunca 0.** O IBGE suprime
 * valores por sigilo estatístico com frequência; escrever 0 ali afirmaria
 * "não existe nenhum", que é uma afirmação diferente e falsa.
 */

const TRACO = "—";

const nfInteiro = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const nfDecimal = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const nfMoeda = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});

export function num(v: number | null | undefined, casas = 0): string {
  if (v == null || !Number.isFinite(v)) return TRACO;
  return casas === 0 ? nfInteiro.format(v) : nfDecimal.format(v);
}

export function moeda(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return TRACO;
  return nfMoeda.format(v);
}

/** Moeda compacta para KPIs: R$ 1,2 bi. Em card, o número longo rouba a
 *  atenção do rótulo — o valor exato vive no tooltip e na tabela. */
export function moedaCompacta(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return TRACO;
  const abs = Math.abs(v);
  if (abs >= 1e12) return `R$ ${nfDecimal.format(v / 1e12)} tri`;
  if (abs >= 1e9) return `R$ ${nfDecimal.format(v / 1e9)} bi`;
  if (abs >= 1e6) return `R$ ${nfDecimal.format(v / 1e6)} mi`;
  if (abs >= 1e3) return `R$ ${nfInteiro.format(Math.round(v / 1e3))} mil`;
  return nfMoeda.format(v);
}

export function numCompacto(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return TRACO;
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${nfDecimal.format(v / 1e9)} bi`;
  if (abs >= 1e6) return `${nfDecimal.format(v / 1e6)} mi`;
  if (abs >= 1e3) return `${nfDecimal.format(v / 1e3)} mil`;
  return nfInteiro.format(v);
}

export function pct(v: number | null | undefined, casas = 1): string {
  if (v == null || !Number.isFinite(v)) return TRACO;
  return `${v.toFixed(casas).replace(".", ",")}%`;
}

/** 00000000000191 → 00.000.000/0001-91 */
export function cnpjMascara(cnpj: string | null | undefined): string {
  if (!cnpj) return TRACO;
  const d = cnpj.replace(/\D/g, "").padStart(14, "0");
  if (d.length !== 14) return cnpj;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

export function soDigitos(v: string): string {
  return v.replace(/\D/g, "");
}

/** Valida CNPJ pelos dígitos verificadores. Barra o pedido antes de gastar
 *  cota da BrasilAPI com um número que ela vai recusar de qualquer jeito. */
export function cnpjValido(bruto: string): boolean {
  const d = soDigitos(bruto);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;

  const dv = (base: string): number => {
    let peso = base.length - 7;
    let soma = 0;
    for (let i = 0; i < base.length; i++) {
      soma += Number(base[i]) * peso--;
      if (peso < 2) peso = 9;
    }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };

  return dv(d.slice(0, 12)) === Number(d[12]) && dv(d.slice(0, 13)) === Number(d[13]);
}

/** 2121660000 → (21) 2166-0000 */
export function telefone(v: string | null | undefined): string {
  if (!v) return TRACO;
  const d = soDigitos(v);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return v;
}

/** "1966-09-28" → "28/09/1966" */
export function data(iso: string | null | undefined): string {
  if (!iso) return TRACO;
  const [a, m, d] = iso.split("-");
  return a && m && d ? `${d}/${m}/${a}` : iso;
}

/** Anos completos desde a data — a "idade" da empresa, sinal forte de ICP. */
export function anosDesde(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / (365.25 * 24 * 3600 * 1000));
}

export function plural(n: number, singular: string, plural_: string): string {
  return `${nfInteiro.format(n)} ${n === 1 ? singular : plural_}`;
}

/** "SÃO PAULO" → "São Paulo". A Receita devolve tudo em caixa alta; caixa
 *  alta em tabela densa é mais difícil de varrer com o olho. */
export function capitalizar(v: string | null | undefined): string {
  if (!v) return TRACO;
  const minusculas = new Set(["de", "da", "do", "das", "dos", "e", "a", "o", "em", "na", "no"]);
  return v
    .toLocaleLowerCase("pt-BR")
    .split(/\s+/)
    .map((p, i) =>
      i > 0 && minusculas.has(p) ? p : p.charAt(0).toLocaleUpperCase("pt-BR") + p.slice(1),
    )
    .join(" ");
}

export { TRACO };
