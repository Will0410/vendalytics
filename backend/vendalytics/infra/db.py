"""
db.py — conexão e migrations versionadas do banco OPERACIONAL (usuários,
auditoria, scores, sinais, menções, CRM, comitê...). Não é o banco de dado
comercial do cliente: esse vive atrás do `DataSourceAdapter` e tem ciclo de
vida próprio.

Por que migrations e não `CREATE TABLE IF NOT EXISTS` espalhado: o segundo
funciona para criar, mas não tem resposta para "adicionar uma coluna" nem
para "em qual versão de schema este ambiente está?". Com o Render resetando
o disco a cada deploy, a resposta precisa ser derivável do banco, não da
memória de quem deployou.

── SQLite por padrão, Postgres quando DATABASE_URL existe ─────────────────
O disco do Render free tier é efêmero — um SQLite de usuários/auditoria se
perde a cada deploy pelo MESMO motivo que os dados de demonstração já se
perdiam (ver `config.py`). Com `DATABASE_URL` setada (Postgres gerenciado
do Render ou qualquer outro), o banco operacional passa a viver lá.

Os oito módulos que leem/escrevem neste banco (`audit.py`, `scores.py`,
`comite.py`, `identidade.py`, `reputacao.py`, `relatorio.py`,
`comunicacao_kpi.py`, `csv_connector.py`, `auth.py`) nunca precisaram saber
qual banco é — todos chamam `db.conexao()`/`con.execute(sql, params)` com
`?` como placeholder (convenção do sqlite3) e leem `row["coluna"]`. Em vez
de reescrever SQL em oito arquivos, `_ConexaoPostgres` abaixo é um wrapper
fino que faz `con.execute()` aceitar a MESMA sintaxe `?` e devolver linhas
com o MESMO acesso por nome — só troca o placeholder (`?`→`%s`) e o driver
por baixo. As poucas construções que SQLite e Postgres não compartilham
(`datetime('now', ?)`, `INSERT OR REPLACE/IGNORE`, `.lastrowid`) foram
removidas na origem (não aqui): datas viraram parâmetro calculado em
Python, upserts viraram `ON CONFLICT` (sintaxe idêntica nos dois bancos
desde SQLite 3.24), e `.lastrowid` virou `RETURNING id` (SQLite 3.35+,
padrão em Postgres) — ver os módulos afetados.
"""
from __future__ import annotations

import logging
import sqlite3
from contextlib import closing, contextmanager
from datetime import datetime, timezone

from .. import config

log = logging.getLogger("vendalytics.infra.db")

