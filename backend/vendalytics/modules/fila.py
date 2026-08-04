"""
fila.py — priorização e loop fechado (spec §5, passos 4 a 7).

A regra central: **score bruto não é prioridade**. Um cliente com 90% de
propensão e ticket de R$ 200 vale menos que um com 40% e ticket de R$ 5.000.
Ordenar pela propensão é o erro mais comum em produto de scoring — produz um
ranking correto e uma fila inútil.

Aqui a ordenação é por **valor esperado** (`probabilidade × ticket`), e a
saída é **finita**: 12 contas para o dia, não 4.000 linhas ordenadas. Uma
fila que não cabe no dia do vendedor não é priorização, é a mesma planilha
com outra cor.

O modelo é treinado sob demanda e mantido em cache por processo. É o
suficiente para a escala atual (uma carteira, milhares de clientes) e o
ponto exato onde entra um MLflow/registry quando houver mais de um tenant
por processo — a interface (`_modelo_de`) não muda.
"""
from __future__ import annotations

import time

from ..infra import audit, context, reactor
from ..infra import scores as repo
from . import propensao

TIPO_SCORE = "propensao_recompra"

# Piso de confiabilidade. Abaixo disto o modelo não discrimina melhor que
# uma moeda enviesada, e a fila é ruído ordenado — continua sendo entregue
# (o usuário pode querer ver), mas marcada como não confiável, bem visível.
# O alvo da spec (§7.1) é 0,78; 0,60 é o piso abaixo do qual não há o que
# defender. Esconder uma AUC ruim não melhora o modelo: só transfere a
# surpresa para o dia em que o vendedor percebe sozinho que a fila não serve.
AUC_MINIMA_CONFIAVEL = 0.60

_CACHE_TTL_S = 900
_cache: dict[tuple[str, str], tuple[float, propensao.Modelo | None]] = {}


def _modelo_de(filial: str) -> propensao.Modelo | None:
    chave = (context.atual().tenant_id, filial)
    agora = time.time()
    em_cache = _cache.get(chave)
    if em_cache and agora - em_cache[0] < _CACHE_TTL_S:
        return em_cache[1]
    modelo = propensao.treinar(filial=filial)
    _cache[chave] = (agora, modelo)
    return modelo


def invalidar_cache() -> None:
    """Chamado quando chega desfecho novo: o modelo em cache passou a estar
    desatualizado em relação ao que se sabe do mundo."""
    _cache.clear()


