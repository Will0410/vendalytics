"""
recompra.py — ciclo de recompra estimado por cliente: intervalo médio entre
compras, última compra e status (normal / vencendo / perdido) a partir do
desvio do intervalo esperado. Técnica estatística genérica (razão entre dias
sem comprar e ciclo médio do próprio cliente) — nenhum dado, nenhuma fórmula
proprietária de nenhum cliente do Vendalytics, só histórico de vendas via
data_layer.
"""
from __future__ import annotations

from datetime import date, datetime

from .. import data_layer

# Faixa de atraso relativo (dias_sem_compra / ciclo_dias) que caracteriza
# "vencendo": abaixo disso é normal, acima é considerado perdido/churn.
VENCENDO_DE = 0.9
VENCENDO_ATE = 2.5


def _ciclo_cliente(datas: list[str]) -> tuple[float, str] | None:
    """A partir das datas de compra de 1 cliente, devolve (ciclo médio em
    dias, data da última compra). None se não houver histórico suficiente."""
    if len(datas) < 2:
        return None
    ordenadas = sorted(datetime.fromisoformat(d).date() for d in datas)
    intervalos = [(ordenadas[i] - ordenadas[i - 1]).days
                  for i in range(1, len(ordenadas)) if (ordenadas[i] - ordenadas[i - 1]).days > 0]
    if not intervalos:
        return None
    return sum(intervalos) / len(intervalos), ordenadas[-1].isoformat()


def _classificar(dias_sem_compra: int, ciclo_dias: float) -> str:
    if ciclo_dias <= 0:
        return "sem_dado"
    ratio = dias_sem_compra / ciclo_dias
    if ratio < VENCENDO_DE:
        return "normal"
    if ratio <= VENCENDO_ATE:
        return "vencendo"
    return "perdido"


def ciclo_por_cliente(*, filial: str = "") -> dict:
    """Ciclo de recompra estimado para todos os clientes com histórico
    suficiente (≥2 compras) no escopo pedido."""
    vendas = data_layer.vendas_por_periodo(filial=filial)
    por_cliente: dict[str, list[str]] = {}
    for v in vendas:
        por_cliente.setdefault(v["cliente_id"], []).append(v["data_venda"])

    hoje = date.today()
    clientes = []
    for cliente_id, datas in por_cliente.items():
        calc = _ciclo_cliente(datas)
        if not calc:
            continue
        ciclo_dias, ultima_str = calc
        dias_sem_compra = (hoje - date.fromisoformat(ultima_str)).days
        status = _classificar(dias_sem_compra, ciclo_dias)
        clientes.append({
            "cliente_id": cliente_id,
            "n_compras": len(datas),
            "ciclo_dias": round(ciclo_dias, 1),
            "ultima_compra": ultima_str,
            "dias_sem_compra": dias_sem_compra,
            "status": status,
        })
    clientes.sort(key=lambda c: (c["status"] != "vencendo", -c["dias_sem_compra"]))
    return {
        "total_avaliado": len(clientes),
        "vencendo": sum(1 for c in clientes if c["status"] == "vencendo"),
        "perdido": sum(1 for c in clientes if c["status"] == "perdido"),
        "clientes": clientes,
    }


def vencendo(*, filial: str = "", max_n: int = 50) -> dict:
    """Recorte só dos clientes "vencendo" (candidatos a follow-up prioritário)."""
    dados = ciclo_por_cliente(filial=filial)
    lista = [c for c in dados["clientes"] if c["status"] == "vencendo"]
    return {"total_vencendo": len(lista), "clientes": lista[:max(1, min(max_n, 200))]}