USANDO_POSTGRES = bool(config.DATABASE_URL)

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
    (
        5,
        "resolucao_de_entidade",
        """
        -- Mapa cliente → conta canônica (spec §3.1). NÃO é append-only: o
        -- mapa é o estado atual da resolução e é reescrito a cada execução.
        -- O que precisa ser estável é o `account_id` em si, e essa
        -- estabilidade vem de ele ser derivado da raiz do CNPJ — não de a
        -- tabela ser imutável.
        CREATE TABLE IF NOT EXISTS contas_canonicas (
            tenant_id    TEXT NOT NULL,
            cliente_id   TEXT NOT NULL,
            account_id   TEXT NOT NULL,
            metodo       TEXT NOT NULL,   -- cnpj_raiz | id_local | curadoria
            resolvido_em TEXT NOT NULL,
            PRIMARY KEY (tenant_id, cliente_id)
        );
        CREATE INDEX IF NOT EXISTS idx_contas_account
            ON contas_canonicas(tenant_id, account_id);

        -- Decisões humanas sobre pares suspeitos. É o que impede o sistema
        -- de fundir contas sozinho (fusão errada é cara de desfazer) e, de
        -- quebra, acumula os pares rotulados que um classificador de match
        -- precisaria para ser treinado.
        CREATE TABLE IF NOT EXISTS decisoes_match (
            tenant_id   TEXT NOT NULL,
            cliente_a   TEXT NOT NULL,
            cliente_b   TEXT NOT NULL,
            decisao     TEXT NOT NULL,    -- mesmo | distinto
            usuario     TEXT NOT NULL,
            decidido_em TEXT NOT NULL,
            PRIMARY KEY (tenant_id, cliente_a, cliente_b)
        );
        """,
    ),
    (
        6,
        "integracoes_crm",
        """
        -- Oportunidades importadas do CRM (spec A6, "in"). Upsert por
        -- (tenant_id, cnpj): reimportar o mesmo CSV/sync não duplica —
        -- atualiza o estágio da mesma oportunidade. É o label mais
        -- confiável que existe quando disponível (ganho/perda real, não a
        -- proxy de recompra).
        CREATE TABLE IF NOT EXISTS oportunidades_crm (
            tenant_id     TEXT NOT NULL,
            provedor      TEXT NOT NULL,
            cnpj          TEXT NOT NULL,
            razao_social  TEXT NOT NULL DEFAULT '',
            estagio       TEXT NOT NULL,
            valor         REAL NOT NULL DEFAULT 0,
            criada_em     TEXT NOT NULL,
            fechada_em    TEXT,
            ganhou        INTEGER,        -- NULL=aberta, 0=perdeu, 1=ganhou
            motivo_perda  TEXT NOT NULL DEFAULT '',
            importado_em  TEXT NOT NULL,
            PRIMARY KEY (tenant_id, cnpj)
        );

        -- Registro de cada rodada de write-back — auditável e reprocessável,
        -- espelhando o padrão de proveniência do resto da spec (§3.1/§3.7).
        CREATE TABLE IF NOT EXISTS envios_crm (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id     TEXT NOT NULL,
            provedor      TEXT NOT NULL,
            itens_enviados   INTEGER NOT NULL,
            itens_falhos     INTEGER NOT NULL,
            destino       TEXT NOT NULL DEFAULT '',
            enviado_em    TEXT NOT NULL
        );
        """,
    ),
    (
        7,
        "comite_de_compras",
        """
        -- Comitê de compras (spec A5): múltiplos decisores por conta, com
        -- papel e canal. `conta_id` é o cliente_id hoje (a conta canônica de
        -- `identidade.py` quando existir) — venda complexa com um único
        -- contato mapeado é risco que o score de completude torna visível.
        CREATE TABLE IF NOT EXISTS contatos (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id     TEXT NOT NULL,
            conta_id      TEXT NOT NULL,
            nome          TEXT NOT NULL,
            papel         TEXT NOT NULL,   -- decisor_economico|usuario|influenciador|gatekeeper|campeao
            senioridade   TEXT NOT NULL DEFAULT '',
            canal_preferencial TEXT NOT NULL DEFAULT '',
            email         TEXT NOT NULL DEFAULT '',
            telefone      TEXT NOT NULL DEFAULT '',
            criado_em     TEXT NOT NULL,
            criado_por    TEXT NOT NULL,
            removido_em   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_contatos_conta
            ON contatos(tenant_id, conta_id) WHERE removido_em IS NULL;
        """,
    ),
    (
        8,
        "reputation_intelligence",
        """
        -- Menções (spec §2.3 C1). Append-only por natureza de uso (nada aqui
        -- faz UPDATE), sem trigger forçando: diferente de Score/Sinal, uma
        -- menção pode legitimamente ser corrigida (reclassificação manual de
        -- sentimento) sem que isso comprometa auditoria — não é o rastro de
        -- decisão de um modelo, é o dado de entrada dele.
        CREATE TABLE IF NOT EXISTS mencoes (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id     TEXT NOT NULL,
            canal         TEXT NOT NULL,
            veiculo       TEXT NOT NULL DEFAULT '',
            url           TEXT NOT NULL DEFAULT '',
            publicado_em  TEXT NOT NULL,
            texto         TEXT NOT NULL,
            alcance       INTEGER NOT NULL DEFAULT 0,
            sentimento    REAL NOT NULL,        -- -1..1
            cluster_id    TEXT,                  -- agrupamento de replicação
            conta_ref     TEXT,                  -- cliente_id, quando casado
            importado_em  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mencoes_tempo ON mencoes(tenant_id, publicado_em);
        CREATE INDEX IF NOT EXISTS idx_mencoes_conta ON mencoes(tenant_id, conta_ref);
        CREATE INDEX IF NOT EXISTS idx_mencoes_cluster ON mencoes(tenant_id, cluster_id);

        -- Alertas gerados (anomalia de volume, crise). Append-only: um
        -- alerta emitido não é apagado nem editado, só substituído por um
        -- estado novo — é o rastro que sustenta a métrica de TTD (spec §7.3).
        CREATE TABLE IF NOT EXISTS alertas_reputacao (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id   TEXT NOT NULL,
            tipo        TEXT NOT NULL,
            gerado_em   TEXT NOT NULL,
            janela_de   TEXT NOT NULL,
            janela_ate  TEXT NOT NULL,
            volume      INTEGER NOT NULL,
            volume_esperado REAL,
            zscore      REAL,
            detalhe     TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_alertas_tempo ON alertas_reputacao(tenant_id, gerado_em);

        CREATE TRIGGER IF NOT EXISTS alertas_reputacao_sem_update
            BEFORE UPDATE ON alertas_reputacao
            BEGIN SELECT RAISE(ABORT, 'alertas_reputacao é append-only'); END;
        CREATE TRIGGER IF NOT EXISTS alertas_reputacao_sem_delete
            BEFORE DELETE ON alertas_reputacao
            BEGIN SELECT RAISE(ABORT, 'alertas_reputacao é append-only'); END;
        """,
    ),
    (
        9,
        "reactor_sinais_processados",
        """
        -- Rastreio de quais sinais o reactor (spec D-1/§3.6, Fase 5) já
        -- consumiu. NÃO é uma coluna em `sinais`: a tabela é append-only por
        -- trigger (nem a própria aplicação pode fazer UPDATE nela), então o
        -- estado "processado" precisa viver em outro lugar — mantém `sinais`
        -- imutável de verdade, em vez de imutável só até o primeiro caso de
        -- uso que precisasse editá-la.
        CREATE TABLE IF NOT EXISTS sinais_processados (
            sinal_id     INTEGER PRIMARY KEY REFERENCES sinais(id),
            processado_em TEXT NOT NULL
        );
        """,
    ),
    (
        10,
        "relatorios_executivos",
        """
        -- Snapshot de cada relatório gerado (spec C4) — histórico é o que
        -- permite a seção fixa "o que mudou desde o último relatório" sem
        -- recalcular tudo do zero a cada chamada.
        CREATE TABLE IF NOT EXISTS relatorios_executivos (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id  TEXT NOT NULL,
            gerado_em  TEXT NOT NULL,
            dados      TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_relatorios_tempo ON relatorios_executivos(tenant_id, gerado_em);
        """,
    ),
    (
        11,
        "experimento_recomendacoes",
        """
        -- Só `recomendacoes`. Os DESFECHOS reaproveitam a tabela genérica que
        -- existe desde a migration 3 (`sujeito_tipo`/`sujeito_id`), que já é
        -- lida por `infra/scores.py` e alimenta o modelo de propensão. Criar
        -- uma segunda tabela de desfechos partiria o loop fechado em dois, e
        -- o `CREATE TABLE IF NOT EXISTS` teria feito isso EM SILÊNCIO — a
        -- tabela antiga vence e o INSERT novo falha só em tempo de execução.

        -- Toda praça que o produto MOSTROU num ranking, com o braço sorteado.
        -- Sem este registro nao ha como, depois, separar "cresceu porque
        -- visitamos" de "cresceu de qualquer jeito" — que e a unica pergunta
        -- que um diretor financeiro faz.
        CREATE TABLE IF NOT EXISTS recomendacoes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id  TEXT NOT NULL,
            municipio  INTEGER NOT NULL,
            setor      TEXT NOT NULL,
            modulo     TEXT NOT NULL,
            posicao    INTEGER NOT NULL,
            score      REAL,
            braco      TEXT NOT NULL CHECK (braco IN ('tratado','controle')),
            usuario    TEXT NOT NULL,
            criado_em  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_reco_praca ON recomendacoes(tenant_id, municipio, setor);
        CREATE INDEX IF NOT EXISTS idx_reco_tempo ON recomendacoes(tenant_id, criado_em);

        """,
    ),
]


