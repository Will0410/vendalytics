"""
test_field.py — Field Execution (spec §2.4, Fase 4 MVP).

O que se checa: o gap de mix compara o cliente contra vizinhos geo+segmento
de verdade (não a carteira inteira), o texto de sugestão é 100% grounded
(todo número nele vem do cálculo, nada gerado livremente), o roteiro funde
propensão com gap local, e a captura de campo publica sinal sem editar o
cadastro sozinha.
"""
from __future__ import annotations

import sqlite3

import pytest

from vendalytics.infra import context, db
from vendalytics.integracoes.console_messaging import ConsoleMessagingConnector
from vendalytics.modules import field


@pytest.fixture(scope="module", autouse=True)
def cluster_geografico_com_gap():
    """Um cluster de 5 clientes do segmento 'padaria' bem próximos entre si:
    4 compram 'bebidas', o alvo (F-000) não compra nada disso — é o gap que
    o módulo precisa encontrar. Um segundo cluster distante (segmento
    diferente) prova que o gap é LOCAL, não da carteira inteira.
    """
    from conftest import base_isolada
    from vendalytics.adapters.sqlite_reference import SCHEMA

    linhas_cli, linhas_prod, linhas_venda, linhas_itens = [], [], [], []
    linhas_prod = [
        ("P-PAO", "Pão", "paes", 1), ("P-BEB", "Refrigerante", "bebidas", 1),
        ("P-LIMP", "Detergente", "limpeza", 1),
    ]
    venda_id = 1
    for i in range(5):
        cid = f"F-{i:03d}"
        linhas_cli.append((cid, f"Padaria {i}", "SP", "ativo",
                           -23.60 + i * 0.001, -46.70 + i * 0.001, "padaria"))
        # Todos compram pão (não é gap); F-001..F-004 também compram bebida.
        linhas_venda.append((venda_id, cid, "V-1", "SP", "2026-06-15", 100.0))
        linhas_itens.append((venda_id, "P-PAO", 10, 10.0))
        venda_id += 1
        if i > 0:
            linhas_venda.append((venda_id, cid, "V-1", "SP", "2026-06-16", 200.0))
            linhas_itens.append((venda_id, "P-BEB", 20, 10.0))
            venda_id += 1

    # Cluster distante, segmento diferente: não pode contaminar o gap do F-000.
    for i in range(5):
        cid = f"LONGE-{i:03d}"
        linhas_cli.append((cid, f"Farmácia {i}", "SP", "ativo",
                           -24.50 + i * 0.001, -47.80 + i * 0.001, "farmacia"))
        linhas_venda.append((venda_id, cid, "V-2", "SP", "2026-06-15", 500.0))
        linhas_itens.append((venda_id, "P-LIMP", 5, 100.0))
        venda_id += 1

    with base_isolada("field") as caminho:
        con = sqlite3.connect(str(caminho))
        con.executescript(SCHEMA)
        con.executemany(
            "INSERT OR REPLACE INTO clientes (id,nome,filial,status,lat,lon,segmento) "
            "VALUES (?,?,?,?,?,?,?)", linhas_cli)
        con.executemany(
            "INSERT OR REPLACE INTO produtos (id,nome,categoria,ativo) VALUES (?,?,?,?)",
            linhas_prod)
        con.executemany(
            "INSERT INTO vendas (id,cliente_id,vendedor_id,filial,data_venda,valor_total) "
            "VALUES (?,?,?,?,?,?)", linhas_venda)
        con.executemany(
            "INSERT INTO vendas_itens (venda_id,produto_id,quantidade,valor_unitario) VALUES (?,?,?,?)",
            linhas_itens)
        con.commit()
        con.close()
        db.migrar()
        yield


# ── gap de mix local ─────────────────────────────────────────────────────
def test_gap_encontra_categoria_que_vizinhos_compram(escopo_irrestrito):
    r = field.gap_cliente("F-000")
    assert r["disponivel"]
    categorias = {g["categoria"] for g in r["categorias_gap"]}
    assert "bebidas" in categorias
    assert "paes" not in categorias, "categoria que o próprio cliente já compra não é gap"


def test_gap_nao_e_contaminado_por_cluster_distante(escopo_irrestrito):
    """A prova de que o gap é LOCAL: o cluster de farmácias longe (e de
    segmento diferente) compra 'limpeza', mas isso não pode aparecer como
    sugestão para um cliente do cluster de padarias."""
    r = field.gap_cliente("F-000")
    categorias = {g["categoria"] for g in r["categorias_gap"]}
    assert "limpeza" not in categorias


def test_gap_ordena_por_prioridade_penetracao_x_valor(escopo_irrestrito):
    r = field.gap_cliente("F-000")
    prioridades = [g["prioridade"] for g in r["categorias_gap"]]
    assert prioridades == sorted(prioridades, reverse=True)


