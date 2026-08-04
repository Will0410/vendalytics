"""
sqlite_reference.py — implementação de referência do DataSourceAdapter sobre
um SQLite de schema neutro. NÃO é um stub/mock: é funcional de verdade — o
mesmo arquivo/schema serve tanto para o dado sintético de demonstração
(demo_data/seed.py) quanto para o primeiro piloto real de um cliente novo
(scripts/import_csv.py popula as mesmas tabelas a partir do CSV dele), sem
precisar esperar um adapter dedicado (Postgres/DW) para começar a mostrar
valor com dado real.
"""
from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

from .base import DataSourceAdapter

SCHEMA = """
CREATE TABLE IF NOT EXISTS clientes (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    razao_social TEXT,
    filial TEXT,
    endereco TEXT,
    municipio TEXT,
    uf TEXT,
    cep TEXT,
    lat REAL,
    lon REAL,
    segmento TEXT,
    cnae TEXT,
    ramo TEXT,
    status TEXT DEFAULT 'ativo',
    telefone TEXT,
    email TEXT,
    data_cadastro TEXT
);
CREATE INDEX IF NOT EXISTS idx_clientes_filial ON clientes(filial);
CREATE INDEX IF NOT EXISTS idx_clientes_coords ON clientes(lat, lon);

CREATE TABLE IF NOT EXISTS vendedores (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    filial TEXT,
    supervisor TEXT,
    ativo INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS produtos (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    categoria TEXT,
    ativo INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id TEXT NOT NULL,
    vendedor_id TEXT,
    filial TEXT,
    data_venda TEXT NOT NULL,
    valor_total REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vendas_cliente ON vendas(cliente_id);
CREATE INDEX IF NOT EXISTS idx_vendas_data ON vendas(data_venda);

CREATE TABLE IF NOT EXISTS vendas_itens (
    venda_id INTEGER NOT NULL,
    produto_id TEXT NOT NULL,
    quantidade REAL NOT NULL,
    valor_unitario REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_itens_venda ON vendas_itens(venda_id);

CREATE TABLE IF NOT EXISTS visitas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id TEXT NOT NULL,
    vendedor_id TEXT,
    data TEXT NOT NULL,
    checkin TEXT,
    checkout TEXT,
    pedido_gerado INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_visitas_cliente ON visitas(cliente_id);
"""


def _filtro_filiais(coluna: str, filiais: tuple[str, ...]) -> tuple[str, list]:
    """Monta `coluna IN (?,?,...)` para o recorte de filiais do escopo.

    Tupla vazia = sem restrição, e devolve '1=1' — nunca uma cláusula que
    casaria com zero linhas. A diferença importa: "irrestrito" e "restrito a
    nada" são estados distintos, e confundi-los faria o admin ver uma base
    vazia em vez da base inteira.
    """
    if not filiais:
        return "1=1", []
    marcadores = ",".join("?" for _ in filiais)
    return f"{coluna} IN ({marcadores})", list(filiais)


