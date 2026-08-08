"""
gerar-espaco-cnae.py — produz `web/src/data/espaco-cnae.json`.

Por que um artefato pré-gerado, e não uma consulta em tempo real: a API do IBGE
entrega **uma divisão CNAE por vez** para os 5.570 municípios (655KB, ~2,7s).
Pedir cinco de uma vez já devolve HTTP 500. São 87 divisões, ou seja ~57MB e
quatro minutos — inviável no navegador.

E é desnecessário: a rede de proximidade é um objeto **global**. Ela não muda
por usuário, nem por filtro, nem por sessão. Muda uma vez por ano, quando o
IBGE publica o CEMPRE. Então é gerada aqui e versionada.

    python scripts/gerar-espaco-cnae.py

O método e sua validação estão em `docs/espaco-de-atividades.md`. Este script
só produz o dado; quem calcula a prontidão é `web/src/domain/ecossistema.ts`.
"""
from __future__ import annotations

import gzip
import io
import json
import pathlib
import time
import urllib.request

RAIZ = pathlib.Path(__file__).resolve().parents[1]
DESTINO = RAIZ / "web" / "src" / "data" / "espaco-cnae.json"
CACHE = RAIZ / "var" / "espaco-cnae"

AGREGADO = 9418          # CEMPRE 2022–2024, com quebra CNAE 2.0 completa
VARIAVEL = 2585          # número de empresas atuantes
CLASSIFICACAO = 12762    # CNAE 2.0
NIVEL_DIVISAO = 2        # 87 divisões (nível 1 = 21 seções, nível 3 = 284 grupos)
ANO = 2024

SUPRIMIDO = {"-", "..", "...", "X", None, ""}


