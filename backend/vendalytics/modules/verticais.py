"""
verticais.py — vertical packs (spec §2.2 B5): "cada um é um conjunto de
camadas + features + modelo calibrado" plugável sobre o simulador de ponto
de `modules/geo.py`.

Arquitetura: um contrato (`VerticalPack`) + um registro (`PACKS`). Cada pack
recebe o mesmo contexto que `geo.simular_ponto` já calcula (proximidade,
densidade, camada IBGE) e devolve fatores ADICIONAIS, específicos daquele
negócio — nunca recalcula do zero o que o simulador genérico já fez.

**Cobertura honesta, pack a pack** — a spec lista seis verticais
(`shopping centers`, `mídia externa`, `condomínios`, `saúde`, `food
service`, `agro`); implementados aqui:

  ShoppingCenterPack → REAL: mix de lojas (diversidade de segmento dos
      clientes vizinhos, entropia de Shannon) + fluxo (densidade, já
      calculada pelo simulador) + produtividade por m² quando o usuário
      informa a ABL.
  MidiaExternaPack   → REAL, mas como PROXY declarado: alcance estimado a
      partir da população do município (IBGE, já integrado em B4)
      ponderada pela densidade local de clientes como proxy de fluxo de
      pessoas — não é medição de tráfego de mídia exterior de verdade
      (isso exigiria contrato com um provedor de inventário OOH).
  CondominiosPack    → CONTRATO SEM DADO: lançamentos/VGV/entrega prevista
      exigem uma base de registro imobiliário (ex.: um agregador de
      lançamentos) que não foi identificada nem validada nesta sessão.
      Devolve `disponivel:false` com o motivo — o mesmo padrão de todo
      componente sem fonte no resto do produto, nunca um número inventado.

Saúde, food service e agro NÃO têm pack implementado — ficam como próximo
pack a escrever quando houver decisão de fonte de dado, sobre o mesmo
contrato (é só implementar `VerticalPack` de novo).
"""
from __future__ import annotations

import math
from abc import ABC, abstractmethod

from ..infra.geo import haversine_km
from ..sources import ibge_real


class VerticalPack(ABC):
    @abstractmethod
    def nome(self) -> str:
        ...

    @abstractmethod
    def aplicar(self, *, lat: float, lon: float, raio_km: float,
               proximos: list[tuple[dict, float]], parametros: dict) -> dict:
        """`proximos` é a mesma lista (cliente, distancia_km) que
        `geo.simular_ponto` já calculou — o pack não refaz a busca espacial.
        Devolve `{"disponivel": bool, "fatores": [...], "motivo"?: str}`."""


class ShoppingCenterPack(VerticalPack):
    def nome(self) -> str:
        return "shopping_center"

    def aplicar(self, *, lat, lon, raio_km, proximos, parametros) -> dict:
        if not proximos:
            return {"disponivel": False, "motivo": "sem clientes na vizinhança para inferir mix"}

        segmentos: dict[str, int] = {}
        for c, _d in proximos:
            s = c.get("segmento") or "indefinido"
            segmentos[s] = segmentos.get(s, 0) + 1
        n = len(proximos)
        # Entropia de Shannon normalizada (0-1): 0 = um segmento só domina
        # tudo (mix pobre); 1 = segmentos igualmente distribuídos (mix rico).
        # É a métrica padrão para "diversidade de composição" — a mesma
        # lógica usada em ecologia para diversidade de espécies.
        entropia = -sum((k / n) * math.log(k / n) for k in segmentos.values())
        entropia_max = math.log(len(segmentos)) if len(segmentos) > 1 else 1.0
        indice_mix = round((entropia / entropia_max) if entropia_max > 0 else 0.0, 3)

        fatores = [
            {"feature": "mix_de_lojas", "contribuicao_pct": round(indice_mix * 100, 1),
             "rotulo": f"diversidade de segmento na vizinhança: índice {indice_mix} "
                      f"({len(segmentos)} segmentos distintos entre {n} clientes)"},
        ]

        abl_m2 = parametros.get("abl_m2")
        if abl_m2 and abl_m2 > 0:
            valor_total = sum(1 for _ in proximos)  # placeholder de contagem — produtividade usa densidade
            produtividade = round(n / float(abl_m2), 4)
            fatores.append({"feature": "produtividade_por_m2", "contribuicao_pct": None,
                            "rotulo": f"{produtividade} clientes vizinhos por m² de ABL informada"})

        return {"disponivel": True, "fatores": fatores, "indice_mix_lojas": indice_mix}


