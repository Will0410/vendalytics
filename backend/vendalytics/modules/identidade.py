"""
identidade.py — resolução de entidade e `account_id` canônico (spec §3.1, §4.3).

O problema: a mesma empresa chega escrita de seis jeitos — "PADARIA DO JOÃO
LTDA", "Padaria do Joao", "PADARIA DO JOAO ME" — em CNPJs de filiais
diferentes, com e sem pontuação, com endereço abreviado de formas distintas.
Se o produto não unifica isso, o vendedor vê a mesma conta três vezes na
fila e para de confiar na tela inteira. É por isso que a spec chama esta
peça de infraestrutura crítica, e não de pré-processamento.

── Estabilidade do id é o requisito, não a precisão do match ──────────────
`account_id` precisa sobreviver a reprocessamento. Se ele muda quando o
pipeline roda de novo, todo score, sinal e desfecho históricos apontam para
um id que não existe mais — e o loop de aprendizado perde o passado. Por
isso a estratégia é, em ordem:

  1. **Raiz do CNPJ** (8 primeiros dígitos), quando existe. É determinístico,
     legalmente correto (matriz e filiais compartilham a raiz) e não depende
     de nenhum estado guardado. Cobre a maior parte dos casos sozinho.
  2. **Atribuição persistida**, para quem não tem CNPJ utilizável. Uma vez
     dado, o id não muda.

O que a similaridade textual faz NÃO é decidir o id: é levantar **candidatos
a duplicata** para uma fila de curadoria humana. É a diferença entre um
sistema que sugere e um que funde contas erradas sozinho — e fusão errada é
muito mais cara de desfazer do que de evitar.

── O que aqui não é o que a spec pede (e por quê) ─────────────────────────
A spec prevê um "classificador de match treinado em pares rotulados". Treinar
exige pares rotulados, que não existem antes de alguém curar duplicata neste
produto. A curadoria implementada aqui é justamente o que produz esses
rótulos (`decisoes_match`); o classificador entra quando houver volume, e a
interface (`candidatos_a_duplicata`) não muda.
"""
from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone

from .. import data_layer
from ..infra import audit, context, db

# Limiar de similaridade para levantar candidato. Calibrado para errar para o
# lado de mostrar demais: um falso candidato custa 5 segundos de curadoria;
# uma duplicata não detectada custa a confiança do usuário na tela.
LIMIAR_CANDIDATO = 0.86

# Sufixos societários e ruído cadastral: não distinguem empresa nenhuma e
# dominam a similaridade se ficarem ("LTDA" vs "LTDA" casa 100%).
_RUIDO = {
    "ltda", "me", "epp", "eireli", "sa", "s", "a", "cia", "e", "de", "do",
    "da", "dos", "das", "comercio", "comercial", "industria", "servicos",
    "distribuidora", "representacoes", "participacoes", "filial", "matriz",
}


def normalizar_texto(s: str) -> str:
    """Minúsculas, sem acento, sem pontuação, sem espaço duplicado."""
    s = unicodedata.normalize("NFKD", str(s or ""))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-zA-Z0-9\s]", " ", s).lower()
    return re.sub(r"\s+", " ", s).strip()


def tokens_significativos(nome: str) -> list[str]:
    return [t for t in normalizar_texto(nome).split() if t not in _RUIDO and len(t) > 1]


def so_digitos(s: str) -> str:
    return re.sub(r"\D", "", str(s or ""))


def cnpj_raiz(documento: str) -> str:
    """Os 8 primeiros dígitos: matriz e filiais da mesma empresa os compartilham.

    Devolve "" quando o documento não tem 14 dígitos — não tenta adivinhar.
    Um CNPJ truncado tratado como válido funde empresas que nada têm a ver.
    """
    d = so_digitos(documento)
    return d[:8] if len(d) == 14 else ""


