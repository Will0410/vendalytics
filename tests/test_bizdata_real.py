"""
test_bizdata_real.py — comércios reais por categoria/local (OpenStreetMap
via BizData API), a fonte que faltava para "buscar comércio por ramo numa
região" sem custo (BrasilAPI é ponto-a-ponto, IBGE só dá contagem agregada).

Mesma postura de test_ibge_real.py: caminho feliz testado contra a fonte
real (validado ao vivo antes de escrever este código — farmácias em
Curitiba batem com redes reais: Droga Raia, Callfarma). O resto (fonte
fora do ar, categoria inválida, cache) é testado com httpx mockado.
"""
from __future__ import annotations

import httpx
import pytest

from vendalytics.sources import bizdata_cache, bizdata_real


@pytest.fixture(autouse=True)
def cache_isolado(tmp_path, monkeypatch):
    monkeypatch.setattr(bizdata_cache, "DB_PATH", tmp_path / "bizdata_cache.sqlite")


# ── contra a fonte real (rede necessária) ──────────────────────────────────
@pytest.mark.network
def test_buscar_farmacias_em_curitiba_traz_dado_real():
    r = bizdata_real.buscar("Curitiba", "PR", "pharmacy", raio_km=5, limit=10)
    assert r is not None
    assert len(r) > 0
    assert all("name" in e and "lat" in e and "lon" in e for e in r)


@pytest.mark.network
def test_categoria_invalida_devolve_none():
    assert bizdata_real.buscar("Curitiba", "PR", "categoria-que-nao-existe") is None


# ── cache e tratamento de erro (HTTP mockado) ──────────────────────────────
def test_categoria_fora_da_lista_nao_chama_rede(monkeypatch):
    chamou = {"sim": False}
    monkeypatch.setattr(httpx, "get", lambda *a, **k: chamou.update(sim=True))
    assert bizdata_real.buscar("Curitiba", "PR", "categoria-invalida") is None
    assert chamou["sim"] is False


def test_fonte_fora_do_ar_nao_levanta(monkeypatch):
    def fake_get(url, **kwargs):
        raise httpx.ConnectError("timeout simulado")
    monkeypatch.setattr(httpx, "get", fake_get)
    assert bizdata_real.buscar("Curitiba", "PR", "pharmacy") is None


def test_buscar_com_cache_grava_e_reusa(monkeypatch):
    chamadas = {"n": 0}
    def fake_get(url, **kwargs):
        chamadas["n"] += 1
        return httpx.Response(200, json={"businesses": [{"name": "Farmácia X", "lat": -25.0, "lon": -49.0}]},
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx, "get", fake_get)

    r1 = bizdata_real.buscar_com_cache("Curitiba", "PR", "pharmacy")
    assert r1["disponivel"] and r1["fonte"] == "ao vivo (OpenStreetMap)"
    assert chamadas["n"] == 1

    r2 = bizdata_real.buscar_com_cache("Curitiba", "PR", "pharmacy")
    assert r2["disponivel"] and r2["fonte"] == "cache"
    assert chamadas["n"] == 1  # não chamou a fonte de novo


def test_fonte_fora_do_ar_cai_para_cache_velho(monkeypatch):
    def fake_get_ok(url, **kwargs):
        return httpx.Response(200, json={"businesses": [{"name": "Farmácia Y"}]},
                              request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx, "get", fake_get_ok)
    bizdata_real.buscar_com_cache("Sorocaba", "SP", "bakery")

    # Força o cache a parecer velho (>30 dias) e a fonte ao vivo a falhar.
    from datetime import datetime, timedelta, timezone
    from vendalytics.modules.identidade import normalizar_texto
    import sqlite3
    con = sqlite3.connect(str(bizdata_cache.DB_PATH))
    velho = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
    con.execute("UPDATE comercios_cache SET atualizado_em=? WHERE municipio_norm=?",
               (velho, normalizar_texto("Sorocaba")))
    con.commit(); con.close()

    def fake_get_fail(url, **kwargs):
        raise httpx.ConnectError("timeout simulado")
    monkeypatch.setattr(httpx, "get", fake_get_fail)

    r = bizdata_real.buscar_com_cache("Sorocaba", "SP", "bakery")
    assert r["disponivel"] is True
    assert "cache" in r["fonte"]


def test_sem_cache_e_fonte_fora_do_ar_e_indisponivel(monkeypatch):
    def fake_get(url, **kwargs):
        raise httpx.ConnectError("timeout simulado")
    monkeypatch.setattr(httpx, "get", fake_get)
    r = bizdata_real.buscar_com_cache("CidadeNuncaConsultada", "XX", "pharmacy")
    assert r["disponivel"] is False and "motivo" in r


# ── endpoints HTTP ──────────────────────────────────────────────────────────
def test_http_comercios_exige_auth(cliente_http):
    assert cliente_http.get("/api/territorio/comercios?municipio=Curitiba&uf=PR&categoria=pharmacy").status_code == 401


def test_http_comercios_categoria_invalida_400(cliente_http, token_admin):
    h = {"Authorization": f"Bearer {token_admin}"}
    r = cliente_http.get("/api/territorio/comercios?municipio=Curitiba&uf=PR&categoria=xyz", headers=h)
    assert r.status_code == 400


def test_http_comercios_responde_com_mock(cliente_http, token_admin, monkeypatch):
    from vendalytics.sources import bizdata_real as mod
    monkeypatch.setattr(mod, "buscar_com_cache",
                        lambda municipio, uf, categoria, **k: {
                            "disponivel": True, "fonte": "cache",
                            "comercios": [{"name": "X", "lat": -25.0, "lon": -49.0}]})
    h = {"Authorization": f"Bearer {token_admin}"}
    r = cliente_http.get("/api/territorio/comercios?municipio=Curitiba&uf=PR&categoria=pharmacy", headers=h)
    assert r.status_code == 200
    assert len(r.json()["comercios"]) == 1


def test_http_comercios_categorias_lista_real(cliente_http, token_admin):
    h = {"Authorization": f"Bearer {token_admin}"}
    r = cliente_http.get("/api/territorio/comercios-categorias", headers=h)
    assert r.status_code == 200
    assert "pharmacy" in r.json()["categorias"]
    assert len(r.json()["categorias"]) == 37
