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

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth, config, data_layer, tenant
from .infra import audit, context, db, middleware, telemetry
from .integracoes.csv_connector import CSVCRMConnector, exportar_recomendacoes, importar, oportunidades
from .modules import (comite, executivo, fila, identidade, mercado, metrics,
                      mix, recompra, territorio)

telemetry.configurar_logging(logging.INFO, json_logs=not config.DEMO_MODE)
log = logging.getLogger("vendalytics")

app = FastAPI(title="Vendalytics")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Abre o escopo de acesso do request. Registrado por último para rodar por
# fora do CORS, de modo que até a resposta de erro carregue o X-Request-Id.
app.add_middleware(
    middleware.EscopoMiddleware,
    resolver_usuario=auth.usuario_do_token,
    tenant_id=lambda: tenant.carregar().nome_curto,
)


@app.exception_handler(context.EscopoNegado)
def _escopo_negado(request: Request, exc: context.EscopoNegado):
    """403 — o usuário está autenticado, mas pediu algo fora do recorte dele.
    A tentativa já foi registrada na trilha por quem levantou."""
    return JSONResponse(status_code=403, content={"erro": str(exc)})


@app.exception_handler(context.EscopoAusente)
def _escopo_ausente(request: Request, exc: context.EscopoAusente):
    """500 — não é erro do usuário: é um endpoint que leu dado sem escopo
    ativo. Devolve genérico para fora e grita no log para dentro, porque em
    produção isso significa que um caminho novo escapou do enforcement."""
    log.error("Endpoint sem escopo ativo em %s: %s", request.url.path, exc)
    audit.registrar("escopo.ausente", recurso=request.url.path, resultado=audit.ERRO,
                    detalhe={"erro": str(exc)})
    return JSONResponse(status_code=500, content={"erro": "erro interno"})


@app.on_event("startup")
def _startup():
    versao = db.migrar()
    log.info("Schema operacional na versão %s.", versao)
    auth.garantir_admin()
    # Log seguro: não imprimir valores sensíveis, apenas presença/contagem
    jwt_present = bool((os.getenv("JWT_SECRET") or "").strip())
    env_keys = [k for k in os.environ.keys() if k in ("JWT_SECRET",) or k.endswith("SECRET") or k.endswith("_KEY")]
    log.info("Startup env check: JWT_SECRET present=%s, keys_found=%s", jwt_present, env_keys)
    if not data_layer.disponivel():
        if config.DEMO_MODE:
            log.warning("Fonte de dados sem dado carregado — gerando base de "
                        "demonstração sintética (DEMO_MODE=true)...")
            _seed_demo_se_vazio()
        else:
            log.warning(
                "Fonte de dados sem dado carregado — rode "
                "`python -m demo_data.seed` para gerar a base de demonstração.")


def _seed_demo_se_vazio() -> None:
    """Gera a base sintética de demonstração direto no startup — necessário
    porque o disco em ambientes como o Render free tier é efêmero: cada
    deploy/restart reseta o filesystem local, então rodar `demo_data.seed`
    manualmente uma vez não sobrevive ao próximo deploy. Faker com seed fixa
    (42) garante o mesmo dado sintético a cada regeneração."""
    import sqlite3
    import sys
    from contextlib import closing

    sys.path.insert(0, str(config.PROJECT_ROOT))
    try:
        from demo_data.seed import gerar
    except ImportError as e:
        log.error("Não foi possível importar demo_data.seed: %s", e)
        return

    config.SQLITE_PATH.parent.mkdir(parents=True, exist_ok=True)
    escopo = context.escopo_de_sistema(tenant.carregar().nome_curto, motivo="seed-demo")
    with context.ativar(escopo):
        try:
            with closing(sqlite3.connect(str(config.SQLITE_PATH))) as con:
                gerar(con)
            log.info("Base de demonstração gerada em %s.", config.SQLITE_PATH)
            audit.registrar("dados.seed_demo", recurso=str(config.SQLITE_PATH))
        except Exception as e:
            log.error("Falha ao gerar base de demonstração: %s", e)
            audit.registrar("dados.seed_demo", recurso=str(config.SQLITE_PATH),
                            resultado=audit.ERRO, detalhe={"erro": str(e)})


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


# ── território / TAM-SAM-SOM (spec §2.1 A2) ─────────────────────────────
@app.get("/api/territorio/cobertura")
def territorio_cobertura(filial: str = "", user: dict = Depends(auth.get_current_user)):
    """SOM: cobertura própria por município/segmento. Sempre disponível."""
    return mercado.cobertura(filial=filial)


@app.get("/api/territorio/tam-sam-som")
def territorio_tam_sam_som(filial: str = "", segmento: str = "", uf: str = "",
                           user: dict = Depends(auth.get_current_user)):
    """TAM→SAM→SOM + whitespace por município. `tam_disponivel=false` e
    `aviso` preenchido quando não há fonte externa de universo configurada
    (CORTEX_API_URL) — nunca finge whitespace=0 por falta de dado."""
    return mercado.tam_sam_som(filial=filial, segmento=segmento, uf=uf)


