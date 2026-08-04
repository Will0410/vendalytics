# Vendalytics

Plataforma de inteligência comercial para distribuidoras: mapa de clientes,
métricas de carteira e (nas próximas fases) prospecção territorial, gap de
mix/cross-sell, recompra preditiva e CRM de WhatsApp com IA.

A identidade de cada instalação (nome, cores, filiais, segmentação de
mercado) vive em `config/tenant_config.yaml` — o código nunca menciona uma
empresa específica. A fonte de dados é plugável (`DataSourceAdapter`); vem
com uma implementação de referência em SQLite que já roda sem nenhuma
dependência externa, populável tanto por dado sintético de demonstração
quanto pelo CSV real de um cliente.

## Setup local

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate   # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd ..
cp .env.example .env
python -c "import secrets; print(secrets.token_hex(32))"   # cole o resultado em JWT_SECRET no .env
cp config/tenant_config.example.yaml config/tenant_config.yaml   # ajuste nome/cores/filiais

python -m demo_data.seed        # gera ~1000 clientes fictícios
cd backend
python -m uvicorn vendalytics.main:app --reload --port 8901
```

Abra `http://localhost:8901/login.html`. Na primeira subida, um usuário
admin é criado automaticamente — o e-mail vem de `tenant_config.yaml`
(`empresa.admin_email`) e a senha é gerada aleatoriamente e impressa **uma
única vez** no log do servidor.

## Estrutura

- `backend/vendalytics/adapters/` — contrato `DataSourceAdapter` + implementação de referência (`sqlite_reference.py`)
- `backend/vendalytics/data_layer.py` — fachada única que os módulos de negócio chamam (nunca importam um adapter concreto)
- `backend/vendalytics/infra/` — fundação transversal: escopo de acesso, migrations, auditoria, observabilidade
- `backend/vendalytics/tenant.py` — carrega `config/tenant_config.yaml`
- `demo_data/seed.py` — dado sintético de demonstração (Faker, nunca dado real)
- `frontend/` — HTML/JS simples, branding aplicado em runtime via `/api/tenant/branding`

## Fundação: escopo de acesso, auditoria e migrations

A arquitetura-alvo está em [docs/gtm-intelligence-platform.md](docs/gtm-intelligence-platform.md).
A Fase 0 dela já está implementada aqui:

**Escopo de acesso (RBAC + ABAC).** Cada usuário tem um papel (`role`) e um
conjunto de filiais (`filiais`, vazio = irrestrito). O escopo é montado a
partir do JWT por um middleware ASGI e viaja por contextvar; `data_layer` é
o único ponto que o traduz em filtro de dado. Ler dado sem escopo ativo
levanta `EscopoAusente` — o caminho do esquecimento quebra em teste em vez
de vazar em produção. Pedir uma filial fora do escopo é 403, nunca uma
redução silenciosa do resultado.

**Trilha de auditoria.** Tabela `auditoria` no banco operacional, append-only
imposto por trigger do SQLite (nem a aplicação reescreve). Registra login,
acessos negados e consultas à própria trilha. Admin lê via `GET /api/auditoria`.

**Migrations versionadas.** `backend/vendalytics/infra/db.py` — aplicadas no
startup, idempotentes, com a versão visível em `GET /api/health`. Nunca edite
uma migration já publicada; adicione a próxima.

**Observabilidade.** `X-Request-Id` em toda resposta, log estruturado em JSON
com o mesmo id (correlaciona log ↔ trilha ↔ resposta) e latência p50/p95 por
rota em `GET /api/metrics/runtime` (admin).

### Testes

```bash
pip install -r backend/requirements-dev.txt
python -m pytest tests -q
```

`tests/test_isolamento_escopo.py` é a trava: ele descobre as funções de
`data_layer` **por reflexão** e reprova qualquer função de leitura nova que
não passe pelo escopo — sem que ninguém precise lembrar de atualizar o teste.

## Onboarding de um cliente real

1. Copie `config/tenant_config.example.yaml` para `config/tenant_config.yaml` e preencha com os dados do cliente.
2. Popule `SQLiteReferenceAdapter` a partir do CSV do cliente (script de import — fase futura do roadmap).
3. Nunca reaproveite `tenant_config.yaml`/`.env` de outro cliente — cada instalação tem os seus, fora do controle de versão.
