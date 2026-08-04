"""
orquestrador.py — o ciclo A7 completo: `planejar → priorizar → executar →
medir → re-aprender` (spec §2.1 A7), composto sobre módulos que já existiam
e já eram testados individualmente — este módulo não introduz lógica de
negócio nova, só ORQUESTRA a chamada em sequência e devolve o resultado
consolidado de cada etapa.

── Onde está a "autonomia", e onde ela para ────────────────────────────────
`executar_ciclo()` roda os cinco passos automaticamente numa chamada só —
isso é a autonomia real que a spec pede: ninguém precisa disparar cada
etapa manualmente. O limite está em QUAL TIPO de autonomia:

  planejar    → determinístico (`fila.py`), sem julgamento de IA.
  priorizar   → determinístico (`fila.py`), sem julgamento de IA.
  executar    → IA entra aqui, e só para REDIGIR (`modules/agente.py`).
                Nunca envia. Enviar é uma chamada separada e explícita
                (`integracoes/*_real.py::enviar`), sempre depois de revisão
                humana — a mesma linha que a spec §3.3 desenha: "ação com
                efeito colateral exige confirmação".
  medir       → determinístico (`fila.py::saude_do_loop`), lê o que já
                aconteceu — não julga, relata.
  re-aprender → determinístico (`fila.py::invalidar_cache`), sem IA.

Ou seja: o orquestrador decide sozinho QUANDO rodar o ciclo (se for
agendado) e COMPÕE as cinco etapas sem intervenção humana entre elas — mas
nenhuma etapa escreve num sistema externo nem gasta dinheiro/reputação da
empresa sem uma confirmação humana no meio. É a interpretação responsável
de "agente autônomo" para um sistema que toca CRM e canal do cliente.
"""
from __future__ import annotations

from datetime import datetime, timezone

from ..infra import audit, context
from . import agente, fila


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def executar_ciclo(*, filial: str = "", meta_contas: int = 12,
                   redigir_abordagens: bool = True) -> dict:
    """Roda o ciclo completo uma vez. Idempotente na medida em que
    `fila.diaria()` já é (mesmo racional de cache/versionamento de score);
    rodar duas vezes no mesmo dia não duplica nada, só reavalia.
    """
    escopo = context.atual()
    iniciado_em = _agora()
    etapas: dict = {}

    # 1. Planejar + 2. Priorizar — a fila finita JÁ é o planejamento (spec
    # §5: "não é ranking de 4.000, é fila executável do dia").
    fila_do_dia = fila.diaria(filial=filial, limite=meta_contas, persistir=True)
    etapas["planejar_priorizar"] = {
        "disponivel": fila_do_dia["disponivel"],
        "motivo": fila_do_dia.get("motivo"),
        "itens_priorizados": len(fila_do_dia.get("itens", [])),
        "confiavel": fila_do_dia.get("confiavel"),
    }

    # 3. Executar — só REDIGIR (nunca enviar). Best-effort por item: um
    # cliente sem dado suficiente para o agente não derruba os outros.
    rascunhos = []
    if fila_do_dia["disponivel"] and redigir_abordagens:
        for item in fila_do_dia["itens"]:
            r = agente.redigir_abordagem(item["cliente_id"])
            rascunhos.append({"cliente_id": item["cliente_id"], "disponivel": r["disponivel"],
                              "texto": r.get("texto"), "motivo": r.get("motivo")})
    etapas["executar"] = {
        "rascunhos_gerados": sum(1 for r in rascunhos if r["disponivel"]),
        "rascunhos_indisponiveis": sum(1 for r in rascunhos if not r["disponivel"]),
        "agente_configurado": agente.configurado(),
        "itens": rascunhos,
    }

    # 4. Medir — lê o que já aconteceu com o ciclo anterior (não o que
    # acabou de rodar agora: desfecho leva tempo humano para acontecer).
    saude = fila.saude_do_loop()
    etapas["medir"] = saude

    # 5. Re-aprender — invalida o modelo em cache para que o próximo ciclo
    # reflita qualquer desfecho registrado desde então. Retreino de verdade
    # (novo split temporal) só acontece na próxima chamada de `_modelo_de`,
    # que é lazy — não força um retreino caro aqui sem necessidade.
    fila.invalidar_cache()
    etapas["re_aprender"] = {"cache_invalidado": True}

    resultado = {
        "disponivel": True,
        "tenant_id": escopo.tenant_id,
        "iniciado_em": iniciado_em,
        "concluido_em": _agora(),
        "etapas": etapas,
        "aviso": "ciclo redige, nunca envia — envio é uma chamada humana separada, "
                "sempre depois de revisão do rascunho e dos fatos usados",
    }
    audit.registrar("orquestrador.ciclo", recurso=f"filial:{filial or 'todas'}",
                    detalhe={"itens_priorizados": etapas["planejar_priorizar"]["itens_priorizados"],
                            "rascunhos_gerados": etapas["executar"]["rascunhos_gerados"]})
    return resultado
