"""
base.py — contrato único que qualquer fonte de dados precisa implementar
para alimentar os módulos de negócio (mapa de clientes, métricas, mix,
recompra, prospecção...). Os módulos NUNCA leem SQL/schema diretamente —
sempre chamam um destes métodos, através da fachada em data_layer.py.

Isso é o que permite trocar a fonte de dados (SQLite de referência hoje,
Postgres/outro DW amanhã, para um cliente específico) sem tocar na lógica
de negócio nenhuma vez.

── Sobre o parâmetro `filiais` ─────────────────────────────────────────────
Todo método que lê dado recortável por filial recebe `filiais: tuple[str,...]`,
onde a tupla VAZIA significa "sem restrição". É plural de propósito: um
usuário pode ter acesso a várias filiais, e o singular `filial: str` de antes
não conseguia expressar isso — o que fazia o escopo do usuário ser ignorado
na prática. Quem monta essa tupla é `data_layer`, a partir do escopo do
request (`infra.context`); o adapter só a aplica.

Os métodos de leitura por id (`cliente_por_id`, `pedidos_recentes`, ...) não
recebem `filiais`: o filtro deles é pós-leitura, feito por `data_layer`, que
tem o escopo e sabe negar. Manter a checagem num lugar só evita que cada
adapter novo reimplemente (e erre) a regra de autorização.
"""
from __future__ import annotations

from abc import ABC, abstractmethod


class DataSourceAdapter(ABC):
    @abstractmethod
    def health_check(self) -> bool:
        """True se a fonte de dados está acessível e com dado carregado."""

    # ── Clientes ──────────────────────────────────────────────────────
    @abstractmethod
    def clientes_query(self, *, bbox: tuple | None = None, texto: str = "",
                       filiais: tuple[str, ...] = (), limit: int = 2000,
                       offset: int = 0) -> dict:
        """Lista paginada de clientes (mapa/busca). bbox = (sul,oeste,norte,leste)."""

    @abstractmethod
    def cliente_por_id(self, customer_id: str) -> dict | None:
        """Cadastro completo de 1 cliente (id = CNPJ ou chave equivalente)."""

    @abstractmethod
    def clientes_do_vendedor(self, vendedor_id: str,
                             filiais: tuple[str, ...] = ()) -> list[dict]:
        """Carteira de um vendedor específico."""

    @abstractmethod
    def metricas_agregadas(self, *, filiais: tuple[str, ...] = ()) -> dict:
        """KPIs gerais: total de clientes, ativos, com coordenada, por filial."""

    # ── Vendas / faturamento ─────────────────────────────────────────
    @abstractmethod
    def vendas_por_periodo(self, *, filiais: tuple[str, ...] = (), data_de: str = "",
                           data_ate: str = "", vendedor_id: str = "") -> list[dict]:
        """Vendas no período (para faturamento, recompra, mix)."""

    @abstractmethod
    def pedidos_recentes(self, customer_id: str, limit: int = 20) -> list[dict]:
        """Últimos pedidos de 1 cliente (histórico de compra)."""

    # ── Mix / catálogo ────────────────────────────────────────────────
    @abstractmethod
    def mix_produtos_cliente(self, customer_id: str, meses: int = 3) -> list[dict]:
        """Produtos/categorias que este cliente comprou na janela recente."""

    @abstractmethod
    def catalogo_produtos(self, filiais: tuple[str, ...] = ()) -> list[dict]:
        """Catálogo de produtos disponíveis (para gap de mix)."""

    @abstractmethod
    def mix_penetracao_categorias(self, *, filiais: tuple[str, ...] = (),
                                  meses: int = 3) -> dict:
        """Penetração por categoria de produto na janela recente: quantos
        clientes ativos (do total do escopo) compraram cada categoria, e o
        valor vendido — base para o gap de mix/cross-sell."""

    # ── Território / TAM-SAM-SOM (spec §2.1 A2) ─────────────────────────
    @abstractmethod
    def cobertura_por_municipio(self, *, filiais: tuple[str, ...] = ()) -> list[dict]:
        """SOM próprio: quantos clientes (total e ativos) a carteira já tem
        em cada município, por segmento. É a metade "cobertura atual" do
        TAM→SAM→SOM (spec A2) — a outra metade (universo de mercado/TAM) vem
        de uma fonte externa plugável (ver modules/mercado.py), porque este
        adapter não tem acesso ao mercado total, só à própria carteira."""

    # ── Equipe / roteiro ──────────────────────────────────────────────
    @abstractmethod
    def vendedores(self, filiais: tuple[str, ...] = ()) -> list[dict]:
        """Lista de vendedores (id, nome, filial, supervisor)."""

    @abstractmethod
    def roteiro_visitas(self, customer_id: str) -> dict:
        """Histórico de visitas de 1 cliente (vendedor responsável, datas)."""
