"""
console_messaging.py — implementação de referência de `MessagingConnector`:
grava em staging versionado (mesmo padrão de `csv_connector.enviar_recomendacoes`),
no formato exato que um conector real (WhatsApp Business API) enviaria.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from .. import config
from ..infra import context
from .messaging_base import MessagingConnector


class ConsoleMessagingConnector(MessagingConnector):
    def nome(self) -> str:
        return "console"

    def enviar(self, destinatario: str, texto: str) -> dict:
        escopo = context.atual()
        pasta = config.CRM_STAGING_DIR.parent / "mensagens_staging"
        pasta.mkdir(parents=True, exist_ok=True)
        destino = pasta / f"{escopo.tenant_id}_{self.nome()}.jsonl"
        registro = {"destinatario": destinatario, "texto": texto,
                   "enviado_em": datetime.now(timezone.utc).isoformat()}
        try:
            with open(destino, "a", encoding="utf-8") as f:
                f.write(json.dumps(registro, ensure_ascii=False) + "\n")
        except (TypeError, ValueError) as e:
            return {"enviado": False, "detalhe": str(e)}
        return {"enviado": True, "destino": str(destino)}
