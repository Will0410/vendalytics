"""
test_identidade.py — resolução de entidade (spec §3.1, §4.3).

O teste que mais importa aqui não é o de precisão do match: é o de
**estabilidade do id**. Um `account_id` que muda entre execuções faz todo
score, sinal e desfecho histórico apontar para uma conta que não existe mais
— e o loop de aprendizado perde o passado inteiro sem ninguém perceber.
"""
from __future__ import annotations

import sqlite3

import pytest

from vendalytics import data_layer
from vendalytics.infra import db
from vendalytics.modules import identidade


# CNPJs construídos de propósito: mesma raiz (matriz/filial), raízes
# distintas com nome quase igual (candidato a duplicata), e cadastro sem
# documento válido.
MATRIZ = "12.345.678/0001-95"
FILIAL = "12.345.678/0002-76"
GEMEO = "98.765.432/0001-10"      # "Padaria do Joao" sem acento, outra raiz
DISTINTO = "11.222.333/0001-81"
SEM_DOC = "CLIENTE-LEGADO-7"


@pytest.fixture(scope="module", autouse=True)
def cadastro_sujo():
    from conftest import base_isolada

    from vendalytics.adapters.sqlite_reference import SCHEMA

    linhas = [
        (MATRIZ, "PADARIA DO JOÃO LTDA", "Padaria do João Ltda", "SP", "São Paulo", "SP",
         "01310-100", "1133334444", "contato@padaria.com.br", "Av Paulista 1000"),
        (FILIAL, "PADARIA DO JOAO - FILIAL", "Padaria do João Ltda", "SP", "São Paulo", "SP",
         "04538-133", "1155556666", "filial@padaria.com.br", "Av Faria Lima 500"),
        (GEMEO, "Padaria do Joao ME", "Padaria do Joao ME", "SP", "São Paulo", "SP",
         "01310-100", "1133334444", "contato@padaria.com.br", "Av Paulista 1000"),
        (DISTINTO, "MERCEARIA SILVA LTDA", "Mercearia Silva Ltda", "SP", "São Paulo", "SP",
         "09090-000", "1199998888", "silva@merc.com", "Rua das Flores 22"),
        (SEM_DOC, "CLIENTE ANTIGO SEM CNPJ", "", "SP", "Santos", "SP",
         "11010-000", "", "", "Rua do Porto 5"),
    ]
    with base_isolada("identidade") as caminho:
        con = sqlite3.connect(str(caminho))
        con.executescript(SCHEMA)
        con.executemany(
            """INSERT OR REPLACE INTO clientes
               (id,nome,razao_social,filial,municipio,uf,cep,telefone,email,endereco,status)
               VALUES (?,?,?,?,?,?,?,?,?,?,'ativo')""", linhas)
        con.commit()
        con.close()
        db.migrar()
        yield


# ── normalização ──────────────────────────────────────────────────────────
def test_normalizacao_remove_acento_e_pontuacao():
    assert identidade.normalizar_texto("PADARIA DO JOÃO LTDA.") == "padaria do joao ltda"


def test_sufixo_societario_nao_conta_como_semelhanca():
    """Sem remover LTDA/ME/EPP, dois nomes completamente diferentes já casam
    parcialmente só por terminarem igual."""
    assert identidade.tokens_significativos("PADARIA DO JOÃO LTDA ME") == ["padaria", "joao"]


def test_cnpj_raiz_agrupa_matriz_e_filial():
    assert identidade.cnpj_raiz(MATRIZ) == identidade.cnpj_raiz(FILIAL) == "12345678"


def test_cnpj_invalido_nao_vira_raiz_adivinhada():
    """Documento truncado tratado como válido funde empresas que nada têm a
    ver — é o erro mais caro que esta camada pode cometer."""
    assert identidade.cnpj_raiz("123") == ""
    assert identidade.cnpj_raiz("") == ""
    assert identidade.cnpj_raiz(SEM_DOC) == ""


# ── similaridade ──────────────────────────────────────────────────────────
def test_jaro_winkler_reconhece_variacao_de_digitacao():
    assert identidade.jaro_winkler("padaria joao", "padaria joão") > 0.9
    assert identidade.jaro_winkler("padaria joao", "mercearia silva") < 0.7


def test_similaridade_traz_evidencias_legiveis():
    """Quem cura precisa ver POR QUE o sistema achou que são a mesma empresa."""
    clientes = {c["id"]: c for c in _todos()}
    nota, evid = identidade.similaridade(clientes[MATRIZ], clientes[GEMEO])
    assert nota >= identidade.LIMIAR_CANDIDATO
    assert any("telefone" in e for e in evid)
    assert any("mail" in e for e in evid)


def test_empresas_distintas_nao_pontuam_alto():
    clientes = {c["id"]: c for c in _todos()}
    nota, _ = identidade.similaridade(clientes[MATRIZ], clientes[DISTINTO])
    assert nota < identidade.LIMIAR_CANDIDATO


