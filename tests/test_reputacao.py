"""
test_reputacao.py — Reputation Intelligence (spec §2.3, Fase 3 MVP).

O que se checa: sentimento reage à polaridade e à negação, replicação de
matéria vira um evento só, alerta de anomalia não dispara sem baseline nem
por flutuação normal, e menção casada com conta publica sinal no barramento
(a prova do diferencial D-1).

Isolamento por TESTE, não por módulo: os testes de anomalia e de resumo
operam sobre datas absolutas ("hoje", "hoje − N dias") que se sobrepõem
entre si — um banco compartilhado entre testes faria a contagem de um
contaminar o baseline do outro. `_base()` dá a cada teste que escreve menção
um SQLite próprio.
"""
from __future__ import annotations

import csv
import sqlite3
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path

import pytest

from vendalytics.infra import context, db
from vendalytics.integracoes.csv_mention_connector import CSVMentionSource
from vendalytics.modules import reputacao


def _escrever_csv(tmp_path: Path, linhas: list[dict], nome: str = "mencoes.csv") -> Path:
    caminho = tmp_path / nome
    campos = ["canal", "veiculo", "url", "publicado_em", "texto", "alcance"]
    with open(caminho, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=campos)
        w.writeheader()
        for linha in linhas:
            w.writerow({c: linha.get(c, "") for c in campos})
    return caminho


@contextmanager
def _base(nome: str, clientes: list[tuple] | None = None):
    """Banco comercial E operacional isolados, únicos por teste. Reputação
    escreve em `mencoes`/`alertas_reputacao`/`sinais` (operacional) e lê
    `clientes` (comercial) para casar conta — os dois precisam de isolamento,
    senão a agregação por dia/veículo soma o resto da sessão de teste junto.
    """
    from conftest import base_isolada, db_operacional_isolado
    from vendalytics.adapters.sqlite_reference import SCHEMA

    with db_operacional_isolado(nome), base_isolada(nome) as caminho:
        con = sqlite3.connect(str(caminho))
        con.executescript(SCHEMA)
        if clientes:
            con.executemany(
                "INSERT OR REPLACE INTO clientes (id,nome,filial,status) VALUES (?,?,?,?)",
                clientes)
        con.commit()
        con.close()
        db.migrar()
        yield caminho


# ── sentimento ────────────────────────────────────────────────────────────
def test_sentimento_positivo_e_negativo():
    assert reputacao._sentimento("Atendimento excelente, super recomendo") > 0
    assert reputacao._sentimento("Péssimo atendimento, um problema atrás do outro") < 0


def test_sentimento_neutro_sem_palavras_do_lexico():
    assert reputacao._sentimento("A entrega está prevista para terça-feira") == 0.0


def test_negacao_inverte_polaridade():
    """'não foi bom' precisa pontuar negativo, não positivo — é o caso mais
    comum de erro de um léxico ingênuo sem negação."""
    assert reputacao._sentimento("O serviço não foi bom") < 0


# ── dedup de replicação ────────────────────────────────────────────────────
def test_materia_replicada_vira_um_cluster_so(tmp_path, escopo_irrestrito):
    texto = ("A empresa anunciou hoje expansão para três novas cidades "
             "com investimento de dez milhões de reais no próximo semestre")
    with _base("rep_dedup"):
        caminho = _escrever_csv(tmp_path, [
            {"canal": "imprensa", "veiculo": "Portal A", "publicado_em": "2026-06-01", "texto": texto},
            {"canal": "imprensa", "veiculo": "Portal B", "publicado_em": "2026-06-01", "texto": texto},
            {"canal": "imprensa", "veiculo": "Portal C", "publicado_em": "2026-06-01",
             "texto": "Notícia completamente diferente sobre outro assunto qualquer aqui hoje"},
        ])
        r = reputacao.importar(CSVMentionSource(caminho))
        assert r["importadas"] == 3
        assert r["duplicadas"] == 1     # só a réplica é contada como duplicata

        visiveis = reputacao.mencoes(dias=365)
        veiculos = {m["veiculo"] for m in visiveis}
        assert "Portal A" in veiculos
        assert "Portal C" in veiculos
        assert len(visiveis) == 2       # a réplica não aparece de novo na listagem


def test_importacoes_separadas_nao_colidem_cluster(tmp_path, escopo_irrestrito):
    """Regressão: o id de cluster já foi um contador derivado do tamanho de
    dicionários em memória, que colidia com cluster_id de uma importação
    ANTERIOR — fundindo duas menções sem relação nenhuma num cluster só, e
    fazendo o dedup descartar uma delas como se fosse duplicata da outra."""
    with _base("rep_sem_colisao"):
        reputacao.importar(CSVMentionSource(_escrever_csv(tmp_path, [
            {"canal": "imprensa", "veiculo": "V1", "publicado_em": "2026-06-01",
             "texto": "Primeira leva de notícias sobre um assunto qualquer aqui"},
            {"canal": "imprensa", "veiculo": "V2", "publicado_em": "2026-06-01",
             "texto": "Segunda notícia completamente distinta da primeira leva"},
        ], nome="leva1.csv")))
        reputacao.importar(CSVMentionSource(_escrever_csv(tmp_path, [
            {"canal": "imprensa", "veiculo": "V3", "publicado_em": "2026-06-02",
             "texto": "Terceira leva chegando agora com um assunto totalmente novo"},
            {"canal": "imprensa", "veiculo": "V4", "publicado_em": "2026-06-02",
             "texto": "Quarta notícia dessa segunda leva de importação separada"},
        ], nome="leva2.csv")))

        visiveis = reputacao.mencoes(dias=365)
        assert len(visiveis) == 4, "uma menção sumiu — sinal de colisão de cluster"
        assert len({m["cluster_id"] for m in visiveis}) == 4


