# dagster_defs.py — definição mínima para o webserver subir de verdade
# (spec §3.1: Dagster como orquestrador da camada de ingestão). Um asset de
# exemplo só para provar que o servidor carrega e serve — os assets reais
# (bronze/silver/gold, entity resolution) entram aqui quando a ingestão em
# lote existir; hoje o produto lê direto do adapter, sem pipeline batch.
from dagster import asset, Definitions


@asset
def exemplo_ingestao_bronze() -> str:
    """Placeholder do asset que a Fase de ingestão real substituiria — prova
    que o servidor Dagster sobe e materializa um asset de verdade."""
    return "ok"


defs = Definitions(assets=[exemplo_ingestao_bronze])
