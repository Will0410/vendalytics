"""
test_infra.py — migrations, trilha de auditoria e o caminho HTTP completo
(header → token → escopo → 403).
"""
from __future__ import annotations

import sqlite3

import pytest

from vendalytics.infra import audit, context, db


# ── migrations ────────────────────────────────────────────────────────────
def test_migrar_e_idempotente():
    v1 = db.migrar()
    v2 = db.migrar()
    assert v1 == v2 == max(m[0] for m in db.MIGRATIONS)


def test_versoes_de_migration_sao_unicas_e_ordenadas():
    versoes = [m[0] for m in db.MIGRATIONS]
    assert versoes == sorted(versoes), "migrations fora de ordem"
    assert len(versoes) == len(set(versoes)), "versão de migration duplicada"


# ── auditoria ─────────────────────────────────────────────────────────────
def test_trilha_e_append_only_no_banco():
    """Append-only imposto por trigger: uma trilha que a própria aplicação
    pode reescrever não é evidência de nada."""
    audit.registrar("teste.append_only", recurso="r1")
    with db.conexao() as con:
        alvo = con.execute("SELECT id FROM auditoria ORDER BY id DESC LIMIT 1").fetchone()["id"]
        with pytest.raises(sqlite3.IntegrityError):
            con.execute("UPDATE auditoria SET acao='adulterado' WHERE id=?", (alvo,))
        with pytest.raises(sqlite3.IntegrityError):
            con.execute("DELETE FROM auditoria WHERE id=?", (alvo,))


def test_registro_carrega_o_escopo_do_request(escopo_filial_a):
    audit.registrar("teste.com_escopo", recurso="r2")
    evento = audit.consultar(acao="teste.com_escopo", limit=1)[0]
    assert evento["usuario"] == "vendedor.a@teste"
    assert evento["request_id"] == "req-filial-a"
    assert evento["role"] == "vendedor"


def test_acesso_negado_vai_para_a_trilha(escopo_filial_a):
    """O evento mais interessante da trilha é o negado — é ele que separa
    curiosidade de credencial comprometida."""
    from vendalytics import data_layer

    with pytest.raises(context.EscopoNegado):
        data_layer.cliente("C-B")
    negados = audit.consultar(acao="cliente.ler", resultado=audit.NEGADO, limit=1)
    assert negados and negados[0]["recurso"] == "cliente:C-B"


def test_auditoria_sem_escopo_nao_inventa_usuario():
    audit.registrar("teste.sem_escopo")
    evento = audit.consultar(acao="teste.sem_escopo", limit=1)[0]
    assert evento["usuario"] == "sistema:sem-escopo"


# ── caminho HTTP ──────────────────────────────────────────────────────────
def test_request_id_volta_no_header(cliente_http):
    r = cliente_http.get("/api/health")
    assert r.status_code == 200
    assert r.headers.get("x-request-id")


def test_http_restrito_recebe_403_em_filial_alheia(cliente_http, token_filial_a):
    h = {"Authorization": f"Bearer {token_filial_a}"}
    assert cliente_http.get("/api/clientes/C-A", headers=h).status_code == 200
    assert cliente_http.get("/api/clientes/C-B", headers=h).status_code == 403
    assert cliente_http.get("/api/clientes?filial=RJ", headers=h).status_code == 403


def test_http_sem_token_nao_le_dado(cliente_http):
    assert cliente_http.get("/api/clientes").status_code == 401


def test_admin_le_a_trilha_e_o_nao_admin_nao(cliente_http, token_admin, token_filial_a):
    assert cliente_http.get(
        "/api/auditoria", headers={"Authorization": f"Bearer {token_admin}"}).status_code == 200
    assert cliente_http.get(
        "/api/auditoria", headers={"Authorization": f"Bearer {token_filial_a}"}).status_code == 403
