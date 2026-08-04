"""
main.py — API do Vendalytics. Esqueleto enxuto de propósito (Fase 1 do
plano): auth, branding do tenant, mapa de clientes e dashboard de métricas,
todos servidos a partir do adapter configurado (sqlite_reference por padrão,
populado por demo_data/seed.py com dado 100% sintético).
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth, config, data_layer, tenant
from .modules import executivo, metrics, mix, recompra

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("vendalytics")

app = FastAPI(title="Vendalytics")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
def _startup():
    auth.garantir_admin()
    # Log seguro: não imprimir valores sensíveis, apenas presença/contagem
    jwt_present = bool((os.getenv("JWT_SECRET") or "").strip())
    env_keys = [k for k in os.environ.keys() if k in ("JWT_SECRET",) or k.endswith("SECRET") or k.endswith("_KEY")]
    log.info("Startup env check: JWT_SECRET present=%s, keys_found=%s", jwt_present, env_keys)
    if not data_layer.disponivel():
        log.warning(
            "Fonte de dados sem dado carregado — rode "
            "`python -m demo_data.seed` para gerar a base de demonstração.")


# ── auth ──────────────────────────────────────────────────────────────
class LoginReq(BaseModel):
    email: str
    senha: str


@app.post("/api/auth/login")
def login(body: LoginReq):
    return auth.autenticar(body.email, body.senha)


@app.get("/api/auth/me")
def me(user: dict = Depends(auth.get_current_user)):
    return user


# ── identidade/branding do tenant ───────────────────────────────────────
@app.get("/api/tenant/branding")
def branding():
    return tenant.carregar().branding_publico()


# ── clientes / mapa ──────────────────────────────────────────────────
@app.get("/api/clientes")
def clientes(bbox: str = "", texto: str = "", filial: str = "",
            limit: int = 2000, offset: int = 0, user: dict = Depends(auth.get_current_user)):
    bb = None
    if bbox:
        partes = [float(x) for x in bbox.split(",")]
        if len(partes) == 4:
            bb = tuple(partes)
    return data_layer.query_clientes(bbox=bb, texto=texto, filial=filial, limit=limit, offset=offset)


@app.get("/api/clientes/{customer_id}")
def cliente_detalhe(customer_id: str, user: dict = Depends(auth.get_current_user)):
    c = data_layer.cliente(customer_id)
    if not c:
        return {"erro": "não encontrado"}
    c["pedidos_recentes"] = data_layer.pedidos_recentes(customer_id)
    c["mix_produtos"] = data_layer.mix_produtos_cliente(customer_id)
    c["roteiro"] = data_layer.roteiro_visitas(customer_id)
    return c


# ── métricas / dashboard ────────────────────────────────────────────────
@app.get("/api/metrics/dashboard")
def dashboard(filial: str = "", user: dict = Depends(auth.get_current_user)):
    return metrics.dashboard(filial=filial)


@app.get("/api/vendedores")
def vendedores(filial: str = "", user: dict = Depends(auth.get_current_user)):
    return {"vendedores": data_layer.vendedores(filial=filial)}


# ── recompra preditiva ───────────────────────────────────────────────────
@app.get("/api/recompra/vencendo")
def recompra_vencendo(filial: str = "", max_n: int = 50, user: dict = Depends(auth.get_current_user)):
    return recompra.vencendo(filial=filial, max_n=max_n)


# ── gap de mix / cross-sell ──────────────────────────────────────────────
@app.get("/api/mix/gap")
def mix_gap(filial: str = "", meses: int = 3, user: dict = Depends(auth.get_current_user)):
    return mix.gap(filial=filial, meses=meses)


# ── painel executivo ─────────────────────────────────────────────────────
@app.get("/api/executivo/overview")
def executivo_overview(filial: str = "", user: dict = Depends(auth.get_current_user)):
    return executivo.overview(filial=filial)


# ── diagnóstico (sem auth — health check simples) ───────────────────────
@app.get("/api/health")
def health():
    return {"ok": True, "adapter": config.ADAPTER_ATIVO, "dado_disponivel": data_layer.disponivel()}


# Endpoint de debug seguro (ativa apenas em DEMO_MODE). Retorna apenas se o
# `JWT_SECRET` está presente e o tamanho do valor, sem revelar o segredo.
if config.DEMO_MODE:
    @app.get("/internal/debug/jwt")
    def _debug_jwt():
        v = os.getenv("JWT_SECRET", "") or ""
        return {"jwt_present": bool(v.strip()), "jwt_length": len(v.strip())}


# ── frontend estático ────────────────────────────────────────────────────
FRONTEND_DIR = config.PROJECT_ROOT / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
