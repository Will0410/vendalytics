"""
contactabilidade.py — segundo score da spec A3 (§2.1): "probabilidade de
conseguir falar com um decisor". Sempre exibido AO LADO da propensão, nunca
sozinho — um lead de propensão alta e contactabilidade baixa é um lead caro,
e o produto precisa dizer isso explicitamente (é a frase da própria spec).

Quatro componentes, cada um virando um FATOR explicável (mesma regra D-2 do
resto do produto — nenhum score sem explicação):

  1. Telefone em formato válido (DDD + número BR).
  2. E-mail em formato válido.
  3. Completude do comitê de compras (`modules/comite.py`) — uma conta com
     decisor econômico mapeado é mais alcançável que uma só com o
     cadastro genérico da empresa.
  4. Contato humano recente e bem-sucedido — sinal `field.visit_outcome`
     dos últimos 90 dias (spec: "histórico de resposta do segmento";
     aqui, o histórico de resposta DESTA conta, que é o que existe).

Não há dado de "e-mail engajado"/"telefone testado" (a spec cita isso como
enriquecimento de terceiros) — cada componente ausente por falta de dado
means peso zero naquele componente, nunca uma penalidade inventada.
"""
from __future__ import annotations

import re

from .. import data_layer
from ..infra import context, scores

_RE_TELEFONE = re.compile(r"^\D*(\d{2})\D*(\d{4,5})\D*(\d{4})\D*$")
_RE_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$")

PESO_TELEFONE = 30.0
PESO_EMAIL = 20.0
PESO_COMITE = 30.0
PESO_CONTATO_RECENTE = 20.0
JANELA_CONTATO_RECENTE_DIAS = 90


def _telefone_valido(telefone: str | None) -> bool:
    return bool(telefone) and bool(_RE_TELEFONE.match(str(telefone)))


def _email_valido(email: str | None) -> bool:
    return bool(email) and bool(_RE_EMAIL.match(str(email)))


def calcular(cliente_id: str) -> dict:
    cliente = data_layer.cliente(cliente_id)
    if not cliente:
        return {"disponivel": False, "motivo": "cliente não encontrado"}

    fatores = []
    score = 0.0

    tel_ok = _telefone_valido(cliente.get("telefone"))
    score += PESO_TELEFONE if tel_ok else 0.0
    fatores.append({"feature": "telefone", "contribuicao_pct": PESO_TELEFONE if tel_ok else 0.0,
                    "rotulo": "telefone em formato válido" if tel_ok
                    else "telefone ausente ou em formato inválido"})

    email_ok = _email_valido(cliente.get("email"))
    score += PESO_EMAIL if email_ok else 0.0
    fatores.append({"feature": "email", "contribuicao_pct": PESO_EMAIL if email_ok else 0.0,
                    "rotulo": "e-mail em formato válido" if email_ok
                    else "e-mail ausente ou em formato inválido"})

    try:
        from . import comite
        completude = comite.completude(cliente_id)["score_completude"]
    except Exception:
        completude = 0.0
    pts_comite = round(PESO_COMITE * completude / 100, 1)
    score += pts_comite
    fatores.append({"feature": "comite_de_compras", "contribuicao_pct": pts_comite,
                    "rotulo": f"comitê de compras {completude:.0f}% mapeado"
                    if completude > 0 else "nenhum contato do comitê de compras mapeado"})

    visitas = scores.sinais_recentes("cliente", cliente_id, "field.visit_outcome",
                                     dias=JANELA_CONTATO_RECENTE_DIAS)
    teve_contato = any(v.get("payload", {}).get("pedido_gerado") is not None for v in visitas)
    score += PESO_CONTATO_RECENTE if teve_contato else 0.0
    fatores.append({"feature": "contato_recente", "contribuicao_pct": PESO_CONTATO_RECENTE if teve_contato else 0.0,
                    "rotulo": f"contato humano registrado nos últimos {JANELA_CONTATO_RECENTE_DIAS} dias"
                    if teve_contato else "sem contato humano registrado recentemente"})

    return {
        "disponivel": True,
        "cliente_id": cliente_id,
        "contactabilidade": round(score, 1),
        "fatores": sorted(fatores, key=lambda f: f["contribuicao_pct"], reverse=True),
    }


def classificar(contactabilidade: float) -> str:
    """Rótulo de negócio — a mesma leitura que a spec pede em UI: um
    vendedor não vai interpretar '42' sozinho."""
    if contactabilidade >= 70:
        return "alta"
    if contactabilidade >= 40:
        return "média"
    return "baixa"
