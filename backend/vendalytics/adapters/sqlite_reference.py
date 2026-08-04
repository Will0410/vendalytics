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
                con.execute("SELECT 1 FROM clientes LIMIT 1")
            return True
        except Exception:
            return False

    def clientes_query(self, *, bbox=None, texto="", filial="", limit=2000, offset=0) -> dict:
        where, params = ["1=1"], []
        if bbox:
            sul, oeste, norte, leste = bbox
            where.append("lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?")
            params += [sul, norte, oeste, leste]
        if filial:
            where.append("filial = ?")
            params.append(filial)
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

    def clientes_do_vendedor(self, vendedor_id: str, filial: str = "") -> list[dict]:
        with closing(self._con()) as con:
            rows = con.execute(
                """SELECT DISTINCT c.* FROM clientes c
                   JOIN vendas v ON v.cliente_id = c.id
                   WHERE v.vendedor_id = ?""", (vendedor_id,)).fetchall()
        return [dict(r) for r in rows]

    def metricas_agregadas(self, *, filial: str = "") -> dict:
        where, params = "1=1", []
        if filial:
            where, params = "filial=?", [filial]
        with closing(self._con()) as con:
            total = con.execute(f"SELECT COUNT(*) FROM clientes WHERE {where}", params).fetchone()[0]
            ativos = con.execute(
                f"SELECT COUNT(*) FROM clientes WHERE {where} AND status='ativo'", params).fetchone()[0]
            com_coord = con.execute(
                f"SELECT COUNT(*) FROM clientes WHERE {where} AND lat IS NOT NULL", params).fetchone()[0]
            por_filial = {r[0]: r[1] for r in con.execute(
                "SELECT filial, COUNT(*) FROM clientes GROUP BY filial")}
            where_v, params_v = "1=1", []
            if filial:
                where_v, params_v = "filial=?", [filial]
            faturamento_30d = con.execute(
                f"SELECT COALESCE(SUM(valor_total),0) FROM vendas "
                f"WHERE {where_v} AND data_venda >= date('now','-30 day')", params_v
            ).fetchone()[0]
        return {
            "total_clientes": total, "clientes_ativos": ativos, "com_coordenada": com_coord,
            "por_filial": por_filial, "faturamento_30d": round(faturamento_30d, 2),
        }

    def vendas_por_periodo(self, *, filial="", data_de="", data_ate="", vendedor_id="") -> list[dict]:
        where, params = ["1=1"], []
        if filial:
            where.append("filial=?"); params.append(filial)
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

    def catalogo_produtos(self, filial: str = "") -> list[dict]:
        with closing(self._con()) as con:
            rows = con.execute("SELECT * FROM produtos WHERE ativo=1 ORDER BY categoria, nome").fetchall()
        return [dict(r) for r in rows]

    def mix_penetracao_categorias(self, *, filial: str = "", meses: int = 3) -> dict:
        where_cli, params_cli = "status='ativo'", []
        if filial:
            where_cli += " AND filial=?"
            params_cli.append(filial)
        where_v, params_v = "v.data_venda >= date('now', ?)", [f"-{int(meses) * 30} day"]
        if filial:
            where_v += " AND v.filial=?"
            params_v.append(filial)
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

    def vendedores(self, filial: str = "") -> list[dict]:
        where, params = "ativo=1", []
        if filial:
            where, params = "ativo=1 AND filial=?", [filial]
        with closing(self._con()) as con:
            rows = con.execute(f"SELECT * FROM vendedores WHERE {where} ORDER BY nome", params).fetchall()
        return [dict(r) for r in rows]

    def roteiro_visitas(self, customer_id: str) -> dict:
        with closing(self._con()) as con:
            rows = con.execute(
                "SELECT * FROM visitas WHERE cliente_id=? ORDER BY data DESC LIMIT 20",
                (customer_id,)).fetchall()
        return {"visitas": [dict(r) for r in rows]}
