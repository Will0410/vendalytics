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

log = logging.getLogger("vendalytics.auth")
_bearer = HTTPBearer(auto_error=False)


def _hash_senha(senha: str) -> str:
    return bcrypt.hashpw(senha.encode("utf-8")[:72], bcrypt.gensalt()).decode("utf-8")


def _verificar_senha(senha: str, hash_: str) -> bool:
    return bcrypt.checkpw(senha.encode("utf-8")[:72], hash_.encode("utf-8"))


def _con() -> sqlite3.Connection:
    con = sqlite3.connect(str(config.USERS_DB_PATH), timeout=10)
    con.row_factory = sqlite3.Row
    return con


def init_db() -> None:
    with closing(_con()) as con:
        con.execute("""
            CREATE TABLE IF NOT EXISTS usuarios (
                email TEXT PRIMARY KEY,
                senha_hash TEXT NOT NULL,
                nome TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                filiais TEXT DEFAULT '',
                criado_em TEXT NOT NULL
            )
        """)
        con.commit()


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
    admin_email = config.ADMIN_EMAIL or t.admin_email
    senha = config.ADMIN_PASSWORD
    if config.ADMIN_EMAIL and not senha:
        log.warning(
            "ADMIN_EMAIL definido sem ADMIN_PASSWORD — gerando senha aleatória."
        )
        senha = secrets.token_urlsafe(12)
    if not senha:
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


def autenticar(email: str, senha: str) -> dict:
    init_db()
    with closing(_con()) as con:
        r = con.execute("SELECT * FROM usuarios WHERE email=?", (email.strip().lower(),)).fetchone()
    if not r or not _verificar_senha(senha, r["senha_hash"]):
        raise HTTPException(401, "e-mail ou senha inválidos")
    payload = {
        "sub": r["email"], "name": r["nome"], "role": r["role"], "filiais": r["filiais"],
        "exp": datetime.now(timezone.utc) + timedelta(hours=config.JWT_EXPIRA_HORAS),
    }
    token = jwt.encode(payload, config.get_jwt_secret(), algorithm=config.JWT_ALGO)
    return {"token": token, "email": r["email"], "nome": r["nome"], "role": r["role"]}


def get_current_user(cred: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> dict:
    if cred is None:
        raise HTTPException(401, "faltando token de autenticação")
    try:
        payload = jwt.decode(cred.credentials, config.get_jwt_secret(), algorithms=[config.JWT_ALGO])
    except JWTError:
        raise HTTPException(401, "token inválido ou expirado")
    return {"email": payload["sub"], "name": payload.get("name", ""),
            "role": payload.get("role", "user"), "filiais": payload.get("filiais", "")}


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(403, "requer perfil admin")
    return user
