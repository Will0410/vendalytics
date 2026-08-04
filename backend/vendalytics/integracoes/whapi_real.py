"""
whapi_real.py — conector real de WhatsApp via WHAPI.cloud (spec §2.4 D2).

Implementa `MessagingConnector` de verdade — não é referência/staging como
`console_messaging.py`. **Nunca foi validado contra a API real**: não há
token WHAPI válido neste ambiente para testar. O que está coberto por teste
é a construção do request e o tratamento de resposta (HTTP mockado); o
contrato exato de payload segue a documentação pública da WHAPI.cloud
(`POST /messages/text`, `Authorization: Bearer <token>`,
`{"to": "<numero>", "body": "<texto>"}`) no momento em que este código foi
escrito — provedores de API mudam contrato sem aviso, então o primeiro uso
real precisa ser validado manualmente antes de confiar em produção.
"""
from __future__ import annotations

import logging

import httpx

from .. import config
from .messaging_base import MessagingConnector

log = logging.getLogger("vendalytics.integracoes.whapi")


def configurado() -> bool:
    return bool(config.WHAPI_TOKEN)


class WhapiMessagingConnector(MessagingConnector):
    def nome(self) -> str:
        return "whapi"

    def enviar(self, destinatario: str, texto: str) -> dict:
        if not configurado():
            return {"enviado": False, "detalhe": "WHAPI_TOKEN não configurado"}
        try:
            r = httpx.post(
                f"{config.WHAPI_BASE_URL}/messages/text",
                headers={"Authorization": f"Bearer {config.WHAPI_TOKEN}"},
                json={"to": destinatario, "body": texto},
                timeout=config.HTTP_TIMEOUT_S,
            )
            r.raise_for_status()
            corpo = r.json()
            return {"enviado": True, "detalhe": corpo, "message_id": corpo.get("id")}
        except httpx.HTTPStatusError as e:
            log.warning("WHAPI recusou envio para %s: %s", destinatario, e)
            return {"enviado": False, "detalhe": f"HTTP {e.response.status_code}: {e.response.text[:200]}"}
        except httpx.HTTPError as e:
            log.warning("WHAPI indisponível: %s", e)
            return {"enviado": False, "detalhe": str(e)}
