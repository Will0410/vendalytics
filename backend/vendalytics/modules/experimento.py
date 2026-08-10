"""
experimento.py — o laço de retorno, e o braço de controle que o torna honesto.

── Por que isto existe ─────────────────────────────────────────────────────
Os dois modelos preditivos da plataforma são calibrados contra a história do
IBGE. Nenhum deles sabe se a operação de vendas GANHOU alguma coisa. O Score
ICP, pior ainda, é um conjunto de pesos que somam 100 porque alguém escolheu
que somassem — nada neles veio de contrato assinado.

Sem registro de desfecho, nenhum modelo novo melhora a decisão comercial: só
melhora a estatística. E desfecho não se coleta retroativamente, então este é
o único item do produto que fica pior quanto mais se adia.

── Por que um braço de CONTROLE ────────────────────────────────────────────
Registrar só o que foi recomendado e deu certo não prova nada. Se a praça ia
crescer de qualquer jeito, o mérito foi do IBGE e não da recomendação.

A única forma de separar "cresceu porque atuamos" de "cresceu sozinho" é ter
praças comparáveis que o produto DELIBERADAMENTE não recomendou. Parece
desperdício e é o contrário: é o que transforma a plataforma de ferramenta de
análise em infraestrutura de experimento — e é a única coisa que um diretor
financeiro aceita como prova.

── Por que o sorteio é determinístico ──────────────────────────────────────
O braço sai de um hash do município, não de um gerador aleatório. Se mudasse a
cada consulta, a mesma praça apareceria ora recomendada ora não, os dois grupos
se contaminariam e a medição não valeria nada.

── O que este módulo NÃO faz ───────────────────────────────────────────────
Não estima efeito causal. Uplift precisa de meses de tratado-contra-controle
acumulado; aqui só se constrói o registro que torna essa conta possível depois.
`resumo()` devolve a contagem dos dois braços justamente para que dê para saber
QUANDO há amostra — e para que ninguém rode a conta antes disso.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone

from fastapi import HTTPException

from ..infra import audit, context, db, scores

log = logging.getLogger("vendalytics.experimento")

# Vocabulário da tabela `desfechos`, que existe desde a migration 3 e é lida
# por `infra/scores.py` e `modules/fila.py`. NÃO inventar palavras novas aqui:
# um segundo vocabulário partiria o loop fechado em dois conjuntos que não se
# somam, e nada denunciaria isso — as duas metades continuariam parecendo
# completas.
TIPOS = scores.DESFECHOS_VALIDOS if hasattr(scores, "DESFECHOS_VALIDOS") else (
    "aceita", "recusada", "ganhou", "perdeu", "ignorada")
BRACOS = ("tratado", "controle")

# Como a praça é identificada dentro da tabela genérica de desfechos.
SUJEITO = "praca"


def sujeito_id(municipio: int, setor: str) -> str:
    """`3550308/G`. O setor entra porque a mesma praça é um experimento
    diferente em cada seção CNAE."""
    return f"{int(municipio)}/{setor.strip().upper()}"

# Fatia do universo que fica de fora das recomendações.
#
# 15% é o meio-termo entre duas perdas reais: um controle grande custa
# oportunidade de venda; um controle pequeno não fecha amostra nunca. Com ~330
# praças sustentáveis por setor, 15% dá ~50 no controle — suficiente para uma
# diferença grande aparecer, insuficiente para uma pequena. Está declarado aqui
# em vez de escondido no código justamente porque é uma decisão de negócio.
FRACAO_CONTROLE = 0.15

# Muda o sorteio inteiro. Trocar isto INVALIDA a comparação acumulada, porque
# praças trocam de braço — por isso é constante e não configuração.
SEMENTE = "vendalytics-experimento-v1"


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def braco_de(municipio: int, setor: str) -> str:
    """Sorteio determinístico e estável do braço.

    Hash e não `random`: a mesma praça precisa cair sempre no mesmo braço, em
    qualquer processo e depois de qualquer restart. Um sorteio por requisição
    contaminaria os dois grupos em uma tarde de uso.

    O setor entra na chave porque a mesma praça pode ser oportunidade em
    Comércio e não em Indústria — são experimentos independentes.
    """
    chave = f"{SEMENTE}:{setor.upper()}:{municipio}".encode()
    # 4 bytes bastam: 2^32 baldes para 5.570 municípios.
    balde = int.from_bytes(hashlib.sha256(chave).digest()[:4], "big") / 2**32
    return "controle" if balde < FRACAO_CONTROLE else "tratado"


def registrar_exibicao(
    itens: list[dict], modulo: str,
) -> dict:
    """Grava as praças que um ranking mostrou.

    Recebe a lista inteira de uma vez: uma requisição por praça exibida seria
    dezenas de chamadas por tela aberta, e o registro não vale esse custo.

    Idempotência NÃO é garantida de propósito — reabrir a tela é uma exibição
    nova, e saber quantas vezes uma praça foi mostrada faz parte da medição.
    """
    escopo = context.atual()
    if not itens:
        return {"gravados": 0}
    if len(itens) > 500:
        raise HTTPException(400, "lote grande demais: máximo 500 exibições por chamada")

    linhas = []
    for i in itens:
        try:
            municipio = int(i["municipio"])
            setor = str(i["setor"]).strip().upper()
            posicao = int(i.get("posicao", 0))
        except (KeyError, TypeError, ValueError) as e:
            raise HTTPException(400, f"item inválido: {e}") from e
        if not setor:
            raise HTTPException(400, "setor é obrigatório")
        score = i.get("score")
        linhas.append((
            escopo.tenant_id, municipio, setor, modulo.strip() or "?", posicao,
            float(score) if score is not None else None,
            braco_de(municipio, setor), escopo.usuario, _agora(),
        ))

    with db.conexao() as con:
        con.executemany(
            """INSERT INTO recomendacoes
               (tenant_id, municipio, setor, modulo, posicao, score, braco, usuario, criado_em)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            linhas)
        con.commit()
    return {"gravados": len(linhas)}


