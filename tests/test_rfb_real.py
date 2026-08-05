"""
test_rfb_real.py — consulta de CNPJ via BrasilAPI, em lote (spec §2.1 A2,
Relatório de Praça do Território).

Mesma postura de test_ibge_real.py: a API é pública, gratuita, sem chave, e
confirmadamente acessível deste ambiente — então o caminho feliz é testado
contra a API real, não mockado. O resto (indisponibilidade, CNPJ inválido)
é testado com httpx mockado.
"""
from __future__ import annotations

import httpx
import pytest

from vendalytics.sources import rfb_real


# ── contra a API real (rede necessária) ────────────────────────────────────
@pytest.mark.network
def test_consultar_cnpj_conhecido_traz_campos_da_tabela_de_prospeccao():
    # Banco do Brasil — CNPJ raiz estável, bom candidato a nunca sumir da base.
    r = rfb_real.consultar("00000000000191", cachear=False)
    assert r is not None
    assert r["razao_social"]
    assert r["cnae_principal"]
    assert r["municipio"] and r["uf"]
    assert isinstance(r["ativa"], bool)
    # Campos que a tabela de prospecção do Território precisa (spec pedida
    # pelo usuário): nome fantasia e porte também vêm da mesma resposta.
    assert "nome_fantasia" in r
    assert "porte" in r


@pytest.mark.network
def test_consultar_lote_traz_varios_cnpjs_reais_em_paralelo():
    cnpjs = ["00000000000191", "33000167000101", "60701190000104"]
    r = rfb_real.consultar_lote(cnpjs, cachear=False)
    assert len(r) == 3
    assert {e["cnpj"] for e in r} == {c for c in cnpjs}


# ── tratamento de erro (HTTP mockado) ──────────────────────────────────────
def test_cnpj_invalido_nao_chama_rede(monkeypatch):
    chamou = {"sim": False}
    monkeypatch.setattr(httpx, "get", lambda *a, **k: chamou.update(sim=True))
    assert rfb_real.consultar("123") is None
    assert chamou["sim"] is False


def test_rfb_fora_do_ar_nao_levanta(monkeypatch):
    def fake_get(url, **kwargs):
        raise httpx.ConnectError("timeout simulado")
    monkeypatch.setattr(httpx, "get", fake_get)
    assert rfb_real.consultar("00000000000191") is None


def test_rfb_indisponivel_cai_para_cache_local_se_ja_consultado(monkeypatch, tmp_path):
    from vendalytics.sources import mercado_publico_cache
    monkeypatch.setattr(mercado_publico_cache, "DB_PATH", tmp_path / "mercado_publico.sqlite")

    # 1ª consulta: sucesso, grava no cache.
    def fake_get_ok(url, **kwargs):
        return httpx.Response(200, json={
            "razao_social": "Empresa Real Ltda", "descricao_situacao_cadastral": "ATIVA",
            "cnae_fiscal": 4711302, "cnae_fiscal_descricao": "Comércio varejista",
            "municipio": "Curitiba", "uf": "PR",
        }, request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx, "get", fake_get_ok)
    primeira = rfb_real.consultar("00000000000191")
    assert primeira is not None and primeira["razao_social"] == "Empresa Real Ltda"

    # 2ª consulta: fonte ao vivo indisponível (429/timeout) — cai pro cache
    # em vez de sumir com a empresa da lista de prospecção.
    def fake_get_429(url, **kwargs):
        raise httpx.HTTPStatusError("429", request=httpx.Request("GET", url),
                                    response=httpx.Response(429, request=httpx.Request("GET", url)))
    monkeypatch.setattr(httpx, "get", fake_get_429)
    segunda = rfb_real.consultar("00000000000191")
    assert segunda is not None
    assert segunda["razao_social"] == "Empresa Real Ltda"
    assert "cache" in segunda["situacao"]


def test_rfb_indisponivel_sem_cache_previo_devolve_none(monkeypatch, tmp_path):
    from vendalytics.sources import mercado_publico_cache
    monkeypatch.setattr(mercado_publico_cache, "DB_PATH", tmp_path / "mercado_publico.sqlite")

    def fake_get_429(url, **kwargs):
        raise httpx.ConnectError("timeout simulado")
    monkeypatch.setattr(httpx, "get", fake_get_429)
    assert rfb_real.consultar("11111111000191") is None


def test_consultar_lote_omite_cnpjs_que_falharam(monkeypatch):
    def fake_get(url, **kwargs):
        doc = url.rsplit("/", 1)[-1]
        if doc == "00000000000191":
            raise httpx.ConnectError("timeout simulado")
        return httpx.Response(200, json={
            "razao_social": "Empresa Teste", "descricao_situacao_cadastral": "ATIVA",
            "cnae_fiscal": 123, "cnae_fiscal_descricao": "Comércio",
            "municipio": "Curitiba", "uf": "PR",
        }, request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx, "get", fake_get)
    r = rfb_real.consultar_lote(["00000000000191", "33000167000101"], cachear=False)
    assert len(r) == 1
    assert r[0]["cnpj"] == "33000167000101"


def test_consultar_lote_vazio_nao_chama_rede(monkeypatch):
    chamou = {"sim": False}
    monkeypatch.setattr(httpx, "get", lambda *a, **k: chamou.update(sim=True))
    assert rfb_real.consultar_lote([]) == []
    assert chamou["sim"] is False


# ── endpoints HTTP ──────────────────────────────────────────────────────────
def test_http_territorio_visao_nacional_exige_auth(cliente_http):
    assert cliente_http.get("/api/territorio/visao-nacional").status_code == 401


