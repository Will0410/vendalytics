from __future__ import annotations

from .. import config


def adapter_ativo():
    """Resolve o adapter configurado em VENDALYTICS_ADAPTER. Só existe
    'sqlite_reference' por enquanto — outros (ex.: postgres) entram aqui
    quando um cliente precisar, sem exigir mudança nos módulos consumidores
    (todos falam com DataSourceAdapter, nunca com o adapter concreto)."""
    nome = config.ADAPTER_ATIVO
    if nome == "sqlite_reference":
        from .sqlite_reference import SQLiteReferenceAdapter
        return SQLiteReferenceAdapter(config.SQLITE_PATH)
    raise ValueError(f"adapter desconhecido: '{nome}' (configure VENDALYTICS_ADAPTER)")
