"""
analise_ia.py — a camada de IA da plataforma de inteligência de mercado.

Mesmo contrato de `modules/relatorio.py` e `modules/agente.py`, aplicado ao
dashboard novo: **o LLM redige, ele não calcula**.

── Por que grounded, e não "pergunte ao modelo sobre o mercado" ────────────
Um LLM perguntado direto "quantas empresas de comércio existem em Curitiba?"
responde com um número plausível e errado, com a mesma confiança com que
responde um número certo. Num painel que sustenta decisão de investimento em
praça, isso é pior que não ter IA nenhuma — o erro entra na apresentação e
ninguém confere.

Aqui o caminho é o inverso: o front calcula os fatos a partir do IBGE e da
BrasilAPI, manda **os fatos já computados** para cá, e o modelo só costura a
leitura por cima. Se um número não está no payload, o modelo é instruído a
dizer que não está disponível — nunca a estimar.

── Por que a chave fica aqui e não no navegador ────────────────────────────
`GROQ_API_KEY` é credencial paga. Toda variável que o Vite expõe ao cliente
vira texto legível no DevTools de qualquer visitante. Este endpoint existe
para que o front nunca precise da chave: ele manda os fatos, o servidor
chama a Groq, e a chave nunca sai do processo.

Por isso o endpoint também exige autenticação — sem isso, seria um proxy de
LLM aberto na internet rodando na cota do dono da instalação.
"""
from __future__ import annotations

import json
import logging

import httpx

from .. import config
from ..infra import audit

log = logging.getLogger("vendalytics.modules.analise_ia")

MAX_TOKENS = 700

# Limite do payload de fatos. Protege dos dois lados: da conta de tokens e de
# um cliente que tente empurrar um prompt gigante por este endpoint.
MAX_BYTES_FATOS = 24_000

_SYSTEM = (
    "Você é um analista sênior de inteligência de mercado B2B escrevendo para "
    "um diretor comercial brasileiro.\n\n"
    "REGRAS ABSOLUTAS:\n"
    "1. Use SOMENTE os números presentes no JSON fornecido. NUNCA invente, "
    "estime ou arredonde para um valor que não esteja lá.\n"
    "2. Se algo não estiver no JSON, diga que o dado não está disponível. "
    "Jamais preencha a lacuna com conhecimento geral seu.\n"
    "3. Todo número que você citar deve aparecer no JSON. Cite-o com a mesma "
    "grandeza (não converta milhões em bilhões de cabeça).\n"
    "4. Distinga o que é dado do IBGE do que é premissa comercial do usuário. "
    "TAM/SAM/SOM em reais dependem de ticket médio arbitrado — ao citá-los, "
    "deixe claro que a base é real mas a conversão em reais é uma premissa.\n"
    "5. Português do Brasil, tom executivo, direto, sem jargão de consultoria "
    "e sem adjetivo vazio ('robusto', 'estratégico', 'promissor').\n\n"
    "FORMATO: 3 parágrafos curtos, sem títulos, sem listas, sem markdown.\n"
    "(1) o que o dado mostra;\n"
    "(2) o que isso significa para cobertura comercial;\n"
    "(3) uma recomendação acionável que se sustente apenas nos números dados.\n"
)


def disponivel() -> bool:
    return bool(config.GROQ_API_KEY)


def _motivo_amigavel(e: httpx.HTTPStatusError) -> str:
    """Traduz a recusa da Groq para algo que o usuário possa AGIR.

    O 429 por cota diária é a falha mais provável do plano gratuito (100 mil
    tokens por dia) e a mais confusa quando aparece crua: o corpo original é
    uma linha de 300 caracteres com id de organização e contagem de tokens, que
    não diz a quem lê o que fazer a respeito.
    """
    status = e.response.status_code
    bruto = ""
    try:
        bruto = e.response.json().get("error", {}).get("message", "")
    except Exception:
        bruto = e.response.text[:200]

    if status == 429:
        if "per day" in bruto or "TPD" in bruto:
            return (
                "Cota diária da Groq esgotada (o plano gratuito dá 100 mil tokens por dia). "
                "Ela renova amanhã; para uso contínuo, é o plano pago da Groq."
            )
        return "Muitas perguntas em sequência. Aguarde alguns segundos e tente de novo."
    if status == 401:
        return "A chave da Groq foi recusada. Confira GROQ_API_KEY no servidor."
    if status == 413 or "context" in bruto.lower():
        return "A conversa ficou longa demais para o modelo. Use 'Limpar' e refaça a pergunta."
    if status >= 500:
        return "A Groq está instável no momento. Tente novamente em instantes."
    return f"Groq recusou a chamada ({status}). {bruto[:160]}".strip()


# ── Agente com ferramentas ─────────────────────────────────────────────────

MAX_TOKENS_AGENTE = 900
MAX_BYTES_CONVERSA = 60_000

_SYSTEM_AGENTE = (
    "Você é um analista de inteligência de mercado B2B brasileiro, conversando "
    "com um diretor comercial.\n\n"
    "REGRA ABSOLUTA: você NÃO tem nenhum dado de mercado na memória. Todo "
    "número precisa vir de uma chamada de ferramenta. Se a pergunta exige um "
    "número, chame a ferramenta — nunca responda de cabeça, nunca estime, "
    "nunca use conhecimento geral sobre municípios brasileiros.\n\n"
    "Se as ferramentas não devolverem o que a pergunta pede, diga exatamente "
    "isso e explique qual dado falta. Não preencha a lacuna.\n\n"
    "Ao responder: português do Brasil, tom executivo, direto. Cite os números "
    "que as ferramentas devolveram, com a mesma grandeza. Seja breve — no "
    "máximo dois parágrafos curtos, ou uma lista de até 8 itens. Sem markdown "
    "de título, sem adjetivo vazio."
)


