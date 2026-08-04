"""
mapa.py — enriquece a listagem de clientes do mapa com sinal de valor
esperado e um mini-histórico de atividade (deltas mensais).

Existe como módulo separado, e não como campo a mais em
`DataSourceAdapter.clientes_query`, de propósito: valor esperado vem do
modelo de propensão (`modules/propensao.py`), que é camada de negócio, não
de dado bruto. Um adapter concreto nunca deveria saber calcular isso — ele
só sabe ler o cadastro. Misturar as duas coisas no contrato do adapter
obrigaria qualquer implementação futura (Postgres, DW de cliente) a
reimplementar lógica de scoring que já existe em `fila.py`.

`GET /api/clientes` (o endpoint genérico, usado por busca/detalhe) continua
sem esse custo: só `GET /api/clientes/mapa` paga o preço de rodar o modelo
— reaproveitando o cache de 15 min de `fila._modelo_de`.
"""
from __future__ import annotations

from datetime import date, datetime

from .. import data_layer
from . import fila

JANELA_MESES = 6


def _dt(s) -> date | None:
    try:
        return datetime.fromisoformat(str(s)[:10]).date()
    except (ValueError, TypeError):
        return None


def _atividade_por_cliente(filial: str) -> dict[str, list[float]]:
    """cliente_id -> deltas mês a mês (mais antigo → mais recente) dos
    últimos `JANELA_MESES`. Uma passada única sobre as vendas do escopo,
    não uma consulta por cliente — o mapa pode ter até 1500 pontos."""
    hoje = date.today()
    totais: dict[str, dict[int, float]] = {}
    for v in data_layer.vendas_por_periodo(filial=filial):
        d = _dt(v.get("data_venda"))
        if d is None:
            continue
        meses_atras = (hoje.year - d.year) * 12 + (hoje.month - d.month)
        if not (0 <= meses_atras < JANELA_MESES):
            continue
        cid = str(v.get("cliente_id"))
        bucket = totais.setdefault(cid, {})
        bucket[meses_atras] = bucket.get(meses_atras, 0.0) + float(v.get("valor_total") or 0.0)

    saida = {}
    for cid, bucket in totais.items():
        serie = [bucket.get(m, 0.0) for m in range(JANELA_MESES - 1, -1, -1)]  # antigo -> recente
        saida[cid] = [round(serie[i] - serie[i - 1], 2) for i in range(1, len(serie))]
    return saida


def pontos(*, bbox=None, texto: str = "", filial: str = "", limit: int = 1500,
          offset: int = 0) -> dict:
    """A mesma listagem de `/api/clientes`, com `valor_esperado` e
    `atividade` quando disponíveis. Ausência não é erro: um cliente sem
    histórico suficiente pontuado simplesmente não ganha os campos extras —
    o mapa já sabe cair para o raio/cor padrão."""
    base = data_layer.query_clientes(bbox=bbox, texto=texto, filial=filial,
                                     limit=limit, offset=offset)
    valores = fila.valores_esperados(filial=filial)
    atividade = _atividade_por_cliente(filial)
    for c in base["clientes"]:
        cid = str(c["id"])
        if cid in valores:
            c["valor_esperado"] = valores[cid]
        if cid in atividade:
            c["atividade"] = atividade[cid]
    return base