# ── similaridade ───────────────────────────────────────────────────────────
def jaro_winkler(a: str, b: str) -> float:
    """Jaro-Winkler: mede bem erro de digitação e abreviação, que é o tipo de
    divergência que aparece em cadastro digitado à mão."""
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    alcance = max(len(a), len(b)) // 2 - 1
    if alcance < 0:
        alcance = 0
    casou_a, casou_b = [False] * len(a), [False] * len(b)
    casamentos = 0
    for i, ca in enumerate(a):
        for j in range(max(0, i - alcance), min(len(b), i + alcance + 1)):
            if not casou_b[j] and ca == b[j]:
                casou_a[i] = casou_b[j] = True
                casamentos += 1
                break
    if casamentos == 0:
        return 0.0
    sa = [a[i] for i in range(len(a)) if casou_a[i]]
    sb = [b[j] for j in range(len(b)) if casou_b[j]]
    transposicoes = sum(1 for x, y in zip(sa, sb) if x != y) // 2
    jaro = (casamentos / len(a) + casamentos / len(b) +
            (casamentos - transposicoes) / casamentos) / 3
    prefixo = 0
    for x, y in zip(a[:4], b[:4]):
        if x != y:
            break
        prefixo += 1
    return jaro + prefixo * 0.1 * (1 - jaro)


def similaridade(a: dict, b: dict) -> tuple[float, list[str]]:
    """Similaridade entre dois cadastros + as evidências que a sustentam.

    As evidências existem para a curadoria: quem decide precisa ver POR QUE o
    sistema achou que são a mesma empresa, não só o número.
    """
    evidencias = []

    nome_a = " ".join(tokens_significativos(a.get("nome") or a.get("razao_social") or ""))
    nome_b = " ".join(tokens_significativos(b.get("nome") or b.get("razao_social") or ""))
    sim_nome = jaro_winkler(nome_a, nome_b)
    if sim_nome > 0.9:
        evidencias.append(f"nomes muito parecidos ({sim_nome:.2f})")

    # Sinais fortes: telefone e e-mail iguais praticamente decidem sozinhos —
    # duas empresas distintas raramente compartilham os dois.
    tel_a, tel_b = so_digitos(a.get("telefone")), so_digitos(b.get("telefone"))
    mesmo_telefone = bool(tel_a) and tel_a == tel_b
    if mesmo_telefone:
        evidencias.append("mesmo telefone")

    email_a = normalizar_texto(a.get("email"))
    email_b = normalizar_texto(b.get("email"))
    mesmo_email = bool(email_a) and email_a == email_b
    if mesmo_email:
        evidencias.append("mesmo e-mail")

    mesmo_cep = bool(so_digitos(a.get("cep"))) and so_digitos(a.get("cep")) == so_digitos(b.get("cep"))
    if mesmo_cep:
        evidencias.append("mesmo CEP")

    sim_endereco = jaro_winkler(normalizar_texto(a.get("endereco")),
                                normalizar_texto(b.get("endereco")))
    if sim_endereco > 0.9:
        evidencias.append(f"endereços parecidos ({sim_endereco:.2f})")

    nota = 0.55 * sim_nome + 0.15 * sim_endereco
    nota += 0.15 if mesmo_telefone else 0.0
    nota += 0.10 if mesmo_email else 0.0
    nota += 0.05 if mesmo_cep else 0.0
    return min(nota, 1.0), evidencias


# ── account_id canônico ────────────────────────────────────────────────────
def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _decisoes_humanas() -> dict[tuple[str, str], str]:
    escopo = context.atual()
    with db.conexao() as con:
        rows = con.execute(
            "SELECT cliente_a, cliente_b, decisao FROM decisoes_match WHERE tenant_id=?",
            (escopo.tenant_id,)).fetchall()
    return {(r["cliente_a"], r["cliente_b"]): r["decisao"] for r in rows}


