"""
test_geo.py — Geo Intelligence (spec §2.2, Fase 2 MVP).

O que se checa: o score responde de forma sensata a densidade e proximidade
(mais clientes perto > mais longe > nenhum), os componentes sem dado real
nunca viram zero disfarçado, similaridade agrupa filiais parecidas, e a
previsão de faturamento nunca sai como ponto único.
"""
from __future__ import annotations

import sqlite3

import pytest

from vendalytics.infra import db
from vendalytics.infra.geo import celula, haversine_km, raio_aproximado_km
from vendalytics.modules import geo


@pytest.fixture(scope="module", autouse=True)
def duas_filiais_com_padroes_distintos():
    """Filial DENSA: 20 clientes concentrados num raio pequeno, alto valor.
    Filial ESPARSA: 20 clientes espalhados, valor baixo. É o contraste que
    prova que o score reage a densidade+proximidade, não é uma constante."""
    from conftest import base_isolada
    from vendalytics.adapters.sqlite_reference import SCHEMA

    linhas_cli, linhas_venda = [], []
    # Densa: em volta de (-23.55, -46.63), raio ~1km, segmentos variados.
    for i in range(20):
        cid = f"G-DENSA-{i:02d}"
        lat = -23.55 + (i % 5) * 0.002
        lon = -46.63 + (i // 5) * 0.002
        linhas_cli.append((cid, f"Cliente {i}", "DENSA", "ativo", lat, lon,
                           "seg" + str(i % 3)))
        linhas_venda.append((cid, "V-1", "DENSA", "2026-06-01", 8000.0))

    # Esparsa: espalhados num raio de ~30km, valor baixo, mesmo segmento.
    for i in range(20):
        cid = f"G-ESPARSA-{i:02d}"
        lat = -24.0 + i * 0.03
        lon = -47.0 + i * 0.03
        linhas_cli.append((cid, f"Cliente {i}", "ESPARSA", "ativo", lat, lon, "seg0"))
        linhas_venda.append((cid, "V-2", "ESPARSA", "2026-06-01", 500.0))

    # Faturamento mensal de 4 meses para a filial DENSA, para o preditor.
    for mes, valor in [("2026-03", 150000), ("2026-04", 160000),
                       ("2026-05", 140000), ("2026-06", 170000)]:
        linhas_venda.append((f"G-DENSA-00", "V-1", "DENSA", f"{mes}-15", valor))

    with base_isolada("geo") as caminho:
        con = sqlite3.connect(str(caminho))
        con.executescript(SCHEMA)
        con.executemany(
            "INSERT OR REPLACE INTO clientes (id,nome,filial,status,lat,lon,segmento) "
            "VALUES (?,?,?,?,?,?,?)", linhas_cli)
        con.executemany(
            "INSERT INTO vendas (cliente_id,vendedor_id,filial,data_venda,valor_total) "
            "VALUES (?,?,?,?,?)", linhas_venda)
        con.commit()
        con.close()
        db.migrar()
        yield


# ── utilitários geo ────────────────────────────────────────────────────────
def test_haversine_distancia_conhecida():
    # São Paulo -> Rio de Janeiro, ~360km em linha reta.
    d = haversine_km(-23.55, -46.63, -22.91, -43.17)
    assert 350 < d < 370


def test_celula_agrupa_pontos_proximos():
    assert celula(-23.5501, -46.6301) == celula(-23.5502, -46.6302)


def test_celula_separa_pontos_distantes():
    assert celula(-23.55, -46.63) != celula(-22.91, -43.17)


def test_raio_aproximado_e_maior_que_linha_reta():
    """A aproximação nunca finge que a rota é mais curta que o voo do
    pássaro — isso seria fisicamente incoerente para deslocamento real."""
    assert raio_aproximado_km(5.0) > 5.0


# ── simulação de ponto ────────────────────────────────────────────────────
def test_ponto_no_meio_da_area_densa_pontua_alto(escopo_irrestrito):
    r = geo.simular_ponto(-23.552, -46.628, raio_km=2.0)
    assert r["disponivel"]
    assert r["score_atratividade"] > 50


def test_ponto_isolado_pontua_baixo(escopo_irrestrito):
    r = geo.simular_ponto(-10.0, -60.0, raio_km=2.0)  # Amazônia, longe de tudo
    assert r["disponivel"]
    assert r["score_atratividade"] < 10


def test_mais_perto_pontua_igual_ou_maior_que_mais_longe(escopo_irrestrito):
    """Prova o decaimento de distância: mesmo raio, ponto mais central entre
    os clientes densos deve pontuar >= um ponto na borda do cluster."""
    central = geo.simular_ponto(-23.552, -46.628, raio_km=3.0)["score_atratividade"]
    borda = geo.simular_ponto(-23.560, -46.640, raio_km=3.0)["score_atratividade"]
    assert central >= borda


def test_componentes_sem_dado_aparecem_como_null_nao_zero(escopo_irrestrito):
    """Fixture desta suíte não tem município/UF nos clientes — o componente
    de IBGE precisa aparecer como indisponível, não como zero disfarçado."""
    r = geo.simular_ponto(-23.552, -46.628, raio_km=2.0)
    assert "pressao_competitiva" in r["componentes_nao_disponiveis"]
    assert "sociodemografico" in r["componentes_nao_disponiveis"]
    assert not any(f["fator"] in ("pressao_competitiva", "sociodemografico")
                   for f in r["fatores"])


def test_camada_ibge_entra_no_score_quando_disponivel(escopo_irrestrito, monkeypatch):
    """Município resolvido + IBGE respondendo: o componente sociodemográfico
    vira FATOR de verdade e passa a compor o score (peso realocado de
    0,6/0,4 para 0,45/0,35/0,20 — ver geo.py)."""
    from vendalytics.modules import geo as geo_mod
    monkeypatch.setattr(geo_mod.ibge_real, "camada_para_ponto",
                        lambda municipio, uf: {"disponivel": True, "populacao": 1_800_000,
                                               "populacao_ano_referencia": 2024, "fonte": "IBGE (mock)"})
    r = geo.simular_ponto(-23.552, -46.628, raio_km=2.0)
    assert r["disponivel"]
    assert any(f["fator"] == "sociodemografico_ibge" for f in r["fatores"])
    assert "sociodemografico" not in r["componentes_nao_disponiveis"]


def test_resposta_nunca_chama_o_raio_de_isocrona(escopo_irrestrito):
    """Rotular a aproximação como isócrona real destrói a credibilidade no
    primeiro usuário que confere no mapa — a resposta precisa deixar claro
    que não é."""
    r = geo.simular_ponto(-23.552, -46.628, raio_km=2.0)
    assert "isocrona" not in r["aviso_isocrona"].lower() or "não é isócrona" in r["aviso_isocrona"]


def test_sem_cliente_geolocalizado_no_escopo_e_honesto(escopo_irrestrito):
    r = geo.simular_ponto(0.0, 0.0, filial="FILIAL-INEXISTENTE", raio_km=1.0)
    assert r["disponivel"] is False and "motivo" in r


# ── similaridade entre filiais ─────────────────────────────────────────────
def test_similaridade_compara_filiais_existentes(escopo_irrestrito):
    r = geo.similaridade_entre_filiais()
    assert r["disponivel"]
    assert set(r["filiais_avaliadas"]) == {"DENSA", "ESPARSA"}
    assert len(r["pares"]) == 1
    assert 0.0 <= r["pares"][0]["similaridade"] <= 1.0


def test_similaridade_indisponivel_com_uma_filial_so(escopo_filial_a):
    r = geo.similaridade_entre_filiais()
    assert r["disponivel"] is False


# ── previsão de faturamento ────────────────────────────────────────────────
def test_previsao_nunca_e_ponto_unico(escopo_irrestrito):
    r = geo.prever_faturamento("DENSA")
    assert r["disponivel"]
    ic = r["intervalo_confianca_80pct"]
    assert ic[0] < r["faturamento_esperado"] < ic[1]
    assert r["mape_backtest_pct"] is not None


def test_previsao_indisponivel_sem_historico_suficiente(escopo_irrestrito):
    r = geo.prever_faturamento("ESPARSA")
    assert r["disponivel"] is False and "motivo" in r


def test_previsao_de_filial_inexistente(escopo_irrestrito):
    r = geo.prever_faturamento("NAO-EXISTE")
    assert r["disponivel"] is False


# ── HTTP ──────────────────────────────────────────────────────────────────
def test_http_geo_endpoints_exigem_auth(cliente_http):
    assert cliente_http.get("/api/geo/simular?lat=0&lon=0").status_code == 401
    assert cliente_http.get("/api/geo/similaridade-filiais").status_code == 401
    assert cliente_http.get("/api/geo/faturamento-previsto?filial=X").status_code == 401


def test_http_geo_simular_responde(cliente_http, token_admin):
    h = {"Authorization": f"Bearer {token_admin}"}
    r = cliente_http.get("/api/geo/simular?lat=-23.552&lon=-46.628&raio_km=2", headers=h)
    assert r.status_code == 200
    assert "score_atratividade" in r.json()
