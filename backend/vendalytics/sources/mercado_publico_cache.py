"""
mercado_publico_cache.py — cache local de empresas do mercado público (fora
da carteira do tenant), acumulado a partir de `rfb_real.consultar()`.

Isto substitui, dentro deste mesmo repositório, o que era um projeto irmão
separado (`cortex-b2b`) consultado por HTTP: mesma ideia — universo de
mercado por CNAE/município — agora um módulo interno. Sem chamada de rede
entre processos, sem segundo deploy, sem `CORTEX_API_URL`.

Chave de junção é (município, UF) por NOME normalizado, não código IBGE: a
base comercial deste projeto (`clientes.municipio`) guarda nome livre, sem
código IBGE nenhuma coluna — usar código exigiria resolver nome→código pra
toda consulta (via `ibge_real.municipio_id`) só para depois desfazer a
tradução na hora de casar com a carteira própria. Nome normalizado
(minúsculo, sem acento) é a chave que os dois lados já têm, sem tradução.

Arquivo próprio (`mercado_publico.sqlite`), fora do banco operacional e do
banco comercial: não é dado do tenant (é dado público, compartilhável entre
tenants no mesmo processo) nem estado de aplicação.
"""
from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

from .. import config
from ..modules.identidade import normalizar_texto

DB_PATH = Path(
    __import__("os").getenv("VENDALYTICS_MERCADO_PUBLICO_DB",
                            str(config.PROJECT_ROOT / "mercado_publico.sqlite")))

SCHEMA = """
CREATE TABLE IF NOT EXISTS empresas_publicas (
    cnpj           TEXT PRIMARY KEY,
    razao_social   TEXT,
    cnae_principal TEXT,
    municipio      TEXT,
    municipio_norm TEXT,
    uf             TEXT,
    ativa          INTEGER,
    atualizado_em  TEXT
);
CREATE INDEX IF NOT EXISTS idx_mp_busca ON empresas_publicas(cnae_principal, municipio_norm, uf);
"""


def _con() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(DB_PATH), timeout=10)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def registrar(empresa: dict) -> None:
    with closing(_con()) as con:
        con.execute(
            """INSERT INTO empresas_publicas
                 (cnpj, razao_social, cnae_principal, municipio, municipio_norm,
                  uf, ativa, atualizado_em)
               VALUES (?,?,?,?,?,?,?, datetime('now'))
               ON CONFLICT (cnpj) DO UPDATE SET
                 razao_social=excluded.razao_social, cnae_principal=excluded.cnae_principal,
                 municipio=excluded.municipio, municipio_norm=excluded.municipio_norm,
                 uf=excluded.uf, ativa=excluded.ativa, atualizado_em=excluded.atualizado_em""",
            (empresa["cnpj"], empresa.get("razao_social", ""),
             empresa.get("cnae_principal", ""), empresa.get("municipio", ""),
             normalizar_texto(empresa.get("municipio", "")),
             empresa.get("uf", ""), 1 if empresa.get("ativa") else 0),
        )
        con.commit()


def universo_por_prefixos(prefixos: list[str], uf: str = "") -> list[dict]:
    """Universo (empresas ativas cacheadas) por município, para qualquer um
    dos prefixos de CNAE dados. Reflete só o que já foi consultado/cacheado
    — cresce com o uso, nunca é o universo nacional completo."""
    if not prefixos:
        return []
    condicoes = " OR ".join(["cnae_principal LIKE ?" for _ in prefixos])
    params: list = [f"{p}%" for p in prefixos]
    where = [f"({condicoes})", "ativa = 1", "municipio != ''"]
    if uf:
        where.append("uf = ?")
        params.append(uf.upper())
    with closing(_con()) as con:
        rows = con.execute(
            f"""SELECT municipio, municipio_norm, uf, COUNT(*) AS empresas
                FROM empresas_publicas
                WHERE {' AND '.join(where)}
                GROUP BY municipio_norm, uf
                ORDER BY empresas DESC""", params).fetchall()
    return [{"municipio": r["municipio"], "municipio_norm": r["municipio_norm"],
             "uf": r["uf"], "empresas": r["empresas"]} for r in rows]


def buscar_por_cnpj(cnpj: str) -> dict | None:
    """Registro cacheado de 1 CNPJ, se já foi consultado antes. Usado como
    fallback quando a BrasilAPI está indisponível/rate-limitada (429) no
    momento — mostrar o último dado real conhecido é mais honesto que sumir
    com a empresa da lista, desde que fique claro que pode estar
    desatualizado (ver `fonte` no retorno de `rfb_real.consultar`)."""
    with closing(_con()) as con:
        r = con.execute(
            "SELECT * FROM empresas_publicas WHERE cnpj = ?", (cnpj,)).fetchone()
    if r is None:
        return None
    return {"cnpj": r["cnpj"], "razao_social": r["razao_social"],
            "cnae_principal": r["cnae_principal"], "cnae_principal_descricao": "",
            "municipio": r["municipio"], "uf": r["uf"], "ativa": bool(r["ativa"]),
            "situacao": "ativa (cache)" if r["ativa"] else "inativa (cache)",
            "nome_fantasia": "", "porte": "", "bairro": "", "telefone": "", "email": "",
            "socios": [], "atualizado_em": r["atualizado_em"]}


def total_ingerido() -> int:
    with closing(_con()) as con:
        return con.execute("SELECT COUNT(*) FROM empresas_publicas").fetchone()[0]