def resolver(*, filial: str = "") -> dict:
    """Atribui `account_id` a cada cliente do escopo e persiste o mapa.

    Determinístico por construção: rodar duas vezes sobre o mesmo cadastro
    produz exatamente os mesmos ids.
    """
    escopo = context.atual()
    clientes = data_layer.query_clientes(filial=filial, limit=100000)["clientes"]
    decisoes = _decisoes_humanas()

    # Grupos por raiz de CNPJ (determinístico) — o caminho principal.
    grupos: dict[str, list[str]] = defaultdict(list)
    sem_documento: list[str] = []
    for c in clientes:
        cid = str(c["id"])
        raiz = cnpj_raiz(cid)
        if raiz:
            grupos[f"BR{raiz}"].append(cid)
        else:
            sem_documento.append(cid)

    # Fusões confirmadas por humano: unem grupos que a raiz do CNPJ separou
    # (empresas com CNPJs realmente distintos que são o mesmo cliente
    # comercial — grupo econômico, troca de razão social).
    por_cliente: dict[str, str] = {}
    for account_id, membros in grupos.items():
        for cid in membros:
            por_cliente[cid] = account_id
    for (a, b), decisao in decisoes.items():
        if decisao != "mesmo":
            continue
        ga, gb = por_cliente.get(a), por_cliente.get(b)
        if ga and gb and ga != gb:
            # Vence o id lexicograficamente menor: regra arbitrária, mas
            # estável — é o que garante o mesmo resultado a cada execução,
            # independentemente da ordem em que as decisões forem lidas.
            vencedor, perdedor = sorted([ga, gb])
            for cid, acc in list(por_cliente.items()):
                if acc == perdedor:
                    por_cliente[cid] = vencedor

    # Sem CNPJ utilizável: id derivado do próprio identificador do cadastro.
    # Não é bonito, mas é estável, que é o requisito de verdade.
    for cid in sem_documento:
        por_cliente[cid] = f"LOCAL:{cid}"

    with db.conexao() as con:
        con.executemany(
            """INSERT INTO contas_canonicas (tenant_id, cliente_id, account_id, metodo, resolvido_em)
               VALUES (?,?,?,?,?)
               ON CONFLICT (tenant_id, cliente_id) DO UPDATE SET
                 account_id=excluded.account_id, metodo=excluded.metodo, resolvido_em=excluded.resolvido_em""",
            [(escopo.tenant_id, cid, acc,
              "cnpj_raiz" if acc.startswith("BR") else "id_local", _agora())
             for cid, acc in por_cliente.items()])

    contas = len(set(por_cliente.values()))
    audit.registrar("identidade.resolvida", recurso=f"filial:{filial or 'todas'}",
                    detalhe={"clientes": len(por_cliente), "contas": contas})
    return {
        "clientes": len(por_cliente),
        "contas_canonicas": contas,
        "sem_documento_valido": len(sem_documento),
        "fusoes_por_curadoria": sum(1 for d in decisoes.values() if d == "mesmo"),
        "taxa_consolidacao_pct": round(
            100 * (1 - contas / len(por_cliente)), 1) if por_cliente else None,
    }


def account_id(cliente_id: str) -> str | None:
    escopo = context.atual()
    with db.conexao() as con:
        r = con.execute(
            "SELECT account_id FROM contas_canonicas WHERE tenant_id=? AND cliente_id=?",
            (escopo.tenant_id, cliente_id)).fetchone()
    return r["account_id"] if r else None


