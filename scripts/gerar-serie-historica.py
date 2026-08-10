"""
gerar-serie-historica.py — produz `web/src/data/serie-historica.json`.

Controle sintético precisa de período PRÉ-intervenção longo: constrói-se um
município contrafactual como combinação de praças parecidas, e o ajuste só é
crível se ele acompanhar o tratado por vários anos antes da intervenção.

O agregado que o produto usa em tempo real (9418) tem **três pontos**
(2022–2024). Insuficiente. A série longa está no 6449 (2006–2021), que não é
carregado no navegador — 16 anos × 5.570 municípios não cabem numa consulta de
tela.

Daí o artefato. E ele é gerado em DOIS pedidos por setor, não um:

    16 anos de uma vez ...... HTTP 500
     8 anos .................. 1.135 KB, 77s   ✓

    python scripts/gerar-serie-historica.py

Só entram municípios com a série COMPLETA e porte mínimo. Um doador com buraco
na série contamina o ajuste em silêncio — o otimizador simplesmente evita os
anos faltantes e o pré-período parece melhor do que é.
"""
from __future__ import annotations

import gzip
import io
import json
import pathlib
import time
import urllib.request

RAIZ = pathlib.Path(__file__).resolve().parents[1]
DESTINO = RAIZ / "web" / "src" / "data" / "serie-historica.json"
CACHE = RAIZ / "var" / "serie-historica"

AGREGADO = 6449
VARIAVEL = 2585
CLASSIFICACAO = 12762
ANOS = list(range(2006, 2022))

# Só os setores em que o indicador de vazios foi validado. Gerar série para os
# 21 é 10× o tamanho para telas que não existem.
SECOES = {"G": 117363, "C": 117897}

# Abaixo disto a variação percentual é ruído de cadastro, e um doador ruidoso
# estraga o contrafactual de todo mundo que o usar.
MINIMO_EMPRESAS = 30

SUPRIMIDO = {"-", "..", "...", "X", None, ""}


def _ibge(url: str):
    req = urllib.request.Request(
        url, headers={"Accept-Encoding": "gzip", "User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=600) as r:
        b = r.read()
    if b[:2] == bytes((0x1F, 0x8B)):
        b = gzip.GzipFile(fileobj=io.BytesIO(b)).read()
    return json.loads(b.decode("utf-8"))


def coletar(secao: str, categoria: int) -> dict[int, dict[int, float]]:
    CACHE.mkdir(parents=True, exist_ok=True)
    arq = CACHE / f"{AGREGADO}_{secao}.json"
    if arq.exists():
        b = json.loads(arq.read_text(encoding="utf-8"))
        return {int(m): {int(a): v for a, v in s.items()} for m, s in b.items()}

    saida: dict[int, dict[int, float]] = {}
    # Dois blocos de 8: 16 de uma vez devolve 500.
    for bloco in (ANOS[:8], ANOS[8:]):
        per = "|".join(str(a) for a in bloco)
        url = (f"https://servicodados.ibge.gov.br/api/v3/agregados/{AGREGADO}"
               f"/periodos/{per}/variaveis/{VARIAVEL}"
               f"?localidades=N6[all]&classificacao={CLASSIFICACAO}[{categoria}]")
        print(f"    {secao}: {bloco[0]}–{bloco[-1]}...", flush=True)
        corpo = None
        for tentativa in range(3):
            try:
                corpo = _ibge(url)
                break
            except Exception as e:
                print(f"      tentativa {tentativa + 1} falhou: {type(e).__name__}")
                time.sleep(5)
        if not corpo:
            continue
        for s in corpo[0]["resultados"][0]["series"]:
            try:
                mun = int(s["localidade"]["id"])
            except (KeyError, TypeError, ValueError):
                continue
            for ano, v in (s.get("serie") or {}).items():
                if v in SUPRIMIDO:
                    continue  # suprimido pelo IBGE — nunca vira zero
                try:
                    saida.setdefault(mun, {})[int(ano)] = float(v)
                except ValueError:
                    pass

    arq.write_text(json.dumps({str(m): {str(a): v for a, v in s.items()}
                               for m, s in saida.items()}), encoding="utf-8")
    return saida


def main() -> None:
    print(f"Coletando {AGREGADO} ({ANOS[0]}–{ANOS[-1]}) para {len(SECOES)} setores...")
    series: dict[str, dict[int, list[int]]] = {}
    for secao, categoria in SECOES.items():
        bruto = coletar(secao, categoria)
        completos: dict[int, list[int]] = {}
        for mun, s in bruto.items():
            # Série completa E porte mínimo no último ano do pré-período.
            if len(s) != len(ANOS):
                continue
            if s.get(ANOS[-1], 0) < MINIMO_EMPRESAS:
                continue
            completos[mun] = [int(round(s[a])) for a in ANOS]
        series[secao] = completos
        print(f"  {secao}: {len(bruto)} municípios coletados, "
              f"{len(completos)} com série completa e {MINIMO_EMPRESAS}+ empresas")

    DESTINO.parent.mkdir(parents=True, exist_ok=True)
    DESTINO.write_text(json.dumps({
        "_o_que_e": ("Série histórica de nº de empresas por município e ano. Existe "
                     "para o controle sintético, que precisa de período pré longo — "
                     "o agregado de produção (9418) só tem 2022–2024."),
        "_fonte": f"IBGE CEMPRE agregado {AGREGADO}/{VARIAVEL}, classificação {CLASSIFICACAO}",
        "_criterio": (f"Só municípios com a série COMPLETA e {MINIMO_EMPRESAS}+ empresas "
                      f"em {ANOS[-1]}. Doador com buraco na série contamina o ajuste em "
                      "silêncio: o otimizador evita os anos faltantes e o pré-período "
                      "parece melhor do que é."),
        "_gerado_por": "scripts/gerar-serie-historica.py",
        "_gerado_em": time.strftime("%Y-%m-%d"),
        "anos": ANOS,
        "series": {s: {str(m): v for m, v in sorted(d.items())} for s, d in series.items()},
    }, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    kb = DESTINO.stat().st_size / 1024
    print(f"\n  gravado: {DESTINO.relative_to(RAIZ)} ({kb:.0f} KB)")


if __name__ == "__main__":
    main()
