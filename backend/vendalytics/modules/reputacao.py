"""
reputacao.py — Reputation / Brand Intelligence (spec §2.3, Fase 3 do roadmap).

Escopo real deste MVP, e o que falta para ser a spec inteira:

  C1 Monitoramento multi-canal → ingestão via `MentionSource` (spec: crawlers
                                  próprios + provedores licenciados). Aqui só
                                  a referência CSV; ver `integracoes/mentions_base.py`
                                  para por que não há crawler nem API real.
  C1 Dedup de replicação        → implementado: shingling + Jaccard, sem lib
                                  externa (MinHash real é o próximo passo se
                                  o volume justificar — a interface não muda).
  C2 Sentimento                 → implementado como LÉXICO PT-BR (positivo/
                                  negativo, com negação simples), não um
                                  modelo de NLP. É deliberadamente rotulado
                                  como heurístico em toda saída — um léxico
                                  erra em ironia, gíria e ambiguidade que um
                                  modelo treinado capturaria. Interface
                                  (`_sentimento`) isolada para trocar depois.
  C2 Relevância ponderada        → implementado (alcance × idade da menção).
  C5 Alerta de anomalia          → implementado (z-score de volume diário
                                  contra baseline móvel).
  C3 KPI de comunicação          → NÃO implementado (depende de correlação
                                  com resultado de negócio ao longo do tempo
                                  — precisa de histórico que este MVP não tem).
  C4 Relatório executivo          → NÃO implementado (geração em linguagem
                                  natural grounded — decisão de provedor de
                                  LLM pendente, mesmo racional do agente A7).
  C6 Benchmarking competitivo    → implementado de forma mínima (share of
                                  voice por veículo mencionado no texto).

── O diferencial que este módulo prova ────────────────────────────────────
Quando uma menção casa com uma conta conhecida (`identidade`/cadastro), o
módulo emite `signal.reputation.mention` no barramento (spec D-1) — é o que
permite o módulo de Sales reagir a uma crise de reputação sem acoplamento
direto entre os dois. Ver `infra/reactor.py` (Fase 5) para o consumidor.
"""
from __future__ import annotations

import math
import uuid
from collections import Counter
from datetime import date, datetime, timedelta

from .. import data_layer
from ..infra import audit, context, db, scores
from .identidade import normalizar_texto, tokens_significativos

# Léxico PT-BR pequeno e deliberado — não é ML, é regra. Cobre vocabulário
# comum de reclamação/elogio em contexto comercial/atendimento, que é onde
# a maior parte do volume de menções de uma distribuidora vive.
_POSITIVAS = {
    "otimo", "excelente", "bom", "boa", "recomendo", "confiavel", "eficiente",
    "rapido", "rapida", "qualidade", "satisfeito", "satisfeita", "parabens",
    "sucesso", "cumpriu", "resolveu", "atencioso", "atenciosa", "cordial",
    "profissional", "agilidade", "pontual", "correto", "correta", "justo",
    "sensacional", "adorei", "impecavel", "confianca", "melhor",
}
_NEGATIVAS = {
    "pessimo", "ruim", "horrivel", "problema", "atraso", "atrasado", "atrasada",
    "reclamacao", "insatisfeito", "insatisfeita", "cancelei", "cancelar",
    "descaso", "demora", "demorou", "defeito", "quebrado", "enganacao",
    "golpe", "fraude", "abandono", "descaso", "prejuizo", "erro", "falha",
    "incompetente", "absurdo", "vergonha", "decepcao", "decepcionado",
    "decepcionante", "pior", "nunca mais", "trabalhista", "processo",
}
_NEGADORES = {"nao", "nunca", "jamais", "sem"}

_SHINGLE_K = 5
_LIMIAR_DUPLICATA = 0.6
_JANELA_BASELINE_DIAS = 14
_ZSCORE_ANOMALIA = 2.0