class SQLiteReferenceAdapter(DataSourceAdapter):
    def __init__(self, path: Path):
        self.path = Path(path)
        self._garantir_schema()

    def _con(self) -> sqlite3.Connection:
        con = sqlite3.connect(str(self.path), timeout=10)
        con.row_factory = sqlite3.Row
        return con

    def _garantir_schema(self) -> None:
        with closing(self._con()) as con:
            con.executescript(SCHEMA)
            con.commit()

    def health_check(self) -> bool:
        try:
            with closing(self._con()) as con:
                row = con.execute("SELECT 1 FROM clientes LIMIT 1").fetchone()
            return row is not None
        except Exception:
            return False

    def clientes_query(self, *, bbox=None, texto="", filiais=(), limit=2000, offset=0) -> dict:
        where, params = ["1=1"], []
        if bbox:
            sul, oeste, norte, leste = bbox
            where.append("lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?")
            params += [sul, norte, oeste, leste]
        clausula, p = _filtro_filiais("filial", filiais)
        where.append(clausula); params += p
        if texto:
            where.append("(nome LIKE ? OR razao_social LIKE ? OR id LIKE ?)")
            like = f"%{texto}%"
            params += [like, like, f"%{texto}%"]
        wc = " AND ".join(where)
        with closing(self._con()) as con:
            total = con.execute(f"SELECT COUNT(*) FROM clientes WHERE {wc}", params).fetchone()[0]
            rows = con.execute(
                f"SELECT * FROM clientes WHERE {wc} ORDER BY nome LIMIT ? OFFSET ?",
                params + [limit, offset]).fetchall()
        return {
            "total": total, "returned": len(rows), "offset": offset, "limit": limit,
            "truncated": total > offset + len(rows),
            "clientes": [dict(r) for r in rows],
        }

    def cliente_por_id(self, customer_id: str) -> dict | None:
        with closing(self._con()) as con:
            r = con.execute("SELECT * FROM clientes WHERE id=?", (customer_id,)).fetchone()
        return dict(r) if r else None

    def clientes_do_vendedor(self, vendedor_id: str, filiais: tuple[str, ...] = ()) -> list[dict]:
        # O recorte de filial era aceito e ignorado aqui: a carteira do
        # vendedor voltava inteira, atravessando o escopo de quem consultava.
        clausula, params = _filtro_filiais("c.filial", filiais)
        with closing(self._con()) as con:
            rows = con.execute(
                f"""SELECT DISTINCT c.* FROM clientes c
                    JOIN vendas v ON v.cliente_id = c.id
                    WHERE v.vendedor_id = ? AND {clausula}""",
                [vendedor_id] + params).fetchall()
        return [dict(r) for r in rows]

    def metricas_agregadas(self, *, filiais: tuple[str, ...] = ()) -> dict:
        where, params = _filtro_filiais("filial", filiais)
        with closing(self._con()) as con:
            total = con.execute(f"SELECT COUNT(*) FROM clientes WHERE {where}", params).fetchone()[0]
            ativos = con.execute(
                f"SELECT COUNT(*) FROM clientes WHERE {where} AND status='ativo'", params).fetchone()[0]
            com_coord = con.execute(
                f"SELECT COUNT(*) FROM clientes WHERE {where} AND lat IS NOT NULL", params).fetchone()[0]
            # `por_filial` ignorava o recorte e devolvia a contagem de TODAS
            # as filiais — um usuário restrito a uma filial recebia, no mesmo
            # payload, o tamanho da carteira das outras.
            por_filial = {r[0]: r[1] for r in con.execute(
                f"SELECT filial, COUNT(*) FROM clientes WHERE {where} GROUP BY filial", params)}
            where_v, params_v = _filtro_filiais("filial", filiais)
            faturamento_30d = con.execute(
                f"SELECT COALESCE(SUM(valor_total),0) FROM vendas "
                f"WHERE {where_v} AND data_venda >= date('now','-30 day')", params_v
            ).fetchone()[0]
        return {
            "total_clientes": total, "clientes_ativos": ativos, "com_coordenada": com_coord,
            "por_filial": por_filial, "faturamento_30d": round(faturamento_30d, 2),
        }

    def vendas_por_periodo(self, *, filiais=(), data_de="", data_ate="", vendedor_id="") -> list[dict]:
        where, params = ["1=1"], []
        clausula, p = _filtro_filiais("filial", filiais)
        where.append(clausula); params += p
        if vendedor_id:
            where.append("vendedor_id=?"); params.append(vendedor_id)
        if data_de:
            where.append("data_venda>=?"); params.append(data_de)
        if data_ate:
            where.append("data_venda<=?"); params.append(data_ate)
        wc = " AND ".join(where)
        with closing(self._con()) as con:
            rows = con.execute(
                f"SELECT * FROM vendas WHERE {wc} ORDER BY data_venda DESC", params).fetchall()
        return [dict(r) for r in rows]

    def pedidos_recentes(self, customer_id: str, limit: int = 20) -> list[dict]:
        with closing(self._con()) as con:
            rows = con.execute(
                "SELECT * FROM vendas WHERE cliente_id=? ORDER BY data_venda DESC LIMIT ?",
                (customer_id, limit)).fetchall()
        return [dict(r) for r in rows]

    def mix_produtos_cliente(self, customer_id: str, meses: int = 3) -> list[dict]:
        with closing(self._con()) as con:
            rows = con.execute(
                """SELECT p.id, p.nome, p.categoria, SUM(i.quantidade) qtd, SUM(i.quantidade*i.valor_unitario) valor
                   FROM vendas v JOIN vendas_itens i ON i.venda_id = v.id
                   JOIN produtos p ON p.id = i.produto_id
                   WHERE v.cliente_id = ? AND v.data_venda >= date('now', ?)
                   GROUP BY p.id ORDER BY valor DESC""",
                (customer_id, f"-{int(meses) * 30} day")).fetchall()
        return [dict(r) for r in rows]

    def catalogo_produtos(self, filiais: tuple[str, ...] = ()) -> list[dict]:
        # `produtos` não tem coluna de filial neste schema de referência: o
        # catálogo é global. O parâmetro fica no contrato porque adapters de
        # cliente costumam ter sortimento por filial, e nesse caso é aqui que
        # o recorte entra.
        with closing(self._con()) as con:
            rows = con.execute("SELECT * FROM produtos WHERE ativo=1 ORDER BY categoria, nome").fetchall()
        return [dict(r) for r in rows]

    def mix_penetracao_categorias(self, *, filiais: tuple[str, ...] = (), meses: int = 3) -> dict:
        clausula_cli, params_cli = _filtro_filiais("filial", filiais)
        where_cli = f"status='ativo' AND {clausula_cli}"
        clausula_v, params_filial_v = _filtro_filiais("v.filial", filiais)
        where_v = f"v.data_venda >= date('now', ?) AND {clausula_v}"
        params_v = [f"-{int(meses) * 30} day"] + params_filial_v
        with closing(self._con()) as con:
            total_ativos = con.execute(
                f"SELECT COUNT(*) FROM clientes WHERE {where_cli}", params_cli).fetchone()[0]
            rows = con.execute(
                f"""SELECT p.categoria AS categoria,
                           COUNT(DISTINCT v.cliente_id) AS clientes,
                           COALESCE(SUM(i.quantidade * i.valor_unitario), 0) AS valor
                    FROM vendas v
                    JOIN vendas_itens i ON i.venda_id = v.id
                    JOIN produtos p ON p.id = i.produto_id
                    WHERE {where_v}
                    GROUP BY p.categoria
                    ORDER BY valor DESC""", params_v).fetchall()
        return {
            "total_clientes_ativos": total_ativos,
            "categorias": [
                {
                    "categoria": r["categoria"],
                    "clientes_compraram": r["clientes"],
                    "penetracao_pct": round(100 * r["clientes"] / total_ativos, 1) if total_ativos else 0.0,
                    "valor": round(r["valor"] or 0, 2),
                    "whitespace": max(total_ativos - r["clientes"], 0),
                }
                for r in rows
            ],
        }

    def cobertura_por_municipio(self, *, filiais: tuple[str, ...] = ()) -> list[dict]:
        """Cobertura da carteira por município/UF — a metade "SOM próprio" do
        TAM→SAM→SOM. Deliberadamente NÃO estima mercado total: este adapter
        enxerga só a carteira do cliente, e inventar um denominador que ele
        não tem seria devolver um número de aparência precisa e sem lastro.
        O universo de mercado entra por fonte externa, que se junta a isto
        pela chave (municipio, uf)."""
        clausula, params = _filtro_filiais("filial", filiais)
        with closing(self._con()) as con:
            rows = con.execute(f"""
                SELECT municipio, uf, segmento,
                       COUNT(*) AS total,
                       SUM(CASE WHEN status='ativo' THEN 1 ELSE 0 END) AS ativos
                FROM clientes
                WHERE {clausula} AND municipio IS NOT NULL AND municipio != ''
                GROUP BY municipio, uf, segmento
                ORDER BY total DESC
            """, params).fetchall()
        return [
            {"municipio": r["municipio"], "uf": r["uf"] or "", "segmento": r["segmento"] or "",
             "total": r["total"], "ativos": r["ativos"] or 0}
            for r in rows
        ]

    def vendedores(self, filiais: tuple[str, ...] = ()) -> list[dict]:
        clausula, params = _filtro_filiais("filial", filiais)
        where = f"ativo=1 AND {clausula}"
        with closing(self._con()) as con:
            rows = con.execute(f"SELECT * FROM vendedores WHERE {where} ORDER BY nome", params).fetchall()
        return [dict(r) for r in rows]

    def roteiro_visitas(self, customer_id: str) -> dict:
        with closing(self._con()) as con:
            rows = con.execute(
                "SELECT * FROM visitas WHERE cliente_id=? ORDER BY data DESC LIMIT 20",
                (customer_id,)).fetchall()
        return {"visitas": [dict(r) for r in rows]}