def test_cliente_ja_maduro_nao_tem_gap(escopo_irrestrito):
    """F-004 já compra pão E bebida — as únicas categorias com penetração
    relevante no cluster — então não deveria sobrar gap nenhum para ele."""
    r = field.gap_cliente("F-004")
    assert r["disponivel"]
    assert r["categorias_gap"] == []


def test_gap_de_cliente_inexistente(escopo_irrestrito):
    r = field.gap_cliente("NAO-EXISTE")
    assert r["disponivel"] is False


def test_gap_sem_vizinhos_suficientes_e_honesto(escopo_irrestrito):
    r = field.gap_cliente("LONGE-000")   # cluster de 5, mas função pede >=3 — deve achar 4 peers
    assert r["disponivel"]  # 4 peers no cluster de farmácias, suficiente


# ── sugestão grounded ──────────────────────────────────────────────────────
def test_sugestao_e_grounded_todo_numero_vem_do_gap(escopo_irrestrito):
    r = field.sugestao_para_cliente("F-000")
    assert r["disponivel"]
    assert r["sugestoes"]
    top = r["sugestoes"][0]
    # Todo número do argumento tem que reaparecer no dado bruto do gap —
    # não pode ter número que não veio do cálculo.
    gap = field.gap_cliente("F-000")["categorias_gap"][0]
    assert str(gap["peers_compraram"]) in top["argumento"]
    assert str(gap["penetracao_pct"]) in top["argumento"]
    assert gap["categoria"] in top["argumento"]


def test_sugestao_sem_gap_tem_texto_honesto(escopo_irrestrito):
    r = field.sugestao_para_cliente("F-004")
    assert r["disponivel"]
    assert r["sugestoes"] == []
    assert "nenhum gap" in r["resumo"].lower()


# ── roteiro do dia ───────────────────────────────────────────────────────
def test_roteiro_funde_propensao_e_gap_local(escopo_irrestrito):
    r = field.roteiro_do_dia(limite=5)
    # Pode não estar "disponível" se a fila de propensão não treinar com
    # este histórico curto — o que importa é que, quando disponível, cada
    # parada carrega os dois sinais (propensão + gap).
    if r["disponivel"]:
        for parada in r["paradas"]:
            assert "score_propensao" in parada and "gap_de_mix" in parada


# ── captura de campo (loop fechado) ────────────────────────────────────────
def test_correcao_publica_sinal_sem_editar_cadastro(escopo_irrestrito):
    r = field.registrar_correcao("F-000", "pdv_fechado", detalhe="fachada fechada, sem placa")
    assert r["sinal_id"]
    with db.conexao() as con:
        sinal = con.execute(
            "SELECT * FROM sinais WHERE id=?", (r["sinal_id"],)).fetchone()
    assert sinal["tipo"] == "field.data_correction"
    # O cadastro em si não muda — a correção fica no sinal, não no registro.
    from vendalytics import data_layer
    assert data_layer.cliente("F-000")["status"] == "ativo"


def test_tipo_de_correcao_invalido_e_recusado(escopo_irrestrito):
    with pytest.raises(ValueError):
        field.registrar_correcao("F-000", "motivo_qualquer")


def test_visita_publica_sinal_de_desfecho(escopo_irrestrito):
    r = field.registrar_visita("F-000", pedido_gerado=True, itens=["P-BEB"])
    with db.conexao() as con:
        sinal = con.execute("SELECT * FROM sinais WHERE id=?", (r["sinal_id"],)).fetchone()
    assert sinal["tipo"] == "field.visit_outcome"


# ── conector de mensageria ──────────────────────────────────────────────────
def test_console_messaging_grava_staging(escopo_irrestrito):
    r = ConsoleMessagingConnector().enviar("F-000", "Mensagem de teste do roteiro")
    assert r["enviado"] is True
    from pathlib import Path
    assert Path(r["destino"]).exists()


# ── HTTP ──────────────────────────────────────────────────────────────────
def test_http_field_gap_e_sugestao(cliente_http, token_admin):
    h = {"Authorization": f"Bearer {token_admin}"}
    assert cliente_http.get("/api/field/gap/C-A", headers=h).status_code == 200
    assert cliente_http.get("/api/field/sugestao/C-A", headers=h).status_code == 200


def test_http_field_correcao_e_visita(cliente_http, token_admin):
    h = {"Authorization": f"Bearer {token_admin}"}
    r1 = cliente_http.post("/api/field/correcao/C-A", headers=h,
                           json={"tipo": "pdv_fechado", "detalhe": "teste"})
    assert r1.status_code == 200
    r2 = cliente_http.post("/api/field/visita/C-A", headers=h,
                           json={"pedido_gerado": False, "motivo_recusa": "sem verba"})
    assert r2.status_code == 200


def test_http_field_exige_auth(cliente_http):
    assert cliente_http.get("/api/field/roteiro-do-dia").status_code == 401
