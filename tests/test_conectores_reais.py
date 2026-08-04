"""
test_conectores_reais.py — conectores reais (Salesforce, HubSpot, WHAPI,
NewsAPI) e o agente A7 de rascunho (Groq).

Nenhum destes foi validado contra a API real do provedor — não há
credencial neste ambiente. O que se testa é O NOSSO CÓDIGO: a forma do
request que ele monta, como ele interpreta a resposta, e como degrada
quando não configurado ou quando a API responde erro. Isso é feito com
`httpx.MockTransport` (Salesforce/HubSpot, via injeção de cliente) ou
monkeypatch de `httpx.post`/`httpx.get` (WHAPI/NewsAPI/Groq, que chamam o
módulo `httpx` diretamente) — nunca uma chamada de rede de verdade.
"""
from __future__ import annotations

import httpx
import pytest

from vendalytics import config
from vendalytics.modules import agente
from vendalytics.integracoes import hubspot_real, newsapi_real, salesforce_real, whapi_real
from vendalytics.integracoes.hubspot_real import HubSpotConnector
from vendalytics.integracoes.newsapi_real import NewsAPIMentionSource
from vendalytics.integracoes.salesforce_real import SalesforceConnector
from vendalytics.integracoes.whapi_real import WhapiMessagingConnector


# ── configurado() é honesto ────────────────────────────────────────────────
def test_nenhum_conector_real_configurado_por_padrao():
    """No ambiente de teste, nenhuma credencial real existe — todo
    `configurado()` precisa admitir isso, nunca fingir que está pronto."""
    assert salesforce_real.configurado() is False
    assert hubspot_real.configurado() is False
    assert whapi_real.configurado() is False
    assert newsapi_real.configurado() is False
    assert agente.configurado() is False


def test_sem_configuracao_devolve_vazio_nao_levanta():
    assert SalesforceConnector().buscar_oportunidades() == []
    assert HubSpotConnector().buscar_oportunidades() == []
    assert NewsAPIMentionSource("Empresa Teste").buscar_mencoes() == []


def test_sem_configuracao_envio_recusa_com_clareza():
    r = WhapiMessagingConnector().enviar("5511999999999", "oi")
    assert r["enviado"] is False and "WHAPI_TOKEN" in r["detalhe"]


def test_sem_configuracao_agente_e_honesto(escopo_irrestrito):
    r = agente.redigir_abordagem("C-A")
    assert r["disponivel"] is False and "GROQ_API_KEY" in r["motivo"]


# ── Salesforce (HTTP mockado) ──────────────────────────────────────────────
@pytest.fixture
def salesforce_configurado(monkeypatch):
    monkeypatch.setattr(config, "SALESFORCE_CLIENT_ID", "cid")
    monkeypatch.setattr(config, "SALESFORCE_CLIENT_SECRET", "csecret")
    monkeypatch.setattr(config, "SALESFORCE_USERNAME", "user@empresa.com")
    monkeypatch.setattr(config, "SALESFORCE_PASSWORD", "senha")
    monkeypatch.setattr(config, "SALESFORCE_SECURITY_TOKEN", "token123")


def _sf_handler(cenario: dict):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/services/oauth2/token":
            return httpx.Response(200, json={"access_token": "tok-fake",
                                              "instance_url": "https://fake.my.salesforce.com"})
        if "query" in request.url.path and request.method == "GET":
            q = request.url.params.get("q", "")
            if "WHERE" in q and "CNPJ__c = " in q:
                return httpx.Response(200, json={"records": cenario.get("busca_conta", [])})
            return httpx.Response(200, json={"records": cenario.get("oportunidades", [])})
        if request.method == "PATCH":
            cenario.setdefault("patches", []).append(request)
            return httpx.Response(204)
        return httpx.Response(404)
    return handler


def test_salesforce_autentica_e_busca_oportunidades(salesforce_configurado):
    cenario = {"oportunidades": [{
        "Amount": 5000.0, "StageName": "Ganho", "CreatedDate": "2026-01-10T00:00:00Z",
        "CloseDate": "2026-02-01T00:00:00Z", "IsWon": True, "IsClosed": True,
        "Account": {"Name": "Padaria X", "CNPJ__c": "12.345.678/0001-95"},
    }]}
    cliente = httpx.Client(transport=httpx.MockTransport(_sf_handler(cenario)))
    conn = SalesforceConnector(cliente_http=cliente)
    ops = conn.buscar_oportunidades()
    assert len(ops) == 1
    assert ops[0].cnpj == "12345678000195"
    assert ops[0].ganhou is True


def test_salesforce_descarta_cnpj_ausente(salesforce_configurado):
    cenario = {"oportunidades": [{"Amount": 100.0, "StageName": "Aberto",
                                  "CreatedDate": "2026-01-01T00:00:00Z", "IsClosed": False,
                                  "Account": {"Name": "Sem CNPJ", "CNPJ__c": None}}]}
    cliente = httpx.Client(transport=httpx.MockTransport(_sf_handler(cenario)))
    assert SalesforceConnector(cliente_http=cliente).buscar_oportunidades() == []


