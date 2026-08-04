"""
test_propensao.py — modelo de propensão, explicabilidade e loop fechado.

A base do `conftest` é mínima demais para treinar (2 clientes). Aqui se gera
uma carteira sintética COM SINAL CONHECIDO: clientes regulares que compram a
cada ~10 dias e clientes que pararam. Se o modelo não separa esses dois
grupos, ele não separa nada — e o teste falha por um motivo interpretável,
em vez de por um limiar de AUC arbitrário.
"""
from __future__ import annotations

import random
import sqlite3
from datetime import date, timedelta

import pytest

from vendalytics import config, data_layer
from vendalytics.infra import context, db, scores as repo
from vendalytics.modules import fila, propensao


@pytest.fixture(scope="module", autouse=True)
def carteira_com_sinal():
    """120 clientes: 60 recorrentes (compram até hoje), 60 que sumiram há
    ~5 meses. O label 'recomprou nos próximos 30 dias' é fortemente
    previsível a partir da recência/atraso — e é isso que se checa."""
    from conftest import base_isolada
    from vendalytics.adapters.sqlite_reference import SCHEMA

    rnd = random.Random(7)
    hoje = date.today()
    linhas_cli, linhas_venda = [], []
    for i in range(120):
        cid = f"P-{i:03d}"
        recorrente = i < 60
        linhas_cli.append((cid, f"Cliente {i}", "SP", "ativo", -23.5, -46.6))
        # Recorrente compra do início até hoje; o que sumiu para há ~150 dias.
        ultimo_dia = 0 if recorrente else 150
        dia = 400
        while dia >= ultimo_dia:
            linhas_venda.append((cid, "V-A", "SP",
                                 (hoje - timedelta(days=dia)).isoformat(),
                                 round(rnd.uniform(300, 3000), 2)))
            dia -= rnd.randint(8, 13)

    with base_isolada("propensao") as caminho:
        con = sqlite3.connect(str(caminho))
        con.executescript(SCHEMA)
        con.executemany(
            "INSERT OR REPLACE INTO clientes (id,nome,filial,status,lat,lon) VALUES (?,?,?,?,?,?)",
            linhas_cli)
        con.executemany(
            "INSERT INTO vendas (cliente_id,vendedor_id,filial,data_venda,valor_total) "
            "VALUES (?,?,?,?,?)", linhas_venda)
        con.commit()
        con.close()
        db.migrar()
        fila.invalidar_cache()
        yield
    fila.invalidar_cache()


# ── correção temporal ─────────────────────────────────────────────────────
def test_features_nao_enxergam_o_futuro():
    """A garantia que sustenta a validação out-of-time: se as features
    vissem compras posteriores à referência, a AUC seria alta e mentirosa."""
    hoje = date.today()
    compras = [(hoje - timedelta(days=60), 100.0), (hoje - timedelta(days=1), 999.0)]
    f = propensao._features_do_cliente(compras, hoje - timedelta(days=30))
    assert f["recencia_dias"] == 30           # ignorou a compra de ontem
    assert f["ticket_medio"] == 100.0         # e o valor dela


def test_cliente_sem_historico_nao_gera_features():
    assert propensao._features_do_cliente([], date.today()) is None


# ── qualidade do modelo ───────────────────────────────────────────────────
def test_modelo_treina_e_separa_os_grupos(escopo_irrestrito):
    modelo = propensao.treinar()
    assert modelo is not None, "não treinou com 400 dias de histórico"
    auc = modelo.metricas["auc_out_of_time"]
    assert auc is not None and auc > 0.75, f"AUC out-of-time fraca demais: {auc}"
    assert modelo.metricas["ece"] is not None


def test_probabilidade_fica_no_intervalo_valido(escopo_irrestrito):
    modelo = propensao.treinar()
    for p in propensao.pontuar(modelo):
        assert 0.0 <= p["probabilidade"] <= 1.0


def test_recorrente_pontua_acima_de_quem_sumiu(escopo_irrestrito):
    """O teste de sanidade que importa mais que a AUC: a ordem faz sentido
    de negócio para um humano que conhece a carteira."""
    modelo = propensao.treinar()
    por_id = {p["cliente_id"]: p["score"] for p in propensao.pontuar(modelo)}
    recorrentes = [por_id[f"P-{i:03d}"] for i in range(60) if f"P-{i:03d}" in por_id]
    sumidos = [por_id[f"P-{i:03d}"] for i in range(60, 120) if f"P-{i:03d}" in por_id]
    assert sum(recorrentes) / len(recorrentes) > sum(sumidos) / len(sumidos)