# ── Migrations equivalentes para Postgres ──────────────────────────────────
# Mesma numeração e mesmo propósito das de cima, linha a linha — só a
# sintaxe muda: AUTOINCREMENT→GENERATED ALWAYS AS IDENTITY, e os triggers
# "RAISE(ABORT,...)" do SQLite viram função PL/pgSQL + trigger (Postgres não
# tem uma forma inline como o SQLite). O restante (índices, CHECK, FK,
# índice parcial com WHERE) é SQL padrão e idêntico nos dois bancos.
MIGRATIONS_POSTGRES: list[tuple[int, str, str]] = [
    (1, "usuarios_inicial", """
        CREATE TABLE IF NOT EXISTS usuarios (
            email      TEXT PRIMARY KEY,
            senha_hash TEXT NOT NULL,
            nome       TEXT NOT NULL,
            role       TEXT NOT NULL DEFAULT 'user',
            filiais    TEXT DEFAULT '',
            criado_em  TEXT NOT NULL
        );
    """),
    (2, "auditoria_append_only", """
        CREATE TABLE IF NOT EXISTS auditoria (
            id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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

        CREATE OR REPLACE FUNCTION vendalytics_bloquear_alteracao() RETURNS TRIGGER AS $$
        BEGIN
            RAISE EXCEPTION 'append-only: tabela % não aceita UPDATE/DELETE', TG_TABLE_NAME;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS auditoria_sem_update ON auditoria;
        CREATE TRIGGER auditoria_sem_update BEFORE UPDATE ON auditoria
            FOR EACH ROW EXECUTE FUNCTION vendalytics_bloquear_alteracao();
        DROP TRIGGER IF EXISTS auditoria_sem_delete ON auditoria;
        CREATE TRIGGER auditoria_sem_delete BEFORE DELETE ON auditoria
            FOR EACH ROW EXECUTE FUNCTION vendalytics_bloquear_alteracao();
    """),
    (3, "usuarios_ultimo_acesso", """
        ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultimo_acesso TEXT;
    """),
    (4, "scores_sinais_desfechos", """
        CREATE TABLE IF NOT EXISTS scores (
            id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            tenant_id     TEXT NOT NULL,
            sujeito_tipo  TEXT NOT NULL,
            sujeito_id    TEXT NOT NULL,
            tipo          TEXT NOT NULL,
            valor         DOUBLE PRECISION NOT NULL,
            probabilidade DOUBLE PRECISION NOT NULL,
            ic_inferior   DOUBLE PRECISION,
            ic_superior   DOUBLE PRECISION,
            modelo_versao TEXT NOT NULL,
            calculado_em  TEXT NOT NULL,
            valido_ate    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_scores_sujeito
            ON scores(tenant_id, sujeito_tipo, sujeito_id, tipo, calculado_em DESC);

        CREATE TABLE IF NOT EXISTS score_fatores (
            score_id     INTEGER NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
            posicao      INTEGER NOT NULL,
            feature      TEXT NOT NULL,
            rotulo       TEXT NOT NULL,
            contribuicao DOUBLE PRECISION NOT NULL,
            valor_feature DOUBLE PRECISION,
            PRIMARY KEY (score_id, posicao)
        );

        CREATE TABLE IF NOT EXISTS sinais (
            id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            tenant_id    TEXT NOT NULL,
            tipo         TEXT NOT NULL,
            sujeito_tipo TEXT NOT NULL,
            sujeito_id   TEXT NOT NULL,
            ocorrido_em  TEXT NOT NULL,
            ingerido_em  TEXT NOT NULL,
            origem       TEXT NOT NULL,
            confianca    DOUBLE PRECISION NOT NULL DEFAULT 1.0,
            payload      TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_sinais_sujeito
            ON sinais(tenant_id, sujeito_tipo, sujeito_id, ocorrido_em DESC);
        CREATE INDEX IF NOT EXISTS idx_sinais_tipo ON sinais(tipo, ocorrido_em DESC);

        CREATE TABLE IF NOT EXISTS desfechos (
            id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            tenant_id    TEXT NOT NULL,
            sujeito_tipo TEXT NOT NULL,
            sujeito_id   TEXT NOT NULL,
            score_id     INTEGER REFERENCES scores(id),
            usuario      TEXT NOT NULL,
            desfecho     TEXT NOT NULL,
            motivo       TEXT NOT NULL DEFAULT '',
            valor        DOUBLE PRECISION,
            registrado_em TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_desfechos_sujeito
            ON desfechos(tenant_id, sujeito_tipo, sujeito_id, registrado_em DESC);

        DROP TRIGGER IF EXISTS scores_sem_update ON scores;
        CREATE TRIGGER scores_sem_update BEFORE UPDATE ON scores
            FOR EACH ROW EXECUTE FUNCTION vendalytics_bloquear_alteracao();
        DROP TRIGGER IF EXISTS sinais_sem_update ON sinais;
        CREATE TRIGGER sinais_sem_update BEFORE UPDATE ON sinais
            FOR EACH ROW EXECUTE FUNCTION vendalytics_bloquear_alteracao();
        DROP TRIGGER IF EXISTS sinais_sem_delete ON sinais;
        CREATE TRIGGER sinais_sem_delete BEFORE DELETE ON sinais
            FOR EACH ROW EXECUTE FUNCTION vendalytics_bloquear_alteracao();
    """),
    (5, "resolucao_de_entidade", """
        CREATE TABLE IF NOT EXISTS contas_canonicas (
            tenant_id    TEXT NOT NULL,
            cliente_id   TEXT NOT NULL,
            account_id   TEXT NOT NULL,
            metodo       TEXT NOT NULL,
            resolvido_em TEXT NOT NULL,
            PRIMARY KEY (tenant_id, cliente_id)
        );
        CREATE INDEX IF NOT EXISTS idx_contas_account
            ON contas_canonicas(tenant_id, account_id);

        CREATE TABLE IF NOT EXISTS decisoes_match (
            tenant_id   TEXT NOT NULL,
            cliente_a   TEXT NOT NULL,
            cliente_b   TEXT NOT NULL,
            decisao     TEXT NOT NULL,
            usuario     TEXT NOT NULL,
            decidido_em TEXT NOT NULL,
            PRIMARY KEY (tenant_id, cliente_a, cliente_b)
        );
    """),
    (6, "integracoes_crm", """
        CREATE TABLE IF NOT EXISTS oportunidades_crm (
            tenant_id     TEXT NOT NULL,
            provedor      TEXT NOT NULL,
            cnpj          TEXT NOT NULL,
            razao_social  TEXT NOT NULL DEFAULT '',
            estagio       TEXT NOT NULL,
            valor         DOUBLE PRECISION NOT NULL DEFAULT 0,
            criada_em     TEXT NOT NULL,
            fechada_em    TEXT,
            ganhou        INTEGER,
            motivo_perda  TEXT NOT NULL DEFAULT '',
            importado_em  TEXT NOT NULL,
            PRIMARY KEY (tenant_id, cnpj)
        );

        CREATE TABLE IF NOT EXISTS envios_crm (
            id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            tenant_id     TEXT NOT NULL,
            provedor      TEXT NOT NULL,
            itens_enviados   INTEGER NOT NULL,
            itens_falhos     INTEGER NOT NULL,
            destino       TEXT NOT NULL DEFAULT '',
            enviado_em    TEXT NOT NULL
        );
    """),
    (7, "comite_de_compras", """
        CREATE TABLE IF NOT EXISTS contatos (
            id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            tenant_id     TEXT NOT NULL,
            conta_id      TEXT NOT NULL,
            nome          TEXT NOT NULL,
            papel         TEXT NOT NULL,
            senioridade   TEXT NOT NULL DEFAULT '',
            canal_preferencial TEXT NOT NULL DEFAULT '',
            email         TEXT NOT NULL DEFAULT '',
            telefone      TEXT NOT NULL DEFAULT '',
            criado_em     TEXT NOT NULL,
            criado_por    TEXT NOT NULL,
            removido_em   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_contatos_conta
            ON contatos(tenant_id, conta_id) WHERE removido_em IS NULL;
    """),
    (8, "reputation_intelligence", """
        CREATE TABLE IF NOT EXISTS mencoes (
            id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            tenant_id     TEXT NOT NULL,
            canal         TEXT NOT NULL,
            veiculo       TEXT NOT NULL DEFAULT '',
            url           TEXT NOT NULL DEFAULT '',
            publicado_em  TEXT NOT NULL,
            texto         TEXT NOT NULL,
            alcance       INTEGER NOT NULL DEFAULT 0,
            sentimento    DOUBLE PRECISION NOT NULL,
            cluster_id    TEXT,
            conta_ref     TEXT,
            importado_em  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mencoes_tempo ON mencoes(tenant_id, publicado_em);
        CREATE INDEX IF NOT EXISTS idx_mencoes_conta ON mencoes(tenant_id, conta_ref);
        CREATE INDEX IF NOT EXISTS idx_mencoes_cluster ON mencoes(tenant_id, cluster_id);

        CREATE TABLE IF NOT EXISTS alertas_reputacao (
            id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            tenant_id   TEXT NOT NULL,
            tipo        TEXT NOT NULL,
            gerado_em   TEXT NOT NULL,
            janela_de   TEXT NOT NULL,
            janela_ate  TEXT NOT NULL,
            volume      INTEGER NOT NULL,
            volume_esperado DOUBLE PRECISION,
            zscore      DOUBLE PRECISION,
            detalhe     TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_alertas_tempo ON alertas_reputacao(tenant_id, gerado_em);

        DROP TRIGGER IF EXISTS alertas_reputacao_sem_update ON alertas_reputacao;
        CREATE TRIGGER alertas_reputacao_sem_update BEFORE UPDATE ON alertas_reputacao
            FOR EACH ROW EXECUTE FUNCTION vendalytics_bloquear_alteracao();
        DROP TRIGGER IF EXISTS alertas_reputacao_sem_delete ON alertas_reputacao;
        CREATE TRIGGER alertas_reputacao_sem_delete BEFORE DELETE ON alertas_reputacao
            FOR EACH ROW EXECUTE FUNCTION vendalytics_bloquear_alteracao();
    """),
    (9, "reactor_sinais_processados", """
        CREATE TABLE IF NOT EXISTS sinais_processados (
            sinal_id     INTEGER PRIMARY KEY REFERENCES sinais(id),
            processado_em TEXT NOT NULL
        );
    """),
    (10, "relatorios_executivos", """
        CREATE TABLE IF NOT EXISTS relatorios_executivos (
            id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            tenant_id  TEXT NOT NULL,
            gerado_em  TEXT NOT NULL,
            dados      TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_relatorios_tempo ON relatorios_executivos(tenant_id, gerado_em);
    """),
    (11, "experimento_recomendacoes", """
        CREATE TABLE IF NOT EXISTS recomendacoes (
            id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            tenant_id  TEXT NOT NULL,
            municipio  INTEGER NOT NULL,
            setor      TEXT NOT NULL,
            modulo     TEXT NOT NULL,
            posicao    INTEGER NOT NULL,
            score      DOUBLE PRECISION,
            braco      TEXT NOT NULL CHECK (braco IN ('tratado','controle')),
            usuario    TEXT NOT NULL,
            criado_em  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_reco_praca ON recomendacoes(tenant_id, municipio, setor);
        CREATE INDEX IF NOT EXISTS idx_reco_tempo ON recomendacoes(tenant_id, criado_em);
    """),
]


