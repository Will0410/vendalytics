"""
seed.py — gera a base de demonstração do Vendalytics: 100% dado SINTÉTICO
(Faker), nunca dado real de nenhum cliente. Roda sozinho, sem precisar de
nenhuma credencial externa — é o que torna o produto demonstrável no
primeiro `uvicorn`, sem depender de um Data Warehouse real.

Uso (a partir da raiz do repo, com o venv do backend ativo):
    python -m demo_data.seed
"""
from __future__ import annotations

import random
import sqlite3
import sys
from contextlib import closing
from datetime import date, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "backend"))

from faker import Faker  # noqa: E402

from vendalytics import config  # noqa: E402
from vendalytics.adapters.sqlite_reference import SCHEMA  # noqa: E402

fake = Faker("pt_BR")
Faker.seed(42)
random.seed(42)

# Municípios REAIS do IBGE (dado público, não é segredo de nenhum cliente) —
# só usados como âncora de coordenada para o mapa parecer plausível; os
# clientes em si são inteiramente fictícios.
MUNICIPIOS = [
    ("Cascavel", "PR", -24.9555, -53.4552),
    ("Foz do Iguaçu", "PR", -25.5478, -54.5882),
    ("Toledo", "PR", -24.7136, -53.7431),
    ("Medianeira", "PR", -25.2958, -54.0939),
    ("Curitiba", "PR", -25.4284, -49.2733),
]

FILIAIS = [
    {"sigla": "F1", "nome": "Filial Norte"},
    {"sigla": "F2", "nome": "Filial Sul"},
]

SEGMENTOS = ["Mercados/Mercearias", "Padarias/Confeitarias", "Açougues", "Farmácias/Drogarias"]
CATEGORIAS_PRODUTO = ["Bebidas", "Mercearia Seca", "Laticínios", "Higiene/Limpeza", "Congelados"]

N_CLIENTES = 1000
N_VENDEDORES = 12
N_PRODUTOS = 60
MESES_HISTORICO = 12


def _jitter(lat: float, lon: float, raio_graus: float = 0.05) -> tuple[float, float]:
    return lat + random.uniform(-raio_graus, raio_graus), lon + random.uniform(-raio_graus, raio_graus)


def gerar(con: sqlite3.Connection) -> None:
    con.executescript(SCHEMA)

    vendedores = []
    for i in range(N_VENDEDORES):
        vid = f"V{i+1:03d}"
        filial = random.choice(FILIAIS)["sigla"]
        vendedores.append((vid, fake.name(), filial, f"SUP-{random.randint(1,3)}", 1))
    con.executemany(
        "INSERT OR REPLACE INTO vendedores (id, nome, filial, supervisor, ativo) VALUES (?,?,?,?,?)",
        vendedores)

    produtos = []
    for i in range(N_PRODUTOS):
        pid = f"P{i+1:04d}"
        produtos.append((pid, fake.word().title() + " " + fake.word().title(),
                         random.choice(CATEGORIAS_PRODUTO), 1))
    con.executemany(
        "INSERT OR REPLACE INTO produtos (id, nome, categoria, ativo) VALUES (?,?,?,?)", produtos)

    clientes = []
    for i in range(N_CLIENTES):
        cid = fake.cnpj()
        municipio, uf, lat0, lon0 = random.choice(MUNICIPIOS)
        lat, lon = _jitter(lat0, lon0)
        filial = random.choice(FILIAIS)["sigla"]
        segmento = random.choice(SEGMENTOS)
        ativo = "ativo" if random.random() > 0.08 else "inativo"
        nome = fake.company()
        clientes.append((
            cid, nome, nome + " LTDA", filial, fake.street_address(), municipio, uf,
            fake.postcode(), lat, lon, segmento, "4711", segmento.upper(), ativo,
            fake.phone_number(), fake.company_email(),
            fake.date_between(start_date="-3y", end_date="-6M").isoformat(),
        ))
    con.executemany(
        """INSERT OR REPLACE INTO clientes
           (id, nome, razao_social, filial, endereco, municipio, uf, cep, lat, lon,
            segmento, cnae, ramo, status, telefone, email, data_cadastro)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", clientes)

    # histórico de vendas: cada cliente ativo compra algumas vezes nos últimos meses
    hoje = date.today()
    vendas, itens = [], []
    venda_id = 1
    for cid, *_resto in clientes:
        if random.random() > 0.85:
            continue  # ~15% dos clientes sem histórico (prospects/recém-cadastrados)
        n_compras = random.randint(1, 8)
        vendedor_id = random.choice(vendedores)[0]
        filial_cliente = next(c[3] for c in clientes if c[0] == cid)
        for _ in range(n_compras):
            dias_atras = random.randint(0, MESES_HISTORICO * 30)
            data_venda = (hoje - timedelta(days=dias_atras)).isoformat()
            n_itens = random.randint(1, 5)
            total = 0.0
            venda_itens = []
            for _i in range(n_itens):
                prod = random.choice(produtos)
                qtd = random.randint(1, 20)
                preco = round(random.uniform(5, 150), 2)
                total += qtd * preco
                venda_itens.append((venda_id, prod[0], qtd, preco))
            vendas.append((venda_id, cid, vendedor_id, filial_cliente, data_venda, round(total, 2)))
            itens.extend(venda_itens)
            venda_id += 1
    con.executemany(
        "INSERT INTO vendas (id, cliente_id, vendedor_id, filial, data_venda, valor_total) VALUES (?,?,?,?,?,?)",
        vendas)
    con.executemany(
        "INSERT INTO vendas_itens (venda_id, produto_id, quantidade, valor_unitario) VALUES (?,?,?,?)",
        itens)

    con.commit()
    print(f"[seed] {len(clientes)} clientes, {len(vendedores)} vendedores, "
          f"{len(produtos)} produtos, {len(vendas)} vendas geradas em {config.SQLITE_PATH}")


def main() -> None:
    config.SQLITE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(str(config.SQLITE_PATH))) as con:
        gerar(con)


if __name__ == "__main__":
    main()
