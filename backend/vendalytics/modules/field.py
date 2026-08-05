"""
field.py — Field Execution (spec §2.4, Fase 4 do roadmap).

Escopo real deste MVP, e o que falta para ser a spec inteira:

  D1 Gap PDV × SKU              → implementado como gap CLIENTE × CATEGORIA:
                                  o que os "vizinhos" (mesma célula geo +
                                  mesmo segmento) compram e este cliente não
                                  — a fusão de Geo (proximidade) com Sales
                                  (propensão) que a spec chama de argumento
                                  mais forte do barramento unificado.
  D2 Agente conversacional       → implementado como GROUNDED puro (sem LLM):
                                  o texto vem 100% de template sobre dado
                                  estruturado, nunca gerado livremente. Mais
                                  restrito que a spec (que aceita LLM "só
                                  redigindo"), e deliberado: sem decisão de
                                  provedor/orçamento validada, não se chama
                                  API paga (mesmo racional do A7 recusado).
  D2 Canal (WhatsApp)            → contrato `MessagingConnector`
                                  (`integracoes/messaging_base.py`) +
                                  referência que grava em staging — mesmo
                                  padrão do CRM. Sem token WHAPI validado,
                                  não se implementa envio real.
  D3 Validação de dado de campo  → implementado via `registrar_correcao`,
                                  publicando sinal `field.data_correction`.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date

from .. import data_layer
from ..infra import audit, context, scores
from ..infra.geo import celula

JANELA_MESES_PADRAO = 3
RESOLUCAO_PEER = 0.02  # ~2km — célula mais grossa que a de geo.py: "vizinho
                       # de rota", não "vizinho de esquina".


def _peers(cliente: dict, filial: str, *, candidatos: list[dict] | None = None) -> list[dict]:
    """Clientes na mesma célula geográfica e mesmo segmento — a definição de
    "vizinho" deste MVP. Sem H3/clustering real (spec B2), é a aproximação
    honesta possível com o dado disponível hoje.

    `candidatos`: lista de clientes já carregada pelo chamador (opcional).
    `roteiro_do_dia` recalcula o gap para cada parada da fila — sem isso,
    cada uma das N paradas recarregaria a base inteira de clientes do zero
    (N consultas idênticas em vez de 1)."""
    if not cliente.get("lat") or not cliente.get("lon"):
        return []
    minha_celula = celula(cliente["lat"], cliente["lon"], RESOLUCAO_PEER)
    meu_segmento = cliente.get("segmento")
    if candidatos is None:
        candidatos = data_layer.query_clientes(filial=filial, limit=100000)["clientes"]
    return [
        c for c in candidatos
        if str(c["id"]) != str(cliente["id"])
        and c.get("lat") and c.get("lon")
        and celula(c["lat"], c["lon"], RESOLUCAO_PEER) == minha_celula
        and (not meu_segmento or c.get("segmento") == meu_segmento)
    ]


def gap_cliente(cliente_id: str, *, meses: int = JANELA_MESES_PADRAO,
                max_peers: int = 40, candidatos: list[dict] | None = None) -> dict:
    """Gap de mix no nível do cliente: categorias que os vizinhos compram e
    este cliente não, priorizadas por penetração entre os vizinhos × valor
    médio gasto por eles — não é whitespace da carteira inteira (já coberto
    por `modules/mix.py`), é whitespace LOCAL, o que dá o argumento "o
    mercado ao seu redor compra X" para a visita de hoje."""
    cliente = data_layer.cliente(cliente_id)
    if not cliente:
        return {"disponivel": False, "motivo": "cliente não encontrado"}

    peers = _peers(cliente, cliente.get("filial", ""), candidatos=candidatos)[:max_peers]
    if len(peers) < 3:
        return {"disponivel": False,
                "motivo": f"menos de 3 vizinhos geográficos/segmento (achou {len(peers)}) "
                          f"— gap local não é confiável com amostra tão pequena"}

    # 1 consulta para o cliente + todos os peers, em vez de 1+len(peers)
    # consultas separadas — é o que mantém "campo → roteiro do dia" rápido
    # o bastante para não estourar o timeout do frontend em CPU limitada.
    ids = [cliente_id] + [str(p["id"]) for p in peers]
    mix_por_cliente = data_layer.mix_categorias_por_clientes(ids, meses=meses)
    minhas_categorias = {p["categoria"] for p in mix_por_cliente.get(cliente_id, [])}

    por_categoria: dict[str, dict] = defaultdict(lambda: {"peers_compraram": 0, "valor_total": 0.0})
    for peer in peers:
        for p in mix_por_cliente.get(str(peer["id"]), []):
            cat = por_categoria[p["categoria"]]
            cat["peers_compraram"] += 1
            cat["valor_total"] += float(p.get("valor") or 0)

    gaps = []
    for categoria, agg in por_categoria.items():
        if categoria in minhas_categorias:
            continue
        penetracao_pct = round(100 * agg["peers_compraram"] / len(peers), 1)
        valor_medio_peer = round(agg["valor_total"] / agg["peers_compraram"], 2)
        gaps.append({
            "categoria": categoria,
            "peers_compraram": agg["peers_compraram"],
            "peers_total": len(peers),
            "penetracao_pct": penetracao_pct,
            "valor_medio_peer": valor_medio_peer,
            "prioridade": round(penetracao_pct / 100 * valor_medio_peer, 2),
        })
    gaps.sort(key=lambda g: g["prioridade"], reverse=True)

    audit.registrar("field.gap_cliente", recurso=f"cliente:{cliente_id}",
                    detalhe={"peers": len(peers), "gaps": len(gaps)})
    return {"disponivel": True, "cliente_id": cliente_id, "peers_avaliados": len(peers),
            "categorias_gap": gaps}


