"""
ibge_real.py — camada sociodemográfica real via API pública do IBGE (spec
B4). Diferente dos outros conectores desta sessão, ESTE FOI VALIDADO AO VIVO
contra a API real (`servicodados.ibge.gov.br`) — é pública, gratuita e não
exige chave, então não há razão para deixá-la sem teste real como os
conectores de CRM/WhatsApp/mídia (esses exigem credencial paga que este
ambiente não tem).

Duas chamadas:
  1. `municipio_id`: resolve nome+UF → código IBGE (localidades API v1).
  2. `populacao_estimada`: população residente estimada do município
     (agregado 6579/variável 9324, SIDRA API v3) — o proxy de demanda mais
     direto e mais confiável que o IBGE oferece sem exigir tabulação
     cruzada complexa.

Escopo deliberadamente contido: a spec B4 também pede renda domiciliar e
estrutura etária. Esses dados existem no IBGE (Censo/PNAD), mas exigem
agregados SIDRA bem mais complexos (múltiplas variáveis, classificações
por faixa etária/renda) — population é o que dá o maior valor por esforço
de integração, e é o suficiente para o gap que `modules/geo.py` já sinaliza
como `"sociodemografico": "sem camada IBGE configurada"`. Se o produto
crescer, população vira só mais um campo neste mesmo módulo, mesmo padrão.
"""
from __future__ import annotations

import logging

import httpx

from .. import config

log = logging.getLogger("vendalytics.sources.ibge")

BASE_LOCALIDADES = "https://servicodados.ibge.gov.br/api/v1/localidades"
BASE_AGREGADOS = "https://servicodados.ibge.gov.br/api/v3/agregados"
AGREGADO_POPULACAO = 6579
VARIAVEL_POPULACAO = 9324
AGREGADO_PIB = 5938  # PIB dos Municípios (Contas Regionais, referência 2010)
VARIAVEL_PIB_TOTAL = 37  # "Produto Interno Bruto a preços correntes", unidade Mil Reais


def configurado() -> bool:
    """Sempre True — API pública, sem chave. Existe pela mesma razão de
    `mercado_externo.configurado()`: o chamador nunca deveria supor
    disponibilidade sem checar, mesmo quando a checagem é trivial hoje —
    se algum dia isso migrar para um provedor pago, só este retorno muda."""
    return not getattr(config, "IBGE_DESATIVADO", False)


def municipio_id(nome: str, uf: str) -> int | None:
    """Resolve nome+UF para o código IBGE do município. `None` se não achar
    ou se a API estiver fora do ar — nunca levanta, mesmo racional de
    `mercado_externo.universo_por_uf`: uma fonte opcional fora do ar não
    pode derrubar o módulo de Geo."""
    if not configurado() or not nome or not uf:
        return None
    try:
        r = httpx.get(f"{BASE_LOCALIDADES}/estados/{uf.upper()}/municipios",
                      timeout=config.HTTP_TIMEOUT_S)
        r.raise_for_status()
        alvo = nome.strip().casefold()
        for m in r.json():
            if str(m.get("nome", "")).strip().casefold() == alvo:
                return int(m["id"])
        return None
    except httpx.HTTPError as e:
        log.warning("IBGE indisponível (localidades): %s", e)
        return None


def municipios_por_uf(uf: str) -> list[dict] | None:
    """Lista de municípios de uma UF (localidades API v1) — o que alimenta o
    filtro Estado→Município e os KPIs da praça no Território. `None` só
    quando a API está fora do ar; UF inexistente/mal formada volta lista
    vazia (a própria API do IBGE responde assim, não é caso de erro)."""
    if not configurado() or not uf:
        return None
    try:
        r = httpx.get(f"{BASE_LOCALIDADES}/estados/{uf.upper()}/municipios",
                      timeout=config.HTTP_TIMEOUT_S)
        r.raise_for_status()
        return [{"id": int(m["id"]), "nome": m.get("nome", "")} for m in r.json()]
    except httpx.HTTPError as e:
        log.warning("IBGE indisponível (municípios por UF): %s", e)
        return None


