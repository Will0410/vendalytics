"""
semantico.py — modelo semântico + construtor de análise no-code + NL→consulta
(spec §2.5 D-3, "citizen data science").

A regra que faz esta feature ser segura, não só conveniente: **não existe
SQL livre em lugar nenhum deste módulo**. Métrica e dimensão vêm de um
registro fechado (`METRICAS`/`DIMENSOES`); a agregação roda em Python sobre
o que `data_layer` já devolve — e `data_layer` já aplica o escopo do
usuário (filial, tenant). Um usuário não pode, nem por acidente, nem via
prompt malicioso ao NL2SQL, pedir um dado fora do que o próprio escopo dele
já permitiria pela API normal. É a leitura literal da spec: "reduz
superfície de erro e de vazamento entre tenants".

`consulta_equivalente` (a representação SQL-like da consulta) é sempre
devolvida — "o SQL gerado sempre visível" — mas é uma REPRESENTAÇÃO da
semântica, não uma string executada; não existe injeção possível porque
não existe execução de string nenhuma.

NL→consulta tem dois níveis:
  1. Parser determinístico por palavra-chave (sempre disponível, testado,
     sem custo, sem chave).
  2. Fallback opcional via LLM (só com GROQ_API_KEY) — e mesmo esse
     fallback só ESCOLHE entre as métricas/dimensões já registradas, nunca
     escreve SQL nem inventa uma métrica nova. O LLM aqui é um classificador
     de intenção, não um gerador de consulta.
"""
from __future__ import annotations

import logging
import re
from collections import defaultdict
from datetime import datetime

import httpx

from .. import config, data_layer
from ..infra import audit

log = logging.getLogger("vendalytics.modules.semantico")

METRICAS = {
    "faturamento": {"rotulo": "Faturamento", "fonte": "vendas", "agregacao": "sum", "campo": "valor_total"},
    "pedidos": {"rotulo": "Número de pedidos", "fonte": "vendas", "agregacao": "count", "campo": None},
    "ticket_medio": {"rotulo": "Ticket médio", "fonte": "vendas", "agregacao": "avg", "campo": "valor_total"},
    "clientes_ativos": {"rotulo": "Clientes ativos", "fonte": "clientes", "agregacao": "count",
                        "campo": None, "filtro_status": "ativo"},
    "clientes_total": {"rotulo": "Total de clientes", "fonte": "clientes", "agregacao": "count", "campo": None},
}

DIMENSOES = {
    "filial": {"rotulo": "Filial", "campo_vendas": "filial", "campo_clientes": "filial"},
    "segmento": {"rotulo": "Segmento", "campo_vendas": None, "campo_clientes": "segmento"},
    "uf": {"rotulo": "UF", "campo_vendas": None, "campo_clientes": "uf"},
    "vendedor": {"rotulo": "Vendedor", "campo_vendas": "vendedor_id", "campo_clientes": None},
    "mes": {"rotulo": "Mês", "campo_vendas": "__mes__", "campo_clientes": None},
}


def _linhas_da_fonte(fonte: str, filial: str) -> list[dict]:
    if fonte == "vendas":
        return data_layer.vendas_por_periodo(filial=filial)
    if fonte == "clientes":
        return data_layer.query_clientes(filial=filial, limit=100000)["clientes"]
    raise ValueError(f"fonte desconhecida: {fonte}")


def _chave_dimensao(linha: dict, dimensao: str, fonte: str) -> str:
    if dimensao == "mes":
        return str(linha.get("data_venda") or "")[:7] or "(sem data)"
    campo = DIMENSOES[dimensao][f"campo_{fonte}"]
    if campo is None:
        return "(dimensão não aplicável a esta métrica)"
    return str(linha.get(campo) or "(não informado)")


def consultar(*, metrica: str, dimensao: str = "", filial: str = "") -> dict:
    """O executor do construtor no-code. Metrica/dimensao são chaves do
    registro — nunca texto livre interpretado como SQL."""
    if metrica not in METRICAS:
        return {"disponivel": False, "motivo": f"métrica '{metrica}' não existe "
                f"(disponíveis: {', '.join(METRICAS)})"}
    if dimensao and dimensao not in DIMENSOES:
        return {"disponivel": False, "motivo": f"dimensão '{dimensao}' não existe "
                f"(disponíveis: {', '.join(DIMENSOES)})"}

    m = METRICAS[metrica]
    # "mes" é uma dimensão calculada (recorte de `data_venda`), não um campo
    # do registro — só existe onde há `data_venda`, ou seja, só em vendas.
    # As demais dimensões dependem de `campo_<fonte>` estar preenchido no
    # registro. Checar as duas condições juntas evita o caso em que "mes"
    # passaria despercebido para a fonte `clientes` (que não tem data de
    # venda) e produziria um agrupamento sem sentido em vez de recusar.
    dimensao_valida = (
        not dimensao
        or (dimensao == "mes" and m["fonte"] == "vendas")
        or (dimensao != "mes" and DIMENSOES[dimensao][f"campo_{m['fonte']}"] is not None)
    )
    if not dimensao_valida:
        return {"disponivel": False,
                "motivo": f"dimensão '{dimensao}' não se aplica à fonte '{m['fonte']}' desta métrica"}

    linhas = _linhas_da_fonte(m["fonte"], filial)
    if m.get("filtro_status"):
        linhas = [l for l in linhas if l.get("status") == m["filtro_status"]]

    grupos: dict[str, list[float]] = defaultdict(list)
    for linha in linhas:
        chave = _chave_dimensao(linha, dimensao, m["fonte"]) if dimensao else "total"
        valor = float(linha.get(m["campo"]) or 0) if m["campo"] else 1.0
        grupos[chave].append(valor)

    def agregar(valores: list[float]) -> float:
        if m["agregacao"] == "sum":
            return sum(valores)
        if m["agregacao"] == "count":
            return float(len(valores))
        if m["agregacao"] == "avg":
            return sum(valores) / len(valores) if valores else 0.0
        raise ValueError(m["agregacao"])

    resultados = sorted(
        [{"chave": k, "valor": round(agregar(v), 2)} for k, v in grupos.items()],
        key=lambda r: r["valor"], reverse=True)

    campo_sql = m["campo"] or "*"
    agregacao_sql = {"sum": "SUM", "count": "COUNT", "avg": "AVG"}[m["agregacao"]]
    group_by = f" GROUP BY {dimensao}" if dimensao else ""
    consulta_equivalente = (f"SELECT {dimensao + ', ' if dimensao else ''}"
                            f"{agregacao_sql}({campo_sql}) AS {metrica} FROM {m['fonte']}"
                            f"{' WHERE filial=' + repr(filial) if filial else ''}{group_by}")

    audit.registrar("semantico.consultar", detalhe={"metrica": metrica, "dimensao": dimensao})
    return {
        "disponivel": True,
        "metrica": metrica, "metrica_rotulo": m["rotulo"],
        "dimensao": dimensao or None,
        "resultados": resultados,
        "consulta_equivalente": consulta_equivalente,
        "aviso": "representação da consulta para transparência — não é SQL executado; "
                "a agregação roda em Python sobre dados já filtrados pelo escopo do usuário",
    }


