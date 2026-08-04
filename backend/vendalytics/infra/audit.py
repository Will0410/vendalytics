"""
audit.py — trilha de auditoria append-only (§3.7 da spec): quem viu qual
conta, quem exportou o quê, quem mudou qual configuração, e todo acesso
negado.

Duas decisões que definem se a trilha presta:

1. **Append-only imposto pelo banco**, via trigger (ver `infra/db.py`), não
   por convenção. Uma trilha que a aplicação pode reescrever não é evidência
   de nada.
2. **Registrar o negado, não só o permitido.** A tentativa de acesso fora do
   escopo é o evento mais interessante que a trilha vai capturar; é ela que
   distingue "usuário curioso" de "credencial comprometida".

O registro nunca derruba o request: falha de auditoria vira log de erro. A
alternativa (recusar servir quando a trilha está indisponível) é defensável
em sistema financeiro, e é a linha a mudar aqui se um cliente exigir.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from . import context, db

log = logging.getLogger("vendalytics.infra.audit")

PERMITIDO = "permitido"
NEGADO = "negado"
ERRO = "erro"


def registrar(acao: str, *, recurso: str = "", resultado: str = PERMITIDO,
              detalhe: dict | None = None) -> None:
    """Grava uma linha na trilha, usando o escopo do request corrente."""
    escopo = context.opcional()
    if escopo is None:
        # Caminho sem escopo (startup, health check). Não inventa um usuário
        # anônimo na trilha: registra como sistema, explicitamente.
        tenant_id, usuario, role, request_id = "-", "sistema:sem-escopo", "sistema", "-"
    else:
        tenant_id = escopo.tenant_id
        usuario = escopo.usuario
        role = escopo.role
        request_id = escopo.request_id

    try:
        with db.conexao() as con:
            con.execute(
                """INSERT INTO auditoria
                   (ocorrido_em, tenant_id, request_id, usuario, role, acao,
                    recurso, resultado, detalhe)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (
                    datetime.now(timezone.utc).isoformat(),
                    tenant_id, request_id, usuario, role, acao, recurso, resultado,
                    json.dumps(detalhe or {}, ensure_ascii=False, default=str),
                ),
            )
    except Exception as e:  # nunca derruba o request por causa da trilha
        log.error("Falha ao gravar auditoria (acao=%s recurso=%s): %s", acao, recurso, e)


def negado(acao: str, *, recurso: str = "", motivo: str = "") -> None:
    registrar(acao, recurso=recurso, resultado=NEGADO, detalhe={"motivo": motivo})


def consultar(*, limit: int = 200, usuario: str = "", acao: str = "",
              resultado: str = "") -> list[dict]:
    """Leitura da trilha — exposta a admin via API para que o cliente possa
    auditar sem precisar de acesso ao banco."""
    where, params = ["1=1"], []
    if usuario:
        where.append("usuario = ?"); params.append(usuario)
    if acao:
        where.append("acao = ?"); params.append(acao)
    if resultado:
        where.append("resultado = ?"); params.append(resultado)
    wc = " AND ".join(where)
    with db.conexao() as con:
        rows = con.execute(
            f"SELECT * FROM auditoria WHERE {wc} ORDER BY id DESC LIMIT ?",
            params + [min(int(limit), 1000)],
        ).fetchall()
    saida = []
    for r in rows:
        d = dict(r)
        try:
            d["detalhe"] = json.loads(d.get("detalhe") or "{}")
        except (ValueError, TypeError):
            pass
        saida.append(d)
    return saida
