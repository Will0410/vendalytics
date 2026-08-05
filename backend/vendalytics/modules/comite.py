"""
comite.py — comitê de compras por conta (spec §2.1 A5).

"Venda complexa com um único contato mapeado é risco": se a pessoa que o
vendedor conhece sai da empresa ou muda de área, a conta inteira perde o
fio. O score de completude aqui existe para tornar esse risco visível ANTES
de acontecer, não depois.

Papéis modelados explicitamente (não é um campo de texto livre): decisor
econômico, usuário, influenciador, gatekeeper, campeão — o vocabulário
padrão de venda B2B complexa. Uma conta com 5 contatos e nenhum decisor
econômico está tão exposta quanto uma com 1 contato só.
"""
from __future__ import annotations

from datetime import datetime, timezone

from ..infra import audit, context, db

PAPEIS = ("decisor_economico", "usuario", "influenciador", "gatekeeper", "campeao")

# Pesos do score de completude (somam 100). Explícitos e auditáveis: cada
# ausência tem um custo declarado, não uma penalidade escondida numa fórmula.
# Decisor econômico e campeão pesam mais — sem o primeiro a venda não fecha;
# sem o segundo, ninguém defende o fornecedor quando o vendedor não está na
# sala. Os outros três papéis dividem o resto igualmente.
_PESO_TEM_CONTATO = 15.0
_PESO_PAPEL = {
    "decisor_economico": 40.0,
    "campeao": 25.0,
    "usuario": 20.0 / 3,
    "influenciador": 20.0 / 3,
    "gatekeeper": 20.0 / 3,
}
assert abs(_PESO_TEM_CONTATO + sum(_PESO_PAPEL.values()) - 100.0) < 1e-6


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def adicionar(conta_id: str, *, nome: str, papel: str, senioridade: str = "",
             canal_preferencial: str = "", email: str = "", telefone: str = "") -> dict:
    if papel not in PAPEIS:
        raise ValueError(f"papel inválido: '{papel}' (esperado um de {', '.join(PAPEIS)})")
    if not nome.strip():
        raise ValueError("nome do contato é obrigatório")
    escopo = context.atual()
    with db.conexao() as con:
        cur = con.execute(
            """INSERT INTO contatos (tenant_id, conta_id, nome, papel, senioridade,
                                     canal_preferencial, email, telefone,
                                     criado_em, criado_por)
               VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id""",
            (escopo.tenant_id, conta_id, nome.strip(), papel, senioridade,
             canal_preferencial, email.strip(), telefone.strip(), _agora(), escopo.usuario))
        contato_id = int(cur.fetchone()["id"])
    audit.registrar("comite.contato_adicionado", recurso=f"conta:{conta_id}",
                    detalhe={"papel": papel})
    return {"id": contato_id, "conta_id": conta_id, "nome": nome, "papel": papel}


def remover(conta_id: str, contato_id: int) -> None:
    """Remoção lógica (`removido_em`), não DELETE: um contato que saiu da
    empresa é histórico de relacionamento, não um erro de digitação.

    Exige `conta_id` e confere que o contato pertence a ela: o endpoint já
    valida que o usuário alcança `conta_id` (via `data_layer.cliente`), mas
    sem essa conferência aqui um id de contato de OUTRA conta — fora do
    escopo do usuário — poderia ser removido só por ele ser adivinhável.
    """
    escopo = context.atual()
    with db.conexao() as con:
        r = con.execute(
            """SELECT conta_id FROM contatos
               WHERE id=? AND tenant_id=? AND conta_id=? AND removido_em IS NULL""",
            (contato_id, escopo.tenant_id, conta_id)).fetchone()
        if not r:
            raise ValueError(f"contato {contato_id} não encontrado nesta conta ou já removido")
        con.execute("UPDATE contatos SET removido_em=? WHERE id=? AND tenant_id=?",
                    (_agora(), contato_id, escopo.tenant_id))
    audit.registrar("comite.contato_removido", recurso=f"conta:{conta_id}",
                    detalhe={"contato_id": contato_id})


def listar(conta_id: str) -> list[dict]:
    escopo = context.atual()
    with db.conexao() as con:
        rows = con.execute(
            """SELECT * FROM contatos WHERE tenant_id=? AND conta_id=? AND removido_em IS NULL
               ORDER BY papel, nome""",
            (escopo.tenant_id, conta_id)).fetchall()
    return [dict(r) for r in rows]


def completude(conta_id: str) -> dict:
    """Score de completude (0-100) e o que falta para subir.

    Não é só contagem: uma conta com 4 usuários e 0 decisores está incompleta
    de um jeito que uma com 1 decisor não está, mesmo tendo menos gente.
    """
    contatos = listar(conta_id)
    papeis_presentes = {c["papel"] for c in contatos}

    score = (_PESO_TEM_CONTATO if contatos else 0.0)
    score += sum(peso for papel, peso in _PESO_PAPEL.items() if papel in papeis_presentes)
    score = round(min(score, 100.0), 1)

    faltando = []
    for papel in PAPEIS:
        if papel not in papeis_presentes:
            faltando.append(papel)

    return {
        "conta_id": conta_id,
        "total_contatos": len(contatos),
        "papeis_mapeados": sorted(papeis_presentes),
        "papeis_faltando": faltando,
        "score_completude": score,
        "risco_alto": "decisor_economico" not in papeis_presentes,
    }
