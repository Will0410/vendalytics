"""
geo.py — Geo Intelligence (spec §2.2, Fase 2 do roadmap).

Escopo real deste MVP, e o que falta para ser a spec inteira:

  B1 Simulador de ponto        → implementado sobre a PRÓPRIA carteira
                                  (densidade de clientes + faturamento
                                  capturável por decaimento de distância).
                                  Sem dado de concorrência nem sociodemografia
                                  externa — os componentes que dependeriam
                                  disso vêm `None`, nunca um número inventado.
  B2 Similaridade entre pontos → implementado (vetor de features do entorno
                                  de cada filial, distância euclidiana).
  B3 Preditor de faturamento   → implementado (histórico mensal da própria
                                  unidade, com intervalo de confiança e
                                  backtest — nunca ponto único).
  B4 Camadas de dado externo   → IMPLEMENTADO PARCIALMENTE: população
                                  estimada via `sources/ibge_real.py`
                                  (validado ao vivo contra a API pública do
                                  IBGE). Renda domiciliar e estrutura etária
                                  seguem de fora — exigem agregados SIDRA
                                  bem mais complexos; ver docstring da
                                  fonte. POI/mobilidade continuam ausentes.
  B5 Vertical packs            → implementado em `modules/verticais.py`.

Isócronas reais (roteamento) também não existem aqui — ver
`infra.geo.raio_aproximado_km` e o aviso que ele carrega. Nunca chamamos o
raio aproximado de "isócrona" na resposta: rotular errado destrói a
credibilidade do produto no primeiro usuário que confere no mapa.
"""
from __future__ import annotations

import math

from .. import data_layer
from ..infra import audit, context
from ..infra.geo import haversine_km, raio_aproximado_km
from ..sources import geocoding_real, ibge_real
from . import verticais

# Expoente de decaimento: quanto mais alto, mais rápido a "gravidade" de um
# cliente cai com a distância dentro do raio de busca. 2.0 é o expoente
# clássico do modelo de Huff para varejo.
EXPOENTE_DECAIMENTO = 2.0


def _peso_huff(distancia_km: float, raio_km: float) -> float:
    """Peso de captura por decaimento de distância (Huff simplificado, sem
    fator de atratividade do destino — aqui o "destino" é o ponto candidato
    sendo avaliado, não uma escolha entre lojas existentes).

    Decaimento RELATIVO ao raio de busca (1,0 no centro, 0 na borda), não a
    uma distância absoluta fixa. Um anchor absoluto (ex.: "peso máximo = a
    50m do ponto") faz qualquer cliente a poucas centenas de metros já valer
    quase zero — o componente inteiro fica morto em qualquer cenário
    realista, porque cliente colado a 50m do ponto exato é o caso raro, não
    o típico. Ancorar no raio pedido é o que mantém o componente sensível
    dentro da escala em que o usuário está de fato buscando.
    """
    if raio_km <= 0:
        return 1.0 if distancia_km <= 0 else 0.0
    return max(1.0 - (distancia_km / raio_km), 0.0) ** EXPOENTE_DECAIMENTO


def _clientes_geolocalizados(filial: str = "") -> list[dict]:
    return [c for c in data_layer.query_clientes(filial=filial, limit=100000)["clientes"]
            if c.get("lat") and c.get("lon")]


