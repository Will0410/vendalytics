"""
test_usuarios.py — gestão de contas de acesso.

O que se checa aqui não é o CRUD (isso o SQLite garante), e sim as três travas
que existem para o sistema não ficar inacessível ou inseguro por um clique:

  1. **A instalação nunca fica sem admin.** Remover ou rebaixar o último admin
     é recusado. Sem isso, um clique deixa a instalação sem ninguém capaz de
     criar contas — e no plano free do Render, onde não há Shell, a
     recuperação exige acesso ao painel de variáveis de ambiente.
  2. **Ninguém remove a própria conta.** Mesma classe de problema, do lado de
     quem está usando a tela.
  3. **Trocar a própria senha exige a senha atual.** Sem isso, um token roubado
     vira takeover permanente: o atacante troca a senha e o dono perde o acesso.

Também se checa que `senha_hash` nunca sai na resposta. É a única propriedade
aqui que, se quebrar, quebra em silêncio — nada na tela denuncia um campo a
mais no JSON.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from conftest import db_operacional_isolado

from vendalytics import auth
from vendalytics.modules import usuarios

ADMIN = "chefe@teste.com"
SENHA_OK = "SenhaLongaDeTeste"


@pytest.fixture
def base(escopo_irrestrito):
    """Banco operacional zerado a cada teste, com um único admin.

    Duas razões para o isolamento, e as duas já morderam:

    - Entre ARQUIVOS: as asserções contam admins da instalação inteira. Se
      outro teste deixar um admin para trás, "é o último admin" deixa de ser
      verdade e a suíte passa a depender da ordem de coleta.
    - Entre TESTES deste arquivo: `db_operacional_isolado` só aponta o caminho,
      não apaga o arquivo. Sem o `unlink`, o segundo teste tentava recriar o
      mesmo admin e tomava 409 na própria fixture.
    """
    with db_operacional_isolado("usuarios") as caminho:
        caminho.unlink(missing_ok=True)
        auth.init_db()
        usuarios.criar(email=ADMIN, senha=SENHA_OK, nome="Chefe", role="admin")
        yield


def _emails(lista):
    return {u["email"] for u in lista}


# ── Criação ────────────────────────────────────────────────────────────────

def test_criar_aparece_na_listagem_e_permite_login(base):
    usuarios.criar(email="novo@teste.com", senha=SENHA_OK, nome="Novo", role="user")

    assert "novo@teste.com" in _emails(usuarios.listar())
    # A conta criada precisa realmente autenticar — criar sem conseguir entrar
    # seria um sucesso silencioso e inútil.
    assert auth.autenticar("novo@teste.com", SENHA_OK)["role"] == "user"


def test_listagem_nunca_devolve_o_hash_da_senha(base):
    usuarios.criar(email="alguem@teste.com", senha=SENHA_OK, nome="Alguém")
    for u in usuarios.listar():
        assert "senha_hash" not in u
        assert "senha" not in u


def test_email_normaliza_caixa_e_espacos(base):
    usuarios.criar(email="  MAIUSCULA@Teste.COM  ", senha=SENHA_OK, nome="Maiúscula")
    assert "maiuscula@teste.com" in _emails(usuarios.listar())


@pytest.mark.parametrize("email", ["sem-arroba", "@dominio.com", "nome@", "a b@c.com", ""])
def test_email_invalido_e_recusado(base, email):
    with pytest.raises(HTTPException) as e:
        usuarios.criar(email=email, senha=SENHA_OK, nome="X")
    assert e.value.status_code == 422


def test_senha_curta_e_recusada(base):
    with pytest.raises(HTTPException) as e:
        usuarios.criar(email="curta@teste.com", senha="123", nome="Curta")
    assert e.value.status_code == 422
    assert "curta@teste.com" not in _emails(usuarios.listar())


def test_papel_invalido_e_recusado(base):
    with pytest.raises(HTTPException) as e:
        usuarios.criar(email="papel@teste.com", senha=SENHA_OK, nome="P", role="superusuario")
    assert e.value.status_code == 422


def test_email_duplicado_e_conflito_nao_erro_de_validacao(base):
    usuarios.criar(email="dup@teste.com", senha=SENHA_OK, nome="Dup")
    with pytest.raises(HTTPException) as e:
        usuarios.criar(email="dup@teste.com", senha=SENHA_OK, nome="Dup 2")
    # 409 e não 422: o pedido está bem formado, o estado do banco é que conflita.
    assert e.value.status_code == 409


# ── Trava 1: a instalação nunca fica sem admin ─────────────────────────────

def test_nao_remove_o_ultimo_admin(base):
    usuarios.criar(email="comum@teste.com", senha=SENHA_OK, nome="Comum", role="user")

    with pytest.raises(HTTPException) as e:
        usuarios.remover(email=ADMIN, por="outro@teste.com")
    assert e.value.status_code == 409
    assert ADMIN in _emails(usuarios.listar())


def test_nao_rebaixa_o_ultimo_admin(base):
    with pytest.raises(HTTPException) as e:
        usuarios.alterar_papel(email=ADMIN, role="user", por="outro@teste.com")
    assert e.value.status_code == 409
    assert next(u for u in usuarios.listar() if u["email"] == ADMIN)["role"] == "admin"


def test_com_dois_admins_o_rebaixamento_passa(base):
    """A trava é sobre o ÚLTIMO admin, não sobre admins em geral — se ela
    bloqueasse sempre, ninguém conseguiria corrigir uma promoção errada."""
    usuarios.criar(email="segundo@teste.com", senha=SENHA_OK, nome="Segundo", role="admin")

    r = usuarios.alterar_papel(email=ADMIN, role="user", por="segundo@teste.com")
    assert r["role"] == "user"


def test_com_dois_admins_a_remocao_passa(base):
    usuarios.criar(email="segundo@teste.com", senha=SENHA_OK, nome="Segundo", role="admin")

    usuarios.remover(email=ADMIN, por="segundo@teste.com")
    assert ADMIN not in _emails(usuarios.listar())


# ── Trava 2: ninguém remove a própria conta ────────────────────────────────

def test_nao_remove_a_propria_conta(base):
    usuarios.criar(email="segundo@teste.com", senha=SENHA_OK, nome="Segundo", role="admin")

    with pytest.raises(HTTPException) as e:
        usuarios.remover(email="segundo@teste.com", por="segundo@teste.com")
    assert e.value.status_code == 409
    assert "segundo@teste.com" in _emails(usuarios.listar())


def test_autorremocao_e_barrada_mesmo_com_caixa_diferente(base):
    """`por` vem do JWT e o e-mail vem da URL: uma diferença de caixa entre os
    dois não pode furar a trava."""
    usuarios.criar(email="segundo@teste.com", senha=SENHA_OK, nome="Segundo", role="admin")

    with pytest.raises(HTTPException) as e:
        usuarios.remover(email="Segundo@Teste.com", por="segundo@teste.com")
    assert e.value.status_code == 409


# ── Trava 3: trocar a própria senha exige a senha atual ────────────────────

def test_troca_de_senha_exige_a_senha_atual(base):
    with pytest.raises(HTTPException) as e:
        usuarios.trocar_propria_senha(
            email=ADMIN, senha_atual="senha-errada-mas-longa", senha_nova="OutraSenhaLonga"
        )
    assert e.value.status_code == 403
    # A senha antiga continua valendo — a tentativa falha não pode ter efeito.
    assert auth.autenticar(ADMIN, SENHA_OK)["email"] == ADMIN


def test_troca_de_senha_com_a_senha_certa_funciona(base):
    nova = "SenhaNovaDeTeste"
    usuarios.trocar_propria_senha(email=ADMIN, senha_atual=SENHA_OK, senha_nova=nova)

    assert auth.autenticar(ADMIN, nova)["email"] == ADMIN
    with pytest.raises(HTTPException):
        auth.autenticar(ADMIN, SENHA_OK)


def test_troca_de_senha_respeita_o_tamanho_minimo(base):
    with pytest.raises(HTTPException) as e:
        usuarios.trocar_propria_senha(email=ADMIN, senha_atual=SENHA_OK, senha_nova="abc")
    assert e.value.status_code == 422
    assert auth.autenticar(ADMIN, SENHA_OK)["email"] == ADMIN


# ── Redefinição por admin ──────────────────────────────────────────────────

def test_admin_redefine_senha_de_outro_sem_saber_a_atual(base):
    usuarios.criar(email="esqueceu@teste.com", senha=SENHA_OK, nome="Esqueceu")
    nova = "SenhaRedefinida1"

    usuarios.redefinir_senha(email="esqueceu@teste.com", senha=nova, por=ADMIN)

    assert auth.autenticar("esqueceu@teste.com", nova)["email"] == "esqueceu@teste.com"


def test_redefinir_senha_de_quem_nao_existe_e_404(base):
    with pytest.raises(HTTPException) as e:
        usuarios.redefinir_senha(email="fantasma@teste.com", senha=SENHA_OK, por=ADMIN)
    assert e.value.status_code == 404
