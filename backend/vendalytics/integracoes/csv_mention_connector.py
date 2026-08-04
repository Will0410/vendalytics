"""
csv_mention_connector.py — implementação de referência de `MentionSource`.

Colunas esperadas: canal, veiculo, url, publicado_em, texto, alcance.
"""
from __future__ import annotations

import csv
from pathlib import Path

from .mentions_base import MencaoExterna, MentionSource


class CSVMentionSource(MentionSource):
    def __init__(self, caminho: str | Path | None = None):
        self.caminho = Path(caminho) if caminho else None

    def nome(self) -> str:
        return "csv"

    def testar_conexao(self) -> bool:
        return self.caminho is not None and self.caminho.exists()

    def buscar_mencoes(self, *, desde: str = "") -> list[MencaoExterna]:
        if not self.caminho or not self.caminho.exists():
            return []
        out = []
        with open(self.caminho, newline="", encoding="utf-8-sig") as f:
            for linha in csv.DictReader(f):
                publicado = (linha.get("publicado_em") or "").strip()
                if desde and publicado and publicado < desde:
                    continue
                texto = (linha.get("texto") or "").strip()
                if not texto:
                    continue
                out.append(MencaoExterna(
                    canal=(linha.get("canal") or "imprensa").strip(),
                    veiculo=(linha.get("veiculo") or "").strip(),
                    url=(linha.get("url") or "").strip(),
                    publicado_em=publicado,
                    texto=texto,
                    alcance=int(float(linha.get("alcance") or 0)),
                ))
        return out
