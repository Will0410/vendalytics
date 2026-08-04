"""
mentions_base.py — contrato de fonte de menções (spec §2.3 C1).

Mesmo padrão de `integracoes/base.py`: os módulos de negócio nunca falam
com uma API de clipping/social listening diretamente, sempre com este
contrato. `CSVMentionSource` é a implementação de referência — funciona de
verdade hoje, sobre arquivo. Um conector real de imprensa/social/ASR exige
credencial e contrato comercial de provedor para ser validado; construir
esse código sem poder rodá-lo contra a API de verdade passaria confiança
sem lastro, o mesmo racional já aplicado a `integracoes/base.py`.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class MencaoExterna:
    canal: str            # imprensa | social | reclamacao | radio_tv
    veiculo: str
    url: str
    publicado_em: str
    texto: str
    alcance: int = 0


class MentionSource(ABC):
    @abstractmethod
    def nome(self) -> str:
        """Identificador da fonte — proveniência obrigatória (spec §3.1)."""

    @abstractmethod
    def testar_conexao(self) -> bool:
        ...

    @abstractmethod
    def buscar_mencoes(self, *, desde: str = "") -> list[MencaoExterna]:
        ...
