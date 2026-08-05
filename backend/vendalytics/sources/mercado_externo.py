"""
mercado_externo.py — universo de mercado (TAM) para o módulo de Território
(spec §2.1 A2), a partir do cache local alimentado por `rfb_real.py`.

Até esta versão, esta era uma chamada HTTP para um projeto irmão separado
(`cortex-b2b`), com a mesma responsabilidade rodando num segundo processo.
Isso foi consolidado: agora é tudo neste repositório, sem chamada de rede
entre processos e sem segundo deploy — mantendo a mesma interface pública
(`configurado()` / `universo_por_uf`) para que `modules/mercado.py` e os
testes existentes não precisassem mudar uma linha.
"""
from __future__ import annotations

from . import mercado_publico_cache, rfb_real


def configurado() -> bool:
    """True se a fonte de universo de mercado está disponível — hoje
    equivale a `rfb_real.configurado()` (API pública, sem chave)."""
    return rfb_real.configurado()


def universo_por_uf(prefixos_cnae: list[str], uf: str = "") -> list[dict] | None:
    """Universo de empresas ativas por município, para os prefixos de CNAE
    dados. `None` só quando a fonte está desligada; lista (possivelmente
    vazia) quando está ligada mas o cache ainda não tem nenhuma empresa
    desses prefixos catalogada — ver `modules/mercado.py` para como cada
    caso vira um aviso diferente ao usuário."""
    if not configurado() or not prefixos_cnae:
        return None
    return mercado_publico_cache.universo_por_prefixos(prefixos_cnae, uf)


def consultar_e_cachear(cnpj: str) -> dict | None:
    """Ponto de entrada para alimentar o cache com 1 CNPJ real (ex.: quando
    o vendedor cadastra um prospect novo, ou uma rotina de enriquecimento
    roda sobre uma lista). Fora do caminho quente de `tam_sam_som` de
    propósito — consultar rede síncrona dentro de uma leitura agregada
    quebraria o `<1s` esperado desse endpoint."""
    return rfb_real.consultar(cnpj, cachear=True)
