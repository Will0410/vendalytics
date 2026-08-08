"""
vazios_de_mercado.py — dá para prever ONDE vai abrir empresa?

**Resposta: parcialmente, e só em alguns setores.** A leitura completa está em
`docs/vazios-de-mercado.md`. Este script existe para que a medição seja
reproduzível e para que ninguém precise refazer o trabalho antes de mexer no
modelo.

    python scripts/pesquisa/vazios_de_mercado.py

Só usa a API pública do IBGE. Nenhuma credencial, nenhum download grande.

── Sobre o desenho do teste ────────────────────────────────────────────────
O modelo é ajustado com dados de 2013 e confrontado com o crescimento de 2015
a 2020. As janelas são DISJUNTAS de propósito.

Isso não é preciosismo: ajustar em 2015 e medir o crescimento a partir de 2015
dá rho = -0,291, contra -0,225 com a janela disjunta. A diferença é reversão à
média — o número de empresas de 2015 aparece dos dois lados da conta, e ruído
nele produz correlação sozinho. Quem medir do jeito fácil vai achar que o
indicador é 30% melhor do que é.

Toda comparação aqui tem uma REFERÊNCIA HONESTA ao lado: a densidade pura
(empresas ÷ população). Um modelo que não bate a conta mais simples possível
não é modelo, é nome novo.

Spearman é a medida principal, não Pearson: variação percentual de município
pequeno tem cauda pesadíssima — de 2 para 4 empresas é +100% — e Pearson
viraria refém desses casos.
"""
from __future__ import annotations

import gzip
import io
import json
import math
import urllib.parse
import urllib.request

# Seções CNAE em 12762. Comércio e Indústria passam; Construção não.
SECOES = {
    "Comércio (G)": 117363,
    "Indústria de transformação (C)": 117897,
    "Construção (F)": 117329,
}

SUPRIMIDO = {"-", "..", "...", "X", None, ""}

# Abaixo disto, variação percentual é ruído de cadastro e não movimento de
# mercado.
MINIMO_EMPRESAS = 20

# Teto do PIB per capita, como percentil da amostra. Ver o bloco de resultados
# no fim: sem ele, o topo do ranking vira royalties de petróleo.
PERCENTIL_TETO_RENDA = 0.95


# ── Fonte ───────────────────────────────────────────────────────────────────

def _ibge(url: str) -> object:
    # O IBGE responde comprimido e o urllib não descomprime sozinho.
    req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=300) as r:
        bruto = r.read()
    if bruto[:2] == bytes((0x1F, 0x8B)):
        bruto = gzip.GzipFile(fileobj=io.BytesIO(bruto)).read()
    return json.loads(bruto.decode("utf-8"))


def serie_municipal(agregado: int, variavel: int, periodos: str,
                    classificacao: str = "") -> dict[int, dict[int, float]]:
    p = {"localidades": "N6[all]"}
    if classificacao:
        p["classificacao"] = classificacao
    corpo = _ibge(
        f"https://servicodados.ibge.gov.br/api/v3/agregados/{agregado}"
        f"/periodos/{periodos}/variaveis/{variavel}?" + urllib.parse.urlencode(p)
    )
    saida: dict[int, dict[int, float]] = {}
    for s in corpo[0]["resultados"][0]["series"]:
        try:
            mun = int(s["localidade"]["id"])
        except (KeyError, TypeError, ValueError):
            continue
        anos = {}
        for ano, v in (s.get("serie") or {}).items():
            if v in SUPRIMIDO:
                continue  # suprimido pelo IBGE — nunca vira zero
            try:
                anos[int(ano)] = float(v)
            except ValueError:
                pass
        if anos:
            saida[mun] = anos
    return saida


# ── Estatística ─────────────────────────────────────────────────────────────

def ols(X: list[list[float]], y: list[float]) -> tuple[list[float], float]:
    """Equações normais + Gauss-Jordan com pivotamento parcial.
    Mesmo algoritmo de `web/src/domain/vazios.ts` — o port é verificado por
    `vazios.validacao.test.ts`, que roda o TypeScript sobre este mesmo dado."""
    k = len(X[0])
    A = [[sum(X[r][i] * X[r][j] for r in range(len(X))) for j in range(k)]
         + [sum(X[r][i] * y[r] for r in range(len(X)))] for i in range(k)]
    for i in range(k):
        p = max(range(i, k), key=lambda r: abs(A[r][i]))
        A[i], A[p] = A[p], A[i]
        if abs(A[i][i]) < 1e-12:
            continue
        for r in range(k):
            if r == i:
                continue
            f = A[r][i] / A[i][i]
            for c in range(i, k + 1):
                A[r][c] -= f * A[i][c]
    beta = [A[i][k] / A[i][i] if abs(A[i][i]) > 1e-12 else 0.0 for i in range(k)]
    my = sum(y) / len(y)
    sqt = sum((v - my) ** 2 for v in y)
    sqr = sum((y[r] - sum(beta[i] * X[r][i] for i in range(k))) ** 2
              for r in range(len(X)))
    return beta, 1 - sqr / sqt if sqt else 0.0


