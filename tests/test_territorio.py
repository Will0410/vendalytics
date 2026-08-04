"""
test_territorio.py — distribuição de carteiras (spec §2.1 A4).

O que se checa não é otimalidade (a heurística é gulosa de propósito), e sim
as propriedades que fazem a proposta ser aceitável para um gestor: todo
cliente tem exatamente um dono, as carteiras ficam equilibradas por
potencial, relacionamento que funciona não é rompido à toa, e simular não
grava nada.
"""
from __future__ import annotations

import sqlite3

import pytest

from vendalytics import config, data_layer
from vendalytics.infra import db
from vendalytics.modules import territorio


@pytest.fixture(scope="module", autouse=True)
def carteira_multi_vendedor():
    """4 vendedores, 80 clientes com potencial bem desigual — o cenário em
    que dividir por headcount produz carteiras absurdas e dividir por
    potencial não."""
    import random

    from conftest import base_isolada
    from vendalytics.adapters.sqlite_reference import SCHEMA

    rnd = random.Random(11)
    clientes, vendas = [], []
    for i in range(80):
        cid = f"T-{i:03d}"
        # Potencial pareto-ish: poucos clientes grandes, muitos pequenos.
        grande = i < 8
        clientes.append((cid, f"Cliente {i}", "SP", "ativo",
                         -23.5 + rnd.uniform(-2, 2), -46.6 + rnd.uniform(-2, 2)))
        dono = f"V-{(i % 4) + 1}"
        for _ in range(rnd.randint(2, 6)):
            valor = rnd.uniform(20000, 60000) if grande else rnd.uniform(200, 3000)
            vendas.append((cid, dono, "SP", "2026-05-10", round(valor, 2)))

    with base_isolada("territorio") as caminho:
        con = sqlite3.connect(str(caminho))
        con.executescript(SCHEMA)
        con.executemany(
            "INSERT OR REPLACE INTO vendedores (id,nome,filial,ativo) VALUES (?,?,?,1)",
            [(f"V-{i}", f"Vendedor {i}", "SP") for i in range(1, 5)])
        con.executemany(
            "INSERT OR REPLACE INTO clientes (id,nome,filial,status,lat,lon) VALUES (?,?,?,?,?,?)",
            clientes)
        con.executemany(
            "INSERT INTO vendas (cliente_id,vendedor_id,filial,data_venda,valor_total) "
            "VALUES (?,?,?,?,?)", vendas)
        con.commit()
        con.close()
        db.migrar()
        yield


def test_todo_cliente_tem_exatamente_um_dono(escopo_irrestrito):
    r = territorio.simular()
    atribuidos = [c["id"] for lista in r["detalhe"].values() for c in lista]
    assert len(atribuidos) == 80
    assert len(set(atribuidos)) == 80, "cliente atribuído a mais de uma carteira"


def test_carteiras_ficam_equilibradas_por_potencial(escopo_irrestrito):
    """O ponto do módulo: equilibrar valor, não contagem. Dividir 80 clientes
    em 4 grupos de 20 é trivial e inútil quando 8 deles valem 90% da receita."""
    r = territorio.simular()
    assert r["equilibrio"]["desvio_max_pct"] < 40, r["equilibrio"]


def test_continuidade_de_relacionamento_e_preservada(escopo_irrestrito):
    """Trocar o dono de conta ativa custa relacionamento — custo que não
    aparece em nenhuma métrica de equilíbrio, por isso é checado aqui."""
    r = territorio.simular()
    assert r["ruptura_de_relacionamento"]["pct_movidos"] < 50


def test_simular_nao_aplica_nada(escopo_irrestrito):
    r = territorio.simular()
    assert r["aplicado"] is False
    # E o dono de fato no banco continua sendo o que era.
    donos = territorio._dono_atual()
    assert donos["T-000"] == "V-1"


def test_contratar_vendedores_alivia_as_carteiras(escopo_irrestrito):
    """A pergunta que o gestor faz antes de abrir vaga."""
    base = territorio.simular()
    com_extras = territorio.simular(vendedores_extra=2)
    assert len(com_extras["carteiras"]) == len(base["carteiras"]) + 2
    assert com_extras["equilibrio"]["potencial_medio"] < base["equilibrio"]["potencial_medio"]
    assert any(c["simulado"] for c in com_extras["carteiras"])


def test_criterio_e_explicito_na_resposta(escopo_irrestrito):
    """Proposta que o gestor não consegue justificar não é aceita — os pesos
    usados voltam junto com o resultado."""
    c = territorio.simular()["criterio"]
    assert "peso_distancia" in c and "bonus_continuidade" in c and "potencial" in c


def test_sem_vendedor_nao_inventa_carteira(escopo_irrestrito):
    with db.conexao():
        pass
    con = sqlite3.connect(str(config.SQLITE_PATH))
    con.execute("UPDATE vendedores SET ativo=0")
    con.commit(); con.close()
    data_layer._adapter.cache_clear()
    try:
        r = territorio.simular()
        assert r["disponivel"] is False and "motivo" in r
    finally:
        con = sqlite3.connect(str(config.SQLITE_PATH))
        con.execute("UPDATE vendedores SET ativo=1")
        con.commit(); con.close()
        data_layer._adapter.cache_clear()


def test_http_simulacao_exige_auth_e_responde(cliente_http, token_admin):
    assert cliente_http.get("/api/territorio/simular-carteiras").status_code == 401
    r = cliente_http.get("/api/territorio/simular-carteiras?vendedores_extra=1",
                         headers={"Authorization": f"Bearer {token_admin}"})
    assert r.status_code == 200 and r.json()["disponivel"]