def test_textos_distintos_nao_agrupam(tmp_path, escopo_irrestrito):
    with _base("rep_sem_dup"):
        caminho = _escrever_csv(tmp_path, [
            {"canal": "social", "veiculo": "X", "publicado_em": "2026-06-01",
             "texto": "Comprei ontem e adorei o produto chegou rapidinho"},
            {"canal": "social", "veiculo": "X", "publicado_em": "2026-06-01",
             "texto": "Reunião de diretoria discutiu metas do próximo trimestre fiscal"},
        ])
        r = reputacao.importar(CSVMentionSource(caminho))
        assert r["duplicadas"] == 0


# ── casamento com conta e sinal no barramento ──────────────────────────────
def test_mencao_casada_com_conta_emite_sinal(tmp_path, escopo_irrestrito):
    """A prova do diferencial D-1: menção sobre conta conhecida publica
    sinal, para o barramento reagir sem acoplamento direto.

    Nomes de cliente distintos de propósito: os clientes padrão do conftest
    ("Cliente da filial A"/"...B") diferem só por uma letra, que o filtro de
    ruído de `tokens_significativos` descarta — usá-los faria o teste
    passar por coincidência de ordenação alfabética, não por garantia real.
    """
    with _base("rep_match", clientes=[
            ("R-1", "Padaria do Sul LTDA", "SP", "ativo"),
            ("R-2", "Mercado Central LTDA", "SP", "ativo")]):
        caminho = _escrever_csv(tmp_path, [
            {"canal": "reclamacao", "veiculo": "Reclame Aqui", "publicado_em": "2026-06-01",
             "texto": "Cliente da Padaria do Sul registrou reclamação grave sobre atraso"},
        ])
        r = reputacao.importar(CSVMentionSource(caminho))
        assert r["casadas_com_conta"] == 1

        with db.conexao() as con:
            sinal = con.execute(
                "SELECT * FROM sinais WHERE tenant_id=? AND tipo='reputation.mention' "
                "ORDER BY id DESC LIMIT 1", (context.atual().tenant_id,)).fetchone()
        assert sinal is not None
        assert sinal["sujeito_id"] == "R-1"


def test_mencao_sem_conta_conhecida_nao_emite_sinal(tmp_path, escopo_irrestrito):
    with _base("rep_sem_match", clientes=[("R-1", "Padaria do Sul LTDA", "SP", "ativo")]):
        caminho = _escrever_csv(tmp_path, [
            {"canal": "social", "veiculo": "X", "publicado_em": "2026-06-01",
             "texto": "Comentário genérico sem nenhuma empresa citada no texto"},
        ])
        r = reputacao.importar(CSVMentionSource(caminho))
        assert r["casadas_com_conta"] == 0


# ── resumo e benchmarking ───────────────────────────────────────────────────
def test_resumo_sem_mencoes_e_honesto(escopo_irrestrito):
    with _base("rep_resumo_vazio"):
        r = reputacao.resumo_sentimento(dias=1)
        assert r["disponivel"] is False


def test_resumo_pondera_por_alcance(tmp_path, escopo_irrestrito):
    with _base("rep_resumo_alcance"):
        caminho = _escrever_csv(tmp_path, [
            {"canal": "imprensa", "veiculo": "V1", "publicado_em": date.today().isoformat(),
             "texto": "Excelente qualidade e ótimo atendimento recomendo muito", "alcance": "1000000"},
            {"canal": "social", "veiculo": "V2", "publicado_em": date.today().isoformat(),
             "texto": "Péssimo, horrível, um problema atrás do outro", "alcance": "10"},
        ])
        reputacao.importar(CSVMentionSource(caminho))
        r = reputacao.resumo_sentimento(dias=1)
        assert r["disponivel"]
        # Alcance milhões x dezenas: a média ponderada deve pender para o positivo.
        assert r["sentimento_medio_ponderado"] > 0


