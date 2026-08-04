"""
mercado.py — Território / TAM→SAM→SOM (spec §2.1, capacidade A2).

  TAM (universo total do segmento no município) — fonte externa opcional
      (sources.mercado_externo), plugável e substituível por provedor
      licenciado (Serasa/Neoway/RFB) sem tocar este módulo.
  SAM (universo filtrado pelo ICP do tenant)     — recorte do TAM pelos
      prefixos de CNAE que o tenant configurou como segmento-alvo
      (tenant.grupos_cnae()) — hoje 1:1 com o TAM porque a segmentação já
      É o filtro de ICP; ICP por modelo preditivo (A1) refina isso depois.
  SOM (o que já está na carteira)                — sempre disponível,
      cobertura própria via data_layer.cobertura_por_municipio.

Quando a fonte de TAM não está configurada, o módulo não finge ter TAM: cada
município volta com `universo: null` e `whitespace: null`, nunca 0 — 0
significaria "sem oportunidade", que é uma afirmação factual que este
módulo não tem como fazer sem o dado externo.
"""
from __future__ import annotations

from .. import data_layer, tenant
from ..sources import mercado_externo


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


def cobertura(*, filial: str = "") -> dict:
    """SOM: cobertura própria por município/segmento. Sempre disponível,
    não depende de nenhuma fonte externa."""
    linhas = data_layer.cobertura_por_municipio(filial=filial)
    return {
        "fonte_tam": "não configurada" if not mercado_externo.configurado() else "configurada",
        "municipios": linhas,
    }


def tam_sam_som(*, filial: str = "", segmento: str = "", uf: str = "") -> dict:
    """Visão consolidada TAM→SAM→SOM por município, com whitespace honesto
    (null quando não há como calcular, nunca 0 por omissão)."""
    propria = {(m["municipio"], m["uf"]): m for m in
              data_layer.cobertura_por_municipio(filial=filial)}

    prefixos = _prefixos_do_segmento(segmento)
    tam_disponivel = mercado_externo.configurado() and bool(prefixos)
    universo_externo = mercado_externo.universo_por_uf(prefixos, uf) if tam_disponivel else None
    tam_disponivel = tam_disponivel and universo_externo is not None

    resultado = []
    if tam_disponivel:
        for m in universo_externo:
            chave = (m["municipio"], m["uf"])
            cob = propria.get(chave, {"total": 0, "ativos": 0})
            sam = m["empresas"]  # SAM == TAM neste recorte (ver docstring)
            som = cob["ativos"]
            resultado.append({
                "municipio": m["municipio"], "uf": m["uf"],
                "tam": sam, "sam": sam, "som": som,
                "whitespace": max(sam - som, 0),
                "penetracao_pct": round(100 * som / sam, 1) if sam else None,
            })
        # Municípios onde a carteira já atua mas o universo externo não
        # retornou nada (segmento não presente na base pública ingerida) —
        # entram com TAM/SAM nulos, nunca escondidos.
        cobertos = {(r["municipio"], r["uf"]) for r in resultado}
        for chave, cob in propria.items():
            if chave not in cobertos:
                resultado.append({
                    "municipio": chave[0], "uf": chave[1],
                    "tam": None, "sam": None, "som": cob["ativos"],
                    "whitespace": None, "penetracao_pct": None,
                })
    else:
        for chave, cob in propria.items():
            resultado.append({
                "municipio": chave[0], "uf": chave[1],
                "tam": None, "sam": None, "som": cob["ativos"],
                "whitespace": None, "penetracao_pct": None,
            })

    resultado.sort(key=lambda r: (r["whitespace"] is None, -(r["whitespace"] or 0)))
    return {
        "segmento": segmento or "(todos os padrão)",
        "prefixos_cnae": prefixos,
        "tam_disponivel": tam_disponivel,
        "aviso": None if tam_disponivel else (
            "TAM indisponível — configure CORTEX_API_URL (ou outra fonte de "
            "universo de mercado) para ver whitespace real. Exibindo só a "
            "cobertura própria (SOM)."),
        "municipios": resultado,
    }
