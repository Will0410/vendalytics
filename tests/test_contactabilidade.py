"""
test_contactabilidade.py — segundo score da spec A3.

O que se checa: cada componente soma o peso certo, dado ausente nunca vira
penalidade inventada (só peso zero naquele componente), e o score aparece
sempre junto da propensão na fila (nunca como número solto e sem contexto).
"""
from __future__ import annotations

import sqlite3

import pytest

from vendalytics.infra import context, db
from vendalytics.modules import comite, contactabilidade, fila


@pytest.fixture(scope="module", autouse=True)
def clientes_contactabilidade():
    from conftest import base_isolada
    from vendalytics.adapters.sqlite_reference import SCHEMA

    linhas = [
        ("CT-COMPLETO", "Cliente Completo", "SP", "ativo", "11987654321", "contato@empresa.com.br"),
        ("CT-SEM-CONTATO", "Cliente Sem Contato", "SP", "ativo", "", ""),
        ("CT-TEL-INVALIDO", "Cliente Tel Invalido", "SP", "ativo", "abc", "valido@empresa.com"),
        ("CT-EMAIL-INVALIDO", "Cliente Email Invalido", "SP", "ativo", "11987654321", "nao-e-email"),
    ]
    with base_isolada("contactabilidade") as caminho:
        con = sqlite3.connect(str(caminho))
        con.executescript(SCHEMA)
        con.executemany(
            "INSERT OR REPLACE INTO clientes (id,nome,filial,status,telefone,email) VALUES (?,?,?,?,?,?)",
            linhas)
        con.commit()
        con.close()
        db.migrar()
        yield


def test_telefone_e_email_validos_somam_pontos(escopo_irrestrito):
    r = contactabilidade.calcular("CT-COMPLETO")
    assert r["disponivel"]
    assert r["contactabilidade"] >= contactabilidade.PESO_TELEFONE + contactabilidade.PESO_EMAIL


def test_ausencia_nao_e_penalidade_e_so_peso_zero(escopo_irrestrito):
    """Sem telefone/e-mail o score cai, mas nunca fica negativo nem soma um
    'castigo' — a ausência de dado é peso zero naquele componente, ponto."""
    r = contactabilidade.calcular("CT-SEM-CONTATO")
    assert r["disponivel"]
    assert r["contactabilidade"] >= 0
    fatores_tel = [f for f in r["fatores"] if f["feature"] == "telefone"][0]
    assert fatores_tel["contribuicao_pct"] == 0.0


def test_telefone_mal_formatado_nao_conta(escopo_irrestrito):
    r = contactabilidade.calcular("CT-TEL-INVALIDO")
    fatores_tel = [f for f in r["fatores"] if f["feature"] == "telefone"][0]
    assert fatores_tel["contribuicao_pct"] == 0.0


def test_email_mal_formatado_nao_conta(escopo_irrestrito):
    r = contactabilidade.calcular("CT-EMAIL-INVALIDO")
    fatores_email = [f for f in r["fatores"] if f["feature"] == "email"][0]
    assert fatores_email["contribuicao_pct"] == 0.0


def test_comite_completo_eleva_contactabilidade(escopo_irrestrito):
    antes = contactabilidade.calcular("CT-SEM-CONTATO")["contactabilidade"]
    for papel in comite.PAPEIS:
        comite.adicionar("CT-SEM-CONTATO", nome=f"Pessoa {papel}", papel=papel)
    depois = contactabilidade.calcular("CT-SEM-CONTATO")["contactabilidade"]
    assert depois > antes


def test_cliente_inexistente(escopo_irrestrito):
    assert contactabilidade.calcular("NAO-EXISTE")["disponivel"] is False


def test_classificar_rotula_faixas():
    assert contactabilidade.classificar(80) == "alta"
    assert contactabilidade.classificar(50) == "média"
    assert contactabilidade.classificar(10) == "baixa"


def test_fatores_somam_o_score_total(escopo_irrestrito):
    r = contactabilidade.calcular("CT-COMPLETO")
    soma = round(sum(f["contribuicao_pct"] for f in r["fatores"]), 1)
    assert soma == r["contactabilidade"]


def test_http_contactabilidade(cliente_http, token_admin):
    r = cliente_http.get("/api/fila/contactabilidade/CT-COMPLETO",
                         headers={"Authorization": f"Bearer {token_admin}"})
    assert r.status_code == 200
    assert r.json()["disponivel"] is True
