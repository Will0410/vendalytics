"""
test_relatorio.py — relatório executivo (spec §2.3 C4).

O que se checa: o relatório funciona sem LLM (camada estrutural sempre
disponível), a prosa via LLM é grounded nos mesmos dados, a seção "o que
mudou" é honesta sobre não ter histórico no primeiro relatório, e detecta
delta real entre dois relatórios.
"""
from __future__ import annotations

import httpx
import pytest

from vendalytics import config
from vendalytics.modules import relatorio


def test_sem_groq_relatorio_e_estrutural(escopo_irrestrito):
    r = relatorio.gerar(dias=30)
    assert r["disponivel"]
    assert r["modo"] == "estrutural"
    assert r["texto_executivo"] is None
    assert "dados" in r and "resumo_sentimento" in r["dados"]


def test_primeiro_relatorio_nao_tem_o_que_mudou(escopo_irrestrito):
    r = relatorio.gerar(dias=30)
    assert r["o_que_mudou_desde_o_ultimo"]["disponivel"] is False


def test_relatorio_persiste_snapshot_para_o_proximo(escopo_irrestrito):
    r1 = relatorio.gerar(dias=30)
    r2 = relatorio.gerar(dias=30)
    assert r2["o_que_mudou_desde_o_ultimo"]["relatorio_anterior_gerado_em"] == r1["gerado_em"]


def test_com_groq_configurado_gera_prosa_grounded(monkeypatch, escopo_irrestrito):
    monkeypatch.setattr(config, "GROQ_API_KEY", "groq-key")
    capturado = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        capturado["payload"] = json
        return httpx.Response(200, json={"choices": [
            {"message": {"content": "Situação estável. Nenhuma mudança relevante. Sem recomendação."}}]},
            request=httpx.Request("POST", url))
    monkeypatch.setattr(httpx, "post", fake_post)

    r = relatorio.gerar(dias=30)
    assert r["modo"] == "grounded_llm"
    assert r["texto_executivo"]
    assert capturado["payload"]["max_tokens"] == relatorio.MAX_TOKENS_RESPOSTA
    assert capturado["payload"]["messages"][0]["role"] == "system"


def test_groq_configurado_mas_api_falha_cai_para_estrutural(monkeypatch, escopo_irrestrito):
    monkeypatch.setattr(config, "GROQ_API_KEY", "groq-key")

    def fake_post(url, headers=None, json=None, timeout=None):
        return httpx.Response(500, request=httpx.Request("POST", url))
    monkeypatch.setattr(httpx, "post", fake_post)

    r = relatorio.gerar(dias=30)
    assert r["disponivel"] is True   # relatório continua saindo, só sem prosa
    assert r["modo"] == "estrutural"
    assert r["texto_executivo"] is None


def test_http_relatorio_exige_admin(cliente_http, token_filial_a, token_admin):
    h_a = {"Authorization": f"Bearer {token_filial_a}"}
    h_admin = {"Authorization": f"Bearer {token_admin}"}
    assert cliente_http.post("/api/reputacao/relatorio-executivo", headers=h_a).status_code == 403
    assert cliente_http.post("/api/reputacao/relatorio-executivo", headers=h_admin).status_code == 200
