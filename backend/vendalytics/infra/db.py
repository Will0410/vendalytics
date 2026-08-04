"""
db.py — conexão e migrations versionadas do banco OPERACIONAL (usuários,
auditoria, configuração). Não é o banco de dado comercial do cliente: esse
vive atrás do `DataSourceAdapter` e tem ciclo de vida próprio.

Por que migrations e não `CREATE TABLE IF NOT EXISTS` espalhado: o segundo
funciona para criar, mas não tem resposta para "adicionar uma coluna" nem
para "em qual versão de schema este ambiente está?". Com o Render resetando
o disco a cada deploy, a resposta precisa ser derivável do banco, não da
memória de quem deployou.
"""
from __future__ import annotations

import logging
import sqlite3
from contextlib import closing, contextmanager

from .. import config

log = logging.getLogger("vendalytics.infra.db")

# Cada entrada é (versão, nome, SQL). NUNCA edite uma migration já
# publicada — adicione a próxima. Editar uma aplicada faz ambientes novos e
# antigos divergirem em silêncio, que é o problema que migrations resolvem.
MIGRATIONS: list[tuple[int, str, str]] = [
    (
        1,
        "usuarios_inicial",
        """
        CREATE TABLE IF NOT EXISTS usuarios (
            email      TEXT PRIMARY KEY,
            senha_hash TEXT NOT NULL,
            nome       TEXT NOT NULL,
            role       TEXT NOT NULL DEFAULT 'user',
            filiais    TEXT DEFAULT '',
            criado_em  TEXT NOT NULL
        );
        """,
    ),
    (
        2,
        "auditoria_append_only",
        """
        CREATE TABLE IF NOT EXISTS auditoria (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ocorrido_em TEXT NOT NULL,
            tenant_id   TEXT NOT NULL,
            request_id  TEXT NOT NULL,
            usuario     TEXT NOT NULL,
            role        TEXT NOT NULL,
            acao        TEXT NOT NULL,
            recurso     TEXT NOT NULL DEFAULT '',
            resultado   TEXT NOT NULL,
            detalhe     TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_auditoria_tempo   ON auditoria(ocorrido_em);
        CREATE INDEX IF NOT EXISTS idx_auditoria_usuario ON auditoria(usuario, ocorrido_em);
        CREATE INDEX IF NOT EXISTS idx_auditoria_acao    ON auditoria(acao, ocorrido_em);

        -- Append-only imposto pelo banco: a trilha só serve para alguma
        -- coisa se nem a própria aplicação puder reescrevê-la depois.
        CREATE TRIGGER IF NOT EXISTS auditoria_sem_update
            BEFORE UPDATE ON auditoria
            BEGIN SELECT RAISE(ABORT, 'trilha de auditoria é append-only'); END;
        CREATE TRIGGER IF NOT EXISTS auditoria_sem_delete
            BEFORE DELETE ON auditoria
            BEGIN SELECT RAISE(ABORT, 'trilha de auditoria é append-only'); END;
        """,
    ),
    (
        3,
        "usuarios_ultimo_acesso",
        """
        ALTER TABLE usuarios ADD COLUMN ultimo_acesso TEXT;
        """,
    ),
    (
        4,
        "scores_sinais_desfechos",
        """
        -- Score: append-only e versionado (spec §4.3). Nunca
        -- `UPDATE scores SET valor=...` — sempre uma linha nova. É o que
        -- permite responder "por que este score mudou desde ontem?".
        CREATE TABLE IF NOT EXISTS scores (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id     TEXT NOT NULL,
            sujeito_tipo  TEXT NOT NULL,          -- 'cliente' | 'territorio' | ...
            sujeito_id    TEXT NOT NULL,
            tipo          TEXT NOT NULL,          -- 'propensao_recompra' | ...
            valor         REAL NOT NULL,          -- 0..100
            probabilidade REAL NOT NULL,          -- 0..1, calibrada
            ic_inferior   REAL,
            ic_superior   REAL,
            modelo_versao TEXT NOT NULL,
            calculado_em  TEXT NOT NULL,
            valido_ate    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_scores_sujeito
            ON scores(tenant_id, sujeito_tipo, sujeito_id, tipo, calculado_em DESC);

        -- Explicabilidade obrigatória (spec D-2): um score sem fator não tem
        -- utilidade nenhuma para quem vai agir a partir dele. A cardinalidade
        -- 1..N é imposta por `infra.scores.registrar()`, que não aceita lista
        -- vazia; aqui o ON DELETE CASCADE só garante que fator não vire órfão.
        CREATE TABLE IF NOT EXISTS score_fatores (
            score_id     INTEGER NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
            posicao      INTEGER NOT NULL,
            feature      TEXT NOT NULL,
            rotulo       TEXT NOT NULL,           -- linguagem de negócio
            contribuicao REAL NOT NULL,           -- + empurra pra cima, - pra baixo
            valor_feature REAL,
            PRIMARY KEY (score_id, posicao)
        );

        -- Sinal: o átomo do barramento (spec §3.6/§4.2). Imutável.
        CREATE TABLE IF NOT EXISTS sinais (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id    TEXT NOT NULL,
            tipo         TEXT NOT NULL,
            sujeito_tipo TEXT NOT NULL,
            sujeito_id   TEXT NOT NULL,
            ocorrido_em  TEXT NOT NULL,
            ingerido_em  TEXT NOT NULL,
            origem       TEXT NOT NULL,
            confianca    REAL NOT NULL DEFAULT 1.0,
            payload      TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_sinais_sujeito
            ON sinais(tenant_id, sujeito_tipo, sujeito_id, ocorrido_em DESC);
        CREATE INDEX IF NOT EXISTS idx_sinais_tipo ON sinais(tipo, ocorrido_em DESC);

        -- Desfecho da recomendação: o passo 7 do fluxo de valor (spec §5).
        -- Sem esta tabela o produto não aprende — é a "cobertura de loop
        -- fechado" da §7.4, a métrica que faz todas as outras melhorarem.
        CREATE TABLE IF NOT EXISTS desfechos (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id    TEXT NOT NULL,
            sujeito_tipo TEXT NOT NULL,
            sujeito_id   TEXT NOT NULL,
            score_id     INTEGER REFERENCES scores(id),
            usuario      TEXT NOT NULL,
            desfecho     TEXT NOT NULL,           -- aceita|recusada|ganhou|perdeu|ignorada
            motivo       TEXT NOT NULL DEFAULT '',
            valor        REAL,
            registrado_em TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_desfechos_sujeito
            ON desfechos(tenant_id, sujeito_tipo, sujeito_id, registrado_em DESC);

        -- Append-only imposto pelo banco, mesma regra da auditoria: score e
        -- sinal reescritos a posteriori inviabilizam tanto a auditoria quanto
        -- o retreino com correção temporal.
        CREATE TRIGGER IF NOT EXISTS scores_sem_update
            BEFORE UPDATE ON scores
            BEGIN SELECT RAISE(ABORT, 'scores é append-only: grave uma nova versão'); END;
        CREATE TRIGGER IF NOT EXISTS sinais_sem_update
            BEFORE UPDATE ON sinais
            BEGIN SELECT RAISE(ABORT, 'sinais é append-only'); END;
        CREATE TRIGGER IF NOT EXISTS sinais_sem_delete
            BEFORE DELETE ON sinais
            BEGIN SELECT RAISE(ABORT, 'sinais é append-only'); END;
        """,
    ),
]