@app.get("/api/territorio/simular-carteiras")
def territorio_simular_carteiras(filial: str = "", vendedores_extra: int = 0,
                                 user: dict = Depends(auth.get_current_user)):
    """Distribuição de carteiras equilibrada por POTENCIAL (spec A4), com
    penalidade geográfica e bônus de continuidade de relacionamento.
    `vendedores_extra` responde "e se eu contratar mais N?".

    Só simula — nunca aplica. Redistribuir carteira mexe em comissão de
    gente, e precisa ser vista e ajustada antes de existir."""
    return territorio.simular(filial=filial, vendedores_extra=vendedores_extra)


# ── propensão / fila priorizada (spec §2.1 A1+A3, §5) ───────────────────
@app.get("/api/fila/diaria")
def fila_diaria(filial: str = "", limite: int = 12,
                user: dict = Depends(auth.get_current_user)):
    """A fila do dia, ordenada por VALOR ESPERADO (propensão × ticket), não
    por score bruto. Vem acompanhada das métricas do modelo (AUC out-of-time,
    ECE, lift) — quem vai agir precisa saber o quanto o número merece
    confiança."""
    return fila.diaria(filial=filial, limite=limite)


@app.get("/api/fila/explicacao/{customer_id}")
def fila_explicacao(customer_id: str, user: dict = Depends(auth.get_current_user)):
    """Fatores do score atual + histórico versionado — a resposta a
    "por que este score mudou desde ontem?" (spec §3.6)."""
    data_layer.cliente(customer_id)   # aplica o escopo antes de expor o score
    return fila.explicacao(customer_id)


class DesfechoReq(BaseModel):
    desfecho: str
    motivo: str = ""
    valor: float | None = None


@app.post("/api/fila/desfecho/{customer_id}")
def fila_desfecho(customer_id: str, body: DesfechoReq,
                  user: dict = Depends(auth.get_current_user)):
    """Fecha o loop (spec §5, passo 7): aceita|recusada|ganhou|perdeu|ignorada.
    Grava o desfecho, emite o sinal e invalida o modelo em cache."""
    data_layer.cliente(customer_id)   # não deixa fechar loop de cliente fora do escopo
    try:
        return fila.registrar_desfecho(customer_id, body.desfecho,
                                       motivo=body.motivo, valor=body.valor)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/fila/saude-do-loop")
def fila_saude_do_loop(dias: int = 30, user: dict = Depends(auth.get_current_user)):
    """Cobertura de loop fechado e taxa de aceite (spec §7.4/§7.1). Se a
    cobertura cai, o produto parou de aprender e virou mais um dashboard."""
    return fila.saude_do_loop(dias=dias)


# ── resolução de entidade / account_id canônico (spec §3.1, §4.3) ────────
@app.post("/api/identidade/resolver")
def identidade_resolver(filial: str = "", user: dict = Depends(auth.require_admin)):
    """Recalcula o `account_id` canônico de cada cliente. Determinístico:
    rodar duas vezes sobre o mesmo cadastro dá exatamente os mesmos ids."""
    return identidade.resolver(filial=filial)


@app.get("/api/identidade/duplicatas")
def identidade_duplicatas(filial: str = "", limite: int = 50,
                          user: dict = Depends(auth.get_current_user)):
    """Fila de curadoria: pares suspeitos COM as evidências que os levantaram.
    O sistema sugere, o humano decide — fusão errada é muito mais cara de
    desfazer do que de evitar."""
    return {"candidatos": identidade.candidatos_a_duplicata(filial=filial, limite=limite)}


class DecisaoMatchReq(BaseModel):
    cliente_a: str
    cliente_b: str
    decisao: str   # mesmo | distinto


@app.post("/api/identidade/decidir")
def identidade_decidir(body: DecisaoMatchReq, user: dict = Depends(auth.get_current_user)):
    """Registra a decisão humana. `mesmo` funde na próxima resolução;
    `distinto` tira o par da fila para sempre."""
    data_layer.cliente(body.cliente_a)   # aplica o escopo nos dois lados
    data_layer.cliente(body.cliente_b)
    try:
        return identidade.decidir(body.cliente_a, body.cliente_b, body.decisao)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/identidade/qualidade")
def identidade_qualidade(user: dict = Depends(auth.get_current_user)):
    """Métrica de qualidade do match, publicada — sem ela ninguém percebe a
    resolução degradando até o usuário reclamar de conta duplicada na tela."""
    return identidade.qualidade()