def test_salesforce_write_back_localiza_e_grava(salesforce_configurado):
    cenario = {"busca_conta": [{"Id": "001xx0000012345"}]}
    cliente = httpx.Client(transport=httpx.MockTransport(_sf_handler(cenario)))
    conn = SalesforceConnector(cliente_http=cliente)
    r = conn.enviar_recomendacoes([{"cliente_id": "12.345.678/0001-95", "score": 88.0,
                                    "fatores": [{"rotulo": "relacionamento longo"}]}])
    assert r["itens_enviados"] == 1 and r["itens_falhos"] == 0
    assert len(cenario["patches"]) == 1


def test_salesforce_conta_nao_encontrada_conta_como_falha(salesforce_configurado):
    cenario = {"busca_conta": []}
    cliente = httpx.Client(transport=httpx.MockTransport(_sf_handler(cenario)))
    r = SalesforceConnector(cliente_http=cliente).enviar_recomendacoes(
        [{"cliente_id": "99.999.999/0001-99", "score": 50.0, "fatores": []}])
    assert r["itens_enviados"] == 0 and r["itens_falhos"] == 1


def test_salesforce_erro_http_na_autenticacao_propaga(salesforce_configurado):
    def handler(request):
        return httpx.Response(400, json={"error": "invalid_grant"})
    cliente = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(httpx.HTTPStatusError):
        SalesforceConnector(cliente_http=cliente).buscar_oportunidades()


# ── HubSpot (HTTP mockado) ──────────────────────────────────────────────────
@pytest.fixture
def hubspot_configurado(monkeypatch):
    monkeypatch.setattr(config, "HUBSPOT_ACCESS_TOKEN", "hs-token")


def _hs_handler(cenario: dict):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/deals/search") and request.method == "POST":
            return httpx.Response(200, json={"results": cenario.get("busca_deal", [])})
        if request.url.path.endswith("/deals") and request.method == "GET":
            return httpx.Response(200, json={"results": cenario.get("deals", []), "paging": {}})
        if request.method == "PATCH":
            cenario.setdefault("patches", []).append(request)
            return httpx.Response(200, json={"id": "1"})
        return httpx.Response(404)
    return handler


def test_hubspot_busca_oportunidades(hubspot_configurado):
    cenario = {"deals": [{"id": "1", "properties": {
        "dealname": "Negócio X", "amount": "3000", "dealstage": "closedwon",
        "createdate": "2026-01-05T00:00:00Z", "closedate": "2026-01-20T00:00:00Z",
        "hs_is_closed_won": "true", "cnpj": "98.765.432/0001-10"}}]}
    cliente = httpx.Client(transport=httpx.MockTransport(_hs_handler(cenario)))
    ops = HubSpotConnector(cliente_http=cliente).buscar_oportunidades()
    assert len(ops) == 1 and ops[0].cnpj == "98765432000110" and ops[0].ganhou is True


def test_hubspot_write_back(hubspot_configurado):
    cenario = {"busca_deal": [{"id": "42"}]}
    cliente = httpx.Client(transport=httpx.MockTransport(_hs_handler(cenario)))
    r = HubSpotConnector(cliente_http=cliente).enviar_recomendacoes(
        [{"cliente_id": "98.765.432/0001-10", "score": 70.0, "fatores": []}])
    assert r["itens_enviados"] == 1
    assert len(cenario["patches"]) == 1


def test_hubspot_deal_nao_encontrado(hubspot_configurado):
    cenario = {"busca_deal": []}
    cliente = httpx.Client(transport=httpx.MockTransport(_hs_handler(cenario)))
    r = HubSpotConnector(cliente_http=cliente).enviar_recomendacoes(
        [{"cliente_id": "11.111.111/0001-11", "score": 10.0, "fatores": []}])
    assert r["itens_falhos"] == 1


# ── WHAPI (monkeypatch de httpx.post) ───────────────────────────────────────
def test_whapi_envia_com_sucesso(monkeypatch):
    monkeypatch.setattr(config, "WHAPI_TOKEN", "whapi-token")

    def fake_post(url, headers=None, json=None, timeout=None):
        assert headers["Authorization"] == "Bearer whapi-token"
        assert json == {"to": "5511999999999", "body": "Olá"}
        return httpx.Response(200, json={"id": "msg-1"}, request=httpx.Request("POST", url))
    monkeypatch.setattr(httpx, "post", fake_post)

    r = WhapiMessagingConnector().enviar("5511999999999", "Olá")
    assert r["enviado"] is True and r["message_id"] == "msg-1"


def test_whapi_erro_http_nao_levanta(monkeypatch):
    monkeypatch.setattr(config, "WHAPI_TOKEN", "whapi-token")

    def fake_post(url, headers=None, json=None, timeout=None):
        request = httpx.Request("POST", url)
        return httpx.Response(422, json={"error": "número inválido"}, request=request)
    monkeypatch.setattr(httpx, "post", fake_post)

    r = WhapiMessagingConnector().enviar("numero-invalido", "Olá")
    assert r["enviado"] is False