def pearson(xs: list[float], ys: list[float]) -> float:
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    return num / (dx * dy) if dx and dy else 0.0


def spearman(xs: list[float], ys: list[float]) -> float:
    def postos(v: list[float]) -> list[float]:
        ordem = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(ordem):
            j = i
            while j + 1 < len(ordem) and v[ordem[j + 1]] == v[ordem[i]]:
                j += 1
            media = (i + j) / 2 + 1
            for t in range(i, j + 1):
                r[ordem[t]] = media
            i = j + 1
        return r
    return pearson(postos(xs), postos(ys))


# ── Modelo ──────────────────────────────────────────────────────────────────

def ajustar(linhas: list[dict], ano: int, teto: float | None):
    ln = math.log
    X, y = [], []
    for r in linhas:
        pc = min(r["pc"], teto) if teto else r["pc"]
        X.append([1.0, ln(r["pop"]), ln(pc)])
        y.append(ln(r[f"e{ano}"]))
    beta, r2 = ols(X, y)
    residuos = [y[i] - sum(beta[j] * X[i][j] for j in range(3)) for i in range(len(X))]
    return beta, r2, residuos


def montar(emp, pop, pib, ano_base: int) -> list[dict]:
    linhas = []
    for m, p in pop.items():
        e_base = emp.get(m, {}).get(ano_base)
        e15 = emp.get(m, {}).get(2015)
        e20 = emp.get(m, {}).get(2020)
        if not e_base or e_base < MINIMO_EMPRESAS or not e15 or not e20:
            continue
        if m not in pib or p <= 0:
            continue
        linhas.append({"m": m, f"e{ano_base}": e_base, "e15": e15, "e20": e20,
                       "pop": p, "pc": pib[m] * 1000.0 / p})
    return linhas


# ── Execução ────────────────────────────────────────────────────────────────

def main() -> None:
    ln = math.log
    print("Baixando população e PIB (2013, 2015)...")
    pop_s = serie_municipal(6579, 9324, "2013|2015")
    pib_s = serie_municipal(5938, 37, "2013|2015")

    for nome, secao in SECOES.items():
        print(f"\n{'=' * 74}\n{nome}\n{'=' * 74}")
        emp = serie_municipal(6449, 2585, "2013|2015|2020", f"12762[{secao}]")

        pop13 = {m: a[2013] for m, a in pop_s.items() if a.get(2013)}
        pib13 = {m: a[2013] for m, a in pib_s.items() if a.get(2013)}
        linhas = montar(emp, pop13, pib13, 2013)
        if len(linhas) < 200:
            print(f"  amostra insuficiente (n={len(linhas)})")
            continue

        cresc = [ln(r["e20"] / r["e15"]) for r in linhas]
        dens = [ln(r["e2013"] / r["pop"]) for r in linhas]
        pcs = sorted(r["pc"] for r in linhas)
        teto = pcs[min(int(PERCENTIL_TETO_RENDA * len(pcs)), len(pcs) - 1)]

        print(f"  n = {len(linhas)}   teto de renda (p95) = R$ {teto:,.0f}\n")
        print("  REFERÊNCIA HONESTA")
        print(f"    densidade pura -> crescimento 15-20 ......... rho = {spearman(dens, cresc):+.3f}\n")
        print("  MODELO (ajustado em 2013, janela DISJUNTA)")
        for rot, t in (("sem teto de renda", None), ("com teto no p95 ", teto)):
            beta, r2, res = ajustar(linhas, 2013, t)
            print(f"    {rot} .... R2 = {r2:.4f}   rho = {spearman(res, cresc):+.3f}"
                  f"   (pop {beta[1]:+.3f}, renda {beta[2]:+.3f})")

        # Reversão à média: a mesma conta com a janela compartilhada.
        pop15 = {m: a[2015] for m, a in pop_s.items() if a.get(2015)}
        pib15 = {m: a[2015] for m, a in pib_s.items() if a.get(2015)}
        l15 = montar(emp, pop15, pib15, 2015)
        if l15:
            pcs15 = sorted(r["pc"] for r in l15)
            t15 = pcs15[min(int(PERCENTIL_TETO_RENDA * len(pcs15)), len(pcs15) - 1)]
            _, _, res15 = ajustar(l15, 2015, t15)
            c15 = [ln(r["e20"] / r["e15"]) for r in l15]
            print(f"\n  ARMADILHA: ajustando em 2015 (janela COMPARTILHADA)")
            print(f"    rho = {spearman(res15, c15):+.3f}  <- inflado por reversão à média")

        # Decis: a leitura que um vendedor faz.
        _, _, res = ajustar(linhas, 2013, teto)
        ordenado = sorted(zip(res, cresc))
        d = len(ordenado) // 10
        p1 = sum(c for _, c in ordenado[:d]) / d
        p10 = sum(c for _, c in ordenado[-d:]) / d
        print(f"\n  Crescimento médio 15-20: decil mais DESABASTECIDO {(math.exp(p1)-1)*100:+.1f}%"
              f"  x  mais SATURADO {(math.exp(p10)-1)*100:+.1f}%")

    print("\nLeitura completa em docs/vazios-de-mercado.md")


if __name__ == "__main__":
    main()
