"""
test_experimento.py — o laço de retorno e o braço de controle.

O que se checa aqui não é o INSERT (isso o SQLite garante), e sim as
propriedades sem as quais a medição futura não vale nada:

  1. **O braço é determinístico.** Se a mesma praça caísse ora em tratado ora
     em controle, os dois grupos se contaminariam em uma tarde de uso e
     nenhuma comparação posterior teria sentido. É a propriedade que, se
     quebrar, quebra em silêncio — nada na tela denuncia.
  2. **A proporção do controle é a declarada.** Um controle que na prática sai
     em 2% nunca fecha amostra; um que sai em 40% custa venda de verdade.
  3. **O vocabulário é o que já existe.** Os desfechos vão para a tabela
     genérica da migration 3, lida por `infra/scores.py` e `modules/fila.py`.
     Inventar palavras novas partiria o loop fechado em dois conjuntos que não
     se somam — e nada denunciaria, porque as duas metades continuariam
     parecendo completas.
  4. **Desfecho do CONTROLE também é aceito.** É contraintuitivo e é o ponto:
     sem o desfecho do controle não há com o que comparar, e o endpoint que
     recusasse essas linhas destruiria o experimento sem erro nenhum.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from conftest import db_operacional_isolado

from vendalytics.infra import db
from vendalytics.modules import experimento


@pytest.fixture
def base(escopo_irrestrito):
    """Banco operacional zerado a cada teste.

    O `unlink` não é redundante: `db_operacional_isolado` só aponta o caminho,
    não apaga o arquivo. Sem ele, as contagens de `resumo()` somariam o que o
    teste anterior deixou para trás e as asserções passariam a depender da
    ordem de coleta.
    """
    with db_operacional_isolado("experimento") as caminho:
        caminho.unlink(missing_ok=True)
        # O banco isolado nasce vazio; as migrations criam `recomendacoes` e
        # `desfechos`. Sem isto o erro é "no such table", que parece bug do
        # módulo e é só ordem de preparo.
        db.migrar()
        yield


# ── 1. Sorteio ────────────────────────────────────────────────────────────

def test_braco_e_estavel_entre_chamadas():
    """A mesma praça cai sempre no mesmo braço.

    Um `random.random()` aqui pareceria funcionar em teste manual e arruinaria
    a medição meses depois, quando já não houvesse como reconstituir quem foi
    tratado.
    """
    for _ in range(50):
        assert experimento.braco_de(3550308, "G") == experimento.braco_de(3550308, "G")


def test_setor_define_experimentos_independentes():
    """A mesma praça pode ser oportunidade em Comércio e não em Indústria —
    são experimentos separados, então o setor entra na chave do sorteio."""
    bracos = {experimento.braco_de(3550308, s) for s in ("G", "C", "F", "A", "B")}
    # Não exigimos que TODOS diferem (seria sorte), só que a chave considera o
    # setor — o que se verifica pela existência de ao menos um par diferente
    # em uma varredura maior.
    diferem = any(
        experimento.braco_de(m, "G") != experimento.braco_de(m, "C")
        for m in range(3500000, 3500400)
    )
    assert diferem, "o setor não está entrando no sorteio"
    assert bracos <= set(experimento.BRACOS)


def test_proporcao_do_controle_bate_com_a_declarada():
    """15% declarado tem que sair ~15% na prática.

    Tolerância de 2 pontos sobre 5.000 praças: estreita o bastante para pegar
    um hash enviesado, larga o bastante para não falhar por flutuação.
    """
    n = 5000
    controle = sum(
        1 for m in range(1100015, 1100015 + n)
        if experimento.braco_de(m, "G") == "controle"
    )
    fracao = controle / n
    assert abs(fracao - experimento.FRACAO_CONTROLE) < 0.02, f"saiu {fracao:.3f}"


def test_todo_municipio_cai_em_um_dos_dois_bracos():
    for m in range(3500000, 3500200):
        assert experimento.braco_de(m, "G") in experimento.BRACOS


# ── 2. Registro de exibição ───────────────────────────────────────────────

def test_grava_lote_de_exibicoes_com_o_braco(base):
    itens = [
        {"municipio": 3550308, "setor": "G", "posicao": 1, "score": 78.4},
        {"municipio": 3543402, "setor": "G", "posicao": 2, "score": 71.0},
    ]
    assert experimento.registrar_exibicao(itens, "vazios")["gravados"] == 2

    r = experimento.resumo("G")
    total = sum(v["registros"] for v in r["exibicoes"].values())
    assert total == 2


def test_lote_vazio_nao_e_erro(base):
    """Uma tela sem resultado não é falha — abstenção pode zerar o ranking."""
    assert experimento.registrar_exibicao([], "vazios")["gravados"] == 0


def test_recusa_lote_grande_demais(base):
    itens = [{"municipio": 1 + i, "setor": "G", "posicao": i} for i in range(501)]
    with pytest.raises(HTTPException) as e:
        experimento.registrar_exibicao(itens, "vazios")
    assert e.value.status_code == 400


def test_recusa_item_sem_municipio(base):
    with pytest.raises(HTTPException):
        experimento.registrar_exibicao([{"setor": "G", "posicao": 1}], "vazios")


def test_reabrir_a_tela_conta_como_nova_exibicao(base):
    """Idempotência NÃO é desejada: quantas vezes uma praça foi mostrada faz
    parte da medição de exposição."""
    item = [{"municipio": 3550308, "setor": "G", "posicao": 1}]
    experimento.registrar_exibicao(item, "vazios")
    experimento.registrar_exibicao(item, "vazios")

    r = experimento.resumo("G")
    total = sum(v["registros"] for v in r["exibicoes"].values())
    pracas = sum(v["pracas"] for v in r["exibicoes"].values())
    assert total == 2 and pracas == 1


# ── 3. Desfecho ───────────────────────────────────────────────────────────

def test_aceita_desfecho_de_praca_do_controle(base):
    """A trava mais importante do arquivo.

    Um endpoint que recusasse desfecho de controle não daria erro nenhum
    visível — e destruiria o experimento, porque o grupo de comparação ficaria
    vazio para sempre.
    """
    controle = next(
        m for m in range(3500000, 3510000)
        if experimento.braco_de(m, "G") == "controle"
    )
    r = experimento.registrar_desfecho(controle, "G", "ganhou", 12000.0)
    assert r["ok"] is True and r["braco"] == "controle"


def test_recusa_tipo_de_desfecho_invalido(base):
    with pytest.raises(HTTPException) as e:
        experimento.registrar_desfecho(3550308, "G", "talvez")
    assert e.value.status_code == 400


def test_desfechos_aparecem_separados_por_braco(base):
    tratado = next(m for m in range(3500000, 3510000)
                   if experimento.braco_de(m, "G") == "tratado")
    controle = next(m for m in range(3500000, 3510000)
                    if experimento.braco_de(m, "G") == "controle")

    experimento.registrar_desfecho(tratado, "G", "ganhou")
    experimento.registrar_desfecho(tratado, "G", "aceita")
    experimento.registrar_desfecho(controle, "G", "perdeu")

    r = experimento.resumo("G")
    assert r["por_braco"]["tratado"]["ganhos"] == 1
    assert r["por_braco"]["tratado"]["desfechos"] == 2
    assert r["por_braco"]["controle"]["ganhos"] == 0
    assert r["por_braco"]["controle"]["desfechos"] == 1


# ── 4. Resumo ─────────────────────────────────────────────────────────────

def test_nao_diz_que_esta_pronto_com_amostra_pequena(base):
    """`pronto_para_medir` é um sinal de ordem de grandeza, e precisa ser
    conservador: rodar a conta cedo produz um número que parece resultado."""
    experimento.registrar_desfecho(3550308, "G", "ganhou")
    r = experimento.resumo("G")
    assert r["pronto_para_medir"] is False
    assert r["faltam_no_menor_braco"] > 0


def test_taxa_de_ganho_e_none_sem_desfecho(base):
    """Zero desfechos não é taxa zero. Um 0% na tela seria lido como
    'não funciona' quando o correto é 'ainda não sabemos'."""
    r = experimento.resumo("G")
    assert r["por_braco"]["tratado"]["taxa_ganho"] is None
    assert r["por_braco"]["controle"]["taxa_ganho"] is None


def test_resumo_filtra_por_setor(base):
    experimento.registrar_desfecho(3550308, "G", "ganhou")
    experimento.registrar_desfecho(3550308, "C", "ganhou")

    assert sum(v["desfechos"] for v in experimento.resumo("G")["por_braco"].values()) == 1
    assert sum(v["desfechos"] for v in experimento.resumo("")["por_braco"].values()) == 2