def _ibge(url: str):
    # O IBGE responde comprimido e o urllib não descomprime sozinho. E a borda
    # rejeita o User-Agent padrão do Python — o mesmo bloqueio já visto na
    # BrasilAPI e na Groq.
    req = urllib.request.Request(
        url, headers={"Accept-Encoding": "gzip", "User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=300) as r:
        b = r.read()
    if b[:2] == bytes((0x1F, 0x8B)):
        b = gzip.GzipFile(fileobj=io.BytesIO(b)).read()
    return json.loads(b.decode("utf-8"))


def divisoes() -> list[dict]:
    meta = _ibge(f"https://servicodados.ibge.gov.br/api/v3/agregados/{AGREGADO}/metadados")
    cls = next(c for c in meta["classificacoes"] if c["id"] == CLASSIFICACAO)
    saida = []
    for c in cls["categorias"]:
        if c.get("nivel") != NIVEL_DIVISAO:
            continue
        nome = c["nome"]
        codigo, _, rotulo = nome.partition(" ")
        saida.append({"id": c["id"], "codigo": codigo, "nome": rotulo.strip() or nome})
    return saida


def coletar_ano(agregado: int, ano: int, divs: list[dict]) -> dict[int, dict[int, float]]:
    """Uma requisicao por divisao — cinco de uma vez ja devolve HTTP 500."""
    CACHE.mkdir(parents=True, exist_ok=True)
    arq = CACHE / f"empresas_{agregado}_{ano}.json"
    if arq.exists():
        b = json.loads(arq.read_text(encoding="utf-8"))
        return {int(m): {int(d): v for d, v in ds.items()} for m, ds in b.items()}

    saida: dict[int, dict[int, float]] = {}
    for k, d in enumerate(divs, 1):
        url = (f"https://servicodados.ibge.gov.br/api/v3/agregados/{agregado}"
               f"/periodos/{ano}/variaveis/{VARIAVEL}"
               f"?localidades=N6[all]&classificacao={CLASSIFICACAO}[{d['id']}]")
        corpo = None
        for tentativa in range(3):
            try:
                corpo = _ibge(url)
                break
            except Exception as e:
                if tentativa == 2:
                    print(f"    [{k}/{len(divs)}] FALHOU {d['codigo']}: {e}")
                time.sleep(2)
        if not corpo:
            continue
        for s in corpo[0]["resultados"][0]["series"]:
            try:
                mun = int(s["localidade"]["id"])
            except (KeyError, TypeError, ValueError):
                continue
            v = (s.get("serie") or {}).get(str(ano))
            if v in SUPRIMIDO:
                continue  # suprimido pelo IBGE — nunca vira zero
            try:
                val = float(v)
            except ValueError:
                continue
            if val > 0:
                saida.setdefault(mun, {})[d["id"]] = val
        if k % 10 == 0 or k == len(divs):
            print(f"    [{k}/{len(divs)}] {d['codigo']} {d['nome'][:34]}")

    arq.write_text(json.dumps({str(m): {str(d): v for d, v in ds.items()}
                               for m, ds in saida.items()}), encoding="utf-8")
    return saida


def especializacoes(dados, ids: list[int]) -> dict[int, list[int]]:
    """Vantagem Comparativa Revelada, binarizada.

    RCA(c,i) = (peso da divisão i no município c) ÷ (peso de i no Brasil).
    RCA ≥ 1 significa: esta atividade pesa MAIS aqui do que pesa no país.

    É o binário disso — e não a contagem — que define a rede, porque o que
    interessa é CAPACIDADE, não tamanho. Sem essa normalização, São Paulo seria
    vizinho de todo mundo simplesmente por ter mais de tudo.
    """
    total_pais = {d: 0.0 for d in ids}
    total_mun: dict[int, float] = {}
    grande = 0.0
    for c, ds in dados.items():
        for d, v in ds.items():
            total_pais[d] = total_pais.get(d, 0.0) + v
            total_mun[c] = total_mun.get(c, 0.0) + v
            grande += v

    idx = {d: i for i, d in enumerate(ids)}
    saida: dict[int, list[int]] = {}
    for c, ds in dados.items():
        if total_mun.get(c, 0) <= 0:
            continue
        presentes = []
        for d, v in ds.items():
            if total_pais.get(d, 0) <= 0:
                continue
            if (v / total_mun[c]) / (total_pais[d] / grande) >= 1.0:
                presentes.append(idx[d])
        saida[c] = sorted(presentes)
    return saida


def proximidade(presenca: dict[int, list[int]], n: int) -> list[list[float]]:
    """φ(i,j) = min( P(RCA_i | RCA_j), P(RCA_j | RCA_i) ).

    O `min` é o coração do método. Sem ele, uma atividade presente em quase
    todo município pareceria próxima de tudo — a ligação só é forte se a
    coocorrência for forte NOS DOIS SENTIDOS.
    """
    cont = [0] * n
    for pres in presenca.values():
        for i in pres:
            cont[i] += 1

    junto = [[0] * n for _ in range(n)]
    for pres in presenca.values():
        for a in range(len(pres)):
            for b in range(a + 1, len(pres)):
                junto[pres[a]][pres[b]] += 1
                junto[pres[b]][pres[a]] += 1

    phi = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            if cont[i] and cont[j] and junto[i][j]:
                v = min(junto[i][j] / cont[i], junto[i][j] / cont[j])
                phi[i][j] = phi[j][i] = round(v, 4)
    return phi


def _auc(scores: list[float], rotulos: list[int]) -> float:
    """Area sob a ROC por postos (Mann-Whitney). 0,5 = moeda."""
    pares = sorted(zip(scores, rotulos))
    postos, i = [0.0] * len(pares), 0
    while i < len(pares):
        j = i
        while j + 1 < len(pares) and pares[j + 1][0] == pares[i][0]:
            j += 1
        m = (i + j) / 2 + 1
        for t in range(i, j + 1):
            postos[t] = m
        i = j + 1
    pos = sum(rotulos)
    neg = len(pares) - pos
    if pos == 0 or neg == 0:
        return 0.5
    soma = sum(p for p, (_, r) in zip(postos, pares) if r == 1)
    return (soma - pos * (pos + 1) / 2) / (pos * neg)


def validar_por_divisao(divs: list[dict]) -> dict[str, float]:
    """Mede, POR DIVISÃO, se a rede realmente antecipa o aparecimento.

    Rede construída com o CEMPRE de 2013 (agregado 6449); rótulo = a divisão
    apareceu naquele município até 2020. Nenhum dado de 2020 entra na rede.

    Isto vai para dentro do artefato porque o indicador NÃO vale para todas as
    atividades, e a diferença não é sutil: vai de 0,88 (descontaminação,
    transporte aéreo, farmoquímicos) a 0,39 (serviços de escritório, varejo,
    educação). O padrão é interpretável — a rede prevê o que exige capacidade
    específica e falha no que apenas acompanha população.

    Sem este número gravado, o produto ofereceria os dois casos com a mesma
    cara.
    """
    ids = [d["id"] for d in divs]
    codigo = {d["id"]: d["codigo"] for d in divs}

    print("\nValidando (CEMPRE 6449: rede de 2013 -> aparecimento até 2020)...")
    d13 = coletar_ano(6449, 2013, divs)
    d20 = coletar_ano(6449, 2020, divs)

    M13 = {c: set(p) for c, p in _rca_ids(d13, ids).items()}
    M20 = {c: set(p) for c, p in _rca_ids(d20, ids).items()}

    cont = {d: sum(1 for p in M13.values() if d in p) for d in ids}
    junto: dict[tuple[int, int], int] = {}
    for pres in M13.values():
        lista = sorted(pres)
        for a in range(len(lista)):
            for b in range(a + 1, len(lista)):
                k = (lista[a], lista[b])
                junto[k] = junto.get(k, 0) + 1
    phi: dict[tuple[int, int], float] = {}
    for (i, j), v in junto.items():
        if cont[i] and cont[j]:
            p = min(v / cont[i], v / cont[j])
            phi[(i, j)] = phi[(j, i)] = p
    soma_total = {i: sum(phi.get((i, j), 0.0) for j in ids if j != i) for i in ids}

    por_div: dict[int, tuple[list[float], list[int]]] = {i: ([], []) for i in ids}
    for c, pres in M13.items():
        if c not in M20:
            continue
        for alvo in ids:
            if alvo in pres:
                continue
            den = soma_total[alvo]
            d = (sum(phi.get((alvo, j), 0.0) for j in pres) / den) if den > 0 else 0.0
            por_div[alvo][0].append(d)
            por_div[alvo][1].append(1 if alvo in M20[c] else 0)

    saida: dict[str, float] = {}
    for i in ids:
        s, y = por_div[i]
        # Menos de 30 aparecimentos não sustenta um AUC. Fica None e o produto
        # trata como "não validado", que é a verdade.
        saida[codigo[i]] = round(_auc(s, y), 4) if sum(y) >= 30 else None
    validas = [v for v in saida.values() if v is not None and v >= 0.55]
    print(f"  {len(validas)} de {len(ids)} divisões com AUC >= 0,55")
    return saida


def _rca_ids(dados, ids) -> dict[int, list[int]]:
    """Como `especializacoes`, mas devolvendo IDs do IBGE em vez de índices."""
    total_pais = {d: 0.0 for d in ids}
    total_mun: dict[int, float] = {}
    grande = 0.0
    for c, ds in dados.items():
        for d, v in ds.items():
            total_pais[d] = total_pais.get(d, 0.0) + v
            total_mun[c] = total_mun.get(c, 0.0) + v
            grande += v
    saida = {}
    for c, ds in dados.items():
        if total_mun.get(c, 0) <= 0:
            continue
        saida[c] = [d for d, v in ds.items()
                    if total_pais.get(d, 0) > 0
                    and (v / total_mun[c]) / (total_pais[d] / grande) >= 1.0]
    return saida


def main() -> None:
    print(f"Coletando {NIVEL_DIVISAO}º nível da CNAE no agregado {AGREGADO} ({ANO})...")
    divs = divisoes()
    dados = coletar_ano(AGREGADO, ANO, divs)
    ids = [d["id"] for d in divs]
    n = len(ids)

    auc_por_divisao = validar_por_divisao(divs)
    presenca = especializacoes(dados, ids)
    phi = proximidade(presenca, n)
    total_mun = len(presenca)
    popularidade = [
        round(sum(1 for p in presenca.values() if i in p) / total_mun, 4) for i in range(n)
    ]

    ligacoes = sum(1 for i in range(n) for j in range(i + 1, n) if phi[i][j] > 0)
    print(f"\n  {total_mun} municípios | {n} divisões | {ligacoes} ligações na rede")
    # Sem acento nem simbolo fora do ASCII nesta linha: o console do Windows
    # roda em cp1252 e um "≥" aqui derruba o script DEPOIS de quatro minutos
    # de coleta. O JSON abaixo e gravado em UTF-8 explicito e nao tem esse
    # problema.
    print(f"  especializacoes (RCA >= 1): {sum(len(p) for p in presenca.values()):,}")

    DESTINO.parent.mkdir(parents=True, exist_ok=True)
    DESTINO.write_text(json.dumps({
        "_o_que_e": ("Espaço de atividades econômicas municipais. Rede de proximidade "
                     "entre divisões CNAE + em que divisões cada município tem "
                     "vantagem comparativa revelada."),
        "_metodo": ("Hausmann-Hidalgo (espaço de produtos) aplicado a CNAE municipal. "
                    "Validação fora da amostra em docs/espaco-de-atividades.md."),
        "_fonte": f"IBGE CEMPRE agregado {AGREGADO}/{VARIAVEL}, classificação "
                  f"{CLASSIFICACAO} nível {NIVEL_DIVISAO}, {ANO}",
        "_gerado_por": "scripts/gerar-espaco-cnae.py",
        "_gerado_em": time.strftime("%Y-%m-%d"),
        "ano": ANO,
        "_validacao": ("AUC por divisao, medido FORA DA AMOSTRA: rede construida com o "
                       "CEMPRE 6449 de 2013, rotulo = a divisao apareceu no municipio ate "
                       "2020. `null` = menos de 30 aparecimentos, insuficiente para medir."),
        "divisoes": [{"codigo": d["codigo"], "nome": d["nome"],
                      "auc": auc_por_divisao.get(d["codigo"])} for d in divs],
        "popularidade": popularidade,
        # Triângulo superior achatado: a matriz é simétrica, gravar as duas
        # metades dobraria o arquivo à toa.
        "proximidade": [[i, j, phi[i][j]] for i in range(n) for j in range(i + 1, n)
                        if phi[i][j] > 0],
        "presenca": {str(m): p for m, p in sorted(presenca.items())},
    }, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    kb = DESTINO.stat().st_size / 1024
    print(f"  gravado: {DESTINO.relative_to(RAIZ)} ({kb:.0f} KB)")


if __name__ == "__main__":
    main()