def diaria(*, filial: str = "", limite: int = 12, persistir: bool = True) -> dict:
    """A fila do dia: as N contas de maior valor esperado, com o porquê.

    `persistir=False` serve para pré-visualizar sem poluir o histórico de
    scores — útil em simulação e em teste.
    """
    modelo = _modelo_de(filial)
    if modelo is None:
        # Sem histórico para um split temporal honesto. Não inventa score:
        # diz o que falta. Um número aqui seria pior que nenhum número.
        return {
            "disponivel": False,
            "motivo": "histórico insuficiente para treinar o modelo com validação "
                      "out-of-time (é preciso ao menos ~3 horizontes de histórico)",
            "modelo": None,
            "itens": [],
        }

    # Processa sinais pendentes de OUTROS módulos (reputação, campo) antes de
    # montar a fila — é o barramento unificado (spec D-1) em ação: Sales
    # nunca importa reputacao.py/field.py, só reage ao que o reactor já
    # publicou. Idempotente e barato quando não há sinal novo.
    reactor.processar_pendentes()

    pontuados = propensao.pontuar(modelo, filial=filial)
    ativos, excluidos_por_sinal = [], 0
    for p in pontuados:
        ticket = p["features"]["ticket_medio"]
        p["ticket_medio"] = round(ticket, 2)
        p["valor_esperado"] = round(p["probabilidade"] * ticket, 2)
        # Decisão do modelo, não calibração: o quanto ele se afasta de "não
        # sei" (p=0,5). 0,51 é uma moeda; 0,95 ou 0,04 são leituras
        # decisivas. É um sinal real computado da própria predição — não um
        # valor inventado para preencher a UI.
        p["confianca"] = round(2 * abs(p["probabilidade"] - 0.5), 3)

        ajuste = reactor.ajustes_de_prioridade("cliente", p["cliente_id"])
        if ajuste["sinalizado_para_exclusao"]:
            # Recomendar visita a um PDV reportado como fechado é pior que
            # não recomendar nada — sai da fila até a curadoria confirmar.
            excluidos_por_sinal += 1
            continue
        if ajuste["penalidade_pct"]:
            p["valor_esperado"] = round(p["valor_esperado"] * (1 + ajuste["penalidade_pct"] / 100), 2)
            # O ajuste vira FATOR visível, não uma penalidade escondida —
            # spec D-2: toda mudança em um score carrega o motivo exposto.
            p["fatores"].append({
                "feature": "sinal_barramento",
                "rotulo": ajuste["motivos"][0] if ajuste["motivos"] else "ajustado por sinal de outro módulo",
                "contribuicao": round(ajuste["penalidade_pct"] / 100, 3),
                "valor_feature": None,
            })
        ativos.append(p)
    pontuados = ativos

    pontuados.sort(key=lambda d: d["valor_esperado"], reverse=True)
    selecionados = pontuados[: max(int(limite), 1)]

    for item in selecionados:
        item["score_id"] = repo.registrar(
            sujeito_tipo="cliente", sujeito_id=item["cliente_id"], tipo=TIPO_SCORE,
            valor=item["score"], probabilidade=item["probabilidade"],
            modelo_versao=modelo.versao,
            fatores=[repo.Fator(feature=f["feature"], rotulo=f["rotulo"],
                                contribuicao=f["contribuicao"],
                                valor_feature=f["valor_feature"])
                     for f in item["fatores"]],
        ) if persistir else None
        item.pop("features", None)

        # Segundo score da spec A3, SEMPRE ao lado da propensão — computado
        # só para os N selecionados (não para a carteira inteira, que pode
        # ter milhares de clientes e não vai aparecer na tela mesmo).
        try:
            from . import contactabilidade as _contact
            c = _contact.calcular(item["cliente_id"])
            item["contactabilidade"] = c["contactabilidade"] if c["disponivel"] else None
            item["contactabilidade_classe"] = (
                _contact.classificar(c["contactabilidade"]) if c["disponivel"] else None)
        except Exception:
            item["contactabilidade"] = None
            item["contactabilidade_classe"] = None

    audit.registrar("fila.gerada", recurso=f"filial:{filial or 'todas'}",
                    detalhe={"itens": len(selecionados), "modelo": modelo.versao})

    auc = modelo.metricas.get("auc_out_of_time")
    confiavel = auc is not None and auc >= AUC_MINIMA_CONFIAVEL
    return {
        "disponivel": True,
        # Qualidade do modelo exibida JUNTO da fila, não escondida numa aba de
        # admin: quem vai agir precisa saber o quanto o número merece confiança.
        "confiavel": confiavel,
        "aviso": None if confiavel else (
            f"AUC out-of-time de {auc} — o modelo mal separa quem vai recomprar "
            f"de quem não vai. Trate esta fila como exploratória, não como "
            f"priorização: o histórico desta carteira não tem padrão de "
            f"recompra suficiente para o modelo aprender."),
        "modelo": {"versao": modelo.versao, **modelo.metricas},
        "total_carteira_pontuada": len(pontuados),
        # Contas fora da fila porque o barramento sinalizou algo (ex.: PDV
        # fechado reportado em campo) — visível para não parecer que a
        # carteira encolheu sozinha.
        "excluidos_por_sinal_de_campo": excluidos_por_sinal,
        "itens": selecionados,
    }


def valores_esperados(*, filial: str = "") -> dict[str, float]:
    """cliente_id -> valor esperado, para uso fora da fila (ex.: `modules/mapa.py`).

    Não persiste score nem levanta se o modelo estiver indisponível — devolve
    vazio, e quem chama decide o que fazer com a ausência. Diferente de
    `diaria()`, que grava e recorta para os N do dia; aqui é o valor bruto
    para TODA a carteira pontuável, reaproveitando o mesmo modelo em cache.
    """
    modelo = _modelo_de(filial)
    if modelo is None:
        return {}
    return {p["cliente_id"]: round(p["probabilidade"] * p["features"]["ticket_medio"], 2)
            for p in propensao.pontuar(modelo, filial=filial)}