def test_benchmarking_share_of_voice(tmp_path, escopo_irrestrito):
    with _base("rep_benchmarking"):
        caminho = _escrever_csv(tmp_path, [
            {"canal": "imprensa", "veiculo": "BV1", "publicado_em": date.today().isoformat(),
             "texto": "Texto um sobre a empresa em questão hoje"},
            {"canal": "imprensa", "veiculo": "BV1", "publicado_em": date.today().isoformat(),
             "texto": "Outro texto totalmente diferente do anterior sobre outro tema"},
            {"canal": "imprensa", "veiculo": "BV2", "publicado_em": date.today().isoformat(),
             "texto": "Terceiro texto de veículo diferente falando de coisa nova"},
        ])
        reputacao.importar(CSVMentionSource(caminho))
        r = reputacao.benchmarking(dias=1)
        assert r["disponivel"]
        bv1 = [v for v in r["por_veiculo"] if v["veiculo"] == "BV1"][0]
        assert bv1["mencoes"] == 2
        assert bv1["share_of_voice_pct"] > 50


# ── alerta de anomalia ──────────────────────────────────────────────────────
def test_anomalia_sem_baseline_e_indisponivel(escopo_irrestrito):
    with _base("rep_anomalia_sem_base"):
        r = reputacao.checar_anomalia_de_volume()
        assert r["disponivel"] is False


def test_volume_normal_nao_dispara_alerta(tmp_path, escopo_irrestrito):
    """14 dias com 2 menções cada, hoje com 2 — sem desvio, sem alerta."""
    with _base("rep_anomalia_normal"):
        hoje = date.today()
        linhas = []
        for i in range(15, 0, -1):
            dia = (hoje - timedelta(days=i)).isoformat()
            linhas.append({"canal": "social", "veiculo": "X", "publicado_em": dia,
                           "texto": f"Menção neutra numero {i} sobre assunto qualquer do dia"})
            linhas.append({"canal": "social", "veiculo": "X", "publicado_em": dia,
                           "texto": f"Segunda menção neutra numero {i} sobre outro assunto"})
        linhas.append({"canal": "social", "veiculo": "X", "publicado_em": hoje.isoformat(),
                       "texto": "Menção de hoje numero um sobre assunto do dia atual"})
        linhas.append({"canal": "social", "veiculo": "X", "publicado_em": hoje.isoformat(),
                       "texto": "Menção de hoje numero dois sobre outro assunto do dia"})
        reputacao.importar(CSVMentionSource(_escrever_csv(tmp_path, linhas)))

        r = reputacao.checar_anomalia_de_volume()
        assert r["disponivel"]
        assert r["anomalo"] is False
        assert reputacao.alertas() == []


def test_pico_de_volume_dispara_alerta(tmp_path, escopo_irrestrito):
    with _base("rep_anomalia_pico"):
        hoje = date.today()
        linhas = []
        for i in range(15, 0, -1):
            dia = (hoje - timedelta(days=i)).isoformat()
            linhas.append({"canal": "social", "veiculo": "X", "publicado_em": dia,
                           "texto": f"Menção neutra numero {i} sobre assunto qualquer do dia"})
        # Hoje: 20 menções, muito acima da baseline de 1/dia.
        for i in range(20):
            linhas.append({"canal": "social", "veiculo": "X", "publicado_em": hoje.isoformat(),
                           "texto": f"Pico de menções numero {i} sobre o mesmo assunto crítico hoje {i}"})
        reputacao.importar(CSVMentionSource(_escrever_csv(tmp_path, linhas)))

        r = reputacao.checar_anomalia_de_volume()
        assert r["disponivel"] and r["anomalo"] is True
        alertas = reputacao.alertas()
        assert len(alertas) == 1
        assert alertas[0]["tipo"] == "volume_anomalo"


def test_alertas_sao_append_only(escopo_irrestrito):
    with _base("rep_append_only"):
        with db.conexao() as con:
            con.execute(
                """INSERT INTO alertas_reputacao (tenant_id, tipo, gerado_em, janela_de, janela_ate, volume)
                   VALUES (?,?,?,?,?,?)""",
                (context.atual().tenant_id, "teste", "2026-01-01", "2026-01-01", "2026-01-01", 1))
        with db.conexao() as con:
            alvo = con.execute("SELECT id FROM alertas_reputacao ORDER BY id DESC LIMIT 1").fetchone()["id"]
            with pytest.raises(sqlite3.IntegrityError):
                con.execute("UPDATE alertas_reputacao SET tipo='x' WHERE id=?", (alvo,))


# ── HTTP ──────────────────────────────────────────────────────────────────
def test_http_importar_exige_admin(cliente_http, token_filial_a, token_admin, tmp_path):
    conteudo = "canal,veiculo,url,publicado_em,texto,alcance\r\n"
    h_a = {"Authorization": f"Bearer {token_filial_a}"}
    h_admin = {"Authorization": f"Bearer {token_admin}"}
    assert cliente_http.post("/api/reputacao/importar-csv", headers=h_a,
                             content=conteudo).status_code == 403
    assert cliente_http.post("/api/reputacao/importar-csv", headers=h_admin,
                             content=conteudo).status_code == 200


def test_http_mencoes_e_resumo(cliente_http, token_admin):
    h = {"Authorization": f"Bearer {token_admin}"}
    assert cliente_http.get("/api/reputacao/mencoes", headers=h).status_code == 200
    assert cliente_http.get("/api/reputacao/resumo", headers=h).status_code == 200
    assert cliente_http.get("/api/reputacao/benchmarking", headers=h).status_code == 200
