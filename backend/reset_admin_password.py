#!/usr/bin/env python3
"""Reseta a senha de um usuário já existente (ex.: admin criado automaticamente
no primeiro boot, cuja senha aleatória só foi impressa uma vez no log).

Rode isto de DENTRO do ambiente onde a app já está configurada (ex.: aba
"Shell" do serviço no Render) — assim ele reusa a mesma DATABASE_URL/config
que a própria aplicação usa, sem você precisar colar a connection string em
lugar nenhum.

Uso (a partir da pasta backend/, com o venv/ambiente da app ativo):
  python reset_admin_password.py seu.email@exemplo.com -s "SenhaNova123!"

Se -s/--senha for omitida, uma senha aleatória é gerada e impressa uma vez.
"""
from __future__ import annotations

import argparse
import secrets
import sys


def main() -> int:
    p = argparse.ArgumentParser(description="Resetar a senha de um usuário existente")
    p.add_argument("email", help="e-mail do usuário a ter a senha resetada")
    p.add_argument("-s", "--senha", help="nova senha (se omitida, será gerada)")
    args = p.parse_args()

    senha = args.senha or secrets.token_urlsafe(12)

    try:
        from vendalytics import auth
        from vendalytics.infra import db
    except Exception as e:
        print("Erro ao importar o pacote vendalytics. Rode este script a partir da "
              "pasta 'backend', no mesmo ambiente/venv da aplicação.")
        print("Detalhe:", e)
        return 2

    email = args.email.strip().lower()
    novo_hash = auth._hash_senha(senha)

    con = db.conectar()
    try:
        cur = con.execute(
            "UPDATE usuarios SET senha_hash = ? WHERE email = ?", (novo_hash, email))
        linhas = cur.rowcount
        con.commit()
    finally:
        con.close()

    if linhas == 0:
        print(f"Nenhum usuário encontrado com e-mail '{email}' — nada foi alterado.")
        print("Para CRIAR um usuário novo em vez de resetar, use create_admin.py.")
        return 1

    print("Senha atualizada com sucesso:")
    print(f"  email: {email}")
    print(f"  senha: {senha}")
    print("Guarde-a agora — não será mostrada de novo.")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
