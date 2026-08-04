"""
context.py — o escopo de acesso do request corrente, propagado por
contextvar em vez de passado à mão de função em função.

Por que contextvar e não parâmetro: um parâmetro opcional é esquecido, e um
escopo esquecido não falha — ele simplesmente devolve o dado de todo mundo.
Aqui a ausência de escopo é um erro duro (`EscopoAusente`), então o caminho
do esquecimento quebra em teste em vez de vazar em produção.

Modelo de escopo (§3.7 da spec — RBAC + ABAC):
  - `tenant_id`  → qual instalação/cliente (hoje 1 por processo, ver nota abaixo)
  - `role`       → papel (admin, gestor, vendedor...)
  - `filiais`    → atributo de recorte: conjunto VAZIO significa "sem
                   restrição"; conjunto não-vazio restringe a esses valores.

Nota sobre multi-tenancy: esta instalação é single-tenant por processo (um
`config/tenant_config.yaml`). O `tenant_id` viaja no escopo mesmo assim, de
propósito — quando a plataforma passar a banco compartilhado com RLS, o
ponto de injeção já existe e é um só, em vez de precisar caçar toda query
do código.
"""
from __future__ import annotations

import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass


class EscopoAusente(RuntimeError):
    """Tentativa de tocar em dado sem escopo ativo. É um bug de programação
    (endpoint que esqueceu de abrir o escopo), não um erro do usuário."""


class EscopoNegado(PermissionError):
    """O escopo ativo existe mas não alcança o que foi pedido. É um 403."""


@dataclass(frozen=True)
class Escopo:
    tenant_id: str
    usuario: str
    role: str
    filiais: frozenset[str]
    request_id: str

    @property
    def irrestrito(self) -> bool:
        """Conjunto vazio de filiais = enxerga tudo do tenant."""
        return not self.filiais

    def resolver_filiais(self, pedida: str = "") -> tuple[str, ...]:
        """Intersecção entre o que o request pediu e o que o usuário pode ver.

        Devolve a tupla de filiais a aplicar no filtro; tupla VAZIA significa
        "sem filtro" e só acontece para quem é irrestrito. Pedir uma filial
        fora do escopo é 403 — nunca silenciosamente ignorado nem
        silenciosamente reduzido, porque as duas alternativas devolvem um
        número que o usuário vai interpretar como sendo o que ele pediu.
        """
        pedida = (pedida or "").strip()
        if pedida:
            if not self.irrestrito and pedida not in self.filiais:
                raise EscopoNegado(f"sem acesso à filial '{pedida}'")
            return (pedida,)
        return () if self.irrestrito else tuple(sorted(self.filiais))

    def alcanca_filial(self, filial: str | None) -> bool:
        """Se o escopo alcança um registro já lido (checagem pós-leitura,
        para busca por id — onde não dá para filtrar antes)."""
        if self.irrestrito:
            return True
        return (filial or "") in self.filiais


_atual: ContextVar[Escopo | None] = ContextVar("vendalytics_escopo", default=None)


def parse_filiais(bruto: str | None) -> frozenset[str]:
    """Converte o claim `filiais` do JWT ('SP,RJ' ou '') em conjunto."""
    if not bruto:
        return frozenset()
    return frozenset(p.strip() for p in bruto.split(",") if p.strip())


def novo_request_id() -> str:
    return uuid.uuid4().hex[:16]


def atual() -> Escopo:
    """O escopo do request corrente. Levanta se não houver — ver docstring
    do módulo: falhar aqui é o mecanismo, não um efeito colateral."""
    e = _atual.get()
    if e is None:
        raise EscopoAusente(
            "nenhum escopo de acesso ativo — todo caminho que lê dado precisa "
            "rodar dentro de `infra.context.ativar(...)` (ver "
            "tests/test_isolamento_escopo.py)")
    return e


def opcional() -> Escopo | None:
    """Para quem legitimamente roda sem escopo (health check, startup)."""
    return _atual.get()


@contextmanager
def ativar(escopo: Escopo):
    token = _atual.set(escopo)
    try:
        yield escopo
    finally:
        _atual.reset(token)


def escopo_de_sistema(tenant_id: str, *, motivo: str) -> Escopo:
    """Escopo irrestrito para tarefas internas (seed, migrations, jobs).

    Existe para que trabalho de background não precise burlar `atual()` —
    mas é nomeado, e o `motivo` vai para a auditoria, então um uso indevido
    fica visível na trilha em vez de invisível.
    """
    return Escopo(
        tenant_id=tenant_id,
        usuario=f"sistema:{motivo}",
        role="sistema",
        filiais=frozenset(),
        request_id=novo_request_id(),
    )
