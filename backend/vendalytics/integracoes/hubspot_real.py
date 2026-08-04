"""
hubspot_real.py — conector real de CRM via HubSpot REST API (spec §2.1 A6).

Implementa `CRMConnector` de verdade. **Nunca foi validado contra uma conta
HubSpot real** — sem token neste ambiente. Coberto por teste com HTTP
mockado, não pela API real.

── Autenticação ────────────────────────────────────────────────────────────
Private App access token (Bearer simples) — o padrão atual do HubSpot para
integração servidor-a-servidor, mais simples que Salesforce: não há fluxo
OAuth para conduzir, só um token gerado uma vez no painel do HubSpot.

── Campo de CNPJ ────────────────────────────────────────────────────────────
`HUBSPOT_CNPJ_PROPERTY` (padrão `cnpj`) — propriedade customizada no objeto
Deal. Times que preferem CNPJ na Company em vez do Deal precisam de uma
segunda chamada via Associations API; este MVP assume o caso mais simples
(CNPJ direto no Deal), documentado como limitação, não escondido.
"""
from __future__ import annotations

import logging
import os

import httpx

from .. import config
from .base import CRMConnector, OportunidadeExterna

log = logging.getLogger("vendalytics.integracoes.hubspot")


def configurado() -> bool:
    return bool(config.HUBSPOT_ACCESS_TOKEN)


class HubSpotConnector(CRMConnector):
    def __init__(self, *, cnpj_property: str = "", cliente_http: httpx.Client | None = None):
        self.cnpj_property = cnpj_property or os.getenv("HUBSPOT_CNPJ_PROPERTY", "cnpj")
        self._http = cliente_http

    def nome(self) -> str:
        return "hubspot"

    def _cliente(self) -> httpx.Client:
        return self._http or httpx

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {config.HUBSPOT_ACCESS_TOKEN}"}

    def testar_conexao(self) -> bool:
        if not configurado():
            return False
        try:
            r = self._cliente().get(f"{config.HUBSPOT_BASE_URL}/crm/v3/objects/deals",
                                    headers=self._headers(), params={"limit": 1},
                                    timeout=config.HTTP_TIMEOUT_S)
            r.raise_for_status()
            return True
        except httpx.HTTPError as e:
            log.warning("HubSpot indisponível: %s", e)
            return False

    def buscar_oportunidades(self, *, desde: str = "") -> list[OportunidadeExterna]:
        if not configurado():
            return []
        propriedades = f"dealname,amount,dealstage,createdate,closedate,hs_is_closed_won,{self.cnpj_property}"
        params = {"limit": 100, "properties": propriedades}
        out, url = [], f"{config.HUBSPOT_BASE_URL}/crm/v3/objects/deals"
        # Paginação simples via cursor — suficiente para o volume de uma
        # sincronização diária; um catálogo com dezenas de milhares de deals
        # precisaria de Bulk Export API, fora do escopo deste MVP.
        while url:
            r = self._cliente().get(url, headers=self._headers(), params=params,
                                    timeout=config.HTTP_TIMEOUT_S)
            r.raise_for_status()
            corpo = r.json()
            for deal in corpo.get("results", []):
                p = deal.get("properties", {})
                cnpj = "".join(ch for ch in str(p.get(self.cnpj_property) or "") if ch.isdigit())
                if len(cnpj) != 14:
                    continue
                fechado = str(p.get("hs_is_closed_won", "")).lower()
                estagio = p.get("dealstage", "")
                out.append(OportunidadeExterna(
                    cnpj=cnpj, razao_social=p.get("dealname", ""), estagio=estagio,
                    valor=float(p.get("amount") or 0), criada_em=(p.get("createdate") or "")[:10],
                    fechada_em=(p.get("closedate") or "")[:10] if p.get("closedate") else None,
                    ganhou=(fechado == "true") if p.get("closedate") else None))
            proximo = (corpo.get("paging") or {}).get("next", {}).get("after")
            url = f"{config.HUBSPOT_BASE_URL}/crm/v3/objects/deals" if proximo else None
            params = {"limit": 100, "properties": propriedades, "after": proximo} if proximo else params
        return out

    def enviar_recomendacoes(self, itens: list[dict]) -> dict:
        if not configurado():
            return {"itens_enviados": 0, "itens_falhos": len(itens), "destino": "não configurado"}
        enviados, falhos = 0, 0
        for item in itens:
            cnpj = "".join(ch for ch in str(item.get("cliente_id") or "") if ch.isdigit())
            if len(cnpj) != 14:
                falhos += 1
                continue
            try:
                busca = self._cliente().post(
                    f"{config.HUBSPOT_BASE_URL}/crm/v3/objects/deals/search",
                    headers=self._headers(),
                    json={"filterGroups": [{"filters": [
                        {"propertyName": self.cnpj_property, "operator": "EQ", "value": cnpj}]}],
                         "limit": 1},
                    timeout=config.HTTP_TIMEOUT_S)
                busca.raise_for_status()
                resultados = busca.json().get("results", [])
                if not resultados:
                    falhos += 1
                    continue
                deal_id = resultados[0]["id"]
                patch = self._cliente().patch(
                    f"{config.HUBSPOT_BASE_URL}/crm/v3/objects/deals/{deal_id}",
                    headers=self._headers(),
                    json={"properties": {
                        "propensao_score": item.get("score"),
                        "propensao_fatores": "; ".join(
                            f["rotulo"] for f in item.get("fatores", []))[:5000]}},
                    timeout=config.HTTP_TIMEOUT_S)
                patch.raise_for_status()
                enviados += 1
            except httpx.HTTPError as e:
                log.warning("Falha ao gravar recomendação no HubSpot (%s): %s", cnpj, e)
                falhos += 1
        return {"itens_enviados": enviados, "itens_falhos": falhos, "destino": "hubspot:deals"}
