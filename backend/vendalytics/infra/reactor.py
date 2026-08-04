"""
reactor.py — o consumidor do barramento de sinais (spec D-1/§3.6, Fase 5).

Este é o módulo que prova o diferencial central da spec: "um sinal
capturado no módulo de reputação alimenta automaticamente o scoring de
propensão de vendas". Sem ele, os módulos desta Fase (Sales, Geo,
Reputation, Field) são silos que só compartilham banco — com ele, um evento
de UM módulo muda o comportamento de OUTRO sem acoplamento direto: Sales
nunca importa `reputacao.py` nem `field.py`, só lê sinais derivados que
este reactor publicou.

── Por que não é um daemon assíncrono ─────────────────────────────────────
A spec (§3.6) descreve consumer groups Kafka rodando em background. Este
processo é síncrono (FastAPI + SQLite, sem worker separado), então o
reactor roda sob demanda: explicitamente via `POST /api/sinais/processar`,
e implicitamente no início de `fila.diaria()` (processa o que houver de
novo antes de montar a fila — barato quando não há nada pendente, porque a
query de `sinais_nao_processados` é O(sinais pendentes), não O(sinais
totais)). Trocar por um worker Kafka de verdade muda ONDE isto é chamado,
não o que as regras abaixo fazem.

── As duas regras implementadas ────────────────────────────────────────────
  reputation.mention (sentimento muito negativo, conta conhecida)
      → emite sales.priority_adjustment: penaliza o valor esperado do
        cliente na fila, com o motivo visível como fator explicativo
        (spec D-2: todo ajuste de score precisa de razão exposta).
  field.data_correction (tipo=pdv_fechado)
      → emite sales.account_flagged: o cliente sai da fila enquanto a
        curadoria não confirmar reabertura — recomendar visita a um PDV
        fechado é pior que não recomendar nada.
"""
from __future__ import annotations

from . import audit, context, scores

LIMIAR_SENTIMENTO_NEGATIVO = -0.30
PENALIDADE_REPUTACAO_PCT = 30  # redução no valor esperado, não zeragem — a
                               # conta continua existindo, só fica menos
                               # atrativa até o sinal sair da janela.


def _reagir_a_mencao(sinal: dict) -> None:
    payload = sinal.get("payload") or {}
    sentimento = payload.get("sentimento")
    if sentimento is None or sentimento > LIMIAR_SENTIMENTO_NEGATIVO:
        return
    scores.emitir_sinal(
        tipo="sales.priority_adjustment", sujeito_tipo=sinal["sujeito_tipo"],
        sujeito_id=sinal["sujeito_id"], origem="reactor:reputation.mention",
        payload={"ajuste_pct": -PENALIDADE_REPUTACAO_PCT,
                "motivo": f"menção negativa recente (sentimento {sentimento:.2f})",
                "sinal_origem_id": sinal["id"]})


def _reagir_a_correcao_de_campo(sinal: dict) -> None:
    payload = sinal.get("payload") or {}
    if payload.get("tipo_correcao") != "pdv_fechado":
        return
    scores.emitir_sinal(
        tipo="sales.account_flagged", sujeito_tipo=sinal["sujeito_tipo"],
        sujeito_id=sinal["sujeito_id"], origem="reactor:field.data_correction",
        payload={"motivo": "PDV reportado como fechado em visita de campo",
                "sinal_origem_id": sinal["id"]})


_REGRAS = {
    "reputation.mention": _reagir_a_mencao,
    "field.data_correction": _reagir_a_correcao_de_campo,
}


def processar_pendentes(*, limite: int = 500) -> dict:
    """Lê os sinais ainda não vistos do tenant corrente e aplica as regras.

    Idempotente: sinal já processado não é reprocessado (marcado em
    `sinais_processados`), então chamar isto repetidamente sem sinal novo é
    barato — é o que permite embutir a chamada no início de `fila.diaria()`
    sem custo perceptível no caminho comum.
    """
    escopo = context.atual()
    pendentes = scores.sinais_nao_processados(limit=limite)
    aplicados = 0
    for sinal in pendentes:
        regra = _REGRAS.get(sinal["tipo"])
        if regra:
            regra(sinal)
            aplicados += 1
        scores.marcar_processado(sinal["id"])
    if pendentes:
        audit.registrar("reactor.processar", detalhe={"tenant": escopo.tenant_id,
                        "sinais_lidos": len(pendentes), "regras_aplicadas": aplicados})
    return {"sinais_lidos": len(pendentes), "regras_aplicadas": aplicados}


def ajustes_de_prioridade(sujeito_tipo: str, sujeito_id: str, *, dias: int = 30) -> dict:
    """Resumo dos ajustes ativos sobre um cliente: penalidade acumulada e se
    está sinalizado para exclusão. `fila.py` consulta isto por item da fila."""
    ajustes = scores.sinais_recentes(sujeito_tipo, sujeito_id, "sales.priority_adjustment", dias=dias)
    flags = scores.sinais_recentes(sujeito_tipo, sujeito_id, "sales.account_flagged", dias=dias)
    penalidade_pct = sum(a["payload"].get("ajuste_pct", 0) for a in ajustes)
    return {
        "penalidade_pct": max(penalidade_pct, -80),  # nunca zera o cliente por acúmulo de sinais
        "motivos": [a["payload"].get("motivo", "") for a in ajustes],
        "sinalizado_para_exclusao": bool(flags),
        "motivo_exclusao": flags[0]["payload"].get("motivo") if flags else None,
    }
