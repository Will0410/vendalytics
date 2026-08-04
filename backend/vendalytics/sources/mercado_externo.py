"""
mercado_externo.py — cliente para uma fonte externa de universo de mercado
(TAM), usada pelo módulo de Território (spec §2.1 A2: TAM→SAM→SOM).

Este adapter NÃO tem acesso ao mercado total endereçável — só à carteira
própria do tenant. O TAM (quantas empresas de um segmento existem de fato
num município) precisa vir de fora: cadastro público de empresas (Receita
Federal/IBGE), plugável e OPCIONAL.

Referência de implementação real: o projeto irmão `cortex-b2b/` (mesmo
workspace) expõe exatamente esse contrato — `GET /api/setor/universo` — a
partir de dado público (RFB/IBGE), sem nenhum dado ou código deste tenant.
Configurável via `CORTEX_API_URL`; se ausente ou fora do ar, o módulo de
Território degrada para "só cobertura própria", nunca quebra.
"""
from __future__ import annotations

import logging

import httpx

from .. import config

log = logging.getLogger("vendalytics.sources.mercado_externo")


def configurado() -> bool:
    return bool(config.CORTEX_API_URL)


def universo_por_uf(prefixos_cnae: list[str], uf: str = "") -> list[dict] | None:
    """Universo de empresas ativas por município, para os prefixos de CNAE
    dados. `None` = fonte não configurada ou indisponível (o chamador decide
    o que fazer — nunca levanta, para o Território nunca quebrar por causa
    de uma fonte opcional fora do ar)."""
    if not configurado() or not prefixos_cnae:
        return None
    try:
        r = httpx.get(
            f"{config.CORTEX_API_URL}/api/setor/universo",
            params={"prefixos": ",".join(prefixos_cnae), "uf": uf},
            timeout=config.CORTEX_TIMEOUT_S,
        )
        r.raise_for_status()
        return r.json().get("municipios", [])
    except httpx.HTTPError as e:
        log.warning("mercado externo indisponível (%s) — Território segue só com cobertura própria", e)
        return None