# ── curadoria ──────────────────────────────────────────────────────────────
def candidatos_a_duplicata(*, filial: str = "", limite: int = 50) -> list[dict]:
    """Pares suspeitos para revisão humana, com as evidências.

    Blocking por (UF + primeiro token significativo do nome): comparar todos
    contra todos é O(n²) e inviável a partir de alguns milhares de cadastros.
    O blocking perde alguns pares (nome cujo primeiro token está digitado
    errado), e é o compromisso consciente que torna o problema tratável.
    """
    clientes = data_layer.query_clientes(filial=filial, limit=100000)["clientes"]
    decisoes = _decisoes_humanas()

    blocos: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for c in clientes:
        toks = tokens_significativos(c.get("nome") or c.get("razao_social") or "")
        if not toks:
            continue
        blocos[(normalizar_texto(c.get("uf")), toks[0])].append(c)

    vistos, candidatos = set(), []
    for membros in blocos.values():
        if len(membros) < 2:
            continue
        for i in range(len(membros)):
            for j in range(i + 1, len(membros)):
                a, b = membros[i], membros[j]
                ida, idb = sorted([str(a["id"]), str(b["id"])])
                if (ida, idb) in vistos or (ida, idb) in decisoes:
                    continue   # já decidido por humano: não volta para a fila
                vistos.add((ida, idb))
                if cnpj_raiz(ida) and cnpj_raiz(ida) == cnpj_raiz(idb):
                    continue   # mesma raiz já é o mesmo account_id, sem dúvida
                nota, evidencias = similaridade(a, b)
                if nota >= LIMIAR_CANDIDATO:
                    candidatos.append({
                        "cliente_a": ida, "cliente_b": idb,
                        "nome_a": a.get("nome"), "nome_b": b.get("nome"),
                        "municipio": a.get("municipio"), "uf": a.get("uf"),
                        "confianca": round(nota, 3),
                        "evidencias": evidencias,
                    })
    candidatos.sort(key=lambda d: d["confianca"], reverse=True)
    return candidatos[: max(int(limite), 1)]


def decidir(cliente_a: str, cliente_b: str, decisao: str) -> dict:
    """Registra a decisão humana sobre um par. `mesmo` funde as contas na
    próxima resolução; `distinto` tira o par da fila para sempre.

    As decisões acumuladas são exatamente o conjunto de pares rotulados que
    um classificador de match precisaria para ser treinado — a curadoria de
    hoje é o dado de treino de amanhã.
    """
    if decisao not in ("mesmo", "distinto"):
        raise ValueError(f"decisão inválida: '{decisao}' (esperado 'mesmo' ou 'distinto')")
    escopo = context.atual()
    a, b = sorted([str(cliente_a), str(cliente_b)])
    with db.conexao() as con:
        con.execute(
            """INSERT INTO decisoes_match (tenant_id, cliente_a, cliente_b, decisao, usuario, decidido_em)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT (tenant_id, cliente_a, cliente_b) DO UPDATE SET
                 decisao=excluded.decisao, usuario=excluded.usuario, decidido_em=excluded.decidido_em""",
            (escopo.tenant_id, a, b, decisao, escopo.usuario, _agora()))
    audit.registrar("identidade.decisao", recurso=f"{a}|{b}",
                    detalhe={"decisao": decisao})
    return {"cliente_a": a, "cliente_b": b, "decisao": decisao}


def qualidade() -> dict:
    """Métrica de qualidade do match, publicada (o anexo de riscos da spec
    prevê isto): sem ela, ninguém percebe a resolução degradando até o
    usuário reclamar de conta duplicada na tela."""
    escopo = context.atual()
    with db.conexao() as con:
        total = con.execute(
            "SELECT COUNT(*) AS n FROM contas_canonicas WHERE tenant_id=?",
            (escopo.tenant_id,)).fetchone()["n"]
        contas = con.execute(
            "SELECT COUNT(DISTINCT account_id) AS n FROM contas_canonicas WHERE tenant_id=?",
            (escopo.tenant_id,)).fetchone()["n"]
        locais = con.execute(
            "SELECT COUNT(*) AS n FROM contas_canonicas WHERE tenant_id=? AND metodo='id_local'",
            (escopo.tenant_id,)).fetchone()["n"]
        decisoes = con.execute(
            "SELECT decisao, COUNT(*) c FROM decisoes_match WHERE tenant_id=? GROUP BY decisao",
            (escopo.tenant_id,)).fetchall()
    por_decisao = {r["decisao"]: r["c"] for r in decisoes}
    return {
        "clientes_resolvidos": total,
        "contas_canonicas": contas,
        # Cadastro sem CNPJ válido é o principal limitador da resolução: cada
        # um vira uma conta isolada que só a curadoria consegue unir.
        "sem_documento_valido": locais,
        "pct_sem_documento": round(100 * locais / total, 1) if total else None,
        "decisoes_de_curadoria": por_decisao,
        "pares_rotulados": sum(por_decisao.values()),
    }
