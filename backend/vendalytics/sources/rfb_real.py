"""
rfb_real.py — consulta pontual de CNPJ via BrasilAPI (espelho open-source do
cadastro da Receita Federal), spec §2.1 A2.

Ponto de ingestão do "mercado público" (empresas reais fora da carteira do
tenant) que alimenta `modules/mercado.py` (TAM/SAM/SOM). Sempre disponível e
sem chave — mesma convenção de `ibge_real.py`.

Por que isto é um cache que ACUMULA, não um "baixar tudo": a BrasilAPI é
ponto-a-ponto (1 CNPJ por chamada). Não existe "universo inteiro" sem o
dump oficial da RFB (dezenas de GB comprimidos) — fora do escopo desta
integração leve. Cada CNPJ consultado uma vez fica disponível para as
contagens seguintes via `mercado_publico_cache.py`; o universo cresce com o
uso, nunca finge ser a base nacional completa (ver aviso em `modules/mercado.py`).
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor

import httpx

from .. import config
from ..modules import identidade
from . import mercado_publico_cache

log = logging.getLogger("vendalytics.sources.rfb")

BASE_URL = "https://brasilapi.com.br/api/cnpj/v1"


def configurado() -> bool:
    """Sempre True — API pública, sem chave. Mesmo racional de
    `ibge_real.configurado()`: existe para o chamador nunca supor
    disponibilidade sem checar, mesmo quando a checagem é trivial hoje."""
    return not getattr(config, "RFB_DESATIVADO", False)


def _mascarar_cpf(valor: str | None) -> str:
    """CPF nunca sai completo daqui — mesma regra não-negociável usada no
    protótipo original (cortex-b2b): nome de sócio é sempre dado pessoal,
    mesmo em contexto B2B. A RFB já mascara a maior parte do CPF na origem
    (`***550179**`); isto só garante que um vazamento acidental de CPF
    completo também seja mascarado na saída."""
    if not valor:
        return ""
    digitos = identidade.so_digitos(valor)
    if len(digitos) == 11:
        return f"***{digitos[3:9]}**"
    return valor


def consultar(cnpj: str, *, cachear: bool = True) -> dict | None:
    """Cadastro público de 1 CNPJ. `None` = inválido, não encontrado, ou
    fonte indisponível — nunca levanta (mesmo racional de
    `ibge_real.populacao_estimada`: fonte opcional fora do ar não pode
    derrubar quem chama). Grava no cache local por padrão, para as
    consultas de universo (`mercado_publico_cache.universo_por_prefixos`)
    enxergarem esta empresa nas contagens seguintes.
    """
    doc = identidade.so_digitos(cnpj)
    if len(doc) != 14 or not configurado():
        return None
    try:
        r = httpx.get(f"{BASE_URL}/{doc}", timeout=config.HTTP_TIMEOUT_S)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        d = r.json()
    except httpx.HTTPError as e:
        log.warning("RFB/BrasilAPI indisponível (cnpj=%s): %s", doc, e)
        # A BrasilAPI é rate-limitada (429) na prática — visto ao vivo neste
        # projeto ao consultar vários CNPJs em sequência curta. Cair pro
        # último dado real já consultado é mais honesto que sumir com a
        # empresa da lista; None só quando nunca foi consultada antes.
        cache_hit = mercado_publico_cache.buscar_por_cnpj(doc)
        if cache_hit is not None:
            log.info("Usando cache local para cnpj=%s (fonte ao vivo indisponível).", doc)
        return cache_hit

    situacao = d.get("descricao_situacao_cadastral") or ""
    empresa = {
        "cnpj": doc,
        "razao_social": d.get("razao_social") or "",
        "nome_fantasia": d.get("nome_fantasia") or "",
        "situacao": situacao,
        "ativa": situacao.strip().upper() == "ATIVA",
        "porte": d.get("descricao_porte") or d.get("porte") or "",
        "cnae_principal": str(d.get("cnae_fiscal") or ""),
        "cnae_principal_descricao": d.get("cnae_fiscal_descricao") or "",
        "municipio": d.get("municipio") or "",
        "uf": d.get("uf") or "",
        "bairro": d.get("bairro") or "",
        "telefone": d.get("ddd_telefone_1") or "",
        "email": d.get("email") or "",
        "socios": [
            {"qualificacao": s.get("qualificacao_socio") or "",
             "documento_mascarado": _mascarar_cpf(s.get("cnpj_cpf_do_socio"))}
            for s in (d.get("qsa") or [])
        ],
    }
    if cachear and empresa["municipio"] and empresa["cnae_principal"]:
        mercado_publico_cache.registrar(empresa)
    return empresa


def consultar_lote(cnpjs: list[str], *, cachear: bool = True) -> list[dict]:
    """Consulta vários CNPJs em paralelo (BrasilAPI é ponto-a-ponto, 1 por
    chamada — não existe busca em lote na API pública). Usado pela tabela de
    prospecção do Território: sem isso, consultar 6+ CNPJs sequenciais
    levaria a soma dos tempos de cada chamada em vez do tempo da mais lenta.
    CNPJs inválidos/não encontrados são omitidos do resultado, não geram erro
    para os demais."""
    if not cnpjs:
        return []
    with ThreadPoolExecutor(max_workers=min(len(cnpjs), 8)) as pool:
        resultados = list(pool.map(lambda c: consultar(c, cachear=cachear), cnpjs))
    return [r for r in resultados if r is not None]