def conectar() -> sqlite3.Connection:
    con = sqlite3.connect(str(config.USERS_DB_PATH), timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


@contextmanager
def conexao():
    con = conectar()
    try:
        yield con
        con.commit()
    finally:
        con.close()


def versao_atual(con: sqlite3.Connection) -> int:
    con.execute(
        """CREATE TABLE IF NOT EXISTS schema_migrations (
               versao     INTEGER PRIMARY KEY,
               nome       TEXT NOT NULL,
               aplicada_em TEXT NOT NULL
           )"""
    )
    r = con.execute("SELECT COALESCE(MAX(versao), 0) FROM schema_migrations").fetchone()
    return int(r[0])


def versao_aplicada() -> int:
    """Versão de schema deste ambiente, para o health check. Não migra."""
    try:
        with closing(conectar()) as con:
            return versao_atual(con)
    except Exception:
        return -1


def migrar() -> int:
    """Aplica as migrations pendentes em ordem. Idempotente: rodar duas vezes
    não faz nada na segunda. Devolve a versão final."""
    from datetime import datetime, timezone

    config.USERS_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with closing(conectar()) as con:
        atual = versao_atual(con)
        pendentes = [m for m in MIGRATIONS if m[0] > atual]
        if not pendentes:
            log.info("Schema operacional já na versão %s.", atual)
            return atual

        for versao, nome, sql in sorted(pendentes):
            try:
                con.executescript(sql)
            except sqlite3.OperationalError as e:
                # ALTER TABLE ADD COLUMN em banco que já tem a coluna (base
                # criada antes das migrations existirem) não é falha real:
                # o estado desejado já está lá.
                if "duplicate column name" not in str(e).lower():
                    raise
                log.info("Migration %s (%s) já refletida no banco.", versao, nome)
            con.execute(
                "INSERT INTO schema_migrations (versao, nome, aplicada_em) VALUES (?,?,?)",
                (versao, nome, datetime.now(timezone.utc).isoformat()),
            )
            con.commit()
            log.info("Migration aplicada: %s (%s).", versao, nome)
        return versao_atual(con)