def _sentimento(texto: str) -> float:
    """Polaridade -1..1 por léxico com negação simples (janela de 2 tokens).

    Isolada nesta função de propósito: é o ponto de troca por um classificador
    de verdade (spec: modelo open-weight ajustado por domínio) sem mexer no
    resto do pipeline de ingestão/dedup/alerta.
    """
    tokens = normalizar_texto(texto).split()
    pontos, hits = 0, 0
    for i, tok in enumerate(tokens):
        polaridade = 1 if tok in _POSITIVAS else (-1 if tok in _NEGATIVAS else 0)
        if polaridade == 0:
            continue
        negado = any(t in _NEGADORES for t in tokens[max(0, i - 2):i])
        pontos += -polaridade if negado else polaridade
        hits += 1
    if hits == 0:
        return 0.0
    return max(min(pontos / hits, 1.0), -1.0)


def _shingles(texto: str) -> set[str]:
    toks = tokens_significativos(texto)
    if len(toks) < _SHINGLE_K:
        return {" ".join(toks)} if toks else set()
    return {" ".join(toks[i:i + _SHINGLE_K]) for i in range(len(toks) - _SHINGLE_K + 1)}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / (len(a) + len(b) - inter)


def _casar_conta(texto: str, clientes: list[dict]) -> str | None:
    """Casa a menção com uma conta pelo nome, via os mesmos tokens
    significativos usados na resolução de entidade — reaproveita a mesma
    normalização, não reinventa outra."""
    toks_texto = set(tokens_significativos(texto))
    if not toks_texto:
        return None
    for c in clientes:
        nome = c.get("nome") or c.get("razao_social") or ""
        toks_nome = tokens_significativos(nome)
        if len(toks_nome) >= 2 and set(toks_nome).issubset(toks_texto):
            return str(c["id"])
    return None


def _agora() -> str:
    return datetime.now().isoformat(timespec="seconds")


# ── ingestão ────────────────────────────────────────────────────────────────
def importar(fonte, *, filial: str = "", desde: str = "") -> dict:
    """Importa, classifica sentimento, deduplica por similaridade e casa com
    conta conhecida — tudo numa passada, porque o dedup precisa comparar
    contra o que já existe no período."""
    escopo = context.atual()
    mencoes = fonte.buscar_mencoes(desde=desde)
    if not mencoes:
        return {"importadas": 0, "duplicadas": 0, "casadas_com_conta": 0}

    clientes = data_layer.query_clientes(filial=filial, limit=100000)["clientes"]

    with db.conexao() as con:
        existentes = con.execute(
            "SELECT id, texto, cluster_id FROM mencoes WHERE tenant_id=?",
            (escopo.tenant_id,)).fetchall()
    representantes = {r["cluster_id"]: _shingles(r["texto"]) for r in existentes if r["cluster_id"]}

    duplicadas, casadas = 0, 0
    linhas = []
    for m in mencoes:
        sh = _shingles(m.texto)
        cluster_id = None
        for rep_id, rep_sh in representantes.items():
            if _jaccard(sh, rep_sh) >= _LIMIAR_DUPLICATA:
                cluster_id = rep_id
                duplicadas += 1
                break
        if cluster_id is None:
            # Id opaco (uuid), não sequencial: um contador derivado do
            # tamanho dos dicionários em memória (versão anterior) colide
            # com cluster_id já persistido de uma importação passada — a
            # colisão funde duas menções não relacionadas num cluster só, e
            # o dedup (MIN(id) GROUP BY cluster_id) passa a descartar uma
            # menção real como se fosse duplicata da outra. Um uuid não tem
            # esse risco: a chance de colisão é desprezível por construção.
            cluster_id = f"{escopo.tenant_id}:{uuid.uuid4().hex}"
            representantes[cluster_id] = sh

        conta_ref = _casar_conta(m.texto, clientes)
        if conta_ref:
            casadas += 1

        linhas.append((escopo.tenant_id, m.canal, m.veiculo, m.url, m.publicado_em,
                       m.texto, m.alcance, _sentimento(m.texto), cluster_id, conta_ref, _agora()))

    with db.conexao() as con:
        con.executemany(
            """INSERT INTO mencoes (tenant_id, canal, veiculo, url, publicado_em, texto,
                                    alcance, sentimento, cluster_id, conta_ref, importado_em)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""", linhas)

    # Publica sinal só para menções casadas com conta — é o gancho do
    # barramento (spec D-1); o corpo carrega sentimento para o consumidor
    # decidir se importa, não decidimos aqui.
    for linha in linhas:
        _, canal, veiculo, url, publicado_em, texto, alcance, sentimento, cluster_id, conta_ref, _ = linha
        if conta_ref:
            scores.emitir_sinal(tipo="reputation.mention", sujeito_tipo="cliente",
                                sujeito_id=conta_ref, origem=f"{fonte.nome()}:{veiculo or canal}",
                                payload={"sentimento": sentimento, "alcance": alcance,
                                        "canal": canal, "url": url},
                                ocorrido_em=publicado_em or None)

    audit.registrar("reputacao.importar", recurso=fonte.nome(),
                    detalhe={"importadas": len(linhas), "duplicadas": duplicadas,
                             "casadas": casadas})
    return {"importadas": len(linhas), "duplicadas": duplicadas, "casadas_com_conta": casadas}