def populacao_estimada(municipio_ibge_id: int) -> dict | None:
    """População residente estimada (ano mais recente disponível). `None`
    quando indisponível — o chamador decide como degradar, nunca um número
    aqui vira 0 por falta de dado (0 afirmaria "cidade vazia")."""
    if not configurado():
        return None
    try:
        r = httpx.get(
            f"{BASE_AGREGADOS}/{AGREGADO_POPULACAO}/periodos/-1/variaveis/{VARIAVEL_POPULACAO}",
            params={"localidades": f"N6[{municipio_ibge_id}]"}, timeout=config.HTTP_TIMEOUT_S)
        r.raise_for_status()
        corpo = r.json()
        if not corpo:
            return None
        series = corpo[0]["resultados"][0]["series"][0]["serie"]
        if not series:
            return None
        ano, valor = next(iter(series.items()))
        return {"ano": int(ano), "populacao": int(valor)}
    except (httpx.HTTPError, KeyError, IndexError, ValueError, StopIteration) as e:
        log.warning("IBGE indisponível (agregado população): %s", e)
        return None


def pib_total(municipio_ibge_id: int) -> dict | None:
    """PIB total do município (Contas Regionais, ano mais recente
    disponível — hoje 2023, a série sai sempre com ~2 anos de defasagem, é
    como a Contas Regionais do IBGE é publicada). `None` quando
    indisponível, mesmo racional de `populacao_estimada`: nunca vira 0."""
    if not configurado():
        return None
    try:
        r = httpx.get(
            f"{BASE_AGREGADOS}/{AGREGADO_PIB}/periodos/-1/variaveis/{VARIAVEL_PIB_TOTAL}",
            params={"localidades": f"N6[{municipio_ibge_id}]"}, timeout=config.HTTP_TIMEOUT_S)
        r.raise_for_status()
        corpo = r.json()
        if not corpo:
            return None
        series = corpo[0]["resultados"][0]["series"][0]["serie"]
        if not series:
            return None
        ano, valor_mil_reais = next(iter(series.items()))
        return {"ano": int(ano), "pib_total_reais": int(valor_mil_reais) * 1000}
    except (httpx.HTTPError, KeyError, IndexError, ValueError, StopIteration) as e:
        log.warning("IBGE indisponível (agregado PIB): %s", e)
        return None


def pib_per_capita(municipio_ibge_id: int) -> dict | None:
    """PIB per capita = PIB total ÷ população estimada — calculado aqui a
    partir de dois números reais do IBGE (o IBGE não publica per capita
    municipal pronto num agregado único), nunca um valor de terceiros.
    `None` se qualquer uma das duas partes faltar (nunca divide por dado
    incompleto para não produzir um número que pareça preciso e não é)."""
    pib = pib_total(municipio_ibge_id)
    pop = populacao_estimada(municipio_ibge_id)
    if pib is None or pop is None or not pop["populacao"]:
        return None
    return {
        "pib_total_reais": pib["pib_total_reais"], "pib_ano_referencia": pib["ano"],
        "populacao": pop["populacao"], "populacao_ano_referencia": pop["ano"],
        "pib_per_capita_reais": round(pib["pib_total_reais"] / pop["populacao"], 2),
    }


def camada_para_ponto(municipio: str, uf: str) -> dict:
    """Interface que `modules/geo.py` consome: uma camada sociodemográfica
    para um município, ou `disponivel:false` honesto — nunca inventa
    número para preencher o componente que a spec B4 pede."""
    mid = municipio_id(municipio, uf)
    if mid is None:
        return {"disponivel": False, "motivo": f"município '{municipio}/{uf}' não resolvido no IBGE"}
    pop = populacao_estimada(mid)
    if pop is None:
        return {"disponivel": False, "motivo": "população não disponível para este município"}
    return {"disponivel": True, "municipio_ibge_id": mid, "populacao": pop["populacao"],
            "populacao_ano_referencia": pop["ano"], "fonte": "IBGE (agregado 6579)"}
