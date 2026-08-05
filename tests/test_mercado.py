"""
test_mercado.py — Território / TAM→SAM→SOM (spec §2.1 A2).

O que se checa: cobertura própria (SOM) sempre disponível sem depender de
nada externo; TAM/whitespace nunca vira 0 por omissão quando a fonte externa
não está configurada (aviso explícito em vez de dado falso); e quando a
fonte externa responde, TAM/SAM/whitespace batem aritmeticamente.
"""
from __future__ import annotations

import sqlite3

import pytest

from conftest import base_isolada
from vendalytics import config
from vendalytics.adapters.sqlite_reference import SCHEMA
from vendalytics.modules import mercado


@pytest.fixture(scope="module", autouse=True)
def carteira_dois_municipios():
    # scope="module": popular uma vez só e reutilizar entre os testes (todos
    # só leem) — abrir/fechar o mesmo arquivo temporário a cada teste dá
    # "database is locked" no SQLite do Windows (journal mode padrão).
    with base_isolada("mercado"):
        con = sqlite3.connect(str(config.SQLITE_PATH))
        con.executescript(SCHEMA)
        con.executemany(
            "INSERT INTO clientes (id,nome,filial,municipio,uf,segmento,status) "
            "VALUES (?,?,?,?,?,?,?)",
            [
                ("M-1", "Mercado A", "SP", "Canoas", "RS", "mercados", "ativo"),
                ("M-2", "Mercado B", "SP", "Canoas", "RS", "mercados", "ativo"),
                ("M-3", "Mercado C", "SP", "Canoas", "RS", "mercados", "inativo"),
                ("M-4", "Padaria D", "SP", "Porto Alegre", "RS", "padarias", "ativo"),
            ],
        )
        con.commit()
        con.close()
        yield


@pytest.fixture(autouse=True)
def _escopo(escopo_irrestrito):
    yield


def test_cobertura_independe_de_ter_universo_cacheado(carteira_dois_municipios):
    """SOM (cobertura própria) nunca depende do cache de universo estar
    populado — só da carteira do tenant, que sempre existe localmente."""
    r = mercado.cobertura()
    assert r["fonte_tam"] == "disponível"  # RFB pública, sem chave — sempre ligada
    por_municipio = {(m["municipio"], m["segmento"]): m for m in r["municipios"]}
    assert por_municipio[("Canoas", "mercados")]["total"] == 3
    assert por_municipio[("Canoas", "mercados")]["ativos"] == 2
    assert por_municipio[("Porto Alegre", "padarias")]["ativos"] == 1


def test_tam_sam_som_sem_universo_cacheado_nao_finge_whitespace(carteira_dois_municipios):
    """Regressão central do módulo: fonte ligada mas cache de universo ainda
    vazio para o segmento — whitespace é `None` (não calculável), nunca `0`
    (que afirmaria 'sem oportunidade')."""
    r = mercado.tam_sam_som(segmento="mercados")
    assert r["tam_disponivel"] is False
    assert r["aviso"] is not None and "cache de mercado" in r["aviso"]
    for m in r["municipios"]:
        assert m["tam"] is None
        assert m["whitespace"] is None
        assert m["som"] >= 0  # SOM continua real mesmo sem TAM


def test_tam_sam_som_com_fonte_externa(monkeypatch, carteira_dois_municipios):
    """Com a fonte configurada, TAM/whitespace saem calculados e batem
    aritmeticamente com o universo devolvido."""
    def falso_universo(prefixos, uf=""):
        assert prefixos  # o segmento precisa ter resolvido para prefixos de CNAE
        return [{"municipio": "Canoas", "uf": "RS", "empresas": 10}]

    monkeypatch.setattr(mercado.mercado_externo, "configurado", lambda: True)
    monkeypatch.setattr(mercado.mercado_externo, "universo_por_uf", falso_universo)

    r = mercado.tam_sam_som(segmento="mercados")
    assert r["tam_disponivel"] is True
    assert r["aviso"] is None
    canoas = next(m for m in r["municipios"] if m["municipio"] == "Canoas")
    assert canoas["tam"] == 10
    assert canoas["som"] == 2          # ativos em Canoas/mercados
    assert canoas["whitespace"] == 8   # 10 - 2
    assert canoas["penetracao_pct"] == 20.0


def test_tam_sam_som_segmento_sem_correspondencia_no_tenant(carteira_dois_municipios):
    """Segmento pedido que não existe na config do tenant não quebra — só
    não resolve prefixos, e a resposta cai para 'sem TAM' normalmente."""
    r = mercado.tam_sam_som(segmento="ramo-inexistente-no-tenant-config")
    assert r["prefixos_cnae"] == []
    assert r["tam_disponivel"] is False


def test_fonte_externa_fora_do_ar_nao_quebra(monkeypatch, carteira_dois_municipios):
    """Fonte configurada mas indisponível (timeout/erro) degrada como 'não
    disponível', nunca propaga exceção para o chamador HTTP."""
    monkeypatch.setattr(mercado.mercado_externo, "configurado", lambda: True)
    monkeypatch.setattr(mercado.mercado_externo, "universo_por_uf", lambda p, uf="": None)

    r = mercado.tam_sam_som(segmento="mercados")
    assert r["tam_disponivel"] is False
    assert r["aviso"] is not None
