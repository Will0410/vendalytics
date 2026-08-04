"""
newsapi_real.py — conector real de imprensa via NewsAPI.org (spec §2.3 C1).

Implementa `MentionSource` de verdade sobre a API pública da NewsAPI.org
(REST simples por chave, sem OAuth — o motivo da escolha como referência:
é o provedor mais fácil de qualquer time validar com uma chave de teste
grátis, antes de migrar para um agregador de clipping licenciado sobre o
mesmo contrato). **Nunca foi validado contra a API real** — sem chave neste
ambiente. Coberto por teste com HTTP mockado.

Limitação honesta: o endpoint `/everything` da NewsAPI não devolve alcance/
circulação do veículo — `alcance` sai sempre 0, nunca um número inventado
para preencher o campo que `reputacao.resumo_sentimento` pondera.
"""
from __future__ import annotations

import logging

import httpx

from .. import config
from .mentions_base import MencaoExterna, MentionSource

log = logging.getLogger("vendalytics.integracoes.newsapi")


def configurado() -> bool:
    return bool(config.NEWSAPI_KEY)


class NewsAPIMentionSource(MentionSource):
    def __init__(self, termo_busca: str):
        """`termo_busca` é obrigatório e explícito — normalmente o nome do
        tenant (`tenant.carregar().nome`). Buscar sem termo devolveria
        manchete do mundo inteiro, não menções à empresa."""
        self.termo_busca = termo_busca

    def nome(self) -> str:
        return "newsapi"

    def testar_conexao(self) -> bool:
        return configurado()

    def buscar_mencoes(self, *, desde: str = "") -> list[MencaoExterna]:
        if not configurado():
            return []
        params = {"q": self.termo_busca, "language": "pt", "sortBy": "publishedAt",
                  "apiKey": config.NEWSAPI_KEY}
        if desde:
            params["from"] = desde
        try:
            r = httpx.get(f"{config.NEWSAPI_BASE_URL}/everything", params=params,
                          timeout=config.HTTP_TIMEOUT_S)
            r.raise_for_status()
            corpo = r.json()
        except httpx.HTTPError as e:
            log.warning("NewsAPI indisponível: %s", e)
            return []

        out = []
        for artigo in corpo.get("articles", []):
            titulo = (artigo.get("title") or "").strip()
            descricao = (artigo.get("description") or "").strip()
            texto = f"{titulo}. {descricao}".strip(". ")
            if not texto:
                continue
            out.append(MencaoExterna(
                canal="imprensa",
                veiculo=(artigo.get("source") or {}).get("name", ""),
                url=artigo.get("url", ""),
                publicado_em=(artigo.get("publishedAt") or "")[:10],
                texto=texto,
                alcance=0,  # NewsAPI não informa circulação — nunca inventado
            ))
        return out
