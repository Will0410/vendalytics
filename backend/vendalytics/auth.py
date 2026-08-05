"""
auth.py — autenticação JWT simples, com dois endurecimentos deliberados em
relação ao projeto de origem: (1) JWT_SECRET é OBRIGATÓRIO via env (sem
fallback hardcoded — ver config._req), e (2) o admin de bootstrap nunca tem
e-mail/senha fixos no código: o e-mail vem do tenant_config e a senha é
gerada aleatoriamente na primeira subida e impressa uma única vez no log.
"""
from __future__ import annotations

import logging
import secrets
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from . import config, tenant
from .infra import audit, db

log = logging.getLogger("vendalytics.auth")
_bearer = HTTPBearer(auto_error=False)


def _hash_senha(senha: str) -> str:
    return bcrypt.hashpw(senha.encode("utf-8")[:72], bcrypt.gensalt()).decode("utf-8")


def _verificar_senha(senha: str, hash_: str) -> bool:
    return bcrypt.checkpw(senha.encode("utf-8")[:72], hash_.encode("utf-8"))


def _con() -> sqlite3.Connection:
    return db.conectar()


def init_db() -> None:
    """O schema agora vem das migrations versionadas (infra/db.py) em vez de
    um CREATE TABLE solto aqui — assim há uma resposta para "em que versão
    este ambiente está?" e para "como adiciono uma coluna?"."""
    db.migrar()


def _tem_usuarios() -> bool:
    with closing(_con()) as con:
        return con.execute("SELECT 1 FROM usuarios LIMIT 1").fetchone() is not None


def garantir_admin() -> None:
    """Cria o 1º admin só se NENHUM usuário existir ainda — nunca sobrescreve
    um admin já criado. Senha aleatória, impressa uma vez no log: o objetivo é
    nunca ter uma credencial padrão previsível commitada em lugar nenhum."""
    init_db()
    if _tem_usuarios():
        return
    t = tenant.carregar()
    admin_email = t.admin_email
    senha = secrets.token_urlsafe(12)
    criar_usuario(admin_email, senha, nome="Administrador", role="admin")
    log.warning(
        "Nenhum usuário existia — admin criado automaticamente:\n"
        f"  e-mail: {admin_email}\n  senha:  {senha}\n"
        "Troque essa senha assim que fizer login (guarde-a agora, não será"
        " mostrada de novo).")


def criar_usuario(email: str, senha: str, *, nome: str, role: str = "user", filiais: str = "") -> None:
    init_db()
    with closing(_con()) as con:
        con.execute(
            "INSERT INTO usuarios (email, senha_hash, nome, role, filiais, criado_em) VALUES (?,?,?,?,?,?)",
            (email.strip().lower(), _hash_senha(senha), nome, role, filiais,
             datetime.now(timezone.utc).isoformat()))
        con.commit()


def redefinir_senha(email: str, senha: str, *, nome: str = "Administrador",
                    role: str = "admin") -> None:
    """Upsert de credencial: atualiza a senha se o e-mail já existe, cria o
    usuário se não existe. Usado pelo reset via env var no startup (ver
    main.py) — o caminho de recuperação quando a senha aleatória do
    bootstrap se perde e não há acesso a Shell (planos free do Render não
    oferecem)."""
    init_db()
    email_norm = email.strip().lower()
    with closing(_con()) as con:
        cur = con.execute(
            "UPDATE usuarios SET senha_hash=? WHERE email=?",
            (_hash_senha(senha), email_norm))
        if cur.rowcount == 0:
            con.execute(
                "INSERT INTO usuarios (email, senha_hash, nome, role, filiais, criado_em) "
                "VALUES (?,?,?,?,?,?)",
                (email_norm, _hash_senha(senha), nome, role, "",
                 datetime.now(timezone.utc).isoformat()))
        con.commit()


def autenticar(email: str, senha: str) -> dict:
    init_db()
    email_norm = email.strip().lower()
    with closing(_con()) as con:
        r = con.execute("SELECT * FROM usuarios WHERE email=?", (email_norm,)).fetchone()
    if not r or not _verificar_senha(senha, r["senha_hash"]):
        # Tentativa falha vai para a trilha: é o sinal que distingue erro de
        # digitação de ataque de força bruta. Sem e-mail existente/inexistente
        # no detalhe, para não transformar a trilha em oráculo de usuários.
        audit.registrar("auth.login", recurso=email_norm, resultado=audit.NEGADO,
                        detalhe={"motivo": "credenciais inválidas"})
        raise HTTPException(401, "e-mail ou senha inválidos")
    with closing(_con()) as con:
        con.execute("UPDATE usuarios SET ultimo_acesso=? WHERE email=?",
                    (datetime.now(timezone.utc).isoformat(), email_norm))
        con.commit()
    audit.registrar("auth.login", recurso=email_norm,
                    detalhe={"role": r["role"], "filiais": r["filiais"]})
    payload = {
        "sub": r["email"], "name": r["nome"], "role": r["role"], "filiais": r["filiais"],
        "exp": datetime.now(timezone.utc) + timedelta(hours=config.JWT_EXPIRA_HORAS),
    }
    token = jwt.encode(payload, config.get_jwt_secret(), algorithm=config.JWT_ALGO)
    return {"token": token, "email": r["email"], "nome": r["nome"], "role": r["role"]}


def usuario_do_token(token: str) -> dict | None:
    """Decodifica um token sem levantar — devolve None se inválido.

    Usado pelo middleware de escopo, que precisa saber QUEM é sem decidir se
    o request pode seguir: a decisão de exigir autenticação continua sendo do
    `Depends(get_current_user)` de cada endpoint, num lugar só."""
    try:
        payload = jwt.decode(token, config.get_jwt_secret(), algorithms=[config.JWT_ALGO])
    except JWTError:
        return None
    return {"email": payload["sub"], "name": payload.get("name", ""),
            "role": payload.get("role", "user"), "filiais": payload.get("filiais", "")}


def get_current_user(cred: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> dict:
    if cred is None:
        raise HTTPException(401, "faltando token de autenticação")
    user = usuario_do_token(cred.credentials)
    if user is None:
        raise HTTPException(401, "token inválido ou expirado")
    return user


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(403, "requer perfil admin")
    return user
