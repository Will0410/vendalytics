"""
test_comunicacao_kpi.py — correlação real entre KPI de comunicação e
resultado de negócio (spec §2.3 C3).

O que se checa: a correlação de Pearson bate com o esperado em séries
sintéticas conhecidas (positiva forte, negativa forte, sem relação),
amostra curta sai marcada como não confiável (nunca escondida), e dia sem
sobreposição de dado nos dois lados não entra no cálculo.
"""
from __future__ import annotations

import sqlite3

import pytest

from vendalytics.infra import db
from vendalytics.modules import comunicacao_kpi


def test_pearson_correlacao_positiva_perfeita():
    assert comunicacao_kpi.pearson([1, 2, 3, 4], [10, 20, 30, 40]) == pytest.approx(1.0)


def test_pearson_correlacao_negativa_perfeita():
    assert comunicacao_kpi.pearson([1, 2, 3, 4], [40, 30, 20, 10]) == pytest.approx(-1.0)


def test_pearson_serie_constante_e_indefinida():
    """Desvio-padrão zero: correlação não é 0 (que afirmaria 'sem relação'),
    é indefinida — a função precisa dizer isso, não inventar um número."""
    assert comunicacao_kpi.pearson([5, 5, 5, 5], [1, 2, 3, 4]) is None


def test_pearson_amostra_curta_demais():
    assert comunicacao_kpi.pearson([1], [2]) is None


@pytest.fixture
def base_correlacao():
    from conftest import base_isolada, db_operacional_isolado
    from vendalytics.adapters.sqlite_reference import SCHEMA
    from vendalytics.infra import context

    with db_operacional_isolado("comunicacao_kpi"), base_isolada("comunicacao_kpi") as caminho:
        con = sqlite3.connect(str(caminho))
        con.executescript(SCHEMA)
        con.commit()
        con.close()
        db.migrar()
        with context.ativar(context.escopo_de_sistema("teste", motivo="fixture")):
            yield


def _inserir_mencao(dia: str, sentimento: float):
    """Texto ÚNICO por dia, de propósito: reusar o mesmo texto em dias
    diferentes aciona corretamente o dedup de replicação de
    `reputacao.importar()` (é matéria repetida de verdade, e o produto
    precisa mesmo colapsar isso) — o que invalidaria este teste, que quer
    simular N eventos DISTINTOS ao longo do tempo, não a mesma nota."""
    from vendalytics.integracoes.csv_mention_connector import CSVMentionSource
    from vendalytics.modules import reputacao
    import tempfile
    from pathlib import Path
    tmp = Path(tempfile.mkdtemp()) / f"m-{dia}-{sentimento}.csv"
    # O marcador do dia precisa aparecer INTERCALADO, não só no fim: com
    # shingle de 5 tokens, dois textos que só diferem no último token ainda
    # compartilham 3 dos 4 shingles (jaccard 0,6) e o dedup os funde por
    # engano — não é bug do dedup, é falha de variedade deste texto de
    # teste. Intercalar garante que toda janela de 5 tokens toque o
    # marcador, então dias diferentes nunca colidem.
    marcador = dia.replace("-", "")
    texto = (f"Excelente {marcador}a atendimento {marcador}b maravilhoso {marcador}c "
            f"otimo {marcador}d recomendo {marcador}e demais" if sentimento > 0
            else f"Pessimo {marcador}a horrivel {marcador}b problema {marcador}c "
            f"atraso {marcador}d reclamacao {marcador}e grave" if sentimento < 0
            else f"Nota {marcador}a informativa {marcador}b sem {marcador}c opiniao {marcador}d nenhuma")
    tmp.write_text(f"canal,veiculo,url,publicado_em,texto,alcance\n"
                   f"social,X,,{dia},{texto},100\n", encoding="utf-8")
    reputacao.importar(CSVMentionSource(tmp))


def _inserir_venda(con, cliente_id, dia, valor):
    con.execute(
        "INSERT INTO vendas (cliente_id,vendedor_id,filial,data_venda,valor_total) VALUES (?,?,?,?,?)",
        (cliente_id, "V-1", "SP", dia, valor))


def test_sem_sobreposicao_e_honesto(base_correlacao):
    r = comunicacao_kpi.correlacionar_sentimento_com_faturamento(dias=30)
    assert r["disponivel"] is False


def test_poucos_dias_sobrepostos_marca_nao_confiavel(base_correlacao):
    import sqlite3 as s
    from vendalytics import config

    con = s.connect(str(config.SQLITE_PATH))
    con.execute("INSERT OR REPLACE INTO clientes (id,nome,filial,status) VALUES ('K1','K','SP','ativo')")
    for i, (dia_off, sent) in enumerate([(1, 1), (2, -1), (3, 1)]):
        dia = f"2026-06-0{dia_off}"
        _inserir_mencao(dia, sent)
        _inserir_venda(con, "K1", dia, 1000.0 * (2 if sent > 0 else 1))
    con.commit(); con.close()

    r = comunicacao_kpi.correlacionar_sentimento_com_faturamento(dias=365)
    assert r["disponivel"] is True
    assert r["confiavel"] is False
    assert r["dias_com_dado_nos_dois_lados"] == 3
    assert "amostra curta" in r["aviso"].lower() or "curta" in r["aviso"].lower()


def test_correlacao_positiva_forte_e_detectada(base_correlacao):
    import sqlite3 as s
    from vendalytics import config

    con = s.connect(str(config.SQLITE_PATH))
    con.execute("INSERT OR REPLACE INTO clientes (id,nome,filial,status) VALUES ('K2','K','SP','ativo')")
    dias_bons = [f"2026-0{m}-{d:02d}" for m in (1, 2) for d in range(1, 11)]  # 20 dias
    for i, dia in enumerate(dias_bons):
        sent = 1 if i % 2 == 0 else -1
        valor = 5000.0 if sent > 0 else 500.0
        _inserir_mencao(dia, sent)
        _inserir_venda(con, "K2", dia, valor)
    con.commit(); con.close()

    r = comunicacao_kpi.correlacionar_sentimento_com_faturamento(dias=365)
    assert r["disponivel"] and r["confiavel"]
    assert r["correlacao"] > 0.5
    assert "positiva" in r["leitura"]
    assert "não é causalidade" in r["leitura"]


# ── HTTP ──────────────────────────────────────────────────────────────────
def test_http_correlacao_negocio(cliente_http, token_admin):
    r = cliente_http.get("/api/reputacao/correlacao-negocio",
                         headers={"Authorization": f"Bearer {token_admin}"})
    assert r.status_code == 200
    assert "disponivel" in r.json()