# ── wrapper Postgres: mesma interface que os 8 módulos já usam ────────────
class _CursorPostgres:
    """Encapsula um cursor psycopg para se comportar como um cursor sqlite3:
    `.fetchone()`/`.fetchall()` devolvendo algo indexável por nome de coluna
    (`row["col"]`), que é o que todo o código consumidor já espera."""

    def __init__(self, cur):
        self._cur = cur

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    @property
    def rowcount(self):
        return self._cur.rowcount


class _ConexaoPostgres:
    """Faz `con.execute(sql_com_?, params)` funcionar sobre psycopg, que
    exige `%s` — e nada além disso muda para quem chama. Ver docstring do
    módulo para o porquê de um wrapper em vez de reescrever SQL em 8 lugares."""

    def __init__(self, pg_con):
        self._con = pg_con

    @staticmethod
    def _traduzir(sql: str) -> str:
        # Não há literal `?` em nenhuma SQL deste projeto (confirmado por
        # inspeção) — todo `?` é placeholder. Troca direta é segura.
        return sql.replace("?", "%s")

    def execute(self, sql: str, params=()):
        cur = self._con.cursor()
        cur.execute(self._traduzir(sql), params)
        return _CursorPostgres(cur)

    def executemany(self, sql: str, seq_params):
        cur = self._con.cursor()
        cur.executemany(self._traduzir(sql), list(seq_params))
        return _CursorPostgres(cur)

    def executescript(self, sql: str) -> None:
        # psycopg aceita múltiplas instruções separadas por `;` num único
        # `execute()` (protocolo "simple query") contanto que não haja
        # parâmetros — é o equivalente ao `executescript` do sqlite3, usado
        # só para DDL de migration.
        with self._con.cursor() as cur:
            cur.execute(sql)

    def commit(self) -> None:
        self._con.commit()

    def close(self) -> None:
        self._con.close()


