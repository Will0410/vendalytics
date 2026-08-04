"""
infra/geo.py — utilitários geoespaciais compartilhados. Extraído de
`modules/territorio.py` para não duplicar quando `modules/geo.py` (Fase 2)
precisou da mesma distância.

── Por que não H3/PostGIS de verdade ──────────────────────────────────────
A spec (§3.3) pede H3 para indexação hexagonal. Este projeto roda em SQLite
sem extensão espacial, sem a lib `h3` como dependência (mesmo racional do
resto do projeto: zero dependência pesada para rodar em free tier). O que
existe aqui é uma **grade regular lat/lon** (não hexagonal) na mesma função
— cobre o mesmo propósito prático (agregar por célula, comparar entorno) com
uma distorção conhecida e documentada: células perto do equador e longe dele
não têm a mesma área, e a grade não tem os vizinhos equidistantes que o
hexágono garante. Para o volume e a latitude de operação deste produto
(Brasil, escala municipal), a distorção é secundária diante do benefício de
não carregar geoprocessamento nativo. Trocar por H3 real é uma troca de
função (`celula`), não de arquitetura — todo chamador usa só o id de string.
"""
from __future__ import annotations

import math

# Resolução da grade em graus. ~0,01° ≈ 1,1km na latitude do Brasil — grosso
# o bastante para agrupar por bairro, fino o bastante para não confundir
# duas cidades médias vizinhas.
RESOLUCAO_GRAU = 0.01


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def celula(lat: float, lon: float, resolucao: float = RESOLUCAO_GRAU) -> str:
    """Id estável de célula de grade — o suficiente do "H3" que este produto
    usa hoje: agrupar pontos próximos sem calcular distância par a par."""
    return f"{round(lat / resolucao) * resolucao:.3f}|{round(lon / resolucao) * resolucao:.3f}"


def raio_aproximado_km(distancia_linha_reta_km: float, *, fator_sinuosidade: float = 1.3) -> float:
    """Aproximação de distância de deslocamento real a partir da distância
    em linha reta — NÃO é isócrona. Uma isócrona real (spec B1) vem de um
    motor de roteamento (OSRM/Valhalla/API comercial) sobre a malha viária
    de verdade, e considera tempo, não só distância. O fator 1,3 é uma
    aproximação de sinuosidade urbana comum na literatura de logística, não
    um valor calibrado para nenhuma cidade específica.

    Todo consumidor deste valor precisa rotular a saída como aproximação —
    ver `modules/geo.py`, que nunca chama isto de "isócrona" na resposta.
    """
    return distancia_linha_reta_km * fator_sinuosidade
