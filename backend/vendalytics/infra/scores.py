"""
scores.py — persistência de Score, ScoreFactor, Sinal e Desfecho.

Três invariantes que este módulo existe para garantir:

1. **Score sem explicação não é gravado.** `registrar()` exige a lista de
   fatores e recusa lista vazia. A spec (D-2) põe isso como regra de schema;
   em SQLite não dá para exprimir "1..N filhos" em constraint, então o
   enforcement mora aqui — no único caminho de escrita — e é coberto por
   teste. Um score gravado por fora deste módulo é um bug, não um atalho.

2. **Append-only.** Nunca se atualiza um score: grava-se outra versão. O
   histórico é o que permite responder "por que mudou desde ontem?" e
   retreinar sem vazar o futuro para dentro do passado.

3. **Escopo.** Toda leitura passa pelo escopo do request, como no
   `data_layer` — um score é dado de cliente e segue o mesmo recorte.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from . import context, db


class ScoreSemExplicacao(ValueError):
    """Tentativa de gravar score sem fatores. Ver invariante 1."""


@dataclass(frozen=True)
class Fator:
    feature: str
    rotulo: str
    contribuicao: float
    valor_feature: float | None = None


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── escrita ────────────────────────────────────────────────────────────────
def registrar(*, sujeito_tipo: str, sujeito_id: str, tipo: str, valor: float,
              probabilidade: float, fatores: list[Fator], modelo_versao: str,
              ic: tuple[float, float] | None = None,
              valido_ate: str | None = None) -> int:
    """Grava um score e seus fatores numa transação só. Devolve o id."""
    if not fatores:
        raise ScoreSemExplicacao(
            f"score '{tipo}' de {sujeito_tipo}:{sujeito_id} sem fatores — "
            "toda recomendação precisa dizer o que a gerou (spec D-2)")
    escopo = context.atual()
    with db.conexao() as con:
        cur = con.execute(
            """INSERT INTO scores (tenant_id, sujeito_tipo, sujeito_id, tipo, valor,
                                   probabilidade, ic_inferior, ic_superior,
                                   modelo_versao, calculado_em, valido_ate)
               VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id""",
            (escopo.tenant_id, sujeito_tipo, sujeito_id, tipo, float(valor),
             float(probabilidade), ic[0] if ic else None, ic[1] if ic else None,
             modelo_versao, _agora(), valido_ate))
        # `RETURNING id` + fetchone(), não `.lastrowid` — o segundo não
        # existe em Postgres (spec §3.5: banco operacional passa a suportar
        # Postgres via DATABASE_URL); RETURNING funciona idêntico nos dois.
        score_id = int(cur.fetchone()["id"])
        con.executemany(
            """INSERT INTO score_fatores (score_id, posicao, feature, rotulo,
                                          contribuicao, valor_feature)
               VALUES (?,?,?,?,?,?)""",
            [(score_id, i, f.feature, f.rotulo, float(f.contribuicao), f.valor_feature)
             for i, f in enumerate(fatores)])
    return score_id


def emitir_sinal(*, tipo: str, sujeito_tipo: str, sujeito_id: str, origem: str,
                 payload: dict | None = None, confianca: float = 1.0,
                 ocorrido_em: str | None = None) -> int:
    """Publica um sinal no barramento. Hoje o "barramento" é uma tabela: os
    consumidores leem por polling. A troca por Kafka (spec §3.6) muda este
    corpo e mais nada — o resto do código só conhece `emitir_sinal`."""
    escopo = context.atual()
    with db.conexao() as con:
        cur = con.execute(
            """INSERT INTO sinais (tenant_id, tipo, sujeito_tipo, sujeito_id,
                                   ocorrido_em, ingerido_em, origem, confianca, payload)
               VALUES (?,?,?,?,?,?,?,?,?) RETURNING id""",
            (escopo.tenant_id, tipo, sujeito_tipo, sujeito_id,
             ocorrido_em or _agora(), _agora(), origem, float(confianca),
             json.dumps(payload or {}, ensure_ascii=False, default=str)))
        return int(cur.fetchone()["id"])


def registrar_desfecho(*, sujeito_tipo: str, sujeito_id: str, desfecho: str,
                       score_id: int | None = None, motivo: str = "",
                       valor: float | None = None) -> int:
    """Passo 7 do fluxo de valor: o resultado da ação volta para o sistema.

    Grava o desfecho E emite o sinal correspondente, sempre juntos — se
    ficassem separados, um chamador esqueceria o segundo e o barramento
    passaria a ter uma visão incompleta do que aconteceu em campo.
    """
    escopo = context.atual()
    with db.conexao() as con:
        cur = con.execute(
            """INSERT INTO desfechos (tenant_id, sujeito_tipo, sujeito_id, score_id,
                                      usuario, desfecho, motivo, valor, registrado_em)
               VALUES (?,?,?,?,?,?,?,?,?) RETURNING id""",
            (escopo.tenant_id, sujeito_tipo, sujeito_id, score_id, escopo.usuario,
             desfecho, motivo, valor, _agora()))
        desfecho_id = int(cur.fetchone()["id"])
    emitir_sinal(tipo="recomendacao.desfecho", sujeito_tipo=sujeito_tipo,
                 sujeito_id=sujeito_id, origem=f"usuario:{escopo.usuario}",
                 payload={"desfecho": desfecho, "motivo": motivo, "valor": valor,
                          "score_id": score_id})
    return desfecho_id


# ── leitura ────────────────────────────────────────────────────────────────
def ultimo(sujeito_tipo: str, sujeito_id: str, tipo: str) -> dict | None:
    """Versão mais recente de um score, com os fatores que a explicam."""
    escopo = context.atual()
    with db.conexao() as con:
        r = con.execute(
            """SELECT * FROM scores
               WHERE tenant_id=? AND sujeito_tipo=? AND sujeito_id=? AND tipo=?
               ORDER BY calculado_em DESC, id DESC LIMIT 1""",
            (escopo.tenant_id, sujeito_tipo, sujeito_id, tipo)).fetchone()
        if not r:
            return None
        fatores = con.execute(
            "SELECT * FROM score_fatores WHERE score_id=? ORDER BY posicao",
            (r["id"],)).fetchall()
    d = dict(r)
    d["fatores"] = [dict(f) for f in fatores]
    return d


def sinais_recentes(sujeito_tipo: str, sujeito_id: str, tipo: str, *, dias: int = 30) -> list[dict]:
    """Sinais de um tipo, sobre um sujeito, nos últimos N dias — o que
    `modules/fila.py` consulta para reagir a sinais de outros módulos
    (reputação, campo) sem importar esses módulos: o acoplamento é só o
    barramento, que é exatamente o ponto do diferencial D-1."""
    escopo = context.atual()
    # Corte calculado em Python, não `datetime('now', ?)` do SQL — essa
    # função é sintaxe exclusiva do SQLite; comparar strings ISO-8601 dá o
    # mesmo resultado em qualquer banco (SQLite ou Postgres), então o corte
    # em Python funciona igual nos dois sem tradução nenhuma em runtime.
    corte = (datetime.now(timezone.utc) - timedelta(days=int(dias))).isoformat()
    with db.conexao() as con:
        rows = con.execute(
            """SELECT * FROM sinais
               WHERE tenant_id=? AND sujeito_tipo=? AND sujeito_id=? AND tipo=?
               AND ocorrido_em >= ?
               ORDER BY ocorrido_em DESC""",
            (escopo.tenant_id, sujeito_tipo, sujeito_id, tipo, corte)).fetchall()
    saida = []
    for r in rows:
        d = dict(r)
        try:
            d["payload"] = json.loads(d.get("payload") or "{}")
        except (ValueError, TypeError):
            pass
        saida.append(d)
    return saida


def sinais_nao_processados(*, limit: int = 500) -> list[dict]:
    """Sinais do tenant corrente ainda não vistos pelo reactor (spec §3.6:
    "consumidores independentes por módulo"). O estado de leitura vive em
    `sinais_processados`, não em `sinais` — ver a migration para o porquê."""
    escopo = context.atual()
    with db.conexao() as con:
        rows = con.execute(
            """SELECT * FROM sinais
               WHERE tenant_id=? AND id NOT IN (SELECT sinal_id FROM sinais_processados)
               ORDER BY id ASC LIMIT ?""",
            (escopo.tenant_id, min(int(limit), 5000))).fetchall()
    saida = []
    for r in rows:
        d = dict(r)
        try:
            d["payload"] = json.loads(d.get("payload") or "{}")
        except (ValueError, TypeError):
            pass
        saida.append(d)
    return saida


def marcar_processado(sinal_id: int) -> None:
    with db.conexao() as con:
        con.execute(
            """INSERT INTO sinais_processados (sinal_id, processado_em) VALUES (?, ?)
               ON CONFLICT (sinal_id) DO NOTHING""",
            (sinal_id, datetime.now(timezone.utc).isoformat()))


def historico(sujeito_tipo: str, sujeito_id: str, tipo: str, limit: int = 30) -> list[dict]:
    """Série de um score ao longo do tempo — a resposta a "por que mudou?"."""
    escopo = context.atual()
    with db.conexao() as con:
        rows = con.execute(
            """SELECT * FROM scores
               WHERE tenant_id=? AND sujeito_tipo=? AND sujeito_id=? AND tipo=?
               ORDER BY calculado_em DESC, id DESC LIMIT ?""",
            (escopo.tenant_id, sujeito_tipo, sujeito_id, tipo, min(int(limit), 200))).fetchall()
    return [dict(r) for r in rows]


def desfechos_registrados(*, sujeito_tipo: str = "cliente", desde: str = "",
                          limit: int = 5000) -> list[dict]:
    """Desfechos do tenant — a fonte de label do retreino."""
    escopo = context.atual()
    where, params = ["tenant_id=?", "sujeito_tipo=?"], [escopo.tenant_id, sujeito_tipo]
    if desde:
        where.append("registrado_em >= ?"); params.append(desde)
    with db.conexao() as con:
        rows = con.execute(
            f"SELECT * FROM desfechos WHERE {' AND '.join(where)} "
            f"ORDER BY registrado_em DESC LIMIT ?", params + [min(int(limit), 20000)]).fetchall()
    return [dict(r) for r in rows]


def cobertura_loop_fechado(*, tipo: str = "propensao_recompra", dias: int = 30) -> dict:
    """A métrica mais importante da §7.4: quantas recomendações emitidas
    tiveram desfecho registrado. Se ela cai, o produto parou de aprender."""
    escopo = context.atual()
    corte = (datetime.now(timezone.utc) - timedelta(days=int(dias))).isoformat()
    with db.conexao() as con:
        emitidos = con.execute(
            """SELECT COUNT(DISTINCT sujeito_id) AS n FROM scores
               WHERE tenant_id=? AND tipo=? AND calculado_em >= ?""",
            (escopo.tenant_id, tipo, corte)).fetchone()["n"]
        com_desfecho = con.execute(
            """SELECT COUNT(DISTINCT d.sujeito_id) AS n FROM desfechos d
               WHERE d.tenant_id=? AND d.registrado_em >= ?""",
            (escopo.tenant_id, corte)).fetchone()["n"]
    return {
        "janela_dias": dias,
        "sujeitos_pontuados": emitidos,
        "sujeitos_com_desfecho": com_desfecho,
        "cobertura_pct": round(100 * com_desfecho / emitidos, 1) if emitidos else None,
    }
