"""
relatorio.py — relatório executivo automatizado (spec §2.3 C4).

"Geração em linguagem natural (LLM sobre dados agregados, nunca sobre
alucinação: cada afirmação do relatório carrega link para os eventos-fonte).
[...] com seção fixa 'o que mudou desde o último relatório'."

Duas camadas, mesmo racional de `modules/agente.py`:

  1. **Estrutural (sempre disponível, sem LLM):** os fatos agregados +
     comparação com o snapshot anterior. É um relatório executivo de
     verdade — números, deltas, alertas — só sem prosa costurada.
  2. **Prosa grounded (só com GROQ_API_KEY configurado):** o LLM recebe
     EXATAMENTE os mesmos fatos da camada 1 e só redige por cima — mesma
     regra de "nunca inventar número" do agente de rascunho. Sem chave
     configurada, a camada 1 sozinha já é um relatório entregável.

"Link para os eventos-fonte": cada seção do relatório inclui os ids/
referências que a sustentam (alertas por id, período exato da correlação)
— não link clicável (não há um viewer de evento dedicado nesta fase), mas
a rastreabilidade que o link serviria.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

import httpx

from .. import config
from ..infra import audit, context, db
from . import comunicacao_kpi, reputacao

log = logging.getLogger("vendalytics.modules.relatorio")

MAX_TOKENS_RESPOSTA = 500

_SYSTEM_PROMPT = (
    "Você é um analista redigindo um relatório executivo de reputação de marca "
    "para a diretoria. Use APENAS os dados fornecidos — nunca invente número, "
    "tendência ou fato que não esteja explicitamente nos dados. Se um dado "
    "não estiver disponível, diga que não está disponível, não estime. "
    "Estruture em 3 parágrafos curtos: (1) situação atual, (2) o que mudou "
    "desde o último relatório, (3) recomendação objetiva baseada só nos dados."
)


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _coletar_dados(*, filial: str, dias: int) -> dict:
    return {
        "periodo_dias": dias,
        "resumo_sentimento": reputacao.resumo_sentimento(dias=dias),
        "alertas_recentes": reputacao.alertas(limit=10),
        "benchmarking": reputacao.benchmarking(dias=dias),
        "correlacao_com_negocio": comunicacao_kpi.correlacionar_sentimento_com_faturamento(
            filial=filial, dias=dias),
    }


def _snapshot_anterior() -> dict | None:
    escopo = context.atual()
    with db.conexao() as con:
        r = con.execute(
            "SELECT * FROM relatorios_executivos WHERE tenant_id=? ORDER BY id DESC LIMIT 1",
            (escopo.tenant_id,)).fetchone()
    if not r:
        return None
    d = dict(r)
    d["dados"] = json.loads(d["dados"])
    return d


def _salvar_snapshot(dados: dict, gerado_em: str) -> int:
    escopo = context.atual()
    with db.conexao() as con:
        cur = con.execute(
            "INSERT INTO relatorios_executivos (tenant_id, gerado_em, dados) VALUES (?,?,?) RETURNING id",
            (escopo.tenant_id, gerado_em, json.dumps(dados, ensure_ascii=False, default=str)))
        return int(cur.fetchone()["id"])


def _o_que_mudou(atual: dict, anterior: dict | None) -> dict:
    """A seção fixa que a spec pede. Sem relatório anterior, diz isso —
    nunca finge uma tendência com um único ponto no tempo."""
    if anterior is None:
        return {"disponivel": False, "motivo": "primeiro relatório gerado — sem histórico para comparar"}

    res_atual = atual["resumo_sentimento"]
    res_anterior = anterior["dados"]["resumo_sentimento"]
    if not (res_atual.get("disponivel") and res_anterior.get("disponivel")):
        return {"disponivel": False, "relatorio_anterior_gerado_em": anterior["gerado_em"],
                "motivo": "sentimento indisponível em um dos dois períodos"}

    delta_sentimento = round(res_atual["sentimento_medio_ponderado"] -
                             res_anterior["sentimento_medio_ponderado"], 3)
    delta_volume = res_atual["total_mencoes"] - res_anterior["total_mencoes"]
    novos_alertas = len(atual["alertas_recentes"]) - len(anterior["dados"]["alertas_recentes"])

    return {
        "disponivel": True,
        "relatorio_anterior_gerado_em": anterior["gerado_em"],
        "delta_sentimento_ponderado": delta_sentimento,
        "delta_volume_mencoes": delta_volume,
        "novos_alertas": max(novos_alertas, 0),
    }


def _prosa_llm(dados: dict, mudancas: dict) -> str | None:
    if not config.GROQ_API_KEY:
        return None
    conteudo = json.dumps({"dados_atuais": dados, "o_que_mudou": mudancas},
                          ensure_ascii=False, default=str)
    try:
        r = httpx.post(
            f"{config.GROQ_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {config.GROQ_API_KEY}"},
            json={"model": config.GROQ_MODEL,
                 "messages": [{"role": "system", "content": _SYSTEM_PROMPT},
                             {"role": "user", "content": f"Dados:\n{conteudo}"}],
                 "temperature": 0.2, "max_tokens": MAX_TOKENS_RESPOSTA},
            timeout=config.HTTP_TIMEOUT_S)
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()
    except (httpx.HTTPError, KeyError, IndexError) as e:
        log.warning("Groq indisponível para relatório executivo: %s", e)
        return None


def gerar(*, filial: str = "", dias: int = 30) -> dict:
    dados = _coletar_dados(filial=filial, dias=dias)
    anterior = _snapshot_anterior()
    mudancas = _o_que_mudou(dados, anterior)
    texto = _prosa_llm(dados, mudancas)

    gerado_em = _agora()  # UMA vez só: é o que vai persistido e o que volta na resposta
    relatorio_id = _salvar_snapshot(dados, gerado_em)
    audit.registrar("relatorio.gerado", recurso=f"filial:{filial or 'todas'}",
                    detalhe={"modo": "grounded_llm" if texto else "estrutural"})

    return {
        "disponivel": True,
        "relatorio_id": relatorio_id,
        "gerado_em": gerado_em,
        "modo": "grounded_llm" if texto else "estrutural",
        "texto_executivo": texto,   # None se GROQ não configurado — a seção "dados" abaixo já é o relatório
        "o_que_mudou_desde_o_ultimo": mudancas,
        "dados": dados,
    }
