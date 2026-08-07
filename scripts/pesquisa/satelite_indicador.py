"""
satelite_indicador.py — a expansão de área construída antecede a abertura de
empresas?

**Resposta: não.** O resultado e a leitura completa estão em
`docs/satelite-como-indicador-antecedente.md`. Este script existe para que a
medição seja reproduzível e para que ninguém precise refazer o trabalho antes
de propor a ideia de novo.

    pip install openpyxl
    python scripts/pesquisa/satelite_indicador.py

Baixa ~59MB do MapBiomas na primeira execução e guarda em `var/pesquisa/`.

── Sobre o desenho do teste ────────────────────────────────────────────────
Cada janela ANTECEDENTE vem acompanhada de uma CONTEMPORÂNEA. Sem esse par, um
ρ positivo pareceria confirmar a hipótese quando na verdade só mostraria que
lugares que crescem crescem em tudo ao mesmo tempo. Foi exatamente o que
aconteceu: nas janelas longas a contemporânea é maior que a antecedente.

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
import zipfile
from pathlib import Path

try:
    import openpyxl
except ImportError:  # pragma: no cover
    raise SystemExit("Este script precisa de openpyxl:  pip install openpyxl")

RAIZ = Path(__file__).resolve().parents[2]
CACHE = RAIZ / "var" / "pesquisa"
PLANILHA = CACHE / "mapbiomas_urbano.xlsx"

URL_MAPBIOMAS = (
    "https://drive.usercontent.google.com/download"
    "?id=1Bxa_irBxpT7gzBXj1nzpr-uQD8tergOO&export=download&confirm=t"
)
CLASSE_CONSTRUIDA = "Non-Vegetated Urban Area"

SECOES = {"Comércio (G)": 117363, "Construção (F)": 117329}

# Abaixo deste porte, variação percentual é ruído de cadastro e não movimento
# de mercado — e o ρ despenca para ~0,02 justamente por isso.
PORTE_MINIMO = 200


# ── Fontes ──────────────────────────────────────────────────────────────────

def baixar_mapbiomas() -> Path:
    if PLANILHA.exists():
        return PLANILHA
    CACHE.mkdir(parents=True, exist_ok=True)
    print("Baixando MapBiomas (~59MB, só na primeira vez)...")
    with urllib.request.urlopen(URL_MAPBIOMAS, timeout=600) as r:
        bruto = r.read()
    with zipfile.ZipFile(io.BytesIO(bruto)) as z:
        nome = next(n for n in z.namelist() if n.endswith(".xlsx"))
        PLANILHA.write_bytes(z.read(nome))
    return PLANILHA


def carregar_construida() -> dict[int, dict[int, float]]:
    """Área construída (ha) por município e ano, do MapBiomas."""
    ws = openpyxl.load_workbook(baixar_mapbiomas(), read_only=True)["UrbanVegetation"]
    linhas = ws.iter_rows(values_only=True)
    cabecalho = next(linhas)

    def eh_ano(c) -> bool:
        # Os cabeçalhos de ano vêm como INTEIRO nesta planilha. Filtrar por
        # `isinstance(c, str)` devolvia série vazia sem erro nenhum.
        try:
            return 1985 <= int(c) <= 2024
        except (TypeError, ValueError):
            return False

    idx_ano = {int(c): i for i, c in enumerate(cabecalho) if eh_ano(c)}
    i_mun = cabecalho.index("munCD")
    i_classe = cabecalho.index("classNM")

    saida: dict[int, dict[int, float]] = {}
    for linha in linhas:
        if linha[i_classe] != CLASSE_CONSTRUIDA:
            continue
        try:
            mun = int(linha[i_mun])
        except (TypeError, ValueError):
            continue
        anos = {}
        for ano, i in idx_ano.items():
            try:
                anos[ano] = float(linha[i])
            except (TypeError, ValueError):
                pass
        if anos:
            saida[mun] = anos
    return saida


def carregar_empresas(agregado: int, secao: int, periodos: str) -> dict[int, dict[int, float]]:
    """Nº de empresas por município e ano, do CEMPRE.

    `periodos` é explícito porque `all` com N6[all] devolve 500 no agregado
    6449 — 16 anos × 5.570 municípios excede o que a API entrega.
    """
    url = (
        f"https://servicodados.ibge.gov.br/api/v3/agregados/{agregado}"
        f"/periodos/{periodos}/variaveis/2585?"
        + urllib.parse.urlencode(
            {"localidades": "N6[all]", "classificacao": f"12762[{secao}]"}
        )
    )
    # O IBGE responde comprimido e o urllib não descomprime sozinho.
    req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=300) as r:
        bruto = r.read()
    if bruto[:2] == bytes((0x1F, 0x8B)):
        bruto = gzip.GzipFile(fileobj=io.BytesIO(bruto)).read()
    corpo = json.loads(bruto.decode("utf-8"))

    saida: dict[int, dict[int, float]] = {}
    for s in corpo[0]["resultados"][0]["series"]:
        try:
            mun = int(s["localidade"]["id"])
        except (KeyError, TypeError, ValueError):
            continue
        anos = {}
        for ano, v in (s.get("serie") or {}).items():
            if v in ("-", "..", "...", "X", None, ""):
                continue  # suprimido pelo IBGE — nunca vira zero
            try:
                anos[int(ano)] = float(v)
            except ValueError:
                pass
        if anos:
            saida[mun] = anos
    return saida


# ── Estatística ─────────────────────────────────────────────────────────────

def variacao(serie: dict[int, float], de: int, ate: int) -> float | None:
    a, b = serie.get(de), serie.get(ate)
    if a is None or b is None or a <= 0:
        return None  # base zero não tem variação percentual definida
    return (b - a) / a * 100


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
            for k in range(i, j + 1):
                r[ordem[k]] = media
            i = j + 1
        return r

    return pearson(postos(xs), postos(ys))


def correlacionar(rotulo, construida, empresas, janela, porte=PORTE_MINIMO):
    ca, cb, ea, eb = janela
    pares = [
        (x, y)
        for mun, se in empresas.items()
        if (sc := construida.get(mun))
        and se.get(ea, 0) >= porte
        and (x := variacao(sc, ca, cb)) is not None
        and (y := variacao(se, ea, eb)) is not None
    ]
    if len(pares) < 30:
        print(f"  {rotulo:<52} amostra insuficiente ({len(pares)})")
        return
    xs = [p[0] for p in pares]
    ys = [p[1] for p in pares]
    print(f"  {rotulo:<52} rho={spearman(xs, ys):+.3f}  r={pearson(xs, ys):+.3f}  n={len(pares)}")


# ── Execução ────────────────────────────────────────────────────────────────

def main() -> None:
    construida = carregar_construida()
    print(f"MapBiomas: {len(construida)} municípios com série de área construída\n")

    for nome, secao in SECOES.items():
        print(f"=== {nome} — janela curta (CEMPRE 9418, 2022–2024) ===")
        curta = carregar_empresas(9418, secao, "all")
        correlacionar("ANTECEDENTE   constr 20-22 -> empresas 22-24",
                      construida, curta, (2020, 2022, 2022, 2024))
        correlacionar("CONTEMPORANEA constr 22-24 -> empresas 22-24",
                      construida, curta, (2022, 2024, 2022, 2024))

        print(f"\n=== {nome} — janela longa, pré-pandemia (CEMPRE 6449) ===")
        longa = carregar_empresas(6449, secao, "2008|2010|2013|2015|2018|2020")
        correlacionar("ANTECEDENTE   constr 10-15 -> empresas 15-20",
                      construida, longa, (2010, 2015, 2015, 2020))
        correlacionar("ANTECEDENTE   constr 08-13 -> empresas 13-18",
                      construida, longa, (2008, 2013, 2013, 2018))
        correlacionar("CONTEMPORANEA constr 10-15 -> empresas 10-15",
                      construida, longa, (2010, 2015, 2010, 2015))
        print()

    print("Leitura completa em docs/satelite-como-indicador-antecedente.md")


if __name__ == "__main__":
    main()
