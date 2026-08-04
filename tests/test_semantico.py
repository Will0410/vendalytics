"""
test_semantico.py — modelo semântico, construtor no-code e NL→consulta
(spec §2.5 D-3).

O que se checa: métrica/dimensão inexistentes são recusadas (nunca viram
SQL livre por acidente), combinações incompatíveis (ex.: "mês" para
clientes) são recusadas em vez de produzir agrupamento sem sentido, o
parser determinístico reconhece frases comuns em português, e o fallback
LLM só escolhe dentro do registro — nunca escreve SQL nem inventa métrica.
"""
from __future__ import annotations

import httpx
import pytest

from vendalytics import config
from vendalytics.modules import semantico


def test_metrica_inexistente_e_recusada(escopo_irrestrito):
    r = semantico.consultar(metrica="lucro_liquido_inventado")
    assert r["disponivel"] is False


def test_dimensao_inexistente_e_recusada(escopo_irrestrito):
    r = semantico.consultar(metrica="faturamento", dimensao="planeta")
    assert r["disponivel"] is False


def test_mes_nao_se_aplica_a_clientes(escopo_irrestrito):
    """'mês' é uma dimensão calculada de `data_venda` — clientes não têm
    isso. Sem a checagem, isso produziria um agrupamento sem sentido em vez
    de recusar."""
    r = semantico.consultar(metrica="clientes_ativos", dimensao="mes")
    assert r["disponivel"] is False


def test_faturamento_por_filial(escopo_irrestrito):
    r = semantico.consultar(metrica="faturamento", dimensao="filial")
    assert r["disponivel"]
    assert r["resultados"] == sorted(r["resultados"], key=lambda x: x["valor"], reverse=True)


def test_clientes_ativos_soma_certo(escopo_irrestrito):
    r = semantico.consultar(metrica="clientes_ativos")
    assert r["disponivel"]
    assert r["resultados"][0]["valor"] >= 0


def test_consulta_equivalente_e_sempre_devolvida(escopo_irrestrito):
    r = semantico.consultar(metrica="faturamento", dimensao="filial")
    assert "SELECT" in r["consulta_equivalente"]
    assert "não é SQL executado" in r["aviso"]


def test_modelo_lista_metricas_e_dimensoes():
    m = semantico.modelo()
    assert "faturamento" in m["metricas"]
    assert "filial" in m["dimensoes"]


# ── NL determinístico ──────────────────────────────────────────────────────
def test_nl_reconhece_faturamento_por_filial(escopo_irrestrito):
    r = semantico.perguntar("qual o faturamento por filial")
    assert r["disponivel"]
    assert r["interpretacao"]["metrica"] == "faturamento"
    assert r["interpretacao"]["dimensao"] == "filial"
    assert r["interpretacao"]["metodo"] == "determinístico"


def test_nl_reconhece_clientes_ativos(escopo_irrestrito):
    r = semantico.perguntar("quantos clientes ativos eu tenho")
    assert r["interpretacao"]["metrica"] == "clientes_ativos"


def test_nl_sem_reconhecimento_e_honesto(escopo_irrestrito):
    r = semantico.perguntar("qual a cor do céu hoje")
    assert r["disponivel"] is False
    assert "motivo" in r


def test_nl_nao_gera_sql_nunca():
    """Garantia estrutural: em nenhum lugar deste módulo existe execução de
    string como SQL — grep no próprio código-fonte."""
    import inspect
    fonte = inspect.getsource(semantico)
    assert "execute(" not in fonte
    assert "cursor(" not in fonte


# ── fallback LLM (mockado) — só escolhe dentro do registro ────────────────
def test_llm_fallback_so_quando_deterministico_falha(monkeypatch, escopo_irrestrito):
    monkeypatch.setattr(config, "GROQ_API_KEY", "groq-key")
    chamou = {"sim": False}

    def fake_post(url, headers=None, json=None, timeout=None):
        chamou["sim"] = True
        return httpx.Response(200, json={"choices": [{"message": {"content": "faturamento,uf"}}]},
                              request=httpx.Request("POST", url))
    monkeypatch.setattr(httpx, "post", fake_post)

    r = semantico.perguntar("me dá um resumo do dinheiro que entrou em cada estado")
    assert chamou["sim"] is True
    assert r["interpretacao"]["metodo"] == "llm"
    assert r["interpretacao"]["metrica"] == "faturamento"


def test_llm_nao_e_chamado_quando_deterministico_reconhece(monkeypatch, escopo_irrestrito):
    monkeypatch.setattr(config, "GROQ_API_KEY", "groq-key")
    chamou = {"sim": False}

    def fake_post(url, **k):
        chamou["sim"] = True
        raise AssertionError("não deveria chamar o LLM quando o parser determinístico já resolveu")
    monkeypatch.setattr(httpx, "post", fake_post)

    r = semantico.perguntar("faturamento por filial")
    assert chamou["sim"] is False
    assert r["interpretacao"]["metodo"] == "determinístico"


def test_llm_respondendo_metrica_invalida_e_ignorado(monkeypatch, escopo_irrestrito):
    """Mesmo se o LLM 'alucinar' uma métrica fora do registro, o sistema
    recusa — o LLM nunca tem autoridade para criar uma métrica nova."""
    monkeypatch.setattr(config, "GROQ_API_KEY", "groq-key")

    def fake_post(url, headers=None, json=None, timeout=None):
        return httpx.Response(200, json={"choices": [{"message": {"content": "lucro_inventado_pelo_llm,"}}]},
                              request=httpx.Request("POST", url))
    monkeypatch.setattr(httpx, "post", fake_post)

    r = semantico.perguntar("me dá o lucro consolidado ajustado")
    assert r["disponivel"] is False


# ── HTTP ──────────────────────────────────────────────────────────────────
def test_http_semantico_modelo_e_consultar(cliente_http, token_admin):
    h = {"Authorization": f"Bearer {token_admin}"}
    assert cliente_http.get("/api/semantico/modelo", headers=h).status_code == 200
    r = cliente_http.get("/api/semantico/consultar?metrica=faturamento&dimensao=filial", headers=h)
    assert r.status_code == 200 and r.json()["disponivel"]


def test_http_semantico_perguntar(cliente_http, token_admin):
    r = cliente_http.get("/api/semantico/perguntar?pergunta=faturamento por filial",
                         headers={"Authorization": f"Bearer {token_admin}"})
    assert r.status_code == 200
