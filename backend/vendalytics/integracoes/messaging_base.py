"""
messaging_base.py — contrato de canal de mensageria (spec §2.4 D2).

Mesmo padrão de `base.py` (CRM) e `mentions_base.py` (menções): módulos de
negócio nunca chamam WhatsApp/Slack/e-mail diretamente. `ConsoleMessagingConnector`
é a referência — grava em staging, testável sem token nenhum. Este projeto já
declara `WHAPI_TOKEN`/`WHAPI_WEBHOOK_SECRET` em `config.py` (não usados até
aqui); um `WhapiMessagingConnector` real implementaria este mesmo contrato,
mas não é construído sem um token validado para rodar contra a API de
verdade — mesmo racional já aplicado ao CRM e ao agente de vendas (A7).
"""
from __future__ import annotations

from abc import ABC, abstractmethod


class MessagingConnector(ABC):
    @abstractmethod
    def nome(self) -> str:
        ...

    @abstractmethod
    def enviar(self, destinatario: str, texto: str) -> dict:
        """Envia uma mensagem. Devolve {"enviado": bool, "detalhe": ...} —
        nunca levanta por falha de UM destinatário, mesmo racional do
        write-back de CRM (`integracoes/csv_connector.py`)."""
