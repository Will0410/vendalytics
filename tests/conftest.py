"""
conftest.py — ambiente isolado para os testes.

Tudo (banco operacional, banco de dado comercial, JWT_SECRET) aponta para um
diretório temporário: rodar a suíte nunca toca no `usuarios.sqlite` nem no
`vendalytics_demo.sqlite` da instalação. As variáveis são setadas ANTES de
qualquer import do pacote, porque `config.py` lê o ambiente no import.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ / "backend"))

_TMP = Path(tempfile.mkdtemp(prefix="vendalytics-testes-"))
os.environ["JWT_SECRET"] = "segredo-de-teste-nao-usar-em-producao"
os.environ["VENDALYTICS_USERS_DB"] = str(_TMP / "usuarios.sqlite")
os.environ["VENDALYTICS_SQLITE_PATH"] = str(_TMP / "dados.sqlite")
os.environ["VENDALYTICS_CRM_STAGING"] = str(_TMP / "crm_staging")
os.environ["DEMO_MODE"] = "false"

from vendalytics import auth, config, data_layer  # noqa: E402
from vendalytics.adapters.sqlite_reference import SCHEMA  # noqa: E402
from vendalytics.infra import context, db  # noqa: E402

FILIAL_A = "SP"
FILIAL_B = "RJ"


def _povoar(caminho: Path) -> None:
    """Duas filiais, dois clientes, duas vendas. O mínimo para provar que o
    recorte separa uma da outra — que é tudo o que estes testes checam."""
    con = sqlite3.connect(str(caminho))
    con.executescript(SCHEMA)
    con.executemany(
        "INSERT OR REPLACE INTO clientes (id,nome,filial,status,lat,lon) VALUES (?,?,?,?,?,?)",
        [
            ("C-A", "Cliente da filial A", FILIAL_A, "ativo", -23.5, -46.6),
            ("C-B", "Cliente da filial B", FILIAL_B, "ativo", -22.9, -43.2),
        ],
    )
    con.executemany(
        "INSERT OR REPLACE INTO vendedores (id,nome,filial,ativo) VALUES (?,?,?,1)",
        [("V-A", "Vendedor A", FILIAL_A), ("V-B", "Vendedor B", FILIAL_B)],
    )
    con.executemany(
        "INSERT INTO vendas (cliente_id,vendedor_id,filial,data_venda,valor_total) VALUES (?,?,?,date('now'),?)",
        [("C-A", "V-A", FILIAL_A, 1000.0), ("C-B", "V-B", FILIAL_B, 2000.0)],
    )
    con.commit()
    con.close()


@contextmanager
def base_isolada(nome: str):
    """Aponta o adapter para um SQLite próprio deste módulo de teste.

    Sem isto, um fixture que popula a base contamina os outros arquivos e a
    suíte só passa na ordem em que os arquivos são coletados — dependência
    invisível que quebra no dia em que alguém renomeia um teste ou instala o
    pytest-randomly.
    """
    anterior = config.SQLITE_PATH
    config.SQLITE_PATH = _TMP / f"{nome}.sqlite"
    data_layer._adapter.cache_clear()
    try:
        yield config.SQLITE_PATH
    finally:
        config.SQLITE_PATH = anterior
        data_layer._adapter.cache_clear()


@pytest.fixture(scope="session", autouse=True)
def ambiente():
    _povoar(config.SQLITE_PATH)
    db.migrar()
    data_layer._adapter.cache_clear()
    yield


@pytest.fixture
def escopo_irrestrito():
    with context.ativar(context.Escopo(
            tenant_id="teste", usuario="admin@teste", role="admin",
            filiais=frozenset(), request_id="req-irrestrito")) as e:
        yield e


@pytest.fixture
def escopo_filial_a():
    with context.ativar(context.Escopo(
            tenant_id="teste", usuario="vendedor.a@teste", role="vendedor",
            filiais=frozenset({FILIAL_A}), request_id="req-filial-a")) as e:
        yield e


@pytest.fixture
def cliente_http():
    """TestClient com o middleware de escopo ativo — exercita o caminho real
    (header → token → escopo), não uma simulação dele."""
    from fastapi.testclient import TestClient

    from vendalytics.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def token_filial_a():
    _garantir_usuario("vendedor.a@teste", role="user", filiais=FILIAL_A)
    return auth.autenticar("vendedor.a@teste", "senha-de-teste-123")["token"]


@pytest.fixture
def token_admin():
    _garantir_usuario("admin@teste", role="admin", filiais="")
    return auth.autenticar("admin@teste", "senha-de-teste-123")["token"]


def _garantir_usuario(email: str, *, role: str, filiais: str) -> None:
    db.migrar()
    with db.conexao() as con:
        existe = con.execute("SELECT 1 FROM usuarios WHERE email=?", (email,)).fetchone()
    if not existe:
        auth.criar_usuario(email, "senha-de-teste-123", nome=email, role=role, filiais=filiais)