def _todos():
    from vendalytics.infra import context
    with context.ativar(context.escopo_de_sistema("teste", motivo="fixture")):
        return data_layer.query_clientes(limit=1000)["clientes"]


# ── account_id canônico ───────────────────────────────────────────────────
def test_matriz_e_filial_viram_uma_conta_so(escopo_irrestrito):
    identidade.resolver()
    assert identidade.account_id(MATRIZ) == identidade.account_id(FILIAL)
    assert identidade.account_id(MATRIZ) != identidade.account_id(DISTINTO)


def test_account_id_e_estavel_entre_execucoes(escopo_irrestrito):
    """O requisito de verdade desta camada. Se o id muda ao reprocessar, todo
    score e desfecho histórico aponta para uma conta que não existe mais."""
    identidade.resolver()
    antes = {c: identidade.account_id(c) for c in (MATRIZ, FILIAL, GEMEO, DISTINTO, SEM_DOC)}
    identidade.resolver()
    identidade.resolver()
    depois = {c: identidade.account_id(c) for c in antes}
    assert antes == depois


def test_cadastro_sem_cnpj_recebe_id_proprio_e_estavel(escopo_irrestrito):
    identidade.resolver()
    acc = identidade.account_id(SEM_DOC)
    assert acc and acc.startswith("LOCAL:")
    identidade.resolver()
    assert identidade.account_id(SEM_DOC) == acc


def test_resolucao_reporta_consolidacao(escopo_irrestrito):
    r = identidade.resolver()
    assert r["clientes"] == 5
    assert r["contas_canonicas"] == 4      # matriz+filial consolidaram
    assert r["sem_documento_valido"] == 1


# ── curadoria ─────────────────────────────────────────────────────────────
def test_duplicata_de_raizes_diferentes_vai_para_curadoria(escopo_irrestrito):
    """Mesma empresa com CNPJs distintos: a raiz não resolve, e o sistema
    NÃO funde sozinho — levanta candidato."""
    pares = {(c["cliente_a"], c["cliente_b"]) for c in identidade.candidatos_a_duplicata()}
    assert tuple(sorted([MATRIZ, GEMEO])) in pares


def test_mesma_raiz_nao_polui_a_fila_de_curadoria(escopo_irrestrito):
    """Matriz e filial já são a mesma conta por construção — mandá-las para
    curadoria seria pedir trabalho humano para confirmar o óbvio."""
    pares = {(c["cliente_a"], c["cliente_b"]) for c in identidade.candidatos_a_duplicata()}
    assert tuple(sorted([MATRIZ, FILIAL])) not in pares


def test_decisao_mesmo_funde_na_proxima_resolucao(escopo_irrestrito):
    identidade.resolver()
    assert identidade.account_id(MATRIZ) != identidade.account_id(GEMEO)
    identidade.decidir(MATRIZ, GEMEO, "mesmo")
    identidade.resolver()
    assert identidade.account_id(MATRIZ) == identidade.account_id(GEMEO)
    assert identidade.account_id(FILIAL) == identidade.account_id(GEMEO)


def test_decisao_distinto_tira_o_par_da_fila(escopo_irrestrito):
    identidade.decidir(MATRIZ, DISTINTO, "distinto")
    pares = {(c["cliente_a"], c["cliente_b"]) for c in identidade.candidatos_a_duplicata()}
    assert tuple(sorted([MATRIZ, DISTINTO])) not in pares


def test_decisao_invalida_e_recusada(escopo_irrestrito):
    with pytest.raises(ValueError):
        identidade.decidir(MATRIZ, DISTINTO, "talvez")


def test_qualidade_publica_pct_sem_documento(escopo_irrestrito):
    identidade.resolver()
    q = identidade.qualidade()
    assert q["clientes_resolvidos"] == 5
    assert q["pct_sem_documento"] == 20.0
    assert q["pares_rotulados"] >= 1


# ── HTTP ──────────────────────────────────────────────────────────────────
def test_http_resolver_exige_admin(cliente_http, token_admin, token_filial_a):
    h_admin = {"Authorization": f"Bearer {token_admin}"}
    assert cliente_http.post("/api/identidade/resolver", headers=h_admin).status_code == 200
    assert cliente_http.post(
        "/api/identidade/resolver",
        headers={"Authorization": f"Bearer {token_filial_a}"}).status_code == 403


def test_http_duplicatas_e_qualidade(cliente_http, token_admin):
    h = {"Authorization": f"Bearer {token_admin}"}
    assert cliente_http.get("/api/identidade/duplicatas", headers=h).status_code == 200
    q = cliente_http.get("/api/identidade/qualidade", headers=h).json()
    assert "contas_canonicas" in q
