"""
territorio.py — distribuição de carteiras entre vendedores (spec §2.1 A4).

O problema: repartir N clientes entre K vendedores equilibrando **potencial**
(não headcount), respeitando geografia e **sem trocar de dono um
relacionamento que está funcionando**.

── Por que heurística e não ótimo global ──────────────────────────────────
Particionamento multi-critério é NP-difícil, e o ótimo global não é o que o
gestor quer: ele quer uma proposta que ele **entenda e possa ajustar à mão**.
Uma solução 3% melhor que ninguém sabe justificar perde para uma solução
explicável — a spec diz isso explicitamente ("não exige ótimo global, exige
explicável e ajustável").

Usa-se *longest processing time first* (maior potencial primeiro, sempre para
a carteira mais leve) com penalidade de distância e bônus de continuidade.
É guloso, roda em O(n log n), e produz um resultado que se explica em uma
frase: "este cliente foi para o João porque a carteira dele estava mais leve
e ele já atende a região".

── Simulação antes de aplicar ─────────────────────────────────────────────
`simular()` NÃO grava nada. Redistribuição de carteira mexe em comissão de
gente, e é o tipo de mudança que precisa ser vista, discutida e ajustada
antes de existir. Aplicar é um passo separado e explícito.
"""
from __future__ import annotations

from collections import defaultdict

from .. import data_layer
from ..infra import audit
from ..infra.geo import haversine_km as _haversine_km_impl

# Peso da penalidade geográfica contra o desequilíbrio de potencial. 0 =
# ignora distância (carteiras equilibradas, vendedor cruzando o estado);
# alto = respeita geografia mesmo desequilibrando. 0.35 mantém as carteiras
# dentro de ~15% de desvio sem gerar rota absurda no dado de demonstração.
PESO_DISTANCIA = 0.35

# Quanto vale manter o dono atual de uma conta ativa. Trocar o vendedor de um
# cliente que compra bem custa relacionamento, e esse custo não aparece em
# nenhuma métrica de equilíbrio — por isso entra explícito aqui.
BONUS_CONTINUIDADE = 0.45


_haversine_km = _haversine_km_impl  # compat: código/testes existentes chamam pelo nome antigo


def _potencial_por_cliente(filial: str = "") -> dict[str, float]:
    """Potencial = faturamento dos últimos 12 meses. É uma proxy, e assumida
    como tal: o potencial verdadeiro é o que o cliente PODERIA comprar, que
    depende do gap de mix (modules/mix.py) e do mercado da praça
    (modules/mercado.py). Cruzar os três é trabalho da Fase 4."""
    total: dict[str, float] = defaultdict(float)
    for v in data_layer.vendas_por_periodo(filial=filial):
        total[str(v.get("cliente_id"))] += float(v.get("valor_total") or 0.0)
    return dict(total)


def _dono_atual(filial: str = "") -> dict[str, str]:
    """Quem vendeu por último para cada cliente — o dono de fato, que nem
    sempre é o dono cadastrado."""
    ultimo: dict[str, tuple[str, str]] = {}
    for v in data_layer.vendas_por_periodo(filial=filial):
        cid, vend, quando = str(v.get("cliente_id")), v.get("vendedor_id"), str(v.get("data_venda") or "")
        if not vend:
            continue
        if cid not in ultimo or quando > ultimo[cid][1]:
            ultimo[cid] = (str(vend), quando)
    return {cid: par[0] for cid, par in ultimo.items()}