def test_sem_historico_suficiente_nao_inventa_modelo(escopo_irrestrito):
    """Horizonte gigante = janela de histórico insuficiente para split
    temporal honesto. Devolver None é a resposta certa; um score aqui seria
    um número sem lastro."""
    assert propensao.treinar(horizonte=500) is None


# ── explicabilidade (spec D-2) ────────────────────────────────────────────
def test_todo_score_vem_com_fatores(escopo_irrestrito):
    modelo = propensao.treinar()
    for p in propensao.pontuar(modelo):
        assert p["fatores"], f"score sem explicação: {p['cliente_id']}"
        for f in p["fatores"]:
            assert f["rotulo"] and not f["rotulo"].startswith("_")


def test_fatores_vem_em_linguagem_de_negocio(escopo_irrestrito):
    modelo = propensao.treinar()
    rotulos = {f["rotulo"] for p in propensao.pontuar(modelo) for f in p["fatores"]}
    # Nenhum rótulo pode ser o nome cru da variável.
    assert not (rotulos & set(propensao.ORDEM_FEATURES))


def test_contribuicoes_reconstroem_o_log_odds(escopo_irrestrito):
    """Prova de que a decomposição é exata, não uma aproximação: a soma das
    contribuições + intercepto reproduz o log-odds do modelo. É o que
    permite afirmar 'estes fatores geraram este score', sem ressalva."""
    import math
    modelo = propensao.treinar()
    x = [1.0, 2.0, 3.0, 1500.0, 1.1, 12.0, 20.0]
    soma = modelo.intercepto + sum(c for _, c in modelo.contribuicoes(x))
    assert math.isclose(1 / (1 + math.exp(-soma)), modelo.probabilidade(x), rel_tol=1e-9)


def test_score_sem_fator_nao_pode_ser_gravado(escopo_irrestrito):
    with pytest.raises(repo.ScoreSemExplicacao):
        repo.registrar(sujeito_tipo="cliente", sujeito_id="P-000",
                       tipo="propensao_recompra", valor=80.0, probabilidade=0.8,
                       fatores=[], modelo_versao="teste")


# ── fila priorizada ───────────────────────────────────────────────────────
def test_fila_ordena_por_valor_esperado_nao_por_score(escopo_irrestrito):
    r = fila.diaria(limite=20, persistir=False)
    assert r["disponivel"]
    valores = [i["valor_esperado"] for i in r["itens"]]
    assert valores == sorted(valores, reverse=True)
    # E não coincide com a ordem por score bruto, senão a priorização por
    # valor esperado não estaria fazendo diferença nenhuma.
    assert [i["score"] for i in r["itens"]] != sorted(
        (i["score"] for i in r["itens"]), reverse=True)


def test_fila_e_finita(escopo_irrestrito):
    assert len(fila.diaria(limite=12, persistir=False)["itens"]) == 12


def test_fila_marca_confiabilidade_do_modelo(escopo_irrestrito):
    """Com dado que tem padrão de recompra, a fila sai confiável e sem aviso.
    O caminho inverso (AUC abaixo do piso → `confiavel=false` + aviso) é o que
    aparece sobre uma carteira sem padrão — e é ele que impede a fila de se
    apresentar como priorização quando é ruído ordenado."""
    r = fila.diaria(limite=5, persistir=False)
    assert r["confiavel"] is True
    assert r["aviso"] is None
    assert r["modelo"]["auc_out_of_time"] >= fila.AUC_MINIMA_CONFIAVEL


def test_fila_avisa_quando_modelo_nao_discrimina(escopo_irrestrito, monkeypatch):
    monkeypatch.setattr(fila, "AUC_MINIMA_CONFIAVEL", 1.01)  # força o piso acima do possível
    r = fila.diaria(limite=3, persistir=False)
    assert r["confiavel"] is False
    assert r["aviso"] and "AUC" in r["aviso"]
    assert r["itens"], "a fila continua sendo entregue, apenas marcada"


def test_fila_expoe_a_qualidade_do_modelo(escopo_irrestrito):
    m = fila.diaria(limite=5, persistir=False)["modelo"]
    for chave in ("auc_out_of_time", "ece", "lift_top_decil", "amostras_treino"):
        assert chave in m


