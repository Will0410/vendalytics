"""
data_layer.py — fachada única que os módulos de negócio chamam. Por trás,
delega para o DataSourceAdapter configurado (VENDALYTICS_ADAPTER). Nenhum
módulo de negócio importa um adapter concreto nem monta SQL — só chama estas
funções, então trocar a fonte de dados (SQLite de referência hoje →
Postgres → DW de um cliente específico) nunca exige tocar na lógica de
negócio.

── Ponto de enforcement (Fase 0) ──────────────────────────────────────────
Esta fachada é o ÚNICO lugar onde o escopo de acesso do request vira filtro
de dado. Consequências deliberadas:

  * Toda função de leitura chama `context.atual()`, que levanta
    `EscopoAusente` se ninguém abriu escopo. Um endpoint novo que esqueça de
    abrir não devolve dado demais — ele quebra, e quebra em teste
    (`tests/test_isolamento_escopo.py`).
  * Os módulos de negócio continuam recebendo `filial: str` como antes. A
    interseção com o que o usuário pode ver acontece aqui, não neles: regra
    de autorização espalhada por módulo de negócio é regra que uma hora
    alguém esquece.
  * Leitura por id (cliente, pedidos, mix, roteiro) é filtrada DEPOIS da
    leitura, comparando a filial do registro com o escopo. Sem isso,
    `/api/clientes/{id}` era um bypass completo do recorte por filial —
    bastava saber o id.
"""
from __future__ import annotations

from functools import lru_cache

from .adapters import adapter_ativo
from .infra import audit, context


@lru_cache(maxsize=1)
def _adapter():
    return adapter_ativo()


def _filiais(filial: str = "") -> tuple[str, ...]:
    """Filiais efetivas: interseção do pedido com o permitido pelo escopo."""
    return context.atual().resolver_filiais(filial)


def _exigir_alcance(cliente_dict: dict | None, *, acao: str, recurso: str) -> dict | None:
    """Nega acesso a registro fora do escopo — e registra a tentativa.

    Devolve None (não 403) quando o cliente simplesmente não existe, e
    levanta quando existe mas está fora do escopo. São situações diferentes
    e o chamador trata cada uma do seu jeito.
    """
    if cliente_dict is None:
        return None
    escopo = context.atual()
    if not escopo.alcanca_filial(cliente_dict.get("filial")):
        audit.negado(acao, recurso=recurso,
                     motivo=f"cliente na filial '{cliente_dict.get('filial')}', "
                            f"fora do escopo do usuário")
        raise context.EscopoNegado("cliente fora do seu escopo de acesso")
    return cliente_dict


def disponivel() -> bool:
    """Health check da fonte. Não exige escopo de propósito: roda no startup,
    antes de existir request, e não devolve dado de ninguém."""
    return _adapter().health_check()


# ── Clientes ───────────────────────────────────────────────────────────────
def query_clientes(*, bbox=None, texto="", filial="", limit=2000, offset=0) -> dict:
    return _adapter().clientes_query(
        bbox=bbox, texto=texto, filiais=_filiais(filial), limit=limit, offset=offset)


def cliente(customer_id: str) -> dict | None:
    c = _adapter().cliente_por_id(customer_id)
    return _exigir_alcance(c, acao="cliente.ler", recurso=f"cliente:{customer_id}")


def clientes_do_vendedor(vendedor_id: str, filial: str = "") -> list[dict]:
    return _adapter().clientes_do_vendedor(vendedor_id, filiais=_filiais(filial))


def metricas(*, filial: str = "") -> dict:
    return _adapter().metricas_agregadas(filiais=_filiais(filial))


# ── Vendas ─────────────────────────────────────────────────────────────────
def vendas_por_periodo(*, filial="", data_de="", data_ate="", vendedor_id="") -> list[dict]:
    return _adapter().vendas_por_periodo(
        filiais=_filiais(filial), data_de=data_de, data_ate=data_ate, vendedor_id=vendedor_id)


def pedidos_recentes(customer_id: str, limit: int = 20) -> list[dict]:
    _exigir_alcance(_adapter().cliente_por_id(customer_id),
                    acao="pedidos.ler", recurso=f"cliente:{customer_id}")
    return _adapter().pedidos_recentes(customer_id, limit=limit)


# ── Mix / catálogo ─────────────────────────────────────────────────────────
def mix_produtos_cliente(customer_id: str, meses: int = 3) -> list[dict]:
    _exigir_alcance(_adapter().cliente_por_id(customer_id),
                    acao="mix.ler", recurso=f"cliente:{customer_id}")
    return _adapter().mix_produtos_cliente(customer_id, meses=meses)


def mix_categorias_por_clientes(customer_ids: list[str], meses: int = 3) -> dict[str, list[dict]]:
    """Versão em lote de `mix_produtos_cliente`, para quando o chamador
    precisa do mix de várias dezenas de clientes de uma vez (ex.: peers
    geográficos em `modules/field.py`) — 1 consulta em vez de N. Os IDs já
    vêm de uma listagem escopada (ex.: `query_clientes`), então não repete
    o check de alcance por item aqui (seria redundante, não a única
    barreira) — mas ainda exige escopo ativo, como toda função de leitura
    desta fachada (ver docstring do módulo)."""
    context.atual()
    return _adapter().mix_categorias_por_clientes(customer_ids, meses=meses)


def catalogo_produtos(filial: str = "") -> list[dict]:
    return _adapter().catalogo_produtos(filiais=_filiais(filial))


def mix_penetracao_categorias(*, filial: str = "", meses: int = 3) -> dict:
    return _adapter().mix_penetracao_categorias(filiais=_filiais(filial), meses=meses)


# ── Território / TAM-SAM-SOM ────────────────────────────────────────────────
def cobertura_por_municipio(*, filial: str = "") -> list[dict]:
    return _adapter().cobertura_por_municipio(filiais=_filiais(filial))


# ── Equipe / roteiro ───────────────────────────────────────────────────────
def vendedores(filial: str = "") -> list[dict]:
    return _adapter().vendedores(filiais=_filiais(filial))


def roteiro_visitas(customer_id: str) -> dict:
    _exigir_alcance(_adapter().cliente_por_id(customer_id),
                    acao="roteiro.ler", recurso=f"cliente:{customer_id}")
    return _adapter().roteiro_visitas(customer_id)
