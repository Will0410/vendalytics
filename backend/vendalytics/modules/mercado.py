"""
mercado.py — Território / TAM→SAM→SOM (spec §2.1, capacidade A2).

  TAM (universo total do segmento no município) — `sources.mercado_externo`,
      hoje sobre o cache local alimentado por `rfb_real.py` (BrasilAPI/RFB),
      plugável e substituível por provedor licenciado (Serasa/Neoway) sem
      tocar este módulo.
  SAM (universo filtrado pelo ICP do tenant)     — recorte do TAM pelos
      prefixos de CNAE que o tenant configurou como segmento-alvo
      (tenant.grupos_cnae()) — hoje 1:1 com o TAM porque a segmentação já
      É o filtro de ICP; ICP por modelo preditivo (A1) refina isso depois.
  SOM (o que já está na carteira)                — sempre disponível,
      cobertura própria via data_layer.cobertura_por_municipio.

Este módulo não finge ter TAM quando não tem: cada município sem dado de
universo volta com `tam`/`whitespace: null`, nunca 0 — 0 significaria "sem
oportunidade", uma afirmação factual que o módulo não tem como fazer sem o
dado real. O cache de universo cresce por uso (cada CNPJ consultado via
`mercado_externo.consultar_e_cachear` fica disponível daí em diante) — não
é o universo nacional completo, e a resposta diz isso explicitamente.
"""
from __future__ import annotations

from .. import data_layer, tenant
from ..sources import mercado_externo, mercado_publico_cache
from .identidade import normalizar_texto


def _prefixos_do_segmento(segmento: str) -> list[str]:
    grupos = tenant.carregar().grupos_cnae()
    if segmento and segmento in grupos:
        return list(grupos[segmento].get("prefixos") or [])
    if segmento:
        return []  # segmento pedido não existe na config do tenant
    # Sem segmento específico: todos os grupos marcados como padrão (mesma
    # convenção usada na prospecção — ver tenant_config.example.yaml).
    prefixos = []
    for g in grupos.values():
        if g.get("padrao"):
            prefixos += g.get("prefixos") or []
    return sorted(set(prefixos))


def _chave(municipio: str, uf: str) -> tuple[str, str]:
    """Chave de junção território: nome de município normalizado (minúsculo,
    sem acento) + UF em maiúsculo. Precisa ser a MESMA normalização usada por
    `mercado_publico_cache.registrar` — nomes vêm de fontes diferentes
    (cadastro digitado à mão vs. RFB em caixa alta) e comparar bruto perderia
    a junção em silêncio, do mesmo jeito que aconteceria comparar sigla de
    filial sem normalizar."""
    return normalizar_texto(municipio), (uf or "").strip().upper()


def cobertura(*, filial: str = "") -> dict:
    """SOM: cobertura própria por município/segmento. Sempre disponível,
    não depende de nenhuma fonte externa."""
    linhas = data_layer.cobertura_por_municipio(filial=filial)
    return {
        "fonte_tam": "disponível" if mercado_externo.configurado() else "indisponível",
        "empresas_no_cache_publico": mercado_publico_cache.total_ingerido(),
        "municipios": linhas,
    }


def tam_sam_som(*, filial: str = "", segmento: str = "", uf: str = "") -> dict:
    """Visão consolidada TAM→SAM→SOM por município, com whitespace honesto
    (null quando não há como calcular, nunca 0 por omissão)."""
    propria = {_chave(m["municipio"], m["uf"]): m for m in
              data_layer.cobertura_por_municipio(filial=filial)}

    prefixos = _prefixos_do_segmento(segmento)
    fonte_ligada = mercado_externo.configurado()
    universo_externo = (
        mercado_externo.universo_por_uf(prefixos, uf) if fonte_ligada and prefixos else None)
    tem_dado_de_universo = bool(universo_externo)  # [] (cache vazio) e None (fonte off) ambos falsy

    resultado = []
    if tem_dado_de_universo:
        for m in universo_externo:
            chave = _chave(m["municipio"], m["uf"])
            cob = propria.get(chave, {"total": 0, "ativos": 0})
            sam = m["empresas"]  # SAM == TAM neste recorte (ver docstring)
            som = cob["ativos"]
            resultado.append({
                "municipio": m["municipio"], "uf": m["uf"],
                "tam": sam, "sam": sam, "som": som,
                "whitespace": max(sam - som, 0),
                "penetracao_pct": round(100 * som / sam, 1) if sam else None,
            })
        # Municípios onde a carteira já atua mas o cache de universo ainda
        # não tem nenhuma empresa desse segmento catalogada — entram com
        # TAM/SAM nulos, nunca escondidos e nunca 0.
        cobertos = {_chave(r["municipio"], r["uf"]) for r in resultado}
        for chave, cob in propria.items():
            if chave not in cobertos:
                resultado.append({
                    "municipio": cob["municipio"], "uf": cob["uf"],
                    "tam": None, "sam": None, "som": cob["ativos"],
                    "whitespace": None, "penetracao_pct": None,
                })
    else:
        for cob in propria.values():
            resultado.append({
                "municipio": cob["municipio"], "uf": cob["uf"],
                "tam": None, "sam": None, "som": cob["ativos"],
                "whitespace": None, "penetracao_pct": None,
            })

    resultado.sort(key=lambda r: (r["whitespace"] is None, -(r["whitespace"] or 0)))

    if not fonte_ligada:
        aviso = "fonte de universo de mercado indisponível no momento."
    elif not prefixos:
        aviso = (f"segmento '{segmento}' sem prefixos de CNAE configurados em "
                 f"tenant_config.yaml — sem isso não há como buscar universo.") if segmento else \
                "nenhum grupo de segmentação padrão configurado no tenant."
    elif not tem_dado_de_universo:
        aviso = ("nenhuma empresa deste segmento catalogada ainda no cache de mercado "
                 "público — o universo cresce conforme CNPJs são consultados "
                 "(mercado_externo.consultar_e_cachear); exibindo só a cobertura própria.")
    else:
        aviso = None

    return {
        "segmento": segmento or "(todos os padrão)",
        "prefixos_cnae": prefixos,
        "tam_disponivel": tem_dado_de_universo,
        "aviso": aviso,
        "municipios": resultado,
    }