def test_fila_respeita_o_escopo(escopo_filial_a):
    """Escopo restrito a SP: a carteira sintética inteira é SP, então a fila
    existe; o que se checa é que o caminho passa pelo escopo sem estourar."""
    assert fila.diaria(limite=3, persistir=False)["disponivel"]


# ── loop fechado (spec §5 passo 7, §7.4) ──────────────────────────────────
def test_desfecho_grava_sinal_e_score_id(escopo_irrestrito):
    fila.diaria(limite=3)                      # persiste scores
    r = fila.registrar_desfecho("P-000", "ganhou", motivo="pedido fechado", valor=1200.0)
    assert r["desfecho"] == "ganhou"
    registrados = repo.desfechos_registrados()
    alvo = [d for d in registrados if d["sujeito_id"] == "P-000"][0]
    assert alvo["score_id"] is not None, "desfecho desconectado do score que o gerou"
    assert alvo["usuario"] == "admin@teste"


def test_desfecho_invalido_e_recusado(escopo_irrestrito):
    with pytest.raises(ValueError):
        fila.registrar_desfecho("P-000", "talvez")


def test_score_e_append_only(escopo_irrestrito):
    fila.diaria(limite=1)
    with db.conexao() as con:
        with pytest.raises(sqlite3.IntegrityError):
            con.execute("UPDATE scores SET valor = 1")


def test_saude_do_loop_reporta_cobertura(escopo_irrestrito):
    fila.diaria(limite=5)
    fila.registrar_desfecho("P-001", "ignorada", motivo="cliente em férias")
    s = fila.saude_do_loop()
    assert s["sujeitos_pontuados"] > 0
    assert s["cobertura_pct"] is not None
    assert "ignorada" in s["por_desfecho"]


def test_explicacao_traz_fatores_e_historico(escopo_irrestrito):
    fila.diaria(limite=5)
    e = fila.explicacao("P-000")
    assert e["score"] is not None
    assert e["fatores"] and e["historico"]


def test_explicacao_de_cliente_nao_pontuado(escopo_irrestrito):
    e = fila.explicacao("NAO-EXISTE")
    assert e["score"] is None and "motivo" in e


def test_cliente_fora_da_fila_tambem_tem_score(escopo_irrestrito):
    """Só os N da fila são persistidos por `diaria()`; abrir qualquer outro
    cliente precisa pontuar sob demanda, senão a maior parte da carteira
    apareceria como 'sem opinião' para o usuário."""
    da_fila = {i["cliente_id"] for i in fila.diaria(limite=3)["itens"]}
    fora = next(f"P-{i:03d}" for i in range(120) if f"P-{i:03d}" not in da_fila)
    assert fila.explicacao(fora)["score"] is not None


# ── caminho HTTP que a tela usa ───────────────────────────────────────────
def test_http_fila_diaria_traz_itens_fatores_e_modelo(cliente_http, token_admin):
    h = {"Authorization": f"Bearer {token_admin}"}
    r = cliente_http.get("/api/fila/diaria?limite=6", headers=h)
    assert r.status_code == 200
    corpo = r.json()
    assert corpo["disponivel"] and len(corpo["itens"]) == 6
    for item in corpo["itens"]:
        assert item["fatores"], "item de fila sem explicação"
        assert item["valor_esperado"] >= 0
    assert corpo["modelo"]["auc_out_of_time"] is not None


def test_http_desfecho_fecha_o_loop(cliente_http, token_admin):
    h = {"Authorization": f"Bearer {token_admin}"}
    alvo = cliente_http.get("/api/fila/diaria?limite=1", headers=h).json()["itens"][0]
    r = cliente_http.post(f"/api/fila/desfecho/{alvo['cliente_id']}",
                          headers=h, json={"desfecho": "ganhou", "motivo": "pedido"})
    assert r.status_code == 200
    saude = cliente_http.get("/api/fila/saude-do-loop", headers=h).json()
    assert saude["cobertura_pct"] is not None


def test_http_desfecho_invalido_e_400(cliente_http, token_admin):
    r = cliente_http.post("/api/fila/desfecho/P-000",
                          headers={"Authorization": f"Bearer {token_admin}"},
                          json={"desfecho": "sei-la"})
    assert r.status_code == 400


def test_http_fila_exige_autenticacao(cliente_http):
    assert cliente_http.get("/api/fila/diaria").status_code == 401
    assert cliente_http.post("/api/fila/desfecho/P-000",
                             json={"desfecho": "ganhou"}).status_code == 401