# ── consulta ────────────────────────────────────────────────────────────────
def mencoes(*, dias: int = 30, apenas_negativas: bool = False, conta_ref: str = "",
           limit: int = 200) -> list[dict]:
    """Lista de menções, deduplicadas por cluster: só o representante de cada
    grupo aparece (id mais antigo do cluster) — o usuário não vê a mesma
    notícia replicada 40 vezes (spec C1)."""
    escopo = context.atual()
    where = ["tenant_id=?", "publicado_em >= ?"]
    params = [escopo.tenant_id, (date.today() - timedelta(days=dias)).isoformat()]
    if apenas_negativas:
        where.append("sentimento < -0.15")
    if conta_ref:
        where.append("conta_ref = ?")
        params.append(conta_ref)
    with db.conexao() as con:
        rows = con.execute(
            f"""SELECT * FROM mencoes WHERE {' AND '.join(where)}
                AND id IN (SELECT MIN(id) FROM mencoes WHERE tenant_id=? GROUP BY cluster_id)
                ORDER BY publicado_em DESC LIMIT ?""",
            params + [escopo.tenant_id, min(int(limit), 2000)]).fetchall()
    return [dict(r) for r in rows]


def resumo_sentimento(*, dias: int = 30) -> dict:
    escopo = context.atual()
    desde = (date.today() - timedelta(days=dias)).isoformat()
    with db.conexao() as con:
        rows = con.execute(
            """SELECT sentimento, alcance FROM mencoes
               WHERE tenant_id=? AND publicado_em>=?
               AND id IN (SELECT MIN(id) FROM mencoes WHERE tenant_id=? GROUP BY cluster_id)""",
            (escopo.tenant_id, desde, escopo.tenant_id)).fetchall()
    if not rows:
        return {"disponivel": False, "motivo": "sem menções no período"}
    total = len(rows)
    positivas = sum(1 for r in rows if r["sentimento"] > 0.15)
    negativas = sum(1 for r in rows if r["sentimento"] < -0.15)
    neutras = total - positivas - negativas
    alcance_total = sum(r["alcance"] for r in rows)
    # Sentimento ponderado por alcance: uma nota de jornal de circulação
    # grande pesa mais que um comentário de baixo alcance (spec C2).
    media_ponderada = (sum(r["sentimento"] * max(r["alcance"], 1) for r in rows) /
                       sum(max(r["alcance"], 1) for r in rows))
    return {
        "disponivel": True, "periodo_dias": dias, "total_mencoes": total,
        "positivas": positivas, "negativas": negativas, "neutras": neutras,
        "sentimento_medio_ponderado": round(media_ponderada, 3),
        "alcance_total": alcance_total,
        "metodo_sentimento": "léxico PT-BR + negação simples (heurístico, não é modelo de NLP)",
    }


