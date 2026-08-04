"""
executivo.py — Painel Executivo: KPIs de faturamento, carteira, risco de
recompra e cobertura de mix numa só visão, com drill-down feito no frontend
para os módulos de origem (Métricas, Recompra, Mix). Não é uma fonte de dado
nova — só combina o que metrics/recompra/mix já calculam a partir do adapter
configurado (nunca bate direto no schema).
"""
from __future__ import annotations

from datetime import datetime, timezone

from . import metrics, mix, recompra


def overview(*, filial: str = "") -> dict:
    m = metrics.dashboard(filial=filial)
    ciclo = recompra.ciclo_por_cliente(filial=filial)
    gap = mix.gap(filial=filial)

    ativos = m["clientes_ativos"]
    return {
        "filial": filial or "todas",
        "gerado_em": datetime.now(timezone.utc).isoformat(),
        "carteira": {
            "total_clientes": m["total_clientes"],
            "clientes_ativos": ativos,
            "com_coordenada": m["com_coordenada"],
        },
        "faturamento": {
            "ultimos_30d": m["faturamento_30d"],
            "por_filial": m["por_filial"],
        },
        "recompra": {
            "avaliados": ciclo["total_avaliado"],
            "vencendo": ciclo["vencendo"],
            "perdido": ciclo["perdido"],
            "pct_carteira_em_risco": round(100 * ciclo["vencendo"] / ativos, 1) if ativos else None,
        },
        "mix": {
            "total_clientes_ativos": gap["total_clientes_ativos"],
            "top_oportunidades": gap["categorias"][:5],
        },
        "total_vendedores": m["total_vendedores"],
    }
