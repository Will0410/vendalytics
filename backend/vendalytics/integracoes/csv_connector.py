"""
csv_connector.py — implementação de referência de `CRMConnector` sobre CSV.

Como o `SQLiteReferenceAdapter` faz para a fonte de dado comercial: não é um
mock. É o caminho real para um cliente cujo CRM não tem API acessível de
imediato (comum em PME) e o caminho de teste para qualquer outro provedor —
o formato de arquivo é o "contrato mínimo" que qualquer exportação de CRM
(Salesforce report, HubSpot export) já produz.

Colunas esperadas: cnpj, razao_social, estagio, valor, criada_em,
fechada_em, ganhou (1/0/vazio), motivo_perda.
"""
from __future__ import annotations

import csv
import io
import json
from pathlib import Path

from .. import config
from ..infra import audit, context, db
from .base import CRMConnector, OportunidadeExterna


def _so_digitos(s: str) -> str:
    return "".join(c for c in str(s or "") if c.isdigit())


class CSVCRMConnector(CRMConnector):
    def __init__(self, caminho: str | Path | None = None):
        self.caminho = Path(caminho) if caminho else None

    def nome(self) -> str:
        return "csv"

    def testar_conexao(self) -> bool:
        return self.caminho is not None and self.caminho.exists()

    def buscar_oportunidades(self, *, desde: str = "") -> list[OportunidadeExterna]:
        if not self.caminho or not self.caminho.exists():
            return []
        out = []
        with open(self.caminho, newline="", encoding="utf-8-sig") as f:
            for linha in csv.DictReader(f):
                fechada = (linha.get("fechada_em") or "").strip()
                if desde and fechada and fechada < desde:
                    continue
                ganhou_bruto = (linha.get("ganhou") or "").strip()
                ganhou = None if ganhou_bruto == "" else ganhou_bruto in ("1", "true", "True", "sim")
                out.append(OportunidadeExterna(
                    cnpj=_so_digitos(linha.get("cnpj", "")),
                    razao_social=(linha.get("razao_social") or "").strip(),
                    estagio=(linha.get("estagio") or "").strip(),
                    valor=float(linha.get("valor") or 0),
                    criada_em=(linha.get("criada_em") or "").strip(),
                    fechada_em=fechada or None,
                    ganhou=ganhou,
                    motivo_perda=(linha.get("motivo_perda") or "").strip(),
                ))
        return out

    def enviar_recomendacoes(self, itens: list[dict]) -> dict:
        """Sem CRM real do outro lado, o "envio" grava um arquivo de staging
        versionado por rodada — auditável, e no formato exato que um
        conector real (Salesforce/HubSpot) enviaria via API. Trocar o corpo
        deste método por uma chamada HTTP não muda nada mais no sistema."""
        escopo = context.atual()
        pasta = config.CRM_STAGING_DIR
        pasta.mkdir(parents=True, exist_ok=True)
        destino = pasta / f"{escopo.tenant_id}_{self.nome()}_recomendacoes.jsonl"
        falhos = 0
        with open(destino, "a", encoding="utf-8") as f:
            for item in itens:
                try:
                    f.write(json.dumps(item, ensure_ascii=False, default=str) + "\n")
                except (TypeError, ValueError):
                    falhos += 1
        return {"itens_enviados": len(itens) - falhos, "itens_falhos": falhos,
                "destino": str(destino)}


def importar(conector: CRMConnector, *, desde: str = "") -> dict:
    """Importa oportunidades via qualquer `CRMConnector`, com upsert
    idempotente por (tenant, CNPJ) — reimportar o mesmo arquivo não duplica,
    apenas atualiza o estágio da mesma oportunidade.

    CNPJ inválido (sem 14 dígitos) é descartado, não adivinhado: reconciliar
    por chave natural errada funde oportunidades de empresas diferentes, o
    mesmo risco que `identidade.cnpj_raiz` recusa a correr.
    """
    escopo = context.atual()
    oportunidades = conector.buscar_oportunidades(desde=desde)
    validas, invalidas = [], 0
    for o in oportunidades:
        if len(o.cnpj) != 14:
            invalidas += 1
            continue
        validas.append(o)

    with db.conexao() as con:
        con.executemany(
            """INSERT INTO oportunidades_crm
               (tenant_id, provedor, cnpj, razao_social, estagio, valor,
                criada_em, fechada_em, ganhou, motivo_perda, importado_em)
               VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
               ON CONFLICT(tenant_id, cnpj) DO UPDATE SET
                 provedor=excluded.provedor, razao_social=excluded.razao_social,
                 estagio=excluded.estagio, valor=excluded.valor,
                 fechada_em=excluded.fechada_em, ganhou=excluded.ganhou,
                 motivo_perda=excluded.motivo_perda, importado_em=excluded.importado_em""",
            [(escopo.tenant_id, conector.nome(), o.cnpj, o.razao_social, o.estagio,
              o.valor, o.criada_em, o.fechada_em,
              None if o.ganhou is None else int(o.ganhou), o.motivo_perda)
             for o in validas])

    audit.registrar("crm.importar", recurso=conector.nome(),
                    detalhe={"validas": len(validas), "invalidas": invalidas})
    return {"provedor": conector.nome(), "importadas": len(validas),
            "descartadas_cnpj_invalido": invalidas}


def oportunidades(*, apenas_fechadas: bool = False) -> list[dict]:
    escopo = context.atual()
    where = "tenant_id=?"
    if apenas_fechadas:
        where += " AND ganhou IS NOT NULL"
    with db.conexao() as con:
        rows = con.execute(
            f"SELECT * FROM oportunidades_crm WHERE {where} ORDER BY importado_em DESC",
            (escopo.tenant_id,)).fetchall()
    return [dict(r) for r in rows]


def exportar_recomendacoes(conector: CRMConnector, itens: list[dict]) -> dict:
    """Write-back (spec A6, "out"): score + fatores + recomendação de volta
    no CRM. Registra o resumo do envio em `envios_crm` para auditoria —
    quantos foram, quantos falharam, nunca aborta o lote por um item ruim."""
    escopo = context.atual()
    r = conector.enviar_recomendacoes(itens)
    with db.conexao() as con:
        con.execute(
            """INSERT INTO envios_crm (tenant_id, provedor, itens_enviados,
                                       itens_falhos, destino, enviado_em)
               VALUES (?,?,?,?,?,datetime('now'))""",
            (escopo.tenant_id, conector.nome(), r["itens_enviados"], r["itens_falhos"],
             r.get("destino", "")))
    audit.registrar("crm.exportar", recurso=conector.nome(), detalhe=r)
    return r
