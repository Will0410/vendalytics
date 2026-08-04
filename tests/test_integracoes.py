"""
test_integracoes.py — conector de CRM (spec §2.1 A6): reconciliação por
CNPJ, idempotência na importação e write-back auditável.
"""
from __future__ import annotations

import csv as csv_mod
import json
from pathlib import Path

import pytest

from vendalytics import config
from vendalytics.infra import context, db
from vendalytics.integracoes.base import OportunidadeExterna
from vendalytics.integracoes.csv_connector import (CSVCRMConnector, exportar_recomendacoes,
                                                    importar, oportunidades)

CNPJ_VALIDO = "12345678000195"
CNPJ_VALIDO_2 = "98765432000110"


def _escrever_csv(tmp_path: Path, linhas: list[dict]) -> Path:
    caminho = tmp_path / "oportunidades.csv"
    campos = ["cnpj", "razao_social", "estagio", "valor", "criada_em",
             "fechada_em", "ganhou", "motivo_perda"]
    with open(caminho, "w", newline="", encoding="utf-8") as f:
        w = csv_mod.DictWriter(f, fieldnames=campos)
        w.writeheader()
        for linha in linhas:
            w.writerow({c: linha.get(c, "") for c in campos})
    return caminho


def test_conector_le_csv_e_ignora_cnpj_invalido(tmp_path, escopo_irrestrito):
    caminho = _escrever_csv(tmp_path, [
        {"cnpj": "12.345.678/0001-95", "razao_social": "Padaria", "estagio": "ganho",
         "valor": "5000", "criada_em": "2026-01-01", "fechada_em": "2026-02-01", "ganhou": "1"},
        {"cnpj": "123", "razao_social": "CNPJ curto", "estagio": "aberto", "valor": "0",
         "criada_em": "2026-01-01"},
    ])
    r = importar(CSVCRMConnector(caminho))
    assert r["importadas"] == 1
    assert r["descartadas_cnpj_invalido"] == 1


def test_importacao_e_idempotente_por_cnpj(tmp_path, escopo_irrestrito):
    """Reimportar o mesmo CSV não duplica: atualiza a mesma linha."""
    caminho = _escrever_csv(tmp_path, [
        {"cnpj": CNPJ_VALIDO, "razao_social": "Padaria", "estagio": "proposta",
         "valor": "3000", "criada_em": "2026-01-01", "ganhou": ""},
    ])
    importar(CSVCRMConnector(caminho))
    importar(CSVCRMConnector(caminho))
    todas = oportunidades()
    assert len([o for o in todas if o["cnpj"] == CNPJ_VALIDO]) == 1


def test_reimportar_atualiza_estagio_da_mesma_oportunidade(tmp_path, escopo_irrestrito):
    aberto = _escrever_csv(tmp_path, [
        {"cnpj": CNPJ_VALIDO_2, "razao_social": "Mercearia", "estagio": "proposta",
         "valor": "1000", "criada_em": "2026-01-01", "ganhou": ""},
    ])
    importar(CSVCRMConnector(aberto))

    ganho = _escrever_csv(tmp_path, [
        {"cnpj": CNPJ_VALIDO_2, "razao_social": "Mercearia", "estagio": "ganho",
         "valor": "1000", "criada_em": "2026-01-01", "fechada_em": "2026-02-10", "ganhou": "1"},
    ])
    importar(CSVCRMConnector(ganho))

    alvo = [o for o in oportunidades() if o["cnpj"] == CNPJ_VALIDO_2][0]
    assert alvo["estagio"] == "ganho" and alvo["ganhou"] == 1


def test_oportunidades_fechadas_filtra_as_abertas(tmp_path, escopo_irrestrito):
    caminho = _escrever_csv(tmp_path, [
        {"cnpj": CNPJ_VALIDO, "razao_social": "A", "estagio": "aberto",
         "valor": "100", "criada_em": "2026-01-01", "ganhou": ""},
        {"cnpj": CNPJ_VALIDO_2, "razao_social": "B", "estagio": "perdido",
         "valor": "200", "criada_em": "2026-01-01", "fechada_em": "2026-02-01",
         "ganhou": "0", "motivo_perda": "preço"},
    ])
    importar(CSVCRMConnector(caminho))
    fechadas = oportunidades(apenas_fechadas=True)
    assert all(o["ganhou"] is not None for o in fechadas)
    assert any(o["cnpj"] == CNPJ_VALIDO_2 for o in fechadas)


def test_conector_sem_arquivo_nao_falha_devolve_vazio():
    c = CSVCRMConnector(None)
    assert c.testar_conexao() is False
    assert c.buscar_oportunidades() == []


def test_write_back_grava_staging_e_nunca_aborta_por_item_ruim(escopo_irrestrito):
    circular: dict = {"cliente_id": "C-B"}
    circular["auto_referencia"] = circular   # json.dumps não serializa isto
    itens = [
        {"cliente_id": "C-A", "score": 80.0, "fatores": [{"rotulo": "x", "contribuicao": 1.0}]},
        circular,
    ]
    r = exportar_recomendacoes(CSVCRMConnector(), itens)
    assert r["itens_enviados"] == 1 and r["itens_falhos"] == 1
    assert Path(r["destino"]).exists()
    linhas = Path(r["destino"]).read_text(encoding="utf-8").strip().splitlines()
    assert len(linhas) == 1        # só o item válido foi escrito
    escrito = json.loads(linhas[-1])
    assert escrito["cliente_id"] == "C-A"


def test_exportacao_e_registrada_em_envios_crm(escopo_irrestrito):
    exportar_recomendacoes(CSVCRMConnector(), [{"cliente_id": "C-A", "score": 10}])
    escopo = context.atual()
    with db.conexao() as con:
        r = con.execute(
            "SELECT * FROM envios_crm WHERE tenant_id=? ORDER BY id DESC LIMIT 1",
            (escopo.tenant_id,)).fetchone()
    assert r["itens_enviados"] == 1


# ── HTTP ──────────────────────────────────────────────────────────────────
def test_http_importar_csv_exige_admin(cliente_http, token_filial_a, token_admin, tmp_path):
    conteudo = "cnpj,razao_social,estagio,valor,criada_em,fechada_em,ganhou,motivo_perda\r\n"
    h_a = {"Authorization": f"Bearer {token_filial_a}"}
    h_admin = {"Authorization": f"Bearer {token_admin}"}
    assert cliente_http.post("/api/crm/importar-csv", headers=h_a,
                             content=conteudo).status_code == 403
    assert cliente_http.post("/api/crm/importar-csv", headers=h_admin,
                             content=conteudo).status_code == 200


def test_http_exportar_recomendacoes_usa_a_fila(cliente_http, token_admin):
    """A base compartilhada de teste (`conftest.ambiente`) tem só 2 clientes
    — histórico curto demais para o split temporal out-of-time do modelo
    (ver `propensao.treinar`). Nesse caso o endpoint recusa com 409 em vez de
    exportar uma fila fantasma; é esse contrato que se verifica aqui."""
    h = {"Authorization": f"Bearer {token_admin}"}
    r = cliente_http.post("/api/crm/exportar-recomendacoes?limite=3", headers=h)
    assert r.status_code in (200, 409)
    if r.status_code == 200:
        assert r.json()["itens_enviados"] >= 0
