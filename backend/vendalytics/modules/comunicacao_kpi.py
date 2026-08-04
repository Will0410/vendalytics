"""
comunicacao_kpi.py — tradução de objetivo de negócio em KPI de comunicação
rastreável, com correlação REAL medida ao longo do tempo (spec §2.3 C3).

A spec pede: mapear "reduzir churn em 2pp" para KPIs de comunicação (share
of voice, sentimento em aspecto "suporte", tempo de resposta), e MEDIR a
correlação real desses KPIs com o resultado de negócio — "descartando os
que não correlacionam". A parte fácil de fingir aqui é a primeira (mapear
nomes); a parte que dá valor de verdade é a segunda (medir, não assumir).

Este módulo faz a segunda parte de verdade: correlação de Pearson pura
Python entre a série diária de sentimento (de `modules/reputacao.py`) e a
série diária de faturamento (de `data_layer`), com um piso de amostra
abaixo do qual o resultado sai marcado como não confiável — mesmo racional
do `AUC_MINIMA_CONFIAVEL` em `modules/propensao.py`.

O que a spec pede e não está aqui: sentimento POR ASPECTO (o léxico de
`reputacao.py` classifica o documento inteiro, não "aspecto suporte" vs
"aspecto preço" separadamente — isso exigiria NER/classificação de tópico
que este MVP não tem) e tempo de resposta público (não há esse dado
capturado). A correlação abaixo usa o sentimento geral disponível — é o
KPI de comunicação que existe para correlacionar, não uma simulação do
aspecto que a spec descreve como exemplo.
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, datetime, timedelta

from .. import data_layer
from ..infra import context, db

MIN_DIAS_PARA_CONFIAVEL = 14  # abaixo disso, correlação de série curta é ruído, não sinal


def _dt(s) -> date | None:
    try:
        return datetime.fromisoformat(str(s)[:10]).date()
    except (ValueError, TypeError):
        return None


def pearson(xs: list[float], ys: list[float]) -> float | None:
    """Correlação de Pearson, pura Python. `None` quando uma das séries é
    constante (desvio-padrão zero) — correlação não é definida nesse caso,
    e devolver 0 ali seria uma afirmação ("sem relação") diferente de "não
    dá para calcular", que é o que de fato aconteceu."""
    n = len(xs)
    if n < 2:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if sx == 0 or sy == 0:
        return None
    return cov / (sx * sy)


def _serie_diaria_sentimento(*, dias: int) -> dict[str, float]:
    escopo = context.atual()
    desde = (date.today() - timedelta(days=dias)).isoformat()
    with db.conexao() as con:
        rows = con.execute(
            """SELECT publicado_em, sentimento, alcance FROM mencoes
               WHERE tenant_id=? AND publicado_em>=?
               AND id IN (SELECT MIN(id) FROM mencoes WHERE tenant_id=? GROUP BY cluster_id)""",
            (escopo.tenant_id, desde, escopo.tenant_id)).fetchall()
    por_dia: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for r in rows:
        dia = str(r["publicado_em"])[:10]
        por_dia[dia].append((r["sentimento"], max(r["alcance"], 1)))
    return {
        dia: sum(s * a for s, a in pares) / sum(a for _, a in pares)
        for dia, pares in por_dia.items()
    }


def _serie_diaria_faturamento(*, filial: str, dias: int) -> dict[str, float]:
    corte = date.today() - timedelta(days=dias)
    por_dia: dict[str, float] = defaultdict(float)
    for v in data_layer.vendas_por_periodo(filial=filial):
        d = _dt(v.get("data_venda"))
        if d is None or d < corte:
            continue
        por_dia[d.isoformat()] += float(v.get("valor_total") or 0.0)
    return dict(por_dia)


def correlacionar_sentimento_com_faturamento(*, filial: str = "", dias: int = 90) -> dict:
    """A medição real que a spec C3 pede: sentimento diário (comunicação)
    vs. faturamento diário (negócio), só nos dias em que os dois existem —
    dia sem menção não é "sentimento zero", é ausência de dado, e entra na
    correlação incorretamente se for tratado como zero."""
    sentimento = _serie_diaria_sentimento(dias=dias)
    faturamento = _serie_diaria_faturamento(filial=filial, dias=dias)
    dias_comuns = sorted(set(sentimento) & set(faturamento))

    if len(dias_comuns) < 3:
        return {"disponivel": False,
                "motivo": f"apenas {len(dias_comuns)} dia(s) com menção E venda no mesmo dia "
                          f"— não dá para calcular correlação"}

    xs = [sentimento[d] for d in dias_comuns]
    ys = [faturamento[d] for d in dias_comuns]
    r = pearson(xs, ys)
    confiavel = len(dias_comuns) >= MIN_DIAS_PARA_CONFIAVEL

    return {
        "disponivel": True,
        "dias_com_dado_nos_dois_lados": len(dias_comuns),
        "correlacao": round(r, 3) if r is not None else None,
        "confiavel": confiavel,
        "aviso": None if confiavel else (
            f"apenas {len(dias_comuns)} dias sobrepostos — abaixo do piso de "
            f"{MIN_DIAS_PARA_CONFIAVEL} para considerar o coeficiente estável. "
            f"Correlação com amostra curta é ruído, não sinal de causalidade."
        ),
        "leitura": _leitura(r) if r is not None else "sem variação suficiente para calcular",
        "kpi_comunicacao": "sentimento diário ponderado por alcance",
        "kpi_negocio": "faturamento diário",
    }


def _leitura(r: float) -> str:
    forca = "forte" if abs(r) >= 0.6 else "moderada" if abs(r) >= 0.3 else "fraca"
    direcao = "positiva" if r > 0 else "negativa" if r < 0 else "nula"
    return f"correlação {direcao} {forca} (r={r:.2f}) — correlação não é causalidade; " \
           f"use como hipótese a investigar, não como conclusão."
