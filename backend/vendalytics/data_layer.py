"""
data_layer.py — fachada única que os módulos de negócio chamam. Por trás,
delega para o DataSourceAdapter configurado (VENDALYTICS_ADAPTER). Nenhum
módulo de negócio importa um adapter concreto nem monta SQL — só chama estas
funções, então trocar a fonte de dados (SQLite de referência → Postgres →
DW de um cliente específico) nunca exige tocar na lógica de negócio.
"""
from __future__ import annotations

from functools import lru_cache

from .adapters import adapter_ativo


@lru_cache(maxsize=1)
def _adapter():
    return adapter_ativo()


def disponivel() -> bool:
    return _adapter().health_check()


def query_clientes(*, bbox=None, texto="", filial="", limit=2000, offset=0) -> dict:
    return _adapter().clientes_query(bbox=bbox, texto=texto, filial=filial, limit=limit, offset=offset)


def cliente(customer_id: str) -> dict | None:
    return _adapter().cliente_por_id(customer_id)


def clientes_do_vendedor(vendedor_id: str, filial: str = "") -> list[dict]:
    return _adapter().clientes_do_vendedor(vendedor_id, filial=filial)


def metricas(*, filial: str = "") -> dict:
    return _adapter().metricas_agregadas(filial=filial)


def vendas_por_periodo(*, filial="", data_de="", data_ate="", vendedor_id="") -> list[dict]:
    return _adapter().vendas_por_periodo(filial=filial, data_de=data_de, data_ate=data_ate, vendedor_id=vendedor_id)


def pedidos_recentes(customer_id: str, limit: int = 20) -> list[dict]:
    return _adapter().pedidos_recentes(customer_id, limit=limit)


def mix_produtos_cliente(customer_id: str, meses: int = 3) -> list[dict]:
    return _adapter().mix_produtos_cliente(customer_id, meses=meses)


def catalogo_produtos(filial: str = "") -> list[dict]:
    return _adapter().catalogo_produtos(filial=filial)


def vendedores(filial: str = "") -> list[dict]:
    return _adapter().vendedores(filial=filial)


def roteiro_visitas(customer_id: str) -> dict:
    return _adapter().roteiro_visitas(customer_id)