def conversar(*, mensagens: list[dict], ferramentas: list[dict]) -> dict:
    """Uma rodada do agente: repassa a conversa à Groq e devolve a resposta crua.

    ── Por que o laço NÃO mora aqui ───────────────────────────────────────
    As ferramentas executam no NAVEGADOR, sobre os 5.570 municípios que já
    estão carregados lá. Mandar essa base para o servidor a cada pergunta
    seria trafegar megabytes para responder o que o cliente já tem em
    memória.

    Então a divisão é: o navegador roda o laço e executa as ferramentas; este
    endpoint só empresta a credencial e repassa o turno. A chave da Groq nunca
    sai deste processo, e o dado nunca sai do cliente.
    """
    if not disponivel():
        return {"disponivel": False, "motivo": "GROQ_API_KEY não configurado no servidor"}

    corpo = json.dumps(mensagens, ensure_ascii=False, default=str)
    if len(corpo.encode("utf-8")) > MAX_BYTES_CONVERSA:
        return {"disponivel": False,
                "motivo": f"conversa acima do limite de {MAX_BYTES_CONVERSA} bytes"}

    try:
        r = httpx.post(
            f"{config.GROQ_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {config.GROQ_API_KEY}"},
            json={
                "model": config.GROQ_MODEL,
                "messages": [{"role": "system", "content": _SYSTEM_AGENTE}, *mensagens],
                "tools": ferramentas,
                "tool_choice": "auto",
                # Baixa de propósito: a mesma pergunta sobre o mesmo dado deve
                # escolher a mesma ferramenta com os mesmos argumentos.
                "temperature": 0.1,
                "max_tokens": MAX_TOKENS_AGENTE,
            },
            timeout=config.HTTP_TIMEOUT_S * 3,
        )
        r.raise_for_status()
        corpo_resposta = r.json()
        escolha = corpo_resposta["choices"][0]["message"]
        uso = corpo_resposta.get("usage", {})
    except httpx.HTTPStatusError as e:
        log.warning("Groq recusou o turno do agente: %s", e)
        return {"disponivel": False, "motivo": _motivo_amigavel(e)}
    except (httpx.HTTPError, KeyError, IndexError, ValueError) as e:
        log.warning("Groq indisponível para o agente: %s", e)
        return {"disponivel": False, "motivo": "Groq indisponível no momento"}

    audit.registrar("ia.agente", recurso=f"turnos:{len(mensagens)}",
                    detalhe={"modelo": config.GROQ_MODEL,
                             "tokens": uso.get("total_tokens"),
                             "chamou_ferramenta": bool(escolha.get("tool_calls"))})

    return {
        "disponivel": True,
        "mensagem": escolha,
        "modelo": config.GROQ_MODEL,
        "tokens": uso.get("total_tokens"),
    }


def analisar(*, contexto: str, fatos: dict) -> dict:
    """Redige a leitura executiva dos `fatos`.

    Nunca levanta por falha da Groq: devolve `disponivel: False` com o motivo.
    A tela já tem a análise determinística renderizada — a prosa do LLM é
    camada por cima, não substituição. Cair aqui degrada o painel, não quebra.
    """
    if not disponivel():
        return {"disponivel": False, "motivo": "GROQ_API_KEY não configurado no servidor"}

    corpo = json.dumps(fatos, ensure_ascii=False, default=str)
    if len(corpo.encode("utf-8")) > MAX_BYTES_FATOS:
        return {"disponivel": False,
                "motivo": f"payload de fatos acima do limite de {MAX_BYTES_FATOS} bytes"}

    try:
        r = httpx.post(
            f"{config.GROQ_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {config.GROQ_API_KEY}"},
            json={
                "model": config.GROQ_MODEL,
                "messages": [
                    {"role": "system", "content": _SYSTEM},
                    {"role": "user",
                     "content": f"Contexto da análise: {contexto}\n\nFatos (JSON):\n{corpo}"},
                ],
                # Temperatura baixa: o objetivo é uma leitura estável do mesmo
                # dado, não variedade criativa. Um texto que muda a cada F5
                # destrói a confiança num painel executivo.
                "temperature": 0.15,
                "max_tokens": MAX_TOKENS,
            },
            timeout=config.HTTP_TIMEOUT_S * 2,
        )
        r.raise_for_status()
        corpo_resposta = r.json()
        texto = corpo_resposta["choices"][0]["message"]["content"].strip()
        uso = corpo_resposta.get("usage", {})
    except httpx.HTTPStatusError as e:
        log.warning("Groq recusou a análise: %s", e)
        return {"disponivel": False, "motivo": _motivo_amigavel(e)}
    except (httpx.HTTPError, KeyError, IndexError, ValueError) as e:
        log.warning("Groq indisponível para análise: %s", e)
        return {"disponivel": False, "motivo": "Groq indisponível no momento"}

    audit.registrar("ia.analisar", recurso=contexto[:120],
                    detalhe={"modelo": config.GROQ_MODEL,
                             "tokens": uso.get("total_tokens")})

    return {
        "disponivel": True,
        "texto": texto,
        "modelo": config.GROQ_MODEL,
        "tokens": uso.get("total_tokens"),
        # O front exibe isto junto do texto: o leitor precisa saber que a
        # prosa saiu de um modelo, e sobre quais fatos.
        "ancoragem": "redigido pelo modelo sobre os fatos enviados; nenhum número foi calculado pelo LLM",
    }
