"""
salesforce_real.py — conector real de CRM via Salesforce REST API (spec §2.1 A6).

Implementa `CRMConnector` de verdade. **Nunca foi validado contra uma
org Salesforce real** — sem credencial neste ambiente. Coberto por teste
com HTTP mockado (autenticação, SOQL, write-back), não pela API real.

── Autenticação ────────────────────────────────────────────────────────────
OAuth2 "username-password flow" (`grant_type=password`) — o fluxo
server-to-server mais simples de configurar sem interação humana, adequado
para uma integração batch como esta (importar/exportar em lote, não um
usuário logando). Exige Connected App configurada na org com esse fluxo
habilitado — decisão e trabalho do lado do cliente Salesforce, não deste
código.

── Campo de CNPJ ────────────────────────────────────────────────────────────
Salesforce não tem CNPJ nativo. `SALESFORCE_CNPJ_FIELD` (padrão `CNPJ__c`)
é o nome do campo customizado no objeto Account — precisa bater com o que
a org do cliente realmente tem. Isso é o "mapeamento de campo configurável
por tenant" que a spec A6 pede — aqui, uma env var; em multi-tenant de
verdade, viraria configuração por tenant em banco.

── Limite conhecido do write-back ──────────────────────────────────────────
`enviar_recomendacoes` faz UM lookup (SOQL por CNPJ) + UM PATCH por item —
não usa a Bulk API. Para volumes de milhares de contas por rodada, isso
precisa trocar para Salesforce Bulk API 2.0; para o volume de uma fila
diária (dezenas de itens), chamada por chamada é simples e correto.
"""
from __future__ import annotations

import logging
import os
import time

import httpx

from .. import config
from .base import CRMConnector, OportunidadeExterna

log = logging.getLogger("vendalytics.integracoes.salesforce")

API_VERSION = "v59.0"
_TTL_TOKEN_S = 25 * 60  # tokens de password flow duram horas; renova bem antes por segurança


def configurado() -> bool:
    return bool(config.SALESFORCE_CLIENT_ID and config.SALESFORCE_CLIENT_SECRET
               and config.SALESFORCE_USERNAME and config.SALESFORCE_PASSWORD)


class SalesforceConnector(CRMConnector):
    def __init__(self, *, cnpj_field: str = "", cliente_http: httpx.Client | None = None):
        self.cnpj_field = cnpj_field or os.getenv("SALESFORCE_CNPJ_FIELD", "CNPJ__c")
        self._http = cliente_http  # injeção para teste — None usa httpx direto
        self._token: str | None = None
        self._instance_url: str | None = None
        self._token_em = 0.0

    def nome(self) -> str:
        return "salesforce"

    def _cliente(self) -> httpx.Client:
        return self._http or httpx

    def _autenticar(self) -> tuple[str, str]:
        if self._token and (time.time() - self._token_em) < _TTL_TOKEN_S:
            return self._token, self._instance_url
        senha = config.SALESFORCE_PASSWORD + config.SALESFORCE_SECURITY_TOKEN
        r = self._cliente().post(
            f"{config.SALESFORCE_LOGIN_URL}/services/oauth2/token",
            data={"grant_type": "password", "client_id": config.SALESFORCE_CLIENT_ID,
                 "client_secret": config.SALESFORCE_CLIENT_SECRET,
                 "username": config.SALESFORCE_USERNAME, "password": senha},
            timeout=config.HTTP_TIMEOUT_S,
        )
        r.raise_for_status()
        corpo = r.json()
        self._token, self._instance_url = corpo["access_token"], corpo["instance_url"]
        self._token_em = time.time()
        return self._token, self._instance_url

    def _headers(self, token: str) -> dict:
        return {"Authorization": f"Bearer {token}"}

    def testar_conexao(self) -> bool:
        if not configurado():
            return False
        try:
            self._autenticar()
            return True
        except httpx.HTTPError as e:
            log.warning("Salesforce indisponível: %s", e)
            return False

    def buscar_oportunidades(self, *, desde: str = "") -> list[OportunidadeExterna]:
        if not configurado():
            return []
        token, instance_url = self._autenticar()
        soql = (f"SELECT Id, Amount, StageName, CreatedDate, CloseDate, IsWon, IsClosed, "
               f"Account.Name, Account.{self.cnpj_field} FROM Opportunity")
        if desde:
            soql += f" WHERE LastModifiedDate >= {desde}T00:00:00Z"
        r = self._cliente().get(
            f"{instance_url}/services/data/{API_VERSION}/query",
            headers=self._headers(token), params={"q": soql}, timeout=config.HTTP_TIMEOUT_S)
        r.raise_for_status()
        registros = r.json().get("records", [])

        out = []
        for reg in registros:
            conta = reg.get("Account") or {}
            cnpj = "".join(ch for ch in str(conta.get(self.cnpj_field) or "") if ch.isdigit())
            if len(cnpj) != 14:
                continue  # CNPJ ausente/inválido no CRM: descartado, não adivinhado
            fechada = reg.get("IsClosed")
            out.append(OportunidadeExterna(
                cnpj=cnpj, razao_social=conta.get("Name", ""), estagio=reg.get("StageName", ""),
                valor=float(reg.get("Amount") or 0), criada_em=(reg.get("CreatedDate") or "")[:10],
                fechada_em=(reg.get("CloseDate") or "")[:10] if fechada else None,
                ganhou=bool(reg.get("IsWon")) if fechada else None))
        return out

    def enviar_recomendacoes(self, itens: list[dict]) -> dict:
        if not configurado():
            return {"itens_enviados": 0, "itens_falhos": len(itens), "destino": "não configurado"}
        token, instance_url = self._autenticar()
        enviados, falhos = 0, 0
        for item in itens:
            cnpj = "".join(ch for ch in str(item.get("cliente_id") or "") if ch.isdigit())
            if len(cnpj) != 14:
                falhos += 1
                continue
            try:
                busca = self._cliente().get(
                    f"{instance_url}/services/data/{API_VERSION}/query",
                    headers=self._headers(token),
                    params={"q": f"SELECT Id FROM Account WHERE {self.cnpj_field} = '{cnpj}' LIMIT 1"},
                    timeout=config.HTTP_TIMEOUT_S)
                busca.raise_for_status()
                registros = busca.json().get("records", [])
                if not registros:
                    falhos += 1
                    continue
                account_id = registros[0]["Id"]
                patch = self._cliente().patch(
                    f"{instance_url}/services/data/{API_VERSION}/sobjects/Account/{account_id}",
                    headers=self._headers(token),
                    json={"Propensao_Score__c": item.get("score"),
                         "Propensao_Fatores__c": "; ".join(
                             f["rotulo"] for f in item.get("fatores", []))[:255]},
                    timeout=config.HTTP_TIMEOUT_S)
                patch.raise_for_status()
                enviados += 1
            except httpx.HTTPError as e:
                log.warning("Falha ao gravar recomendação no Salesforce (%s): %s", cnpj, e)
                falhos += 1
        return {"itens_enviados": enviados, "itens_falhos": falhos, "destino": "salesforce:Account"}