def registrar_desfecho(
    municipio: int, setor: str, tipo: str, valor: float | None = None, motivo: str = "",
) -> dict:
    """Grava o que aconteceu com uma praça.

    O desfecho é registrado para QUALQUER praça, inclusive as do braço de
    controle — sem isso não haveria com o que comparar. É contraintuitivo e é o
    ponto: o controle não é "praça ignorada", é "praça que a operação alcançou
    sem a nossa recomendação".
    """
    tipo = tipo.strip().lower()
    if tipo not in TIPOS:
        raise HTTPException(400, f"desfecho inválido: use um de {', '.join(TIPOS)}")
    setor = setor.strip().upper()
    if not setor:
        raise HTTPException(400, "setor é obrigatório")

    # Reaproveita a gravação que já existe: ela grava E emite o sinal no
    # barramento, sempre juntos. Um INSERT direto aqui teria pulado o sinal e
    # o barramento passaria a ter uma visão incompleta do que aconteceu.
    scores.registrar_desfecho(
        sujeito_tipo=SUJEITO, sujeito_id=sujeito_id(municipio, setor),
        desfecho=tipo, motivo=motivo.strip()[:400], valor=valor)

    audit.registrar("experimento.desfecho", recurso=sujeito_id(municipio, setor),
                    detalhe={"desfecho": tipo})
    return {"ok": True, "braco": braco_de(int(municipio), setor)}


def resumo(setor: str = "") -> dict:
    """Estado do experimento: quanto já se acumulou em cada braço.

    Devolve `pronto_para_medir` como um SINAL, não como um veredito. O piso de
    30 desfechos por braço é a ordem de grandeza abaixo da qual qualquer
    diferença observada é ruído — não é poder estatístico calculado, e o campo
    se chama assim para não ser lido como se fosse.
    """
    escopo = context.atual()
    filtro = " AND setor=?" if setor else ""
    params_base: tuple = (escopo.tenant_id,) + ((setor.strip().upper(),) if setor else ())

    with db.conexao() as con:
        exib = con.execute(
            f"""SELECT braco, COUNT(*) AS n, COUNT(DISTINCT municipio) AS pracas
                FROM recomendacoes WHERE tenant_id=?{filtro} GROUP BY braco""",
            params_base).fetchall()
        # Os desfechos vêm da tabela genérica, filtrados por sujeito_tipo. O
        # `sujeito_id` é "municipio/SETOR", então o recorte por setor é sufixo.
        sufixo = " AND sujeito_id LIKE ?" if setor else ""
        p_desf: tuple = (escopo.tenant_id, SUJEITO) + (
            (f"%/{setor.strip().upper()}",) if setor else ())
        desf = con.execute(
            f"""SELECT desfecho, COUNT(*) AS n FROM desfechos
                WHERE tenant_id=? AND sujeito_tipo=?{sufixo} GROUP BY desfecho""",
            p_desf).fetchall()
        por_braco = con.execute(
            f"""SELECT sujeito_id, desfecho FROM desfechos
                WHERE tenant_id=? AND sujeito_tipo=?{sufixo}""",
            p_desf).fetchall()

    exibicoes = {r["braco"]: {"registros": r["n"], "pracas": r["pracas"]} for r in exib}
    ganhos = {"tratado": 0, "controle": 0}
    total = {"tratado": 0, "controle": 0}
    for r in por_braco:
        alvo, _, sec = str(r["sujeito_id"]).partition("/")
        try:
            b = braco_de(int(alvo), sec)
        except ValueError:
            continue  # linha de outro formato — ignora em vez de estourar
        total[b] += 1
        if r["desfecho"] == "ganhou":
            ganhos[b] += 1

    minimo = min(total["tratado"], total["controle"])
    return {
        "setor": setor.upper() or "todos",
        "fracao_controle": FRACAO_CONTROLE,
        "exibicoes": exibicoes,
        "desfechos": {r["desfecho"]: r["n"] for r in desf},
        "por_braco": {
            b: {"desfechos": total[b], "ganhos": ganhos[b],
                "taxa_ganho": round(ganhos[b] / total[b], 4) if total[b] else None}
            for b in BRACOS
        },
        "pronto_para_medir": minimo >= 30,
        "faltam_no_menor_braco": max(0, 30 - minimo),
    }
