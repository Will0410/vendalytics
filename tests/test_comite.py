"""
test_comite.py — comitê de compras (spec §2.1 A5).

O que se checa não é a fórmula exata do score (pesos são uma escolha de
negócio, não uma verdade matemática), e sim as propriedades que fazem o
score cumprir o papel dele: conta sem contato nenhum é o pior caso, faltar
decisor econômico pesa mais que faltar um papel secundário, e remover é
lógico (histórico), não destrutivo.
"""
from __future__ import annotations

import pytest

from vendalytics.modules import comite


def test_conta_sem_contato_tem_score_zero(escopo_irrestrito):
    c = comite.completude("CONTA-VAZIA")
    assert c["score_completude"] == 0.0
    assert c["risco_alto"] is True
    assert c["papeis_faltando"] == list(comite.PAPEIS)


def test_um_contato_generico_sobe_pouco(escopo_irrestrito):
    comite.adicionar("CONTA-1", nome="Ana", papel="usuario")
    c = comite.completude("CONTA-1")
    assert 0 < c["score_completude"] < 30


def test_decisor_economico_pesa_mais_que_papel_secundario(escopo_irrestrito):
    comite.adicionar("CONTA-2A", nome="Beto", papel="decisor_economico")
    comite.adicionar("CONTA-2B", nome="Carla", papel="gatekeeper")
    a = comite.completude("CONTA-2A")["score_completude"]
    b = comite.completude("CONTA-2B")["score_completude"]
    assert a > b


def test_todos_os_papeis_mapeados_da_cem(escopo_irrestrito):
    for papel in comite.PAPEIS:
        comite.adicionar("CONTA-COMPLETA", nome=f"Pessoa {papel}", papel=papel)
    c = comite.completude("CONTA-COMPLETA")
    assert c["score_completude"] == 100.0
    assert c["risco_alto"] is False
    assert c["papeis_faltando"] == []


def test_papel_invalido_e_recusado(escopo_irrestrito):
    with pytest.raises(ValueError):
        comite.adicionar("CONTA-3", nome="X", papel="chefao")


def test_nome_vazio_e_recusado(escopo_irrestrito):
    with pytest.raises(ValueError):
        comite.adicionar("CONTA-3", nome="   ", papel="usuario")


def test_remover_e_logico_nao_destrutivo(escopo_irrestrito):
    r = comite.adicionar("CONTA-4", nome="Duda", papel="campeao")
    assert len(comite.listar("CONTA-4")) == 1
    comite.remover("CONTA-4", r["id"])
    assert comite.listar("CONTA-4") == []
    # A remoção existe: não some do histórico, só sai da listagem ativa.
    with pytest.raises(ValueError):
        comite.remover("CONTA-4", r["id"])   # já removido


def test_remover_contato_de_outra_conta_e_negado(escopo_irrestrito):
    """O furo que este teste existe para travar: contato de uma conta não
    pode ser removido informando o id de OUTRA conta."""
    r = comite.adicionar("CONTA-5", nome="Eva", papel="usuario")
    with pytest.raises(ValueError):
        comite.remover("CONTA-OUTRA", r["id"])
    assert len(comite.listar("CONTA-5")) == 1   # continua lá


def test_http_comite_respeita_escopo_da_conta(cliente_http, token_admin, token_filial_a):
    h_admin = {"Authorization": f"Bearer {token_admin}"}
    h_a = {"Authorization": f"Bearer {token_filial_a}"}
    assert cliente_http.post("/api/contas/C-A/comite", headers=h_a,
                             json={"nome": "Fio", "papel": "usuario"}).status_code == 200
    assert cliente_http.post("/api/contas/C-B/comite", headers=h_a,
                             json={"nome": "Fio", "papel": "usuario"}).status_code == 403
    assert cliente_http.get("/api/contas/C-B/comite", headers=h_admin).status_code == 200
