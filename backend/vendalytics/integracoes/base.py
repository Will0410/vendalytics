"""
integracoes/base.py — contrato de integração com CRM (spec §2.1 A6).

Mesmo padrão do `DataSourceAdapter`: os módulos de negócio nunca falam com
Salesforce/HubSpot/Pipedrive diretamente, sempre com este contrato. Trocar
de provedor — ou adicionar um segundo — nunca exige tocar em `fila.py` ou
`identidade.py`.

── Por que não há um conector Salesforce/HubSpot real aqui ────────────────
Um conector OAuth real exige credenciais de uma conta de teste do provedor
para ser validado — sem isso, código "pronto" que nunca rodou contra a API
de verdade é pior que não ter o código: ele passa confiança que não tem
lastro. O que este módulo entrega é o que É testável sem essas credenciais:
o contrato, a reconciliação por CNPJ, a idempotência e o write-back — que
são o mesmo comportamento independente de qual provedor está do outro lado.
`CSVCRMConnector` é a implementação de referência (equivalente ao
`SQLiteReferenceAdapter`): funciona de verdade, com dado de verdade, hoje.
Um `SalesforceConnector`/`HubSpotConnector` implementam este mesmo contrato
quando houver conta de teste para validar contra a API real.

── Duas direções ────────────────────────────────────────────────────────
  IN  (importar_oportunidades): o histórico de ganho/perda do CRM é o label
      mais confiável que existe — melhor que o proxy de recompra usado hoje
      quando disponível. Upsert idempotente por CNPJ: rodar a importação
      duas vezes não duplica nada.
  OUT (enviar_recomendacoes): score + fatores + recomendação, no formato que
      o CRM consome. Aqui, por não haver CRM real conectado, o envio grava
      um arquivo de staging versionado por rodada — o formato e o conteúdo
      já são o que um conector real enviaria via API.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class OportunidadeExterna:
    """Uma oportunidade como o CRM a representa — o vocabulário do CRM
    (stage/won/loss_reason), não o nosso. A tradução para o nosso modelo de
    dados acontece em `importar_oportunidades`, não aqui."""
    cnpj: str
    razao_social: str
    estagio: str
    valor: float
    criada_em: str
    fechada_em: str | None
    ganhou: bool | None          # None = ainda aberta
    motivo_perda: str = ""


class CRMConnector(ABC):
    @abstractmethod
    def nome(self) -> str:
        """Identificador do provedor, para rastrear a origem do dado
        (spec: proveniência obrigatória — §3.1)."""

    @abstractmethod
    def testar_conexao(self) -> bool:
        """Verifica credenciais/alcançabilidade sem mover dado nenhum."""

    @abstractmethod
    def buscar_oportunidades(self, *, desde: str = "") -> list[OportunidadeExterna]:
        """Lê oportunidades do CRM, opcionalmente desde uma data (sync
        incremental)."""

    @abstractmethod
    def enviar_recomendacoes(self, itens: list[dict]) -> dict:
        """Escreve score + fatores + recomendação de volta no CRM. Devolve um
        resumo (quantos escritos, quantos falharam) — nunca levanta por item
        individual: uma conta com CNPJ que o CRM rejeita não pode derrubar
        o envio das outras 500."""
