"""
geocoding_real.py — geocodificação reversa real via Nominatim (OpenStreetMap),
para resolver o município/UF de QUALQUER ponto clicado no mapa (spec B1/B4).

Por que isso existe: antes, `modules/geo.py` só sabia o município de um ponto
através do cliente mais próximo dentro do raio de busca — clicar num lugar
sem nenhum cliente cadastrado por perto deixava a camada sociodemográfica
(IBGE) sem forma de saber em que município está o ponto, mesmo o IBGE tendo
o dado. Geocodificação reversa de verdade resolve isso para qualquer
coordenada, cliente por perto ou não — é o que faz "analise a região que eu
escolher" funcionar em qualquer região, não só onde já há carteira.

Validado ao vivo contra a API pública do Nominatim (gratuita, sem chave,
uso não-comercial de baixo volume permitido pela política deles — daí o
`User-Agent` identificado e o rate limit de 1 req/s abaixo, ambos exigidos
pelos termos de uso: https://operations.osmfoundation.org/policies/nominatim/).
Overpass API (para densidade de concorrentes por categoria) foi tentada e
NÃO ficou disponível de forma confiável neste ambiente (testados o servidor
principal e dois espelhos, todos falharam ou deram timeout) — por isso
`pressao_competitiva` continua indisponível em `modules/geo.py`, não
fingida aqui.
"""
from __future__ import annotations

import logging
import time

import httpx

from .. import config

log = logging.getLogger("vendalytics.sources.geocoding")

NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "Vendalytics/1.0 (plataforma de inteligencia comercial; uso interno)"

_ultimo_request = 0.0
_INTERVALO_MIN_S = 1.0  # política de uso do Nominatim: no máx. 1 req/s


def _respeitar_rate_limit() -> None:
    global _ultimo_request
    espera = _INTERVALO_MIN_S - (time.monotonic() - _ultimo_request)
    if espera > 0:
        time.sleep(espera)
    _ultimo_request = time.monotonic()


def municipio_de(lat: float, lon: float) -> dict | None:
    """Resolve lat/lon para município/UF via geocodificação reversa real.
    `None` quando indisponível — nunca inventa um município para uma
    coordenada que a API não conseguiu identificar."""
    try:
        _respeitar_rate_limit()
        r = httpx.get(NOMINATIM_URL, params={"lat": lat, "lon": lon, "format": "jsonv2"},
                     headers={"User-Agent": USER_AGENT}, timeout=config.HTTP_TIMEOUT_S)
        r.raise_for_status()
        endereco = r.json().get("address", {})
    except httpx.HTTPError as e:
        log.warning("Nominatim indisponível: %s", e)
        return None
    except (ValueError, KeyError):
        return None

    municipio = endereco.get("city") or endereco.get("town") or endereco.get("municipality") \
        or endereco.get("village")
    uf_nome = endereco.get("state")
    if not municipio or not uf_nome:
        return None
    return {"municipio": municipio, "uf_nome": uf_nome, "uf": _sigla_uf(uf_nome)}


_SIGLAS_UF = {
    "acre": "AC", "alagoas": "AL", "amapá": "AP", "amapa": "AP", "amazonas": "AM",
    "bahia": "BA", "ceará": "CE", "ceara": "CE", "distrito federal": "DF",
    "espírito santo": "ES", "espirito santo": "ES", "goiás": "GO", "goias": "GO",
    "maranhão": "MA", "maranhao": "MA", "mato grosso": "MT", "mato grosso do sul": "MS",
    "minas gerais": "MG", "pará": "PA", "para": "PA", "paraíba": "PB", "paraiba": "PB",
    "paraná": "PR", "parana": "PR", "pernambuco": "PE", "piauí": "PI", "piaui": "PI",
    "rio de janeiro": "RJ", "rio grande do norte": "RN", "rio grande do sul": "RS",
    "rondônia": "RO", "rondonia": "RO", "roraima": "RR", "santa catarina": "SC",
    "são paulo": "SP", "sao paulo": "SP", "sergipe": "SE", "tocantins": "TO",
}


def _sigla_uf(nome_uf: str) -> str:
    return _SIGLAS_UF.get(nome_uf.strip().lower(), "")
