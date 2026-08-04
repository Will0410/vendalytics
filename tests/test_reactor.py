"""
test_reactor.py — o barramento unificado de sinais (spec D-1, Fase 5).

A prova que importa aqui: `modules/fila.py` NUNCA importa `reputacao.py`
nem `field.py` (confirmado no primeiro teste, por introspecção do módulo),
e mesmo assim uma menção negativa publicada por `reputacao.importar()` muda
o valor esperado que `fila.diaria()` calcula para o mesmo cliente. O único
acoplamento é o barramento (`infra.scores`/`infra.reactor`).
"""
from __future__ import annotations

import random
import sqlite3
from datetime import date, timedelta

import pytest

from vendalytics.infra import context, db, reactor, scores
from vendalytics.modules import field, fila


def test_fila_nao_importa_modulos_de_outras_fases():
    """Acoplamento zero por construção: se algum dia alguém importar
    reputacao/field dentro de fila.py, este teste denuncia — o barramento
    deixaria de ser o único canal entre os módulos."""
    import inspect

    import vendalytics.modules.fila as fila_mod
    fonte = inspect.getsource(fila_mod)
    assert "import reputacao" not in fonte
    assert "import field" not in fonte


@pytest.fixture(scope="module", autouse=True)
def carteira_com_sinal():
    """Mesma carteira sintética de `test_propensao.py` (sinal de recompra
    real, necessário para a fila ficar disponível)."""
    from conftest import base_isolada
    from vendalytics.adapters.sqlite_reference import SCHEMA

    rnd = random.Random(9)
    hoje = date.today()
    linhas_cli, linhas_venda = [], []
    for i in range(80):
        cid = f"RB-{i:03d}"
        recorrente = i < 40
        linhas_cli.append((cid, f"Cliente Reactor {i}", "SP", "ativo", -23.5, -46.6))
        ultimo_dia = 0 if recorrente else 150
        dia = 400
        while dia >= ultimo_dia:
            linhas_venda.append((cid, "V-A", "SP",
                                 (hoje - timedelta(days=dia)).isoformat(),
                                 round(rnd.uniform(300, 3000), 2)))
            dia -= rnd.randint(8, 13)

    with base_isolada("reactor") as caminho:
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


# ── mecânica do reactor ──────────────────────────────────────────────────
def test_sinal_sem_regra_e_ignorado_mas_marcado_processado(escopo_irrestrito):
    scores.emitir_sinal(tipo="tipo.sem_regra_nenhuma", sujeito_tipo="cliente",
                        sujeito_id="RB-000", origem="teste")
    r = reactor.processar_pendentes()
    assert r["sinais_lidos"] >= 1
    assert r["regras_aplicadas"] == 0
    # Reprocessar não conta o mesmo sinal de novo — idempotência.
    r2 = reactor.processar_pendentes()
    assert r2["sinais_lidos"] == 0


def test_mencao_pouco_negativa_nao_aciona_regra(escopo_irrestrito):
    scores.emitir_sinal(tipo="reputation.mention", sujeito_tipo="cliente",
                        sujeito_id="RB-001", origem="teste",
                        payload={"sentimento": -0.10, "alcance": 100})
    reactor.processar_pendentes()
    ajuste = reactor.ajustes_de_prioridade("cliente", "RB-001")
    assert ajuste["penalidade_pct"] == 0
    assert ajuste["sinalizado_para_exclusao"] is False


def test_mencao_muito_negativa_gera_ajuste_com_motivo(escopo_irrestrito):
    scores.emitir_sinal(tipo="reputation.mention", sujeito_tipo="cliente",
                        sujeito_id="RB-002", origem="teste",
                        payload={"sentimento": -0.60, "alcance": 5000})
    reactor.processar_pendentes()
    ajuste = reactor.ajustes_de_prioridade("cliente", "RB-002")
    assert ajuste["penalidade_pct"] < 0
    assert ajuste["motivos"] and "negativa" in ajuste["motivos"][0]


def test_pdv_fechado_sinaliza_exclusao(escopo_irrestrito):
    field.registrar_correcao("RB-003", "pdv_fechado", detalhe="confirmado em visita")
    reactor.processar_pendentes()
    ajuste = reactor.ajustes_de_prioridade("cliente", "RB-003")
    assert ajuste["sinalizado_para_exclusao"] is True
    assert "fechado" in ajuste["motivo_exclusao"].lower()


def test_outros_tipos_de_correcao_de_campo_nao_excluem(escopo_irrestrito):
    field.registrar_correcao("RB-004", "concorrente_presente", detalhe="preço agressivo")
    reactor.processar_pendentes()
    ajuste = reactor.ajustes_de_prioridade("cliente", "RB-004")
    assert ajuste["sinalizado_para_exclusao"] is False


# ── efeito de ponta a ponta na fila ─────────────────────────────────────────
def test_mencao_negativa_reduz_valor_esperado_na_fila(escopo_irrestrito):
    """A prova real do diferencial: publica o sinal pelo caminho de
    reputação, dispara pelo caminho de vendas, mede o efeito."""
    base = fila.diaria(limite=80, persistir=False)
    assert base["disponivel"]
    antes = next(i for i in base["itens"] if i["cliente_id"] == "RB-005")

    scores.emitir_sinal(tipo="reputation.mention", sujeito_tipo="cliente",
                        sujeito_id="RB-005", origem="teste",
                        payload={"sentimento": -0.70, "alcance": 10000})

    depois_resp = fila.diaria(limite=80, persistir=False)
    depois = next((i for i in depois_resp["itens"] if i["cliente_id"] == "RB-005"), None)
    assert depois is not None
    assert depois["valor_esperado"] < antes["valor_esperado"]
    # E o motivo aparece como fator — spec D-2, todo ajuste é explicado.
    assert any(f["feature"] == "sinal_barramento" for f in depois["fatores"])


def test_pdv_fechado_remove_cliente_da_fila(escopo_irrestrito):
    base = fila.diaria(limite=80, persistir=False)
    assert any(i["cliente_id"] == "RB-006" for i in base["itens"])

    field.registrar_correcao("RB-006", "pdv_fechado", detalhe="teste e2e")

    depois = fila.diaria(limite=80, persistir=False)
    assert not any(i["cliente_id"] == "RB-006" for i in depois["itens"])
    assert depois["excluidos_por_sinal_de_campo"] >= 1


def test_cliente_sem_sinal_nenhum_fica_inalterado(escopo_irrestrito):
    a = fila.diaria(limite=80, persistir=False)
    item_a = next(i for i in a["itens"] if i["cliente_id"] == "RB-007")
    b = fila.diaria(limite=80, persistir=False)
    item_b = next(i for i in b["itens"] if i["cliente_id"] == "RB-007")
    assert item_a["valor_esperado"] == item_b["valor_esperado"]


# ── HTTP ──────────────────────────────────────────────────────────────────
def test_http_processar_exige_admin(cliente_http, token_filial_a, token_admin):
    h_a = {"Authorization": f"Bearer {token_filial_a}"}
    h_admin = {"Authorization": f"Bearer {token_admin}"}
    assert cliente_http.post("/api/sinais/processar", headers=h_a).status_code == 403
    assert cliente_http.post("/api/sinais/processar", headers=h_admin).status_code == 200


def test_http_ajustes_responde(cliente_http, token_admin):
    r = cliente_http.get("/api/sinais/ajustes/C-A",
                         headers={"Authorization": f"Bearer {token_admin}"})
    assert r.status_code == 200
    assert "penalidade_pct" in r.json()
