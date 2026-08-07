"""
usuarios.py — gestão de contas de acesso.

O `auth.py` já sabia criar usuário e autenticar, mas isso só existia como
função Python: criar o segundo usuário da instalação exigia abrir um shell.
Este módulo é a camada de negócio que falta para a operação virar tela.

── As três regras que este arquivo protege ─────────────────────────────────

1. **Senha nunca trafega de volta.** Nenhuma função aqui devolve `senha_hash`.
   A listagem monta o dicionário campo a campo, em vez de `dict(row)` — assim
   uma coluna nova adicionada por migration não vaza por descuido.

2. **A instalação nunca fica sem admin.** Remover o último admin, ou rebaixar
   o último admin para `user`, é recusado. Sem essa trava, um clique deixa a
   instalação sem ninguém capaz de criar usuário — e a recuperação exige
   acesso ao disco do servidor, que em free tier de PaaS não existe.

3. **Ninguém remove a própria conta.** Mesma classe de problema: o admin
   que se apaga por engano fica de fora do sistema que ele administra.

Tudo passa pela trilha de auditoria. Criação de acesso é exatamente o tipo de
evento que alguém vai querer reconstituir depois.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from fastapi import HTTPException

from .. import auth
from ..infra import audit, db

# Papéis reconhecidos. `admin` administra contas; `user` opera o produto.
PAPEIS = ("admin", "user")

# Mínimo de 10 caracteres. Não é política de segurança completa (não há
# verificação de vazamento nem exigência de complexidade — regra de
# complexidade empurra o usuário para "Senha@123", que é pior), mas barra a
# senha de 4 dígitos que aparece quando não há limite nenhum.
SENHA_MINIMA = 10

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalizar_email(email: str) -> str:
    e = (email or "").strip().lower()
    if not _EMAIL.match(e):
        raise HTTPException(422, f"e-mail inválido: {email!r}")
    return e


def _validar_senha(senha: str) -> None:
    if len(senha or "") < SENHA_MINIMA:
        raise HTTPException(422, f"a senha precisa ter ao menos {SENHA_MINIMA} caracteres")


def _validar_papel(role: str) -> str:
    if role not in PAPEIS:
        raise HTTPException(422, f"papel inválido: {role!r} (use um de {PAPEIS})")
    return role


def _linha_publica(r) -> dict:
    """Projeção explícita — `senha_hash` nunca sai daqui, por construção e não
    por lembrança."""
    return {
        "email": r["email"],
        "nome": r["nome"],
        "role": r["role"],
        "filiais": [f for f in (r["filiais"] or "").split(",") if f.strip()],
        "criado_em": r["criado_em"],
        "ultimo_acesso": r["ultimo_acesso"],
    }


def _contar_admins(con) -> int:
    r = con.execute("SELECT COUNT(*) AS n FROM usuarios WHERE role='admin'").fetchone()
    return int(r["n"])


def _buscar(con, email: str):
    return con.execute("SELECT * FROM usuarios WHERE email=?", (email,)).fetchone()


# ── Consultas ──────────────────────────────────────────────────────────────

def listar() -> list[dict]:
    auth.init_db()
    with db.conexao() as con:
        linhas = con.execute(
            "SELECT * FROM usuarios ORDER BY role DESC, nome ASC").fetchall()
    audit.registrar("usuarios.listar", detalhe={"total": len(linhas)})
    return [_linha_publica(r) for r in linhas]


# ── Comandos ───────────────────────────────────────────────────────────────

def criar(*, email: str, senha: str, nome: str, role: str = "user",
          filiais: list[str] | None = None) -> dict:
    auth.init_db()
    email_norm = _normalizar_email(email)
    _validar_senha(senha)
    _validar_papel(role)
    nome_limpo = (nome or "").strip()
    if not nome_limpo:
        raise HTTPException(422, "nome é obrigatório")

    with db.conexao() as con:
        if _buscar(con, email_norm) is not None:
            # 409, não 422: o pedido está bem formado, o estado é que conflita.
            raise HTTPException(409, f"já existe um usuário com o e-mail {email_norm}")

    auth.criar_usuario(email_norm, senha, nome=nome_limpo, role=role,
                       filiais=",".join(filiais or []))

    audit.registrar("usuarios.criar", recurso=email_norm,
                    detalhe={"role": role, "filiais": filiais or []})

    with db.conexao() as con:
        return _linha_publica(_buscar(con, email_norm))


def redefinir_senha(*, email: str, senha: str, por: str) -> dict:
    """Redefinição feita por um admin. A troca da PRÓPRIA senha é
    `trocar_propria_senha`, que exige a senha atual."""
    auth.init_db()
    email_norm = _normalizar_email(email)
    _validar_senha(senha)

    with db.conexao() as con:
        if _buscar(con, email_norm) is None:
            raise HTTPException(404, f"usuário {email_norm} não encontrado")

    auth.redefinir_senha(email_norm, senha)
    audit.registrar("usuarios.redefinir_senha", recurso=email_norm,
                    detalhe={"por": por})
    return {"ok": True, "email": email_norm}


def trocar_propria_senha(*, email: str, senha_atual: str, senha_nova: str) -> dict:
    """Exige a senha atual — sem isso, um token roubado viraria takeover
    permanente da conta, porque o atacante trocaria a senha e o dono perderia
    o acesso."""
    auth.init_db()
    email_norm = _normalizar_email(email)
    _validar_senha(senha_nova)

    with db.conexao() as con:
        r = _buscar(con, email_norm)
    if r is None:
        raise HTTPException(404, "usuário não encontrado")

    if not auth._verificar_senha(senha_atual, r["senha_hash"]):
        audit.registrar("usuarios.trocar_senha", recurso=email_norm,
                        resultado=audit.NEGADO, detalhe={"motivo": "senha atual incorreta"})
        raise HTTPException(403, "senha atual incorreta")

    auth.redefinir_senha(email_norm, senha_nova)
    audit.registrar("usuarios.trocar_senha", recurso=email_norm)
    return {"ok": True, "email": email_norm}


def alterar_papel(*, email: str, role: str, por: str) -> dict:
    auth.init_db()
    email_norm = _normalizar_email(email)
    _validar_papel(role)

    with db.conexao() as con:
        r = _buscar(con, email_norm)
        if r is None:
            raise HTTPException(404, f"usuário {email_norm} não encontrado")

        # Regra 2: a instalação nunca fica sem admin.
        if r["role"] == "admin" and role != "admin" and _contar_admins(con) <= 1:
            audit.registrar("usuarios.alterar_papel", recurso=email_norm,
                            resultado=audit.NEGADO,
                            detalhe={"motivo": "é o último admin da instalação"})
            raise HTTPException(
                409, "este é o último admin — promova outro usuário antes de rebaixá-lo")

        con.execute("UPDATE usuarios SET role=? WHERE email=?", (role, email_norm))
        con.commit()

    audit.registrar("usuarios.alterar_papel", recurso=email_norm,
                    detalhe={"novo_papel": role, "por": por})
    with db.conexao() as con:
        return _linha_publica(_buscar(con, email_norm))


def remover(*, email: str, por: str) -> dict:
    auth.init_db()
    email_norm = _normalizar_email(email)

    # Regra 3: ninguém remove a própria conta.
    if email_norm == (por or "").strip().lower():
        audit.registrar("usuarios.remover", recurso=email_norm, resultado=audit.NEGADO,
                        detalhe={"motivo": "tentou remover a própria conta"})
        raise HTTPException(409, "você não pode remover a própria conta")

    with db.conexao() as con:
        r = _buscar(con, email_norm)
        if r is None:
            raise HTTPException(404, f"usuário {email_norm} não encontrado")

        if r["role"] == "admin" and _contar_admins(con) <= 1:
            audit.registrar("usuarios.remover", recurso=email_norm, resultado=audit.NEGADO,
                            detalhe={"motivo": "é o último admin da instalação"})
            raise HTTPException(
                409, "este é o último admin — a instalação ficaria sem quem cria contas")

        con.execute("DELETE FROM usuarios WHERE email=?", (email_norm,))
        con.commit()

    audit.registrar("usuarios.remover", recurso=email_norm, detalhe={"por": por})
    return {"ok": True, "email": email_norm}
