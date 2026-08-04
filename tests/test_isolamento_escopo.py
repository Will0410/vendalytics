"""
test_isolamento_escopo.py — o teste que a §3.5 da spec exige: "teste
automatizado que FALHA O BUILD se alguma query sair sem filtro de tenant".

O primeiro caso é o que dá o efeito de trava permanente: ele descobre as
funções de `data_layer` por reflexão, em vez de listá-las. Uma função de
leitura adicionada amanhã sem passar pelo escopo é reprovada por um teste
que ninguém precisou lembrar de atualizar — que é a única forma de uma regra
dessas sobreviver a um ano de features novas.
"""
from __future__ import annotations

import inspect

import pytest

from vendalytics import data_layer
from vendalytics.infra import context

# `disponivel` é a exceção documentada: roda no startup, antes de existir
# request, e não devolve dado de ninguém — só um booleano de conectividade.
SEM_ESCOPO_PERMITIDO = {"disponivel"}


def _funcoes_de_leitura():
    for nome, fn in vars(data_layer).items():
        if nome.startswith("_") or not inspect.isfunction(fn):
            continue
        if fn.__module__ != data_layer.__name__ or nome in SEM_ESCOPO_PERMITIDO:
            continue
        yield nome, fn


def _argumentos_dummy(fn):
    """Preenche só o que é obrigatório — o teste não se importa com o valor,
    só quer chegar até a linha que consulta o escopo."""
    args = []
    for p in inspect.signature(fn).parameters.values():
        if p.default is not inspect.Parameter.empty:
            continue
        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD):
            args.append("C-A")
    return args


def test_toda_leitura_exige_escopo_ativo():
    """Sem escopo ativo, nenhuma função de leitura pode devolver dado."""
    verificadas = []
    for nome, fn in _funcoes_de_leitura():
        with pytest.raises(context.EscopoAusente):
            fn(*_argumentos_dummy(fn))
        verificadas.append(nome)

    # Se a reflexão parar de achar as funções (refactor que mova o módulo, por
    # exemplo), o teste passaria vazio e daria falsa segurança.
    assert len(verificadas) >= 10, f"reflexão achou poucas funções: {verificadas}"


def test_escopo_restrito_ve_so_a_propria_filial(escopo_filial_a):
    r = data_layer.query_clientes()
    filiais = {c["filial"] for c in r["clientes"]}
    assert filiais == {"SP"}, f"vazou filial fora do escopo: {filiais}"


def test_escopo_irrestrito_ve_tudo(escopo_irrestrito):
    r = data_layer.query_clientes()
    assert {c["filial"] for c in r["clientes"]} == {"SP", "RJ"}


def test_pedir_filial_fora_do_escopo_e_negado(escopo_filial_a):
    """Negar, e não reduzir em silêncio: devolver os dados de SP para quem
    pediu RJ seria um número que o usuário leria como sendo do RJ."""
    with pytest.raises(context.EscopoNegado):
        data_layer.query_clientes(filial="RJ")


def test_leitura_por_id_nao_e_bypass(escopo_filial_a):
    """Era o furo mais direto: /api/clientes/{id} não checava filial nenhuma,
    então bastava saber o id para ler cliente de qualquer filial."""
    assert data_layer.cliente("C-A")["filial"] == "SP"
    with pytest.raises(context.EscopoNegado):
        data_layer.cliente("C-B")


def test_derivados_do_cliente_seguem_o_escopo(escopo_filial_a):
    for fn in (data_layer.pedidos_recentes, data_layer.mix_produtos_cliente,
               data_layer.roteiro_visitas):
        with pytest.raises(context.EscopoNegado):
            fn("C-B")


def test_cliente_inexistente_e_404_nao_403(escopo_filial_a):
    """Não existir e não poder ver são coisas diferentes — e o chamador
    precisa distinguir para não transformar 'não achei' em 'acesso negado'."""
    assert data_layer.cliente("C-INEXISTENTE") is None


def test_agregados_nao_vazam_outras_filiais(escopo_filial_a):
    """`por_filial` devolvia a contagem de TODAS as filiais junto do payload
    de quem só podia ver uma."""
    m = data_layer.metricas()
    assert set(m["por_filial"]) == {"SP"}
    assert m["total_clientes"] == 1


def test_vendedores_e_vendas_seguem_o_escopo(escopo_filial_a):
    assert {v["filial"] for v in data_layer.vendedores()} == {"SP"}
    assert {v["filial"] for v in data_layer.vendas_por_periodo()} == {"SP"}


def test_carteira_do_vendedor_respeita_o_escopo(escopo_filial_a):
    """O parâmetro de filial era aceito e ignorado aqui."""
    assert data_layer.clientes_do_vendedor("V-B") == []
    assert [c["id"] for c in data_layer.clientes_do_vendedor("V-A")] == ["C-A"]
