"""
middleware.py — abre o escopo de acesso e mede o request.

É middleware ASGI puro (e não `BaseHTTPMiddleware`) por um motivo concreto:
`BaseHTTPMiddleware` executa o handler numa task separada, e contextvar
setada antes do `call_next` não chega de forma confiável no endpoint. Como o
escopo INTEIRO deste sistema viaja por contextvar, essa diferença é entre
funcionar e vazar. No ASGI puro, o endpoint roda no mesmo contexto — e
endpoints síncronos herdam o contexto porque o anyio copia o contexto atual
ao mandar a função para o threadpool.

O middleware nunca rejeita request por falta de token: quem exige
autenticação é o `Depends` do endpoint. Aqui só se resolve QUEM é, para
montar o escopo — endpoint público (login, health) segue sem escopo, e a
fachada de dados é quem recusa servir sem ele.
"""
from __future__ import annotations

import time
from typing import Callable

from . import context, telemetry


class EscopoMiddleware:
    def __init__(self, app, *, resolver_usuario: Callable[[str], dict | None],
                 tenant_id: Callable[[], str]):
        self.app = app
        self._resolver_usuario = resolver_usuario
        self._tenant_id = tenant_id

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        request_id = context.novo_request_id()
        rota = f"{scope.get('method', '?')} {scope.get('path', '?')}"
        escopo = self._montar_escopo(scope, request_id)
        status_visto = {"code": 0}

        async def send_com_header(mensagem):
            if mensagem["type"] == "http.response.start":
                status_visto["code"] = mensagem["status"]
                mensagem.setdefault("headers", [])
                mensagem["headers"].append((b"x-request-id", request_id.encode()))
            await send(mensagem)

        t0 = time.perf_counter()
        try:
            if escopo is None:
                await self.app(scope, receive, send_com_header)
            else:
                with context.ativar(escopo):
                    await self.app(scope, receive, send_com_header)
        finally:
            telemetry.logar_request(
                request_id=request_id,
                rota=rota,
                status=status_visto["code"],
                ms=(time.perf_counter() - t0) * 1000,
                usuario=escopo.usuario if escopo else "-",
                tenant=escopo.tenant_id if escopo else "-",
            )

    def _montar_escopo(self, scope, request_id: str) -> context.Escopo | None:
        token = ""
        for nome, valor in scope.get("headers", []):
            if nome == b"authorization":
                bruto = valor.decode("latin-1")
                if bruto.lower().startswith("bearer "):
                    token = bruto[7:].strip()
                break
        if not token:
            return None
        user = self._resolver_usuario(token)
        if not user:
            return None
        return context.Escopo(
            tenant_id=self._tenant_id(),
            usuario=user.get("email", "?"),
            role=user.get("role", "user"),
            filiais=context.parse_filiais(user.get("filiais", "")),
            request_id=request_id,
        )