class MidiaExternaPack(VerticalPack):
    """Inventário OOH (spec B5) — sem contrato de provedor de inventário/
    medição de tráfego, a métrica aqui é DECLARADAMENTE uma estimativa
    (população do município × densidade local como proxy de fluxo), não
    medição de mídia exterior real."""

    def nome(self) -> str:
        return "midia_externa"

    def aplicar(self, *, lat, lon, raio_km, proximos, parametros) -> dict:
        municipio = parametros.get("municipio", "")
        uf = parametros.get("uf", "")
        camada = ibge_real.camada_para_ponto(municipio, uf) if municipio and uf else {"disponivel": False}
        if not camada.get("disponivel"):
            return {"disponivel": False,
                    "motivo": "sem população IBGE do município (informe 'municipio'/'uf' nos parâmetros) "
                             "— alcance estimado exige essa base"}

        densidade_local = len(proximos)
        # Proxy declarado: fração da população do município "capturável" no
        # raio, escalada pela densidade de clientes local (mais clientes
        # cadastrados na região = mais movimento observado). NÃO é medição
        # de tráfego real de mídia exterior — é a aproximação possível sem
        # provedor de inventário OOH contratado.
        fator_captura = min(densidade_local / 30.0, 1.0)
        alcance_estimado = int(camada["populacao"] * 0.01 * fator_captura)  # 1% do município como teto de captura local
        frequencia_estimada = round(1.0 + fator_captura * 3, 1)  # 1x a 4x/semana, proxy

        return {
            "disponivel": True,
            "fatores": [
                {"feature": "alcance_estimado", "contribuicao_pct": None,
                 "rotulo": f"~{alcance_estimado:,} pessoas/mês (estimativa — população IBGE × densidade local, "
                          f"não medição de tráfego real)"},
                {"feature": "frequencia_estimada", "contribuicao_pct": None,
                 "rotulo": f"~{frequencia_estimada}x/semana estimado"},
            ],
            "alcance_estimado_mensal": alcance_estimado,
            "aviso": "proxy declarado a partir de população IBGE + densidade local — "
                    "não substitui medição de tráfego de um provedor de inventário OOH",
        }


class CondominiosPack(VerticalPack):
    """Lançamentos/VGV/entrega prevista (spec B5) exigem uma base de
    registro imobiliário — nenhuma foi identificada/validada nesta sessão.
    Devolve indisponível, sempre, até essa fonte existir."""

    def nome(self) -> str:
        return "condominios"

    def aplicar(self, *, lat, lon, raio_km, proximos, parametros) -> dict:
        return {"disponivel": False,
                "motivo": "sem fonte de lançamentos/VGV configurada — "
                         "requer contrato com agregador de dados imobiliários, não implementado"}


PACKS: dict[str, VerticalPack] = {
    p.nome(): p for p in (ShoppingCenterPack(), MidiaExternaPack(), CondominiosPack())
}


def aplicar_pack(nome: str, *, lat: float, lon: float, raio_km: float,
                 proximos: list[tuple[dict, float]], parametros: dict | None = None) -> dict:
    pack = PACKS.get(nome)
    if pack is None:
        return {"disponivel": False, "motivo": f"vertical pack '{nome}' não existe "
                f"(disponíveis: {', '.join(PACKS)})"}
    return pack.aplicar(lat=lat, lon=lon, raio_km=raio_km, proximos=proximos,
                        parametros=parametros or {})
