"""
bizdata_real.py — comércios reais por categoria e localização, via BizData
API (https://bizdata-web.vercel.app), um wrapper gratuito sobre dados do
OpenStreetMap. Sem chave, sem cadastro, sem custo — a fonte real que faltava
para "buscar comércio por ramo/região" (BrasilAPI só faz 1 CNPJ por vez,
IBGE só dá contagem agregada, nunca nome/endereço — ver `rfb_real.py` e
`ibge_real.py`).

Honestidade sobre esta fonte: é um projeto pequeno/não-oficial de terceiros,
não é Google nem um serviço com SLA garantido. Validado ao vivo antes de
integrar (nomes batem com redes reais — Droga Raia, Callfarma — em
Curitiba), mas já observei 1 erro 502 em 4 chamadas e a primeira consulta
de um local novo pode levar ~10s (proxy ao vivo para o Overpass por trás).
Por isso: cache local agressivo (`bizdata_cache.py`) — cada local+categoria
consultado uma vez fica disponível instantaneamente depois, e se a fonte
sair do ar um dia, o cache já coletado continua servindo.
"""
from __future__ import annotations

import logging

import httpx

from .. import config
from . import bizdata_cache

log = logging.getLogger("vendalytics.sources.bizdata")

BASE_URL = "https://bizdata-web.vercel.app/api"

# As 37 categorias reais que a fonte suporta (api/categories, consultado ao
# vivo) — expostas como estão, sem forçar mapeamento pros "ramos" do tenant
# que não têm correspondente 1:1 (ex.: não existe "açougue"/"hortifruti"
# como categoria própria nesta fonte).
CATEGORIAS = [
    "accountant", "bakery", "bank", "bar", "beauty", "bookstore", "cafe",
    "car_dealer", "car_repair", "cinema", "clothing", "coworking", "dentist",
    "doctor", "electronics", "florist", "furniture", "gallery", "gas_station",
    "guest_house", "gym", "hairdresser", "hospital", "hostel", "hotel",
    "insurance", "lawyer", "museum", "parking", "pet_shop", "pharmacy",
    "real_estate", "restaurant", "school", "supermarket", "theatre",
    "university",
]

# Timeout maior que o padrão do projeto: a 1ª consulta de um local novo
# pode demorar ~10s (a fonte proxya ao vivo pro Overpass por trás).
_TIMEOUT_S = max(config.HTTP_TIMEOUT_S, 20.0)


def configurado() -> bool:
    return not getattr(config, "BIZDATA_DESATIVADO", False)


def buscar(municipio: str, uf: str, categoria: str, *,
          raio_km: float = 8.0, limit: int = 100) -> list[dict] | None:
    """Comércios reais (nome, endereço, telefone, lat/lon) de 1 categoria
    perto de 1 município. `None` só quando a fonte está indisponível ou a
    categoria é inválida — nunca finge lista vazia como "sem comércio
    nenhum" quando na verdade é a fonte que falhou."""
    if not configurado() or categoria not in CATEGORIAS or not municipio:
        return None
    localizacao = f"{municipio},{uf},Brazil" if uf else f"{municipio},Brazil"
    try:
        r = httpx.get(f"{BASE_URL}/businesses", params={
            "location": localizacao, "category": categoria,
            "radius_km": raio_km, "limit": min(int(limit), 500),
        }, timeout=_TIMEOUT_S)
        r.raise_for_status()
        return r.json().get("businesses", [])
    except httpx.HTTPError as e:
        log.warning("BizData indisponível (municipio=%s, categoria=%s): %s",
                    municipio, categoria, e)
        return None


def buscar_com_cache(municipio: str, uf: str, categoria: str, *,
                     raio_km: float = 8.0, limit: int = 100) -> dict:
    """Cache-first: só chama a fonte ao vivo se nunca consultou esse
    (município, UF, categoria) antes, ou se o cache passou de 30 dias — e
    mesmo aí, se a fonte ao vivo falhar, cai pro cache velho em vez de
    devolver vazio. `disponivel=False` só quando não há cache NENHUM e a
    fonte ao vivo também falhou."""
    em_cache = bizdata_cache.buscar_no_cache(municipio, uf, categoria)
    if em_cache is not None and em_cache[1]:  # existe e está fresco
        return {"disponivel": True, "comercios": em_cache[0], "fonte": "cache"}

    ao_vivo = buscar(municipio, uf, categoria, raio_km=raio_km, limit=limit)
    if ao_vivo is not None:
        bizdata_cache.salvar(municipio, uf, categoria, ao_vivo)
        return {"disponivel": True, "comercios": ao_vivo, "fonte": "ao vivo (OpenStreetMap)"}

    if em_cache is not None:  # cache velho, mas fonte ao vivo falhou agora
        return {"disponivel": True, "comercios": em_cache[0], "fonte": "cache (pode estar desatualizado)"}

    return {"disponivel": False, "motivo": "fonte indisponível e sem cache prévio para este local/categoria"}