def _conectar_postgres():
    import psycopg
    from psycopg.rows import dict_row

    con = psycopg.connect(config.DATABASE_URL, row_factory=dict_row, autocommit=False)
    return _ConexaoPostgres(con)


def conectar():
    if USANDO_POSTGRES:
        return _conectar_postgres()
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


def versao_atual(con) -> int:
    con.execute(
        """CREATE TABLE IF NOT EXISTS schema_migrations (
               versao      INTEGER PRIMARY KEY,
               nome        TEXT NOT NULL,
               aplicada_em TEXT NOT NULL
           )"""
    )
    r = con.execute("SELECT COALESCE(MAX(versao), 0) AS versao FROM schema_migrations").fetchone()
    # Acesso por NOME de coluna, não por posição: dict_row do psycopg (banco
    # Postgres) só indexa por nome, sqlite3.Row aceita os dois — usar nome
    # em todo lugar é o único caminho compatível com os dois bancos.
    return int(r["versao"])


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
    lista = MIGRATIONS_POSTGRES if USANDO_POSTGRES else MIGRATIONS

    if not USANDO_POSTGRES:
        config.USERS_DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    with closing(conectar()) as con:
        atual = versao_atual(con)
        pendentes = [m for m in lista if m[0] > atual]
        if not pendentes:
            log.info("Schema operacional (%s) já na versão %s.",
                     "Postgres" if USANDO_POSTGRES else "SQLite", atual)
            return atual

        for versao, nome, sql in sorted(pendentes):
            try:
                con.executescript(sql)
            except sqlite3.OperationalError as e:
                # ALTER TABLE ADD COLUMN em banco que já tem a coluna (base
                # criada antes das migrations existirem) não é falha real:
                # o estado desejado já está lá. Só se aplica a SQLite — a
                # versão Postgres já usa `ADD COLUMN IF NOT EXISTS`.
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
