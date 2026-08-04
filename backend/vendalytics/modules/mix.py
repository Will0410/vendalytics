"""
mix.py — gap de mix / cross-sell: penetração por categoria de produto
(quantos clientes ativos compraram cada categoria) e curva ABC por valor
(classe A ≤80% do valor acumulado, B ≤95%, C o resto). Consolida o que
data_layer.mix_penetracao_categorias já traz do adapter — nenhuma consulta
nova ao schema aqui.
"""
from __future__ import annotations

from .. import data_layer


def gap(*, filial: str = "", meses: int = 3) -> dict:
    """Categorias ordenadas por whitespace (clientes ativos que ainda não
    compraram a categoria) — as maiores oportunidades de cross-sell primeiro."""
    dados = data_layer.mix_penetracao_categorias(filial=filial, meses=meses)
    categorias = dados["categorias"]

    total_valor = sum(c["valor"] for c in categorias) or 1
    acumulado = 0.0
    for c in sorted(categorias, key=lambda x: -x["valor"]):
        acumulado += c["valor"]
        pct_acumulado = acumulado / total_valor * 100
        c["classe_abc"] = "A" if pct_acumulado <= 80 else ("B" if pct_acumulado <= 95 else "C")

    categorias.sort(key=lambda c: c["whitespace"], reverse=True)
    return {
        "total_clientes_ativos": dados["total_clientes_ativos"],
        "categorias": categorias,
    }
