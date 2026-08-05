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
from .infra import reactor
from .integracoes import hubspot_real, newsapi_real, salesforce_real, whapi_real
from .integracoes.console_messaging import ConsoleMessagingConnector
from .integracoes.csv_connector import CSVCRMConnector, exportar_recomendacoes, importar, oportunidades
from .integracoes.csv_mention_connector import CSVMentionSource
from .integracoes.hubspot_real import HubSpotConnector
from .integracoes.newsapi_real import NewsAPIMentionSource
from .integracoes.salesforce_real import SalesforceConnector
from .integracoes.whapi_real import WhapiMessagingConnector
from .sources import ibge_real, mercado_externo, rfb_real
from .modules import (agente, comite, comunicacao_kpi, contactabilidade,
                      executivo, field, fila, geo, identidade, mapa, mercado,
                      metrics, mix, orquestrador, recompra, relatorio,
                      reputacao, semantico, territorio)

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
    _resetar_senha_via_env_se_pedido()
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
    _prequecer_modelo_de_propensao()


def _resetar_senha_via_env_se_pedido() -> None:
    """Caminho de recuperação de senha para planos free do Render, que não
    oferecem Shell/One-Off Jobs: se ADMIN_RESET_EMAIL e ADMIN_RESET_PASSWORD
    estiverem definidas no ambiente, aplica essa senha ao e-mail indicado
    (cria o usuário se ainda não existir) a cada boot.

    Roda em TODO restart enquanto essas variáveis continuarem no ambiente —
    por isso o log abaixo insiste para removê-las assim que o login for
    confirmado: senha em texto puro num painel de env vars é exatamente o
    tipo de exposição que já aconteceu antes neste projeto."""
    email = os.getenv("ADMIN_RESET_EMAIL", "").strip()
    senha = os.getenv("ADMIN_RESET_PASSWORD", "").strip()
    if not email or not senha:
        return
    auth.redefinir_senha(email, senha)
    log.warning(
        "Senha redefinida via ADMIN_RESET_EMAIL/ADMIN_RESET_PASSWORD para %s. "
        "REMOVA essas duas variáveis de ambiente agora que o login funciona — "
        "elas ficam visíveis em texto puro no painel do Render e serão "
        "reaplicadas a cada novo deploy/restart enquanto continuarem lá.",
        email)


def _prequecer_modelo_de_propensao() -> None:
    """Treina o modelo de propensão AGORA, no boot do servidor, em vez de na
    primeira visita de um usuário à Fila do dia/Campo.

    Por que isso importa de verdade: o treino é gradient descent puro Python
    sobre toda a carteira, e em CPU compartilhada/limitada (ex.: Render free
    tier) é caro o bastante para estourar o timeout de uma request HTTP —
    era exatamente por isso que essas telas ficavam presas em "Carregando..."
    para sempre. Mover o custo para o startup (onde alguns segundos a mais
    não incomodam ninguém, e falha não derruba a aplicação) resolve isso sem
    tocar em UI nenhuma. O cache de `fila._modelo_de` (15 min) faz o resto:
    todo request de usuário dentro dessa janela reaproveita este treino."""
    import time
    try:
        escopo = context.escopo_de_sistema(tenant.carregar().nome_curto, motivo="prequecer-modelo")
        t0 = time.perf_counter()
        with context.ativar(escopo):
            modelo = fila._modelo_de("")
        segundos = time.perf_counter() - t0
        if modelo is None:
            log.info("Pré-aquecimento: sem histórico suficiente para treinar ainda (%.1fs).", segundos)
        else:
            log.info("Modelo de propensão pré-aquecido em %.1fs (AUC out-of-time: %s).",
                     segundos, modelo.metricas.get("auc_out_of_time"))
    except Exception as e:
        # Nunca derruba o startup por causa disto — pior caso, a primeira
        # request de usuário treina na hora, como acontecia antes.
        log.warning("Pré-aquecimento do modelo falhou (seguindo sem ele): %s", e)


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


