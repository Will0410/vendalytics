"""
agente.py — o pedaço seguro de A7: "Executar: redige a abordagem
personalizada" (spec §2.1 A7). NÃO é o agente orquestrador completo da spec.

O que a spec pede para A7 é um ciclo `planejar → priorizar → executar →
medir → re-aprender` autônomo. Este módulo implementa só o "executar"
(redação), porque é o único passo do ciclo que precisa de geração de
linguagem natural — os outros quatro **já existem** e não precisam de LLM
nenhum:

  planejar   → `fila.diaria()` já decide quantas contas atacar (a fila
               finita é o planejamento).
  priorizar  → `fila.diaria()` já ordena por valor esperado.
  executar   → REDAÇÃO fica aqui (`redigir_abordagem`); ENVIO é uma ação
               separada e explícita via `integracoes/messaging_base.py` —
               nunca a mesma chamada que redige. Separar os dois é o
               guardrail mais importante deste módulo: gerar texto não tem
               efeito colateral, enviar tem, e a spec (§3.3) exige que ação
               com efeito colateral peça confirmação. Aqui a confirmação é
               estrutural: são dois endpoints diferentes, o segundo nunca é
               chamado automaticamente pelo primeiro.
  medir      → `fila.registrar_desfecho()` já existe (Fase 1).
  re-aprender→ `fila.invalidar_cache()` + retreino já existem (Fase 1).

Não construí o "orquestrador" que decide sozinho quando planejar, priorizar
etc. — isso seria um agente com agência de verdade sobre o CRM, e a spec
(§3.3) exige orçamento de passos e allowlist de ferramentas para isso, que
não faz sentido desenhar sem um caso de uso real testando os limites. O que
existe aqui é o degrau mínimo e seguro: geração de texto, sempre grounded,
sempre revisável por humano antes de qualquer envio.

── Groundedness ────────────────────────────────────────────────────────────
O prompt instrui explicitamente a não inventar números/prazos/promoções, e
só os fatos calculados por outros módulos (nunca opinião do modelo) entram
no contexto. Não há verificação automática de que o modelo obedeceu — isso
exigiria um segundo classificador ou parsing estruturado que este MVP não
tem. Por isso o fluxo nunca envia sozinho: o rascunho volta junto com os
fatos usados, para revisão humana antes do primeiro clique de envio.
"""
from __future__ import annotations

import logging

import httpx

from .. import config, data_layer
from ..infra import audit
from . import fila

log = logging.getLogger("vendalytics.modules.agente")

MODELO_VERSAO_PROMPT = "agente-redator-v1"
MAX_TOKENS_RESPOSTA = 300  # orçamento de saída — guardrail explícito (spec §3.3)

_SYSTEM_PROMPT = (
    "Você é um assistente de vendas de uma distribuidora. Redija uma "
    "abordagem comercial curta (3 a 4 frases, tom profissional e direto) "
    "para um vendedor usar ao contatar o cliente descrito.\n\n"
    "REGRAS OBRIGATÓRIAS:\n"
    "1. Use APENAS os fatos fornecidos abaixo. Nunca invente números, "
    "prazos, promoções, descontos ou qualquer dado que não esteja na lista.\n"
    "2. Se um fato não estiver disponível, simplesmente não o mencione — "
    "não preencha a lacuna com suposição.\n"
    "3. Não prometa nada em nome da empresa (preço, prazo, condição) que "
    "não esteja explicitamente nos fatos.\n"
    "4. Responda só com o texto da abordagem, sem saudação inicial tipo "
    "'Claro, aqui está'."
)


def configurado() -> bool:
    return bool(config.GROQ_API_KEY)


def _coletar_fatos(cliente_id: str) -> dict:
    """Todos os fatos vêm de módulos que já existem — o agente não calcula
    nada, só resume o que outros módulos já sabem, em linguagem que o LLM
    consegue costurar em texto."""
    cliente = data_layer.cliente(cliente_id)
    fatos: dict = {"cliente_id": cliente_id}
    if cliente:
        fatos["municipio"] = cliente.get("municipio")
        fatos["uf"] = cliente.get("uf")
        fatos["segmento"] = cliente.get("segmento")

    explicacao = fila.explicacao(cliente_id)
    if explicacao.get("score") is not None:
        fatos["score_propensao"] = explicacao["score"]
        fatos["fatores_propensao"] = [f["rotulo"] for f in explicacao.get("fatores", [])[:3]]

    try:
        from . import field
        gap = field.gap_cliente(cliente_id)
        if gap.get("disponivel") and gap["categorias_gap"]:
            top = gap["categorias_gap"][0]
            fatos["gap_de_mix"] = (f"{top['peers_compraram']} de {top['peers_total']} clientes "
                                   f"vizinhos compram {top['categoria']} e este cliente não")
    except Exception:
        pass  # gap é enriquecimento opcional — ausência dele não impede a abordagem

    return fatos


def redigir_abordagem(cliente_id: str) -> dict:
    """Gera o rascunho. Nunca envia nada — ver docstring do módulo."""
    if not configurado():
        return {"disponivel": False, "motivo": "GROQ_API_KEY não configurado"}

    fatos = _coletar_fatos(cliente_id)
    if len(fatos) <= 1:  # só cliente_id, sem nenhum dado real
        return {"disponivel": False, "motivo": "sem dados suficientes sobre este cliente"}

    linhas_fatos = "\n".join(f"- {k}: {v}" for k, v in fatos.items() if k != "cliente_id")
    mensagens = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": f"Fatos sobre o cliente:\n{linhas_fatos}"},
    ]

    try:
        r = httpx.post(
            f"{config.GROQ_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {config.GROQ_API_KEY}"},
            json={"model": config.GROQ_MODEL, "messages": mensagens,
                 "temperature": 0.3, "max_tokens": MAX_TOKENS_RESPOSTA},
            timeout=config.HTTP_TIMEOUT_S,
        )
        r.raise_for_status()
        corpo = r.json()
        texto = corpo["choices"][0]["message"]["content"].strip()
    except httpx.HTTPStatusError as e:
        log.warning("Groq recusou a chamada: %s", e)
        return {"disponivel": False, "motivo": f"HTTP {e.response.status_code}: {e.response.text[:200]}"}
    except httpx.HTTPError as e:
        log.warning("Groq indisponível: %s", e)
        return {"disponivel": False, "motivo": str(e)}
    except (KeyError, IndexError, TypeError):
        return {"disponivel": False, "motivo": "resposta do modelo em formato inesperado"}

    audit.registrar("agente.redigir_abordagem", recurso=f"cliente:{cliente_id}",
                    detalhe={"modelo": config.GROQ_MODEL})
    return {
        "disponivel": True,
        "cliente_id": cliente_id,
        "texto": texto,
        "fatos_usados": fatos,
        "modelo": config.GROQ_MODEL,
        "aviso": "rascunho gerado por LLM — revise antes de enviar; groundedness não é "
                "verificada automaticamente, só o conjunto de fatos passado é controlado",
    }
