"""
test_mapa.py — enriquecimento do mapa (valor esperado + atividade) e o
campo `confianca` da fila.

Precisa de uma carteira com sinal de recompra para o modelo treinar (mesma
lógica de `test_propensao.py`, base própria e isolada).
"""
from __future__ import annotations

import random
import sqlite3
from datetime import date, timedelta

import pytest

from vendalytics import data_layer
from vendalytics.infra import db
from vendalytics.modules import fila, mapa


@pytest.fixture(scope="module", autouse=True)
def carteira_com_sinal():
    from conftest import base_isolada
    from vendalytics.adapters.sqlite_reference import SCHEMA

    rnd = random.Random(3)
    hoje = date.today()
    linhas_cli, linhas_venda = [], []
    for i in range(80):
        cid = f"M-{i:03d}"
        recorrente = i < 40
        linhas_cli.append((cid, f"Cliente {i}", "SP", "ativo", -23.5, -46.6))
        ultimo_dia = 0 if recorrente else 150
        dia = 400
        while dia >= ultimo_dia:
            linhas_venda.append((cid, "V-A", "SP",
                                 (hoje - timedelta(days=dia)).isoformat(),
                                 round(rnd.uniform(300, 3000), 2)))
            dia -= rnd.randint(8, 13)

    with base_isolada("mapa") as caminho:
        con = sqlite3.connect(str(caminho))
        con.executescript(SCHEMA)
        con.executemany(
            "INSERT OR REPLACE INTO clientes (id,nome,filial,status,lat,lon) VALUES (?,?,?,?,?,?)",
            linhas_cli)
        con.executemany(
            "INSERT INTO vendas (cliente_id,vendedor_id,filial,data_venda,valor_total) "
            "VALUES (?,?,?,?,?)", linhas_venda)
        con.commit()
        con.close()
        db.migrar()
        fila.invalidar_cache()
        yield
    fila.invalidar_cache()


def test_itens_da_fila_trazem_confianca_coerente(escopo_irrestrito):
    r = fila.diaria(limite=10, persistir=False)
    assert r["disponivel"], "modelo não treinou com a carteira sintética desta fixture"
    for item in r["itens"]:
        assert 0.0 <= item["confianca"] <= 1.0
        # Identidade: confiança é a distância de 0,5, dobrada — não um valor
        # inventado para preencher a UI.
        esperado = round(2 * abs(item["probabilidade"] - 0.5), 3)
        assert item["confianca"] == esperado


def test_score_extremo_e_mais_confiante_que_score_no_meio():
    """0,51 é praticamente uma moeda; 0,95 é uma leitura decisiva."""
    def confianca(p):
        return round(2 * abs(p - 0.5), 3)
    assert confianca(0.95) > confianca(0.51)
    assert confianca(0.5) == 0.0
    assert confianca(0.0) == confianca(1.0) == 1.0


def test_valores_esperados_bate_com_a_fila(escopo_irrestrito):
    diaria = {i["cliente_id"]: i["valor_esperado"]
             for i in fila.diaria(limite=50, persistir=False)["itens"]}
    todos = fila.valores_esperados()
    for cid, ve in diaria.items():
        assert todos[cid] == ve


def test_valores_esperados_vazio_sem_modelo(escopo_irrestrito):
    """Base genuinamente sem histórico de vendas: sem dado para treinar,
    devolve vazio — não levanta e não inventa número. Usa uma base isolada
    À PARTE da fixture do módulo (que tem histórico de sinal por
    construção), senão o teste não provaria o caminho de ausência."""
    from conftest import base_isolada
    from vendalytics.adapters.sqlite_reference import SCHEMA

    with base_isolada("mapa_sem_historico") as caminho:
        con = sqlite3.connect(str(caminho))
        con.executescript(SCHEMA)
        con.execute(
            "INSERT INTO clientes (id,nome,filial,status) VALUES ('SEM-HIST','X','SP','ativo')")
        con.commit()
        con.close()
        db.migrar()
        fila.invalidar_cache()
        assert fila.valores_esperados() == {}
    fila.invalidar_cache()


def test_mapa_enriquece_pontos_com_valor_e_atividade(escopo_irrestrito):
    r = mapa.pontos(limit=200)
    enriquecidos = [c for c in r["clientes"] if "valor_esperado" in c]
    assert enriquecidos, "nenhum ponto do mapa recebeu valor_esperado"
    for c in enriquecidos:
        assert isinstance(c["valor_esperado"], float)
    com_atividade = [c for c in r["clientes"] if "atividade" in c]
    assert com_atividade
    for c in com_atividade:
        assert isinstance(c["atividade"], list)


def test_mapa_atividade_e_delta_nao_soma_bruta(escopo_irrestrito):
    """A série é delta mês a mês, não total acumulado — é o que o sparkline
    do frontend espera (barras positivas/negativas por variação)."""
    r = mapa.pontos(limit=200)
    algum_negativo = any(
        v < 0 for c in r["clientes"] for v in c.get("atividade", []))
    # Com 40 clientes que pararam de comprar há 5 meses, ao menos uma queda
    # mês a mês deve aparecer — senão a série não é delta de verdade.
    assert algum_negativo


def test_mapa_nao_quebra_sem_modelo(escopo_irrestrito):
    """Base sem histórico: sem modelo treinável. O mapa continua devolvendo
    a listagem normal, só sem os campos extras."""
    from conftest import base_isolada
    from vendalytics.adapters.sqlite_reference import SCHEMA

    with base_isolada("mapa_sem_historico_2") as caminho:
        con = sqlite3.connect(str(caminho))
        con.executescript(SCHEMA)
        con.execute(
            "INSERT INTO clientes (id,nome,filial,status) VALUES ('SEM-HIST','X','SP','ativo')")
        con.commit()
        con.close()
        db.migrar()
        fila.invalidar_cache()
        r = mapa.pontos()
        assert r["clientes"]
        assert all("valor_esperado" not in c for c in r["clientes"])
    fila.invalidar_cache()


def test_mapa_respeita_o_escopo(escopo_filial_a):
    r = mapa.pontos()
    assert all(c["filial"] == "SP" for c in r["clientes"])


def test_http_clientes_mapa(cliente_http, token_admin):
    r = cliente_http.get("/api/clientes/mapa?limit=50",
                         headers={"Authorization": f"Bearer {token_admin}"})
    assert r.status_code == 200
    assert "clientes" in r.json()


def test_http_clientes_mapa_exige_auth(cliente_http):
    assert cliente_http.get("/api/clientes/mapa").status_code == 401