def modelo() -> dict:
    return {
        "metricas": {k: v["rotulo"] for k, v in METRICAS.items()},
        "dimensoes": {k: v["rotulo"] for k, v in DIMENSOES.items()},
    }


# ── NL → consulta ────────────────────────────────────────────────────────
_PALAVRAS_METRICA = {
    "faturamento": "faturamento", "vendas": "faturamento", "receita": "faturamento",
    "pedidos": "pedidos", "numero de pedidos": "pedidos",
    "ticket medio": "ticket_medio", "ticket": "ticket_medio",
    "clientes ativos": "clientes_ativos",
    "total de clientes": "clientes_total", "clientes": "clientes_total",
}
_PALAVRAS_DIMENSAO = {
    "por filial": "filial", "por segmento": "segmento", "por uf": "uf",
    "por estado": "uf", "por vendedor": "vendedor", "por mes": "mes", "por mês": "mes",
}


def _normalizar(s: str) -> str:
    import unicodedata
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s.lower()).strip()


def _interpretar_deterministico(pergunta: str) -> dict | None:
    p = _normalizar(pergunta)
    metrica = None
    for frase, chave in sorted(_PALAVRAS_METRICA.items(), key=lambda kv: -len(kv[0])):
        if _normalizar(frase) in p:
            metrica = chave
            break
    if metrica is None:
        return None
    dimensao = ""
    for frase, chave in _PALAVRAS_DIMENSAO.items():
        if _normalizar(frase) in p:
            dimensao = chave
            break
    return {"metrica": metrica, "dimensao": dimensao, "metodo": "determinístico"}


def _interpretar_llm(pergunta: str) -> dict | None:
    """Fallback só quando o parser determinístico não reconheceu nada e
    GROQ está configurado. O LLM só ESCOLHE entre chaves já registradas —
    nunca gera SQL nem inventa métrica fora do modelo semântico."""
    if not config.GROQ_API_KEY:
        return None
    opcoes = f"Métricas válidas: {', '.join(METRICAS)}. Dimensões válidas: {', '.join(DIMENSOES)} ou vazio."
    try:
        r = httpx.post(
            f"{config.GROQ_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {config.GROQ_API_KEY}"},
            json={"model": config.GROQ_MODEL, "temperature": 0, "max_tokens": 30,
                 "messages": [
                     {"role": "system", "content": f"Responda APENAS 'metrica,dimensao' (dimensao pode "
                      f"ser vazia) escolhendo estritamente das opções válidas. {opcoes} "
                      f"Se nada corresponder, responda 'nenhuma,'."},
                     {"role": "user", "content": pergunta}]},
            timeout=config.HTTP_TIMEOUT_S)
        r.raise_for_status()
        resposta = r.json()["choices"][0]["message"]["content"].strip()
        metrica, _, dimensao = resposta.partition(",")
        metrica, dimensao = metrica.strip(), dimensao.strip()
        if metrica not in METRICAS:
            return None
        if dimensao and dimensao not in DIMENSOES:
            dimensao = ""
        return {"metrica": metrica, "dimensao": dimensao, "metodo": "llm"}
    except (httpx.HTTPError, KeyError, IndexError) as e:
        log.warning("Groq indisponível para NL2SQL: %s", e)
        return None


def perguntar(pergunta: str, *, filial: str = "") -> dict:
    """NL → consulta segura → resultado. Sempre visível: a interpretação
    escolhida (método + métrica + dimensão) e a consulta equivalente."""
    interpretado = _interpretar_deterministico(pergunta) or _interpretar_llm(pergunta)
    if interpretado is None:
        return {"disponivel": False,
                "motivo": "não consegui mapear a pergunta para uma métrica conhecida "
                         f"(métricas: {', '.join(METRICAS)})"}
    resultado = consultar(metrica=interpretado["metrica"], dimensao=interpretado["dimensao"], filial=filial)
    resultado["interpretacao"] = interpretado
    resultado["pergunta_original"] = pergunta
    return resultado