def simular_ponto(lat: float, lon: float, *, filial: str = "", raio_km: float = 5.0,
                  vertical: str = "", parametros_vertical: dict | None = None) -> dict:
    """Score de atratividade (0-100) de um ponto candidato, decomposto em
    fatores — todo score aqui obedece a mesma regra de explicabilidade do
    resto do produto (spec D-2), mesmo sem persistir em `infra.scores`.

    `vertical` (spec B5, opcional) anexa um vertical pack —
    `modules/verticais.py` — como contexto ADICIONAL, num campo `vertical`
    à parte: um índice de mix de shopping ou um alcance estimado de mídia
    externa não entra no mesmo score genérico de densidade+valor, porque
    são dimensões heterogêneas que diluiriam um ao outro se misturadas.
    """
    clientes = _clientes_geolocalizados(filial=filial)
    if not clientes:
        return {"disponivel": False, "motivo": "sem clientes geolocalizados no escopo"}

    proximos = []
    for c in clientes:
        d = haversine_km(lat, lon, c["lat"], c["lon"])
        if d <= raio_km:
            proximos.append((c, d))

    densidade = len(proximos)
    fatores = []

    # Componente 1: densidade de clientes no raio.
    score_densidade = min(densidade / 30.0, 1.0) * 100  # 30 clientes no raio = teto
    fatores.append({"fator": "densidade_clientes", "rotulo": f"{densidade} clientes no raio de {raio_km}km",
                    "contribuicao_pct": round(score_densidade, 1)})

    # Componente 2: valor capturável PONDERADO por decaimento de distância
    # (Huff — spec B1: "população capturável ponderada, não soma bruta"). Um
    # cliente a 200m pesa muito mais que um a 4,9km, mesmo os dois estando
    # dentro do raio — a soma bruta trataria os dois como iguais.
    valor_ponderado = 0.0
    if proximos:
        vendas = data_layer.vendas_por_periodo(filial=filial)
        valor_por_cliente: dict[str, float] = {}
        for v in vendas:
            cid = str(v.get("cliente_id"))
            valor_por_cliente[cid] = valor_por_cliente.get(cid, 0.0) + float(v.get("valor_total") or 0)
        for c, d in proximos:
            valor_ponderado += valor_por_cliente.get(str(c["id"]), 0.0) * _peso_huff(d, raio_km)
    score_valor = min(valor_ponderado / 200000.0, 1.0) * 100
    fatores.append({"fator": "valor_capturavel_ponderado",
                    "rotulo": f"R$ {valor_ponderado:,.0f} em vendas na vizinhança, "
                              f"ponderado por proximidade (modelo de Huff)",
                    "contribuicao_pct": round(score_valor, 1)})

    # Componente 3: camada sociodemográfica real (IBGE, spec B4) — para
    # QUALQUER ponto clicado, não só perto de cliente cadastrado. Resolve o
    # município por geocodificação reversa real (Nominatim/OSM); se essa
    # API estiver fora do ar, cai para o cliente mais próximo como
    # aproximação (melhor um palpite razoável do que nenhum dado).
    componentes_ausentes = {
        "pressao_competitiva": "sem base de concorrentes georreferenciada "
                               "(Overpass/OSM tentado e indisponível neste ambiente)",
    }
    score_socio = None
    municipio_ponto = geocoding_real.municipio_de(lat, lon)
    if municipio_ponto is None and proximos:
        c_mais_perto = min(proximos, key=lambda par: par[1])[0]
        if c_mais_perto.get("municipio") and c_mais_perto.get("uf"):
            municipio_ponto = {"municipio": c_mais_perto["municipio"], "uf": c_mais_perto["uf"]}

    if municipio_ponto:
        camada = ibge_real.camada_para_ponto(municipio_ponto["municipio"], municipio_ponto["uf"])
        if camada.get("disponivel"):
            # Proxy simples e documentado: cidade grande = mercado potencial
            # maior. Não é renda nem estrutura etária (a spec pede isso
            # também) — só o que a integração cobre hoje.
            score_socio = min(camada["populacao"] / 500_000, 1.0) * 100
            fatores.append({
                "fator": "sociodemografico_ibge",
                "rotulo": f"{municipio_ponto['municipio']}/{municipio_ponto['uf']}: "
                          f"{camada['populacao']:,} habitantes "
                          f"(IBGE, estimativa {camada['populacao_ano_referencia']})",
                "contribuicao_pct": round(score_socio, 1),
            })
        else:
            componentes_ausentes["sociodemografico"] = camada.get("motivo", "IBGE indisponível")
    else:
        componentes_ausentes["sociodemografico"] = (
            "não foi possível identificar o município deste ponto (geocodificação "
            "indisponível e nenhum cliente próximo para aproximar)")

    if score_socio is not None:
        score = round(0.45 * score_densidade + 0.35 * score_valor + 0.20 * score_socio, 1)
    else:
        score = round(0.6 * score_densidade + 0.4 * score_valor, 1)

    audit.registrar("geo.simulacao", recurso=f"{lat:.4f},{lon:.4f}",
                    detalhe={"raio_km": raio_km, "score": score, "vertical": vertical or None})

    resultado = {
        "disponivel": True,
        "lat": lat, "lon": lon, "raio_km": raio_km,
        "municipio": municipio_ponto,   # {municipio, uf} ou None — de onde vieram os dados de mercado
        "score_atratividade": score,
        "fatores": fatores,
        "componentes_nao_disponiveis": componentes_ausentes,
        "raio_deslocamento_aproximado_km": round(raio_aproximado_km(raio_km), 2),
        "aviso_isocrona": ("aproximação por fator de sinuosidade sobre distância "
                          "em linha reta — não é isócrona real de roteamento"),
    }
    if vertical:
        resultado["vertical"] = verticais.aplicar_pack(
            vertical, lat=lat, lon=lon, raio_km=raio_km, proximos=proximos,
            parametros=parametros_vertical)
    return resultado


