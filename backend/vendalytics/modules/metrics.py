"""
metrics.py — KPIs de dashboard. Lógica trivial de propósito: o valor está em
consolidar o que já vem pronto de data_layer.metricas(), não em reimplementar
agregação aqui (isso já é responsabilidade do adapter).
"""
from __future__ import annotations

from .. import data_layer


def dashboard(*, filial: str = "") -> dict:
    m = data_layer.metricas(filial=filial)
    vendedores = data_layer.vendedores(filial=filial)
    return {
        "total_clientes": m["total_clientes"],
        "clientes_ativos": m["clientes_ativos"],
        "com_coordenada": m["com_coordenada"],
        "faturamento_30d": m["faturamento_30d"],
        "por_filial": m["por_filial"],
        "total_vendedores": len(vendedores),
    }
