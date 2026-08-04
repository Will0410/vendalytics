"""
test_verticais.py — vertical packs (spec §2.2 B5).

O que se checa: o índice de mix reage à diversidade real de segmento, o
pack de mídia externa nunca finge medição de tráfego que não tem (deixa
isso explícito no aviso), condomínios é honesto sobre não ter fonte, e nada
disso se mistura ao score genérico do simulador.
"""
from __future__ import annotations

import math

import pytest

from vendalytics.modules import verticais


def _cliente(id_, segmento, dist=1.0):
    return ({"id": id_, "segmento": segmento}, dist)


# ── ShoppingCenterPack ──────────────────────────────────────────────────────
def test_mix_uniforme_da_indice_alto():
    proximos = [_cliente(f"c{i}", seg) for i, seg in enumerate(["a", "b", "c", "d"] * 5)]
    r = verticais.aplicar_pack("shopping_center", lat=0, lon=0, raio_km=1, proximos=proximos, parametros={})
    assert r["disponivel"]
    assert r["indice_mix_lojas"] > 0.9   # distribuição igual entre 4 segmentos


def test_mix_concentrado_da_indice_baixo():
    proximos = [_cliente(f"c{i}", "so_um_segmento") for i in range(20)]
    r = verticais.aplicar_pack("shopping_center", lat=0, lon=0, raio_km=1, proximos=proximos, parametros={})
    assert r["indice_mix_lojas"] == 0.0   # um segmento só = zero diversidade


def test_sem_vizinho_e_honesto():
    r = verticais.aplicar_pack("shopping_center", lat=0, lon=0, raio_km=1, proximos=[], parametros={})
    assert r["disponivel"] is False


def test_abl_informada_calcula_produtividade():
    proximos = [_cliente(f"c{i}", "seg") for i in range(10)]
    r = verticais.aplicar_pack("shopping_center", lat=0, lon=0, raio_km=1,
                               proximos=proximos, parametros={"abl_m2": 1000})
    rotulos = " ".join(f["rotulo"] for f in r["fatores"])
    assert "por m²" in rotulos


# ── MidiaExternaPack ─────────────────────────────────────────────────────────
def test_midia_externa_sem_municipio_e_honesta():
    r = verticais.aplicar_pack("midia_externa", lat=0, lon=0, raio_km=1, proximos=[], parametros={})
    assert r["disponivel"] is False and "municipio" in r["motivo"].lower() or "municip" in r["motivo"].lower()


def test_midia_externa_nunca_finge_medicao_real(monkeypatch):
    from vendalytics.modules import verticais as v
    monkeypatch.setattr(v.ibge_real, "camada_para_ponto",
                        lambda m, u: {"disponivel": True, "populacao": 1_000_000})
    proximos = [_cliente(f"c{i}", "seg") for i in range(15)]
    r = v.aplicar_pack("midia_externa", lat=0, lon=0, raio_km=1, proximos=proximos,
                       parametros={"municipio": "X", "uf": "Y"})
    assert r["disponivel"]
    assert "não substitui medição" in r["aviso"]
    assert r["alcance_estimado_mensal"] > 0


def test_midia_externa_reage_a_densidade(monkeypatch):
    from vendalytics.modules import verticais as v
    monkeypatch.setattr(v.ibge_real, "camada_para_ponto",
                        lambda m, u: {"disponivel": True, "populacao": 1_000_000})
    poucos = v.aplicar_pack("midia_externa", lat=0, lon=0, raio_km=1,
                            proximos=[_cliente("c1", "s")], parametros={"municipio": "X", "uf": "Y"})
    muitos = v.aplicar_pack("midia_externa", lat=0, lon=0, raio_km=1,
                            proximos=[_cliente(f"c{i}", "s") for i in range(40)],
                            parametros={"municipio": "X", "uf": "Y"})
    assert muitos["alcance_estimado_mensal"] > poucos["alcance_estimado_mensal"]


# ── CondominiosPack ──────────────────────────────────────────────────────────
def test_condominios_sempre_indisponivel_sem_fonte():
    r = verticais.aplicar_pack("condominios", lat=0, lon=0, raio_km=1,
                               proximos=[_cliente("c1", "s")], parametros={})
    assert r["disponivel"] is False
    assert "fonte" in r["motivo"].lower()


# ── registro / pack inexistente ──────────────────────────────────────────────
def test_pack_inexistente_e_honesto():
    r = verticais.aplicar_pack("vertical_que_nao_existe", lat=0, lon=0, raio_km=1, proximos=[])
    assert r["disponivel"] is False and "não existe" in r["motivo"]


def test_todos_os_packs_registrados_tem_nome_consistente():
    for chave, pack in verticais.PACKS.items():
        assert pack.nome() == chave


# ── integração com o simulador de geo.py ─────────────────────────────────────
def test_simular_ponto_sem_vertical_nao_traz_campo_extra(escopo_irrestrito):
    from vendalytics.modules import geo
    import sqlite3
    from conftest import base_isolada
    from vendalytics.adapters.sqlite_reference import SCHEMA
    with base_isolada("geo_vertical") as caminho:
        con = sqlite3.connect(str(caminho))
        con.executescript(SCHEMA)
        con.executemany(
            "INSERT OR REPLACE INTO clientes (id,nome,filial,status,lat,lon,segmento) VALUES (?,?,?,?,?,?,?)",
            [(f"v{i}", f"C{i}", "SP", "ativo", -23.55, -46.63, "seg") for i in range(10)])
        con.commit(); con.close()
        from vendalytics.infra import db
        db.migrar()
        r = geo.simular_ponto(-23.55, -46.63, raio_km=2.0)
        assert "vertical" not in r


def test_simular_ponto_com_vertical_traz_o_pack(escopo_irrestrito):
    from vendalytics.modules import geo
    import sqlite3
    from conftest import base_isolada
    from vendalytics.adapters.sqlite_reference import SCHEMA
    with base_isolada("geo_vertical_2") as caminho:
        con = sqlite3.connect(str(caminho))
        con.executescript(SCHEMA)
        con.executemany(
            "INSERT OR REPLACE INTO clientes (id,nome,filial,status,lat,lon,segmento) VALUES (?,?,?,?,?,?,?)",
            [(f"v{i}", f"C{i}", "SP", "ativo", -23.55, -46.63, f"seg{i%3}") for i in range(10)])
        con.commit(); con.close()
        from vendalytics.infra import db
        db.migrar()
        r = geo.simular_ponto(-23.55, -46.63, raio_km=2.0, vertical="shopping_center")
        assert "vertical" in r and r["vertical"]["disponivel"]


# ── HTTP ──────────────────────────────────────────────────────────────────
def test_http_geo_verticais(cliente_http, token_admin):
    r = cliente_http.get("/api/geo/verticais", headers={"Authorization": f"Bearer {token_admin}"})
    assert r.status_code == 200
    assert set(r.json()["packs"]) == {"shopping_center", "midia_externa", "condominios"}