def pontuar_cliente(cliente_id: str, *, filial: str = "") -> dict | None:
    """Pontua UM cliente sob demanda e persiste o score.

    Existe porque `diaria()` só persiste os N da fila — e um usuário que
    abre um cliente fora da fila também precisa ver score e fatores. Sem
    isto, "não pontuado" apareceria para a maior parte da carteira, o que o
    usuário leria (corretamente) como o produto não ter opinião sobre ela.
    """
    modelo = _modelo_de(filial)
    if modelo is None:
        return None
    for p in propensao.pontuar(modelo, filial=filial):
        if p["cliente_id"] != cliente_id:
            continue
        repo.registrar(
            sujeito_tipo="cliente", sujeito_id=cliente_id, tipo=TIPO_SCORE,
            valor=p["score"], probabilidade=p["probabilidade"],
            modelo_versao=modelo.versao,
            fatores=[repo.Fator(feature=f["feature"], rotulo=f["rotulo"],
                                contribuicao=f["contribuicao"],
                                valor_feature=f["valor_feature"])
                     for f in p["fatores"]])
        return p
    return None


def explicacao(cliente_id: str, *, filial: str = "") -> dict:
    """Score atual + histórico de um cliente — a resposta a "por que mudou?"."""
    atual = repo.ultimo("cliente", cliente_id, TIPO_SCORE)
    if not atual and pontuar_cliente(cliente_id, filial=filial) is not None:
        atual = repo.ultimo("cliente", cliente_id, TIPO_SCORE)
    if not atual:
        return {"cliente_id": cliente_id, "score": None,
                "motivo": "cliente sem histórico de compra suficiente para pontuar"}
    return {
        "cliente_id": cliente_id,
        "score": atual["valor"],
        "probabilidade": atual["probabilidade"],
        "modelo_versao": atual["modelo_versao"],
        "calculado_em": atual["calculado_em"],
        "fatores": atual["fatores"],
        "historico": repo.historico("cliente", cliente_id, TIPO_SCORE, limit=20),
    }


DESFECHOS_VALIDOS = ("aceita", "recusada", "ganhou", "perdeu", "ignorada")


def registrar_desfecho(cliente_id: str, desfecho: str, *, motivo: str = "",
                       valor: float | None = None) -> dict:
    """Passo 6→7 do fluxo de valor: o que aconteceu depois da recomendação.

    `ignorada` é um desfecho de primeira classe, não a ausência de um: saber
    que o vendedor viu e não agiu é informação sobre a fila, e é o que
    permite separar "recomendação ruim" de "recomendação nunca entregue".
    """
    if desfecho not in DESFECHOS_VALIDOS:
        raise ValueError(f"desfecho inválido: '{desfecho}' "
                         f"(esperado um de {', '.join(DESFECHOS_VALIDOS)})")
    # Pontua sob demanda se preciso: o desfecho precisa apontar para o score
    # que motivou a ação, senão o retreino não sabe o que estava sendo
    # afirmado quando o vendedor agiu.
    atual = repo.ultimo("cliente", cliente_id, TIPO_SCORE)
    if not atual:
        pontuar_cliente(cliente_id)
        atual = repo.ultimo("cliente", cliente_id, TIPO_SCORE)
    desfecho_id = repo.registrar_desfecho(
        sujeito_tipo="cliente", sujeito_id=cliente_id, desfecho=desfecho,
        score_id=atual["id"] if atual else None, motivo=motivo, valor=valor)
    invalidar_cache()
    audit.registrar("recomendacao.desfecho", recurso=f"cliente:{cliente_id}",
                    detalhe={"desfecho": desfecho, "motivo": motivo})
    return {"desfecho_id": desfecho_id, "cliente_id": cliente_id, "desfecho": desfecho}


def saude_do_loop(*, dias: int = 30) -> dict:
    """A métrica mais importante da §7.4 — se cai, o produto parou de aprender."""
    cobertura = repo.cobertura_loop_fechado(tipo=TIPO_SCORE, dias=dias)
    desfechos = repo.desfechos_registrados()
    contagem: dict[str, int] = {}
    for d in desfechos:
        contagem[d["desfecho"]] = contagem.get(d["desfecho"], 0) + 1
    trabalhadas = sum(contagem.get(k, 0) for k in ("aceita", "ganhou", "perdeu"))
    total = sum(contagem.values())
    return {
        **cobertura,
        "por_desfecho": contagem,
        # Taxa de aceite da §7.1: quantas recomendações o vendedor trabalhou.
        # "ignorada" no denominador de propósito — ignorar é a resposta que
        # mais diz sobre a qualidade da fila.
        "taxa_aceite_pct": round(100 * trabalhadas / total, 1) if total else None,
    }