@app.get("/api/clientes/mapa")
def clientes_mapa(bbox: str = "", texto: str = "", filial: str = "",
                  limit: int = 1500, offset: int = 0,
                  user: dict = Depends(auth.get_current_user)):
    """Mesma listagem de `/api/clientes`, enriquecida com `valor_esperado`
    (modelo de propensão) e `atividade` (deltas mensais, últimos 6 meses) —
    o que o mapa usa para raio/sparkline do ponto. Separado do endpoint
    genérico para não pagar o custo de rodar o modelo em toda consulta."""
    bb = None
    if bbox:
        partes = [float(x) for x in bbox.split(",")]
        if len(partes) == 4:
            bb = tuple(partes)
    return mapa.pontos(bbox=bb, texto=texto, filial=filial, limit=limit, offset=offset)


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
    `aviso` preenchido quando o cache de mercado público ainda não tem
    nenhuma empresa do segmento catalogada — nunca finge whitespace=0 por
    falta de dado. Ver `/api/territorio/enriquecer-cnpj/{cnpj}` para
    alimentar o cache."""
    return mercado.tam_sam_som(filial=filial, segmento=segmento, uf=uf)


@app.get("/api/territorio/enriquecer-cnpj/{cnpj}")
def territorio_enriquecer_cnpj(cnpj: str, user: dict = Depends(auth.get_current_user)):
    """Consulta 1 CNPJ real na Receita Federal (BrasilAPI) e adiciona ao
    cache de mercado público — é assim que o universo do TAM cresce (não
    existe "baixar tudo de uma vez" sem o dump oficial da RFB, dezenas de
    GB). Uso típico: enriquecer um prospect novo, ou rodar sobre uma lista
    de CNPJs conhecidos da praça antes de olhar o TAM→SAM→SOM."""
    empresa = mercado_externo.consultar_e_cachear(cnpj)
    if empresa is None:
        raise HTTPException(404, "CNPJ inválido, não encontrado, ou fonte indisponível")
    return empresa


@app.get("/api/territorio/municipios")
def territorio_municipios(uf: str, user: dict = Depends(auth.get_current_user)):
    """Municípios de uma UF (IBGE, real, sem chave) — alimenta o filtro
    Estado→Município do Relatório de Praça. 502 se o IBGE estiver fora do
    ar (não é erro de quem chamou)."""
    municipios = ibge_real.municipios_por_uf(uf)
    if municipios is None:
        raise HTTPException(502, "IBGE indisponível no momento")
    return {"uf": uf.upper(), "municipios": municipios}


@app.get("/api/territorio/municipio-info")
def territorio_municipio_info(municipio: str, uf: str, user: dict = Depends(auth.get_current_user)):
    """População estimada (IBGE) de 1 município — o mesmo dado que já
    alimenta a camada sociodemográfica do simulador de Geo
    (`ibge_real.camada_para_ponto`), exposto aqui para os KPIs do Relatório
    de Praça sem duplicar a integração."""
    return ibge_real.camada_para_ponto(municipio, uf)


@app.get("/api/territorio/prospects")
def territorio_prospects(cnpjs: str, user: dict = Depends(auth.get_current_user)):
    """Consulta em lote de CNPJs reais (BrasilAPI/RFB) para a tabela de
    prospecção do Relatório de Praça — mesma fonte de
    `/api/territorio/enriquecer-cnpj`, em lote. `cnpjs` é uma lista separada
    por vírgula; cada CNPJ consultado também alimenta o cache de mercado
    público (mesmo efeito colateral de enriquecer-cnpj)."""
    lista = [c.strip() for c in cnpjs.split(",") if c.strip()]
    if not lista:
        raise HTTPException(400, "informe ao menos um CNPJ")
    if len(lista) > 20:
        raise HTTPException(400, "no máximo 20 CNPJs por consulta")
    return {"prospects": rfb_real.consultar_lote(lista)}


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


@app.get("/api/fila/contactabilidade/{customer_id}")
def fila_contactabilidade(customer_id: str, user: dict = Depends(auth.get_current_user)):
    """Segundo score da spec A3 — sempre para ser lido AO LADO da propensão,
    nunca sozinho: lead de propensão alta e contactabilidade baixa é caro."""
    data_layer.cliente(customer_id)
    return contactabilidade.calcular(customer_id)


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


# ── Geo Intelligence (spec §2.2, Fase 2) ──────────────────────────────────
@app.get("/api/geo/simular")
def geo_simular(lat: float, lon: float, filial: str = "", raio_km: float = 5.0,
                vertical: str = "", municipio: str = "", uf: str = "", abl_m2: float = 0,
                user: dict = Depends(auth.get_current_user)):
    """Score de atratividade de um ponto candidato, ponderado por proximidade
    (Huff), com camada sociodemográfica real do IBGE quando o município é
    resolvido. Componentes sem dado real (concorrência) aparecem como
    `null` em `componentes_nao_disponiveis`, nunca como 0.

    `vertical` (spec B5, opcional): shopping_center | midia_externa |
    condominios — anexa contexto específico do negócio, à parte do score
    genérico. `municipio`/`uf`/`abl_m2` alimentam parâmetros do pack."""
    params = {k: v for k, v in {"municipio": municipio, "uf": uf, "abl_m2": abl_m2 or None}.items()
             if v}
    return geo.simular_ponto(lat, lon, filial=filial, raio_km=raio_km,
                             vertical=vertical, parametros_vertical=params)


@app.get("/api/geo/verticais")
def geo_verticais_disponiveis(user: dict = Depends(auth.get_current_user)):
    from .modules.verticais import PACKS
    return {"packs": list(PACKS)}


@app.get("/api/geo/similaridade-filiais")
def geo_similaridade(user: dict = Depends(auth.get_current_user)):
    """Comparador de similaridade entre filiais (spec B2) — base para
    transferir aprendizado de precificação/sortimento entre unidades."""
    return geo.similaridade_entre_filiais()


@app.get("/api/geo/faturamento-previsto")
def geo_faturamento_previsto(filial: str, user: dict = Depends(auth.get_current_user)):
    """Preditor de faturamento com intervalo de confiança (spec B3) — nunca
    ponto único, sempre com o erro histórico do método ao lado (backtest)."""
    return geo.prever_faturamento(filial)


# ── Reputation Intelligence (spec §2.3, Fase 3) ───────────────────────────
@app.post("/api/reputacao/importar-csv")
async def reputacao_importar_csv(request: Request, filial: str = "",
                                 user: dict = Depends(auth.require_admin)):
    """Importa menções de um CSV (multipart 'arquivo' ou corpo bruto).
    Classifica sentimento por léxico, deduplica por similaridade e casa com
    conta conhecida — publicando sinal no barramento quando casa (spec D-1)."""
    from tempfile import NamedTemporaryFile

    form = None
    try:
        form = await request.form()
    except Exception:
        pass
    conteudo = await form["arquivo"].read() if form and "arquivo" in form else await request.body()
    if not conteudo:
        raise HTTPException(400, "envie o CSV como multipart 'arquivo' ou como corpo bruto")

    with NamedTemporaryFile(suffix=".csv", delete=False) as tmp:
        tmp.write(conteudo)
        caminho = tmp.name
    try:
        return reputacao.importar(CSVMentionSource(caminho), filial=filial)
    finally:
        import os as _os
        _os.unlink(caminho)


@app.get("/api/reputacao/mencoes")
def reputacao_mencoes(dias: int = 30, apenas_negativas: bool = False, conta_ref: str = "",
                      limit: int = 200, user: dict = Depends(auth.get_current_user)):
    """Menções deduplicadas — só o representante de cada cluster de
    replicação aparece (spec: 40 portais republicando a mesma nota são UM
    evento, não 40)."""
    return {"mencoes": reputacao.mencoes(dias=dias, apenas_negativas=apenas_negativas,
                                        conta_ref=conta_ref, limit=limit)}


@app.get("/api/reputacao/resumo")
def reputacao_resumo(dias: int = 30, user: dict = Depends(auth.get_current_user)):
    return reputacao.resumo_sentimento(dias=dias)


@app.get("/api/reputacao/benchmarking")
def reputacao_benchmarking(dias: int = 30, user: dict = Depends(auth.get_current_user)):
    return reputacao.benchmarking(dias=dias)


@app.get("/api/reputacao/correlacao-negocio")
def reputacao_correlacao_negocio(filial: str = "", dias: int = 90,
                                 user: dict = Depends(auth.get_current_user)):
    """C3: correlação REAL medida entre sentimento diário e faturamento
    diário — não um mapeamento fixo de nomes. Abaixo do piso de amostra,
    sai marcado como não confiável (nunca escondido)."""
    return comunicacao_kpi.correlacionar_sentimento_com_faturamento(filial=filial, dias=dias)


@app.post("/api/reputacao/relatorio-executivo")
def reputacao_relatorio_executivo(filial: str = "", dias: int = 30,
                                  user: dict = Depends(auth.require_admin)):
    """C4: relatório sempre disponível como fatos estruturados; prosa
    gerada por LLM só se GROQ_API_KEY estiver configurado — grounded nos
    mesmos dados, nunca inventando número. Persiste snapshot para a seção
    fixa 'o que mudou desde o último relatório' da próxima chamada."""
    return relatorio.gerar(filial=filial, dias=dias)


@app.post("/api/reputacao/checar-anomalia")
def reputacao_checar_anomalia(dia: str = "", user: dict = Depends(auth.require_admin)):
    """Dispara a checagem de anomalia de volume (spec C5). Em produção seria
    um job agendado; aqui é explícito para não depender de scheduler."""
    return reputacao.checar_anomalia_de_volume(dia=dia)


@app.get("/api/reputacao/alertas")
def reputacao_alertas(limit: int = 50, user: dict = Depends(auth.get_current_user)):
    return {"alertas": reputacao.alertas(limit=limit)}


# ── Field Execution (spec §2.4, Fase 4) ───────────────────────────────────
@app.get("/api/field/gap/{cliente_id}")
def field_gap(cliente_id: str, user: dict = Depends(auth.get_current_user)):
    """Gap de mix LOCAL (spec D1): categorias que os vizinhos geográficos +
    de segmento compram e este cliente não. Aplica o escopo via `cliente()`."""
    data_layer.cliente(cliente_id)
    return field.gap_cliente(cliente_id)


@app.get("/api/field/sugestao/{cliente_id}")
def field_sugestao(cliente_id: str, user: dict = Depends(auth.get_current_user)):
    """A pergunta do vendedor de campo: "o que levo para este cliente hoje?"
    Resposta 100% grounded — nenhum texto gerado livremente, cada número vem
    do próprio cálculo do gap."""
    data_layer.cliente(cliente_id)
    return field.sugestao_para_cliente(cliente_id)


@app.get("/api/field/roteiro-do-dia")
def field_roteiro(filial: str = "", limite: int = 12,
                  user: dict = Depends(auth.get_current_user)):
    """Fusão Geo+Sales (spec D1): a fila priorizada de propensão, com o gap
    de mix local anexado a cada parada."""
    return field.roteiro_do_dia(filial=filial, limite=limite)


@app.post("/api/field/enviar-roteiro")
def field_enviar_roteiro(filial: str = "", limite: int = 12,
                         user: dict = Depends(auth.require_admin)):
    """Envia o roteiro do dia pelo canal de mensageria (spec D2). Sem token
    WHAPI validado, grava em staging — mesmo formato que o envio real usaria."""
    r = field.roteiro_do_dia(filial=filial, limite=limite)
    if not r["disponivel"]:
        raise HTTPException(409, r["motivo"])
    conector = ConsoleMessagingConnector()
    enviados = 0
    for parada in r["paradas"]:
        texto = f"Cliente {parada['cliente_id']}: "
        if parada["gap_de_mix"]:
            texto += parada["gap_de_mix"][0]["argumento"]
        else:
            texto += "sem gap de mix identificado hoje."
        res = conector.enviar(parada["cliente_id"], texto)
        enviados += 1 if res.get("enviado") else 0
    return {"paradas": len(r["paradas"]), "enviados": enviados}


class CorrecaoReq(BaseModel):
    tipo: str
    detalhe: str = ""


@app.post("/api/field/correcao/{cliente_id}")
def field_correcao(cliente_id: str, body: CorrecaoReq,
                   user: dict = Depends(auth.get_current_user)):
    """Divergência reportada em campo (spec D3) — nunca edita o cadastro
    sozinho, só registra e publica o sinal para o barramento."""
    data_layer.cliente(cliente_id)
    try:
        return field.registrar_correcao(cliente_id, body.tipo, detalhe=body.detalhe)
    except ValueError as e:
        raise HTTPException(400, str(e))


class VisitaReq(BaseModel):
    pedido_gerado: bool
    itens: list[str] = []
    motivo_recusa: str = ""


@app.post("/api/field/visita/{cliente_id}")
def field_visita(cliente_id: str, body: VisitaReq,
                 user: dict = Depends(auth.get_current_user)):
    data_layer.cliente(cliente_id)
    return field.registrar_visita(cliente_id, pedido_gerado=body.pedido_gerado,
                                  itens=body.itens, motivo_recusa=body.motivo_recusa)


# ── conectores reais (spec A6/C1/D2) ──────────────────────────────────────
# Nenhum destes foi validado contra a API real do provedor — sem credencial
# neste ambiente para testar. `configurado()` degrada honesto quando a env
# var não está setada, em vez de tentar e falhar com erro confuso.
@app.get("/api/integracoes/status")
def integracoes_status(user: dict = Depends(auth.require_admin)):
    """O que está configurado de verdade neste ambiente — para o admin saber
    o que vai funcionar antes de tentar."""
    return {
        "salesforce": salesforce_real.configurado(),
        "hubspot": hubspot_real.configurado(),
        "whapi": whapi_real.configurado(),
        "newsapi": newsapi_real.configurado(),
        "agente_llm": agente.configurado(),
    }


@app.post("/api/crm/salesforce/importar")
def crm_salesforce_importar(user: dict = Depends(auth.require_admin)):
    if not salesforce_real.configurado():
        raise HTTPException(409, "Salesforce não configurado (faltam variáveis de ambiente)")
    return importar(SalesforceConnector())


@app.post("/api/crm/hubspot/importar")
def crm_hubspot_importar(user: dict = Depends(auth.require_admin)):
    if not hubspot_real.configurado():
        raise HTTPException(409, "HubSpot não configurado (falta HUBSPOT_ACCESS_TOKEN)")
    return importar(HubSpotConnector())


@app.post("/api/reputacao/newsapi/importar")
def reputacao_newsapi_importar(termo: str, user: dict = Depends(auth.require_admin)):
    """`termo` é obrigatório — normalmente o nome do tenant. Sem termo a
    busca traria manchete do mundo inteiro, não menções à empresa."""
    if not newsapi_real.configurado():
        raise HTTPException(409, "NewsAPI não configurada (falta NEWSAPI_KEY)")
    return reputacao.importar(NewsAPIMentionSource(termo))


class EnviarMensagemReq(BaseModel):
    destinatario: str
    texto: str


@app.post("/api/field/whapi/enviar")
def field_whapi_enviar(body: EnviarMensagemReq, user: dict = Depends(auth.require_admin)):
    if not whapi_real.configurado():
        raise HTTPException(409, "WHAPI não configurado (falta WHAPI_TOKEN)")
    return WhapiMessagingConnector().enviar(body.destinatario, body.texto)


# ── agente A7 (rascunho grounded, spec A7) ────────────────────────────────
@app.post("/api/orquestrador/executar-ciclo")
def orquestrador_executar_ciclo(filial: str = "", meta_contas: int = 12,
                                redigir_abordagens: bool = True,
                                user: dict = Depends(auth.require_admin)):
    """Ciclo A7 completo: planejar→priorizar→executar(redigir)→medir→
    re-aprender, numa chamada. Nunca envia nada — ver aviso na resposta e
    a docstring de `modules/orquestrador.py`."""
    return orquestrador.executar_ciclo(filial=filial, meta_contas=meta_contas,
                                       redigir_abordagens=redigir_abordagens)


@app.get("/api/agente/rascunho/{cliente_id}")
def agente_rascunho(cliente_id: str, user: dict = Depends(auth.get_current_user)):
    """Redige um rascunho de abordagem — NUNCA envia nada sozinho. Enviar é
    uma chamada separada e explícita (`/api/field/whapi/enviar`), sempre
    depois de revisão humana do texto e dos fatos usados."""
    data_layer.cliente(cliente_id)
    return agente.redigir_abordagem(cliente_id)


# ── construtor no-code + NL→consulta (spec D-3) ───────────────────────────
@app.get("/api/semantico/modelo")
def semantico_modelo(user: dict = Depends(auth.get_current_user)):
    """Métricas e dimensões disponíveis — o que alimenta os dropdowns do
    construtor no-code. Não existe SQL livre neste módulo: é sempre uma
    escolha dentro deste registro fechado."""
    return semantico.modelo()


@app.get("/api/semantico/consultar")
def semantico_consultar(metrica: str, dimensao: str = "", filial: str = "",
                        user: dict = Depends(auth.get_current_user)):
    return semantico.consultar(metrica=metrica, dimensao=dimensao, filial=filial)


@app.get("/api/semantico/perguntar")
def semantico_perguntar(pergunta: str, filial: str = "",
                        user: dict = Depends(auth.get_current_user)):
    """NL→consulta: parser determinístico primeiro (sempre disponível),
    LLM só como fallback se não reconhecer nada e GROQ estiver configurado
    — e mesmo o LLM só escolhe entre métricas/dimensões já registradas."""
    return semantico.perguntar(pergunta, filial=filial)


# ── barramento de sinais (spec D-1/§3.6, Fase 5) ──────────────────────────
@app.post("/api/sinais/processar")
def sinais_processar(user: dict = Depends(auth.require_admin)):
    """Dispara o reactor manualmente. `fila.diaria()` já chama isto sozinha
    no início — este endpoint existe para inspecionar o efeito sem precisar
    montar a fila inteira, e para o caso de um scheduler externo preferir
    processar em cadência própria em vez de sob demanda."""
    return reactor.processar_pendentes()


@app.get("/api/sinais/ajustes/{cliente_id}")
def sinais_ajustes(cliente_id: str, user: dict = Depends(auth.get_current_user)):
    """O que o barramento sabe sobre este cliente agora: penalidade
    acumulada de reputação, e se está sinalizado para sair da fila."""
    data_layer.cliente(cliente_id)
    return reactor.ajustes_de_prioridade("cliente", cliente_id)


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