# ── integração CRM (spec A6) ──────────────────────────────────────────────
@app.post("/api/crm/importar-csv")
async def crm_importar_csv(request: Request, user: dict = Depends(auth.require_admin)):
    """IN: importa oportunidades de um CSV enviado como corpo do request
    (multipart 'arquivo' ou corpo bruto). Upsert idempotente por CNPJ —
    reimportar o mesmo arquivo não duplica, só atualiza o estágio."""
    from tempfile import NamedTemporaryFile

    form = None
    try:
        form = await request.form()
    except Exception:
        pass
    conteudo = None
    if form and "arquivo" in form:
        conteudo = await form["arquivo"].read()
    else:
        conteudo = await request.body()
    if not conteudo:
        raise HTTPException(400, "envie o CSV como multipart 'arquivo' ou como corpo bruto")

    with NamedTemporaryFile(suffix=".csv", delete=False) as tmp:
        tmp.write(conteudo)
        caminho = tmp.name
    try:
        return importar(CSVCRMConnector(caminho))
    finally:
        import os as _os
        _os.unlink(caminho)


@app.get("/api/crm/oportunidades")
def crm_oportunidades(apenas_fechadas: bool = False, user: dict = Depends(auth.get_current_user)):
    return {"oportunidades": oportunidades(apenas_fechadas=apenas_fechadas)}


@app.post("/api/crm/exportar-recomendacoes")
def crm_exportar_recomendacoes(filial: str = "", limite: int = 50,
                               user: dict = Depends(auth.require_admin)):
    """OUT (write-back, spec A6): pega a fila priorizada atual e escreve
    score + fatores de volta no CRM. Sem provedor real conectado, grava em
    staging versionado — mesmo formato que um conector real enviaria."""
    r = fila.diaria(filial=filial, limite=limite, persistir=True)
    if not r["disponivel"]:
        raise HTTPException(409, r["motivo"])
    itens = [
        {"cliente_id": i["cliente_id"], "score": i["score"],
         "probabilidade": i["probabilidade"], "valor_esperado": i["valor_esperado"],
         "fatores": i["fatores"], "modelo_versao": r["modelo"]["versao"]}
        for i in r["itens"]
    ]
    return exportar_recomendacoes(CSVCRMConnector(), itens)


# ── comitê de compras (spec A5) ───────────────────────────────────────────
class ContatoReq(BaseModel):
    nome: str
    papel: str
    senioridade: str = ""
    canal_preferencial: str = ""
    email: str = ""
    telefone: str = ""


@app.get("/api/contas/{conta_id}/comite")
def comite_listar(conta_id: str, user: dict = Depends(auth.get_current_user)):
    data_layer.cliente(conta_id)   # aplica o escopo
    return {"contatos": comite.listar(conta_id), "completude": comite.completude(conta_id)}


@app.post("/api/contas/{conta_id}/comite")
def comite_adicionar(conta_id: str, body: ContatoReq,
                     user: dict = Depends(auth.get_current_user)):
    data_layer.cliente(conta_id)
    try:
        return comite.adicionar(conta_id, nome=body.nome, papel=body.papel,
                                senioridade=body.senioridade,
                                canal_preferencial=body.canal_preferencial,
                                email=body.email, telefone=body.telefone)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/contas/{conta_id}/comite/{contato_id}")
def comite_remover(conta_id: str, contato_id: int, user: dict = Depends(auth.get_current_user)):
    data_layer.cliente(conta_id)
    try:
        comite.remover(conta_id, contato_id)
        return {"removido": True}
    except ValueError as e:
        raise HTTPException(404, str(e))


# ── auditoria (§3.7) ─────────────────────────────────────────────────────
@app.get("/api/auditoria")
def auditoria(limit: int = 200, usuario: str = "", acao: str = "", resultado: str = "",
              user: dict = Depends(auth.require_admin)):
    """Trilha exportável pelo próprio cliente, sem depender de acesso ao banco.
    A consulta da trilha também é registrada na trilha — quem audita é
    auditado, senão o log de acessos tem um ponto cego do tamanho do admin."""
    audit.registrar("auditoria.consultar",
                    detalhe={"filtros": {"usuario": usuario, "acao": acao,
                                         "resultado": resultado}})
    return {"eventos": audit.consultar(limit=limit, usuario=usuario, acao=acao,
                                       resultado=resultado)}


# ── diagnóstico (sem auth — health check simples) ───────────────────────
@app.get("/api/health")
def health():
    return {
        "ok": True,
        "adapter": config.ADAPTER_ATIVO,
        "dado_disponivel": data_layer.disponivel(),
        "schema_versao": db.versao_aplicada(),
    }


@app.get("/api/metrics/runtime")
def metrics_runtime(user: dict = Depends(auth.require_admin)):
    """Latência p50/p95 e contagem por rota, da janela em memória. Só admin:
    o mapa de rotas e o volume de uso são informação operacional."""
    return telemetry.snapshot()


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