def _argumento(gap: dict) -> str:
    """Texto 100% grounded: cada número vem direto do dicionário calculado
    acima, nunca gerado livremente — é o que a spec pede de um LLM
    ("números interpolados de variáveis, nunca gerados"), aqui sem LLM
    nenhum no meio."""
    return (f"{gap['peers_compraram']} de {gap['peers_total']} clientes na mesma região "
           f"e segmento compram {gap['categoria']} (penetração de {gap['penetracao_pct']}%), "
           f"gastando em média R$ {gap['valor_medio_peer']:,.0f} nessa categoria — "
           f"este cliente ainda não comprou.")


def sugestao_para_cliente(cliente_id: str, *, top_n: int = 3,
                          candidatos: list[dict] | None = None) -> dict:
    """A pergunta do vendedor de campo: "o que levo para este cliente hoje?"
    Resposta grounded, com o argumento de cada sugestão explícito."""
    g = gap_cliente(cliente_id, candidatos=candidatos)
    if not g["disponivel"]:
        return g
    sugestoes = [
        {"categoria": item["categoria"], "argumento": _argumento(item),
         "prioridade": item["prioridade"]}
        for item in g["categorias_gap"][:top_n]
    ]
    if not sugestoes:
        texto = "Nenhum gap de mix identificado em relação aos vizinhos — carteira já madura nesta região."
    else:
        texto = "Sugestões para hoje: " + " | ".join(s["categoria"] for s in sugestoes)
    return {"disponivel": True, "cliente_id": cliente_id, "resumo": texto, "sugestoes": sugestoes}


def roteiro_do_dia(*, filial: str = "", limite: int = 12) -> dict:
    """Roteiro de campo do dia: fila priorizada (propensão × valor esperado,
    de `fila.py`) com a sugestão de gap de mix anexada a cada parada — é a
    fusão Geo+Sales que materializa o barramento unificado (spec D1)."""
    from . import fila as fila_mod   # import tardio: evita ciclo (fila usa scores; field não é dependência de fila)

    r = fila_mod.diaria(filial=filial, limite=limite, persistir=False)
    if not r["disponivel"]:
        return {"disponivel": False, "motivo": r["motivo"]}

    # Carregado 1 vez para as N paradas, não 1 vez por parada — é a base de
    # candidatos a "vizinho geográfico" que `_peers` usaria de qualquer
    # jeito, idêntica a cada chamada (mesma filial, mesmo escopo).
    candidatos = data_layer.query_clientes(filial=filial, limit=100000)["clientes"]

    paradas = []
    for item in r["itens"]:
        sugestao = sugestao_para_cliente(item["cliente_id"], top_n=2, candidatos=candidatos)
        paradas.append({
            "cliente_id": item["cliente_id"],
            "score_propensao": item["score"],
            "valor_esperado": item["valor_esperado"],
            "fatores_propensao": item["fatores"][:2],
            "gap_de_mix": sugestao.get("sugestoes", []),
        })
    return {"disponivel": True, "data": date.today().isoformat(), "paradas": paradas}


# ── captura de campo em loop fechado (spec D3) ─────────────────────────────
TIPOS_CORRECAO = ("pdv_fechado", "endereco_errado", "concorrente_presente", "sem_espaco_gondola")


def registrar_correcao(cliente_id: str, tipo: str, *, detalhe: str = "") -> dict:
    """Divergência reportada em campo — publica sinal para o barramento
    (Geo/Sales reagirem sem acoplamento direto, spec D-1). Não edita o
    cadastro diretamente: a correção fica na fila de curadoria, com o mesmo
    racional de `identidade.candidatos_a_duplicata` — o sistema registra a
    alegação, não a aplica sozinho."""
    if tipo not in TIPOS_CORRECAO:
        raise ValueError(f"tipo de correção inválido: '{tipo}' (esperado um de {', '.join(TIPOS_CORRECAO)})")
    escopo = context.atual()
    sinal_id = scores.emitir_sinal(tipo="field.data_correction", sujeito_tipo="cliente",
                                   sujeito_id=cliente_id, origem=f"campo:{escopo.usuario}",
                                   payload={"tipo_correcao": tipo, "detalhe": detalhe})
    audit.registrar("field.correcao", recurso=f"cliente:{cliente_id}",
                    detalhe={"tipo": tipo, "detalhe": detalhe})
    return {"sinal_id": sinal_id, "cliente_id": cliente_id, "tipo": tipo}


def registrar_visita(cliente_id: str, *, pedido_gerado: bool, itens: list[str] | None = None,
                     motivo_recusa: str = "") -> dict:
    """Resultado da visita — passo 6→7 do fluxo de valor (spec §5), versão
    de campo do `fila.registrar_desfecho`."""
    escopo = context.atual()
    sinal_id = scores.emitir_sinal(tipo="field.visit_outcome", sujeito_tipo="cliente",
                                   sujeito_id=cliente_id, origem=f"campo:{escopo.usuario}",
                                   payload={"pedido_gerado": pedido_gerado,
                                           "itens": itens or [], "motivo_recusa": motivo_recusa})
    audit.registrar("field.visita", recurso=f"cliente:{cliente_id}",
                    detalhe={"pedido_gerado": pedido_gerado})
    return {"sinal_id": sinal_id, "cliente_id": cliente_id, "pedido_gerado": pedido_gerado}
