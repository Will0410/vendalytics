"""
test_ibge_real.py — camada sociodemográfica real (spec B4).

Diferente de todo outro conector desta sessão, este tem uma seção de testes
que chama a API REAL do IBGE (`servicodados.ibge.gov.br`) — é pública,
gratuita, sem chave, e confirmadamente acessível deste ambiente (validado
manualmente antes de escrever este código). Não haveria honestidade em
fingir que só dá para mockar quando dá para validar de verdade.

O resto (indisponibilidade, município não encontrado, resposta malformada)
é testado com `httpx.get` mockado — o objetivo ali não é a API do IBGE, é
o nosso tratamento de erro.
"""
from __future__ import annotations

import httpx
import pytest

from vendalytics.sources import ibge_real


# ── contra a API real (rede necessária) ────────────────────────────────────
@pytest.mark.network
def test_municipio_id_resolve_cidade_conhecida():
    assert ibge_real.municipio_id("Curitiba", "PR") == 4106902


@pytest.mark.network
def test_municipio_inexistente_devolve_none():
    assert ibge_real.municipio_id("CidadeQueNaoExisteEmLugarNenhum", "PR") is None


@pytest.mark.network
def test_populacao_estimada_de_curitiba_e_plausivel():
    r = ibge_real.populacao_estimada(4106902)
    assert r is not None
    # Curitiba está na casa dos ~1,7-2,0 milhões desde 2015 — checagem de
    # sanidade, não um valor fixo (a estimativa muda todo ano).
    assert 1_500_000 < r["populacao"] < 2_500_000
    assert r["ano"] >= 2015


@pytest.mark.network
def test_camada_para_ponto_ponta_a_ponta():
    r = ibge_real.camada_para_ponto("Curitiba", "PR")
    assert r["disponivel"] is True
    assert r["populacao"] > 1_000_000
    assert r["fonte"].startswith("IBGE")


# ── tratamento de erro (HTTP mockado) ──────────────────────────────────────
def test_sem_nome_ou_uf_nao_chama_rede(monkeypatch):
    chamou = {"sim": False}
    monkeypatch.setattr(httpx, "get", lambda *a, **k: chamou.update(sim=True))
    assert ibge_real.municipio_id("", "PR") is None
    assert ibge_real.municipio_id("Curitiba", "") is None
    assert chamou["sim"] is False


def test_ibge_fora_do_ar_nao_levanta(monkeypatch):
    def fake_get(url, **kwargs):
        raise httpx.ConnectError("timeout simulado")
    monkeypatch.setattr(httpx, "get", fake_get)
    assert ibge_real.municipio_id("Curitiba", "PR") is None
    assert ibge_real.populacao_estimada(4106902) is None


def test_resposta_sem_serie_devolve_none(monkeypatch):
    def fake_get(url, params=None, timeout=None):
        return httpx.Response(200, json=[{"resultados": [{"series": [{"serie": {}}]}]}],
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx, "get", fake_get)
    assert ibge_real.populacao_estimada(4106902) is None


def test_camada_para_ponto_sem_municipio_e_honesto(monkeypatch):
    monkeypatch.setattr(httpx, "get",
                        lambda url, **k: httpx.Response(200, json=[], request=httpx.Request("GET", url)))
    r = ibge_real.camada_para_ponto("CidadeInexistente", "XX")
    assert r["disponivel"] is False and "motivo" in r
