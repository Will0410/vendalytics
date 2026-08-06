"""
bizdata_cache.py — cache local dos comércios reais consultados via
bizdata_real (OpenStreetMap). Mesmo racional de `mercado_publico_cache.py`:
fonte de terceiro sem SLA, sem chave — cada (município, UF, categoria)
consultado uma vez fica disponível instantaneamente depois, e se a fonte
sair do ar, o que já foi coletado continua servindo.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .. import config
from ..modules.identidade import normalizar_texto

DB_PATH = Path(
    __import__("os").getenv("VENDALYTICS_BIZDATA_DB",
                            str(config.PROJECT_ROOT / "bizdata_cache.sqlite")))

# Acima disso o cache é considerado velho o bastante pra tentar de novo na
# fonte ao vivo (comércio muda: abre, fecha, muda de endereço).
VALIDADE_DIAS = 30

SCHEMA = """
CREATE TABLE IF NOT EXISTS comercios_cache (
    municipio_norm TEXT NOT NULL,
    uf             TEXT NOT NULL,
    categoria      TEXT NOT NULL,
    resultado_json TEXT NOT NULL,
    atualizado_em  TEXT NOT NULL,
    PRIMARY KEY (municipio_norm, uf, categoria)
);
"""


def _con() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(DB_PATH), timeout=10)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def buscar_no_cache(municipio: str, uf: str, categoria: str) -> tuple[list[dict], bool] | None:
    """`None` se nunca foi consultado. Senão, (lista, fresco) — `fresco`
    indica se está dentro da validade ou se já passou dos 30 dias (o
    chamador decide se tenta atualizar ou usa mesmo assim)."""
    chave = (normalizar_texto(municipio), (uf or "").upper(), categoria)
    with closing(_con()) as con:
        r = con.execute(
            "SELECT * FROM comercios_cache WHERE municipio_norm=? AND uf=? AND categoria=?",
            chave).fetchone()
    if r is None:
        return None
    fresco = (datetime.now(timezone.utc) - datetime.fromisoformat(r["atualizado_em"])
             ) < timedelta(days=VALIDADE_DIAS)
    return json.loads(r["resultado_json"]), fresco


def salvar(municipio: str, uf: str, categoria: str, resultado: list[dict]) -> None:
    with closing(_con()) as con:
        con.execute(
            """INSERT INTO comercios_cache (municipio_norm, uf, categoria, resultado_json, atualizado_em)
               VALUES (?,?,?,?,?)
               ON CONFLICT (municipio_norm, uf, categoria) DO UPDATE SET
                 resultado_json=excluded.resultado_json, atualizado_em=excluded.atualizado_em""",
            (normalizar_texto(municipio), (uf or "").upper(), categoria,
             json.dumps(resultado), datetime.now(timezone.utc).isoformat()))
        con.commit()