def _vetor_filial(filial: str, clientes: list[dict]) -> list[float] | None:
    do_filial = [c for c in clientes if c.get("filial") == filial]
    if len(do_filial) < 3:
        return None
    lat_c = sum(c["lat"] for c in do_filial) / len(do_filial)
    lon_c = sum(c["lon"] for c in do_filial) / len(do_filial)
    distancias = [haversine_km(lat_c, lon_c, c["lat"], c["lon"]) for c in do_filial]
    segmentos = {}
    for c in do_filial:
        s = c.get("segmento") or "?"
        segmentos[s] = segmentos.get(s, 0) + 1
    diversidade_segmento = len(segmentos) / max(len(do_filial), 1)
    return [
        len(do_filial),                                    # porte da carteira
        sum(distancias) / len(distancias),                 # dispersão média
        diversidade_segmento,                               # mix de segmento
    ]


def similaridade_entre_filiais() -> dict:
    """Compara o entorno (perfil de clientes) das filiais existentes — a
    base para "transferir aprendizado de uma unidade para outra" (spec B2).
    Distância euclidiana sobre features normalizadas, sem lib externa."""
    escopo = context.atual()
    clientes = _clientes_geolocalizados()
    filiais = sorted({c.get("filial") for c in clientes if c.get("filial")})
    vetores = {f: _vetor_filial(f, clientes) for f in filiais}
    vetores = {f: v for f, v in vetores.items() if v is not None}
    if len(vetores) < 2:
        return {"disponivel": False,
                "motivo": "menos de 2 filiais com clientes geolocalizados suficientes"}

    # Normalização min-max por dimensão — necessária porque "porte" está em
    # dezenas/centenas e "diversidade" está em 0..1; sem normalizar, porte
    # dominaria a distância sozinho.
    dims = len(next(iter(vetores.values())))
    minimos = [min(v[i] for v in vetores.values()) for i in range(dims)]
    maximos = [max(v[i] for v in vetores.values()) for i in range(dims)]
    def norm(v):
        return [(v[i] - minimos[i]) / (maximos[i] - minimos[i]) if maximos[i] > minimos[i] else 0.0
                for i in range(dims)]

    normalizados = {f: norm(v) for f, v in vetores.items()}
    pares = []
    itens = list(normalizados.items())
    for i in range(len(itens)):
        for j in range(i + 1, len(itens)):
            fa, va = itens[i]
            fb, vb = itens[j]
            dist = math.sqrt(sum((va[k] - vb[k]) ** 2 for k in range(dims)))
            similaridade = round(1 / (1 + dist), 3)
            pares.append({"filial_a": fa, "filial_b": fb, "similaridade": similaridade})
    pares.sort(key=lambda p: p["similaridade"], reverse=True)

    audit.registrar("geo.similaridade_filiais", detalhe={"tenant": escopo.tenant_id, "filiais": len(vetores)})
    return {"disponivel": True, "filiais_avaliadas": list(vetores), "pares": pares}


def prever_faturamento(filial: str) -> dict:
    """Faturamento esperado do próximo mês para uma filial, com intervalo de
    confiança — nunca ponto único (spec B3: "R$480k±190k é honesto; 483.271
    é falsa precisão"). Baseado no próprio histórico mensal da unidade."""
    vendas = data_layer.vendas_por_periodo(filial=filial)
    if not vendas:
        return {"disponivel": False, "motivo": "sem histórico de vendas para esta filial"}

    from datetime import datetime
    por_mes: dict[str, float] = {}
    for v in vendas:
        d = str(v.get("data_venda") or "")[:7]  # AAAA-MM
        try:
            datetime.strptime(d, "%Y-%m")
        except ValueError:
            continue
        por_mes[d] = por_mes.get(d, 0.0) + float(v.get("valor_total") or 0.0)

    meses = sorted(por_mes)
    if len(meses) < 3:
        return {"disponivel": False,
                "motivo": "histórico curto demais (< 3 meses) para estimar variação"}

    valores = [por_mes[m] for m in meses]
    media = sum(valores) / len(valores)
    variancia = sum((v - media) ** 2 for v in valores) / len(valores)
    desvio = math.sqrt(variancia)

    # Backtest simples: erro do "previsor ingênuo" (média dos meses
    # anteriores) contra cada mês real, exibido ao lado da previsão —
    # honestidade sobre o quanto o método já errou no passado (spec B3).
    erros_pct = []
    for i in range(1, len(valores)):
        media_ate_aqui = sum(valores[:i]) / i
        if valores[i] > 0:
            erros_pct.append(abs(valores[i] - media_ate_aqui) / valores[i] * 100)
    mape_backtest = round(sum(erros_pct) / len(erros_pct), 1) if erros_pct else None

    return {
        "disponivel": True,
        "filial": filial,
        "meses_historico": len(meses),
        "faturamento_esperado": round(media, 2),
        "intervalo_confianca_80pct": [round(max(media - 1.28 * desvio, 0), 2),
                                      round(media + 1.28 * desvio, 2)],
        "mape_backtest_pct": mape_backtest,
        "metodo": "média histórica ± 1,28×desvio-padrão mensal (aproximação normal, IC 80%)",
    }
