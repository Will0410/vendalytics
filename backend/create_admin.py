#!/usr/bin/env python3
"""Cria um usuário admin localmente no banco de `usuarios.sqlite`.

Uso:
  python create_admin.py seu.email@exemplo.com
  python create_admin.py seu.email@exemplo.com -s SenhaSegura123

O script gera uma senha aleatória se `-s/--senha` não for informada.
"""
from __future__ import annotations

import argparse
import secrets
import sys


def main() -> int:
    p = argparse.ArgumentParser(description="Criar usuário admin no DB local")
    p.add_argument("email", help="e-mail do admin a ser criado")
    p.add_argument("-s", "--senha", help="senha (se omitida, será gerada)")
    p.add_argument("--nome", default="Administrador", help="nome do usuário")
    args = p.parse_args()

    senha = args.senha or secrets.token_urlsafe(12)

    # Import aqui para permitir rodar o script a partir de backend/ com o venv
    try:
        from vendalytics import auth
    except Exception as e:
        print("Erro ao importar o pacote vendalytics. Rode este script a partir da pasta 'backend' com o venv ativado.")
        print("Detalhe:", e)
        return 2

    try:
        auth.criar_usuario(args.email, senha, nome=args.nome, role="admin")
    except Exception as e:
        print("Falha ao criar usuário:", e)
        return 1

    print("Usuário admin criado com sucesso:")
    print(f"  email: {args.email}")
    print(f"  senha:  {senha}")
    print("Não commit/compartilhe o arquivo usuarios.sqlite se não quiser vazar credenciais.")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