def benchmarking(*, dias: int = 30) -> dict:
    """Share of voice por veículo mencionado no texto das próprias menções
    da carteira — versão mínima de C6. Comparar contra CONCORRENTES exigiria
    saber quem são (spec B4/entidade concorrente), que este MVP não tem."""
    escopo = context.atual()
    desde = (date.today() - timedelta(days=dias)).isoformat()
    with db.conexao() as con:
        rows = con.execute(
            """SELECT veiculo, sentimento FROM mencoes
               WHERE tenant_id=? AND publicado_em>=? AND veiculo != ''
               AND id IN (SELECT MIN(id) FROM mencoes WHERE tenant_id=? GROUP BY cluster_id)""",
            (escopo.tenant_id, desde, escopo.tenant_id)).fetchall()
    if not rows:
        return {"disponivel": False, "motivo": "sem menções com veículo identificado no período"}
    contagem = Counter(r["veiculo"] for r in rows)
    total = sum(contagem.values())
    por_veiculo = []
    for veiculo, n in contagem.most_common():
        sents = [r["sentimento"] for r in rows if r["veiculo"] == veiculo]
        por_veiculo.append({
            "veiculo": veiculo, "mencoes": n,
            "share_of_voice_pct": round(100 * n / total, 1),
            "sentimento_medio": round(sum(sents) / len(sents), 3),
        })
    return {"disponivel": True, "periodo_dias": dias, "por_veiculo": por_veiculo}


# ── alerta de anomalia (spec C5) ───────────────────────────────────────────
def _volume_diario(desde: date, ate: date) -> dict[str, int]:
    escopo = context.atual()
    with db.conexao() as con:
        rows = con.execute(
            """SELECT substr(publicado_em,1,10) AS dia, COUNT(*) AS n FROM mencoes
               WHERE tenant_id=? AND publicado_em BETWEEN ? AND ?
               AND id IN (SELECT MIN(id) FROM mencoes WHERE tenant_id=? GROUP BY cluster_id)
               GROUP BY dia""",
            (escopo.tenant_id, desde.isoformat(), ate.isoformat(), escopo.tenant_id)).fetchall()
    return {r["dia"]: r["n"] for r in rows}


def checar_anomalia_de_volume(*, dia: str = "") -> dict:
    """Compara o volume do dia contra a média móvel dos `_JANELA_BASELINE_DIAS`
    anteriores (z-score). Sem baseline suficiente, não inventa alerta —
    devolve indisponível, mesmo padrão do resto do produto."""
    alvo = date.fromisoformat(dia) if dia else date.today()
    baseline_ini = alvo - timedelta(days=_JANELA_BASELINE_DIAS)
    baseline = _volume_diario(baseline_ini, alvo - timedelta(days=1))
    if len(baseline) < 5:
        return {"disponivel": False,
                "motivo": f"histórico curto demais (< 5 dias com menção) para baseline"}

    valores = list(baseline.values())
    media = sum(valores) / len(valores)
    desvio = math.sqrt(sum((v - media) ** 2 for v in valores) / len(valores))
    volume_hoje = _volume_diario(alvo, alvo).get(alvo.isoformat(), 0)

    if desvio == 0:
        zscore = float("inf") if volume_hoje > media else 0.0
    else:
        zscore = (volume_hoje - media) / desvio

    anomalo = zscore >= _ZSCORE_ANOMALIA
    resultado = {
        "disponivel": True, "dia": alvo.isoformat(), "volume": volume_hoje,
        "volume_esperado": round(media, 1), "zscore": round(zscore, 2) if zscore != float("inf") else None,
        "anomalo": anomalo,
    }
    if anomalo:
        escopo = context.atual()
        with db.conexao() as con:
            con.execute(
                """INSERT INTO alertas_reputacao (tenant_id, tipo, gerado_em, janela_de, janela_ate,
                                                  volume, volume_esperado, zscore, detalhe)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (escopo.tenant_id, "volume_anomalo", _agora(), baseline_ini.isoformat(),
                 alvo.isoformat(), volume_hoje, media, resultado["zscore"], "{}"))
        audit.registrar("reputacao.alerta", recurso=alvo.isoformat(),
                        detalhe={"zscore": resultado["zscore"], "volume": volume_hoje})
    return resultado


def alertas(*, limit: int = 50) -> list[dict]:
    escopo = context.atual()
    with db.conexao() as con:
        rows = con.execute(
            "SELECT * FROM alertas_reputacao WHERE tenant_id=? ORDER BY id DESC LIMIT ?",
            (escopo.tenant_id, min(int(limit), 500))).fetchall()
    return [dict(r) for r in rows]
