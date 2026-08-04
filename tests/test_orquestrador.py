"""
test_orquestrador.py — ciclo A7 completo (spec §2.1 A7).

O que se checa: as cinco etapas rodam e aparecem na resposta, o ciclo NUNCA
chama nada que envie mensagem/e-mail (guardrail estrutural verificado por
introspecção — a mesma técnica usada em test_reactor.py e
test_conectores_reais.py), rascunho é best-effort por item (um cliente sem
dado não derruba o ciclo), e o cache é invalidado ao final.
"""
from __future__ import annotations

import random
import sqlite3
from datetime import date, timedelta

import pytest

from vendalytics.modules import fila, orquestrador


def test_orquestrador_nunca_importa_nada_que_envie():
    """Guardrail estrutural: nenhum MessagingConnector, nenhum enviar_*,
    em lugar nenhum deste módulo. Enviar é sempre uma chamada humana
    separada."""
    import inspect
    fonte = inspect.getsource(orquestrador)
    assert "MessagingConnector" not in fonte
    assert "enviar_recomendacoes" not in fonte
    assert "WhapiMessagingConnector" not in fonte
    assert ".enviar(" not in fonte


@pytest.fixture(scope="module", autouse=True)
def carteira_com_sinal():
    from conftest import base_isolada
    from vendalytics.adapters.sqlite_reference import SCHEMA

    rnd = random.Random(5)
    hoje = date.today()
    linhas_cli, linhas_venda = [], []
    for i in range(60):
        cid = f"OR-{i:03d}"
        recorrente = i < 30
        linhas_cli.append((cid, f"Cliente Orq {i}", "SP", "ativo", -23.5, -46.6,
                           "sp.com", "11987654321"))
        ultimo_dia = 0 if recorrente else 150
        dia = 400
        while dia >= ultimo_dia:
            linhas_venda.append((cid, "V-A", "SP",
                                 (hoje - timedelta(days=dia)).isoformat(),
                                 round(rnd.uniform(300, 3000), 2)))
            dia -= rnd.randint(8, 13)

    with base_isolada("orquestrador") as caminho:
        con = sqlite3.connect(str(caminho))
        con.executescript(SCHEMA)
        con.executemany(
            "INSERT OR REPLACE INTO clientes (id,nome,filial,status,lat,lon,email,telefone) "
            "VALUES (?,?,?,?,?,?,?,?)", linhas_cli)
        con.executemany(
            "INSERT INTO vendas (cliente_id,vendedor_id,filial,data_venda,valor_total) "
            "VALUES (?,?,?,?,?)", linhas_venda)
        con.commit()
        con.close()
        from vendalytics.infra import db
        db.migrar()
        fila.invalidar_cache()
        yield
    fila.invalidar_cache()


def test_ciclo_roda_as_cinco_etapas(escopo_irrestrito):
    r = orquestrador.executar_ciclo(meta_contas=5, redigir_abordagens=False)
    assert r["disponivel"]
    for etapa in ("planejar_priorizar", "executar", "medir", "re_aprender"):
        assert etapa in r["etapas"]


def test_ciclo_prioriza_contas_de_verdade(escopo_irrestrito):
    r = orquestrador.executar_ciclo(meta_contas=5, redigir_abordagens=False)
    assert r["etapas"]["planejar_priorizar"]["itens_priorizados"] == 5


def test_ciclo_sem_groq_nao_gera_rascunho_mas_nao_quebra(escopo_irrestrito):
    r = orquestrador.executar_ciclo(meta_contas=3, redigir_abordagens=True)
    assert r["disponivel"]
    assert r["etapas"]["executar"]["agente_configurado"] is False
    assert r["etapas"]["executar"]["rascunhos_gerados"] == 0
    assert r["etapas"]["executar"]["rascunhos_indisponiveis"] == 3


def test_ciclo_com_agente_configurado_gera_rascunhos(escopo_irrestrito, monkeypatch):
    import httpx
    from vendalytics import config
    monkeypatch.setattr(config, "GROQ_API_KEY", "groq-key")

    def fake_post(url, headers=None, json=None, timeout=None):
        return httpx.Response(200, json={"choices": [{"message": {"content": "Olá, tudo bem?"}}]},
                              request=httpx.Request("POST", url))
    monkeypatch.setattr(httpx, "post", fake_post)

    r = orquestrador.executar_ciclo(meta_contas=3, redigir_abordagens=True)
    assert r["etapas"]["executar"]["rascunhos_gerados"] == 3


def test_ciclo_reaprender_invalida_cache(escopo_irrestrito):
    r = orquestrador.executar_ciclo(meta_contas=2, redigir_abordagens=False)
    assert r["etapas"]["re_aprender"]["cache_invalidado"] is True


def test_ciclo_indisponivel_quando_fila_indisponivel(escopo_irrestrito):
    """Base genuinamente sem histórico (à parte da fixture do módulo, que
    tem histórico de sinal por construção) — o ciclo não quebra, só reporta
    a indisponibilidade da fila."""
    from conftest import base_isolada
    from vendalytics.adapters.sqlite_reference import SCHEMA

    with base_isolada("orquestrador_sem_historico") as caminho:
        con = sqlite3.connect(str(caminho))
        con.executescript(SCHEMA)
        con.execute("INSERT INTO clientes (id,nome,filial,status) VALUES ('SEM-HIST','X','SP','ativo')")
        con.commit()
        con.close()
        from vendalytics.infra import db
        db.migrar()
        fila.invalidar_cache()
        r = orquestrador.executar_ciclo(meta_contas=5)
        assert r["etapas"]["planejar_priorizar"]["disponivel"] is False
        assert r["disponivel"] is True
    fila.invalidar_cache()


def test_http_orquestrador_exige_admin(cliente_http, token_filial_a, token_admin):
    h_a = {"Authorization": f"Bearer {token_filial_a}"}
    h_admin = {"Authorization": f"Bearer {token_admin}"}
    assert cliente_http.post("/api/orquestrador/executar-ciclo", headers=h_a).status_code == 403
    assert cliente_http.post("/api/orquestrador/executar-ciclo", headers=h_admin).status_code == 200