def simular(*, filial: str = "", vendedores_extra: int = 0) -> dict:
    """Propõe uma distribuição de carteiras. Não grava nada.

    `vendedores_extra` responde à pergunta que o gestor sempre faz antes de
    contratar: "se eu colocar mais 3 vendedores, como fica?".
    """
    equipe = data_layer.vendedores(filial=filial)
    for i in range(max(int(vendedores_extra), 0)):
        equipe.append({"id": f"NOVO-{i + 1}", "nome": f"(vaga {i + 1})",
                       "filial": filial or "", "simulado": True})
    if not equipe:
        return {"disponivel": False, "motivo": "nenhum vendedor ativo no escopo",
                "carteiras": []}

    clientes = data_layer.query_clientes(filial=filial, limit=100000)["clientes"]
    if not clientes:
        return {"disponivel": False, "motivo": "nenhum cliente no escopo", "carteiras": []}

    potencial = _potencial_por_cliente(filial=filial)
    donos = _dono_atual(filial=filial)

    # Maior potencial primeiro: decidir os grandes no fim, quando as carteiras
    # já estão cheias, é o que produz desequilíbrio grosseiro.
    ordenados = sorted(clientes, key=lambda c: potencial.get(str(c["id"]), 0.0), reverse=True)

    carteiras: dict[str, dict] = {
        str(v["id"]): {"vendedor_id": str(v["id"]), "nome": v.get("nome", ""),
                       "simulado": bool(v.get("simulado")), "potencial": 0.0,
                       "clientes": [], "centro": None, "mantidos": 0, "movidos": 0}
        for v in equipe}

    escala = max(potencial.values()) if potencial else 1.0
    for c in ordenados:
        cid = str(c["id"])
        pot = potencial.get(cid, 0.0)
        melhor, melhor_nota = None, None
        for vid, cart in carteiras.items():
            # Nota menor = melhor. Base: carga atual (equilíbrio).
            nota = cart["potencial"] / escala if escala else 0.0
            if cart["centro"] and c.get("lat") and c.get("lon"):
                d = _haversine_km(c["lat"], c["lon"], cart["centro"][0], cart["centro"][1])
                nota += PESO_DISTANCIA * min(d / 300.0, 1.0)
            if donos.get(cid) == vid:
                nota -= BONUS_CONTINUIDADE
            if melhor_nota is None or nota < melhor_nota:
                melhor, melhor_nota = vid, nota

        cart = carteiras[melhor]
        cart["clientes"].append({"id": cid, "nome": c.get("nome", ""),
                                 "potencial": round(pot, 2),
                                 "dono_anterior": donos.get(cid)})
        cart["potencial"] += pot
        if donos.get(cid) == melhor:
            cart["mantidos"] += 1
        elif donos.get(cid):
            cart["movidos"] += 1
        # Centro de gravidade incremental da carteira, para a próxima decisão.
        if c.get("lat") and c.get("lon"):
            n = sum(1 for x in cart["clientes"] if x.get("id"))
            if cart["centro"] is None:
                cart["centro"] = (c["lat"], c["lon"])
            else:
                clat, clon = cart["centro"]
                cart["centro"] = (clat + (c["lat"] - clat) / n,
                                  clon + (c["lon"] - clon) / n)

    resumo = []
    for cart in carteiras.values():
        resumo.append({
            "vendedor_id": cart["vendedor_id"], "nome": cart["nome"],
            "simulado": cart["simulado"],
            "clientes": len(cart["clientes"]),
            "potencial": round(cart["potencial"], 2),
            "mantidos": cart["mantidos"], "movidos": cart["movidos"],
        })
    resumo.sort(key=lambda r: r["potencial"], reverse=True)

    potenciais = [r["potencial"] for r in resumo]
    media = sum(potenciais) / len(potenciais) if potenciais else 0.0
    desvio = (max(potenciais) - min(potenciais)) / media * 100 if media else 0.0
    total_movidos = sum(r["movidos"] for r in resumo)
    total_com_dono = sum(1 for cid in donos if cid)

    audit.registrar("territorio.simulado", recurso=f"filial:{filial or 'todas'}",
                    detalhe={"vendedores": len(resumo), "extras": vendedores_extra})

    return {
        "disponivel": True,
        "aplicado": False,   # simulação nunca grava — ver docstring do módulo
        "criterio": {
            "peso_distancia": PESO_DISTANCIA,
            "bonus_continuidade": BONUS_CONTINUIDADE,
            "potencial": "faturamento dos últimos 12 meses (proxy)",
        },
        "equilibrio": {
            "potencial_medio": round(media, 2),
            "desvio_max_pct": round(desvio, 1),
        },
        "ruptura_de_relacionamento": {
            "clientes_movidos": total_movidos,
            "clientes_com_dono": total_com_dono,
            "pct_movidos": round(100 * total_movidos / total_com_dono, 1) if total_com_dono else None,
        },
        "carteiras": resumo,
        "detalhe": {vid: c["clientes"] for vid, c in carteiras.items()},
    }