def test_http_territorio_visao_nacional_responde_com_mock(cliente_http, token_admin, monkeypatch):
    from vendalytics.sources import ibge_real as ibge_mod
    monkeypatch.setattr(ibge_mod, "visao_nacional",
                        lambda: [{"uf_nome": "São Paulo", "populacao": 45_000_000,
                                  "pib_total_reais": 1e12, "pib_per_capita_reais": 22000.0,
                                  "pib_ano_referencia": 2023, "empresas_atuantes_total": 3_000_000,
                                  "empresas_atuantes_ano_referencia": 2024}])
    h = {"Authorization": f"Bearer {token_admin}"}
    r = cliente_http.get("/api/territorio/visao-nacional", headers=h)
    assert r.status_code == 200
    assert len(r.json()["estados"]) == 1


def test_http_territorio_visao_nacional_502_se_ibge_fora_do_ar(cliente_http, token_admin, monkeypatch):
    from vendalytics.sources import ibge_real as ibge_mod
    monkeypatch.setattr(ibge_mod, "visao_nacional", lambda: None)
    h = {"Authorization": f"Bearer {token_admin}"}
    r = cliente_http.get("/api/territorio/visao-nacional", headers=h)
    assert r.status_code == 502


def test_http_territorio_municipios_exige_auth(cliente_http):
    assert cliente_http.get("/api/territorio/municipios?uf=PR").status_code == 401


def test_http_territorio_prospects_exige_auth(cliente_http):
    assert cliente_http.get("/api/territorio/prospects?cnpjs=00000000000191").status_code == 401


def test_http_territorio_prospects_exige_ao_menos_um_cnpj(cliente_http, token_admin):
    h = {"Authorization": f"Bearer {token_admin}"}
    assert cliente_http.get("/api/territorio/prospects?cnpjs=", headers=h).status_code == 400


def test_http_territorio_prospects_limita_20_cnpjs(cliente_http, token_admin):
    h = {"Authorization": f"Bearer {token_admin}"}
    muitos = ",".join(str(i).zfill(14) for i in range(21))
    assert cliente_http.get(f"/api/territorio/prospects?cnpjs={muitos}", headers=h).status_code == 400


def test_http_territorio_prospects_responde_com_lote_mockado(cliente_http, token_admin, monkeypatch):
    from vendalytics.sources import rfb_real as rfb_mod
    monkeypatch.setattr(rfb_mod, "consultar_lote",
                        lambda cnpjs, **k: [{"cnpj": c, "razao_social": "X"} for c in cnpjs])
    h = {"Authorization": f"Bearer {token_admin}"}
    r = cliente_http.get("/api/territorio/prospects?cnpjs=00000000000191,33000167000101", headers=h)
    assert r.status_code == 200
    assert len(r.json()["prospects"]) == 2


def test_http_territorio_municipios_responde_com_lote_mockado(cliente_http, token_admin, monkeypatch):
    from vendalytics.sources import ibge_real as ibge_mod
    monkeypatch.setattr(ibge_mod, "municipios_por_uf",
                        lambda uf: [{"id": 1, "nome": "Curitiba"}])
    h = {"Authorization": f"Bearer {token_admin}"}
    r = cliente_http.get("/api/territorio/municipios?uf=PR", headers=h)
    assert r.status_code == 200
    assert r.json()["municipios"] == [{"id": 1, "nome": "Curitiba"}]


def test_http_territorio_municipio_info_exige_auth(cliente_http):
    assert cliente_http.get("/api/territorio/municipio-info?municipio=Curitiba&uf=PR").status_code == 401


def test_http_territorio_municipio_info_responde_com_camada_mockada(cliente_http, token_admin, monkeypatch):
    from vendalytics.sources import ibge_real as ibge_mod
    monkeypatch.setattr(ibge_mod, "camada_para_ponto",
                        lambda municipio, uf: {"disponivel": True, "municipio_ibge_id": 4106902,
                                               "populacao": 1_800_000,
                                               "populacao_ano_referencia": 2024, "fonte": "IBGE (mock)"})
    monkeypatch.setattr(ibge_mod, "pib_per_capita",
                        lambda mid: {"pib_per_capita_reais": 55000.0, "pib_ano_referencia": 2023})
    monkeypatch.setattr(ibge_mod, "empresas_atuantes_total",
                        lambda mid: {"total": 230758, "ano": 2024})
    h = {"Authorization": f"Bearer {token_admin}"}
    r = cliente_http.get("/api/territorio/municipio-info?municipio=Curitiba&uf=PR", headers=h)
    assert r.status_code == 200
    body = r.json()
    assert body["populacao"] == 1_800_000
    assert body["pib_per_capita_reais"] == 55000.0
    assert body["empresas_atuantes_total"] == 230758


def test_http_territorio_municipio_info_sem_pib_ou_empresas_nao_quebra(cliente_http, token_admin, monkeypatch):
    from vendalytics.sources import ibge_real as ibge_mod
    monkeypatch.setattr(ibge_mod, "camada_para_ponto",
                        lambda municipio, uf: {"disponivel": True, "municipio_ibge_id": 4106902,
                                               "populacao": 1_800_000,
                                               "populacao_ano_referencia": 2024, "fonte": "IBGE (mock)"})
    monkeypatch.setattr(ibge_mod, "pib_per_capita", lambda mid: None)
    monkeypatch.setattr(ibge_mod, "empresas_atuantes_total", lambda mid: None)
    h = {"Authorization": f"Bearer {token_admin}"}
    r = cliente_http.get("/api/territorio/municipio-info?municipio=Curitiba&uf=PR", headers=h)
    assert r.status_code == 200
    body = r.json()
    assert body["pib_per_capita_reais"] is None
    assert body["empresas_atuantes_total"] is None