# ── NewsAPI (monkeypatch de httpx.get) ──────────────────────────────────────
def test_newsapi_converte_artigos_em_mencoes(monkeypatch):
    monkeypatch.setattr(config, "NEWSAPI_KEY", "news-key")

    def fake_get(url, params=None, timeout=None):
        assert params["q"] == "Empresa Teste"
        return httpx.Response(200, json={"articles": [
            {"title": "Empresa Teste expande operação", "description": "Detalhes da expansão",
             "url": "https://x.com/1", "publishedAt": "2026-06-01T10:00:00Z",
             "source": {"name": "Portal X"}},
        ]}, request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx, "get", fake_get)

    mencoes = NewsAPIMentionSource("Empresa Teste").buscar_mencoes()
    assert len(mencoes) == 1
    assert mencoes[0].alcance == 0   # nunca inventado
    assert "expande operação" in mencoes[0].texto


def test_newsapi_artigo_sem_titulo_nem_descricao_e_ignorado(monkeypatch):
    monkeypatch.setattr(config, "NEWSAPI_KEY", "news-key")

    def fake_get(url, params=None, timeout=None):
        return httpx.Response(200, json={"articles": [
            {"title": None, "description": None, "url": "x", "publishedAt": "2026-01-01",
             "source": {"name": "Y"}}]}, request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx, "get", fake_get)

    assert NewsAPIMentionSource("Empresa Teste").buscar_mencoes() == []


# ── agente A7 (grounded, monkeypatch de httpx.post) ────────────────────────
def test_agente_usa_apenas_fatos_calculados(monkeypatch, escopo_irrestrito):
    monkeypatch.setattr(config, "GROQ_API_KEY", "groq-key")

    capturado = {}
    def fake_post(url, headers=None, json=None, timeout=None):
        capturado["payload"] = json
        return httpx.Response(200, json={"choices": [
            {"message": {"content": "Olá! Notei que sua região tem boa cobertura conosco."}}]},
            request=httpx.Request("POST", url))
    monkeypatch.setattr(httpx, "post", fake_post)

    r = agente.redigir_abordagem("C-A")
    assert r["disponivel"] is True
    assert r["texto"]
    assert "fatos_usados" in r
    # Guardrail: orçamento de tokens de saída explícito na chamada (spec §3.3).
    assert capturado["payload"]["max_tokens"] == agente.MAX_TOKENS_RESPOSTA
    assert capturado["payload"]["messages"][0]["role"] == "system"


def test_agente_nunca_envia_nada_sozinho():
    """Guardrail estrutural: o módulo do agente não importa nenhum
    MessagingConnector — gerar texto não pode, por construção, disparar
    envio. São dois endpoints/chamadas sempre separados."""
    import inspect

    fonte = inspect.getsource(agente)
    assert "MessagingConnector" not in fonte
    assert "enviar(" not in fonte


def test_agente_erro_da_api_nao_inventa_rascunho(monkeypatch, escopo_irrestrito):
    monkeypatch.setattr(config, "GROQ_API_KEY", "groq-key")

    def fake_post(url, headers=None, json=None, timeout=None):
        request = httpx.Request("POST", url)
        return httpx.Response(429, json={"error": "rate limited"}, request=request)
    monkeypatch.setattr(httpx, "post", fake_post)

    r = agente.redigir_abordagem("C-A")
    assert r["disponivel"] is False


def test_agente_sem_dados_do_cliente_e_honesto(escopo_irrestrito, monkeypatch):
    monkeypatch.setattr(config, "GROQ_API_KEY", "groq-key")
    r = agente.redigir_abordagem("CLIENTE-QUE-NAO-EXISTE")
    assert r["disponivel"] is False


# ── HTTP ──────────────────────────────────────────────────────────────────
def test_http_status_de_integracoes(cliente_http, token_admin, token_filial_a):
    h_admin = {"Authorization": f"Bearer {token_admin}"}
    r = cliente_http.get("/api/integracoes/status", headers=h_admin)
    assert r.status_code == 200
    assert all(v is False for v in r.json().values())
    assert cliente_http.get("/api/integracoes/status",
                            headers={"Authorization": f"Bearer {token_filial_a}"}).status_code == 403


def test_http_conectores_sem_configuracao_dao_409(cliente_http, token_admin):
    h = {"Authorization": f"Bearer {token_admin}"}
    assert cliente_http.post("/api/crm/salesforce/importar", headers=h).status_code == 409
    assert cliente_http.post("/api/crm/hubspot/importar", headers=h).status_code == 409
    assert cliente_http.post("/api/reputacao/newsapi/importar?termo=x", headers=h).status_code == 409
    assert cliente_http.post("/api/field/whapi/enviar", headers=h,
                             json={"destinatario": "x", "texto": "y"}).status_code == 409


def test_http_agente_rascunho(cliente_http, token_admin):
    r = cliente_http.get("/api/agente/rascunho/C-A",
                         headers={"Authorization": f"Bearer {token_admin}"})
    assert r.status_code == 200
    assert r.json()["disponivel"] is False   # sem GROQ_API_KEY no ambiente de teste
