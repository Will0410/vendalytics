"""
config.py — configuração de INFRAESTRUTURA (segredos, conexões, feature
flags). NÃO guarda identidade de empresa (nome, cores, filiais, segmentação)
— isso é responsabilidade de tenant.py + config/tenant_config.yaml.
"""
from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]

# Carrega .env (se existir) sem sobrescrever variáveis já setadas no ambiente
# (ex.: quando rodando em produção com env vars reais do sistema/orquestrador).
try:
    from dotenv import load_dotenv
    _env = PROJECT_ROOT / ".env"
    if _env.exists():
        load_dotenv(_env, override=False)
except Exception:
    pass


def _req(nome: str) -> str:
    """Variável obrigatória — derruba o start em vez de cair num default
    inseguro (ex.: JWT_SECRET fixo no código, que foi o caso no projeto de
    origem). Falhar rápido aqui é preferível a rodar com um segredo previsível."""
    v = os.getenv(nome, "").strip()
    if not v:
        raise RuntimeError(
            f"variável de ambiente obrigatória '{nome}' não configurada — "
            f"copie .env.example para .env e preencha antes de subir o servidor.")
    return v


def get_jwt_secret() -> str:
    """Lazy de propósito — só é exigido quando algo realmente vai assinar/
    validar um token (auth.py), não no import de config.py. Assim scripts
    que só precisam de SQLITE_PATH (ex.: demo_data/seed.py) não são
    bloqueados por uma variável que não usam."""
    return _req("JWT_SECRET")


JWT_ALGO = "HS256"
JWT_EXPIRA_HORAS = int(os.getenv("JWT_EXPIRA_HORAS", "12"))

ADAPTER_ATIVO = os.getenv("VENDALYTICS_ADAPTER", "sqlite_reference").strip()
SQLITE_PATH = Path(os.getenv("VENDALYTICS_SQLITE_PATH", str(PROJECT_ROOT / "vendalytics_demo.sqlite")))
TENANT_CONFIG_PATH = Path(os.getenv("VENDALYTICS_TENANT_CONFIG", str(PROJECT_ROOT / "config" / "tenant_config.yaml")))

DEMO_MODE = os.getenv("DEMO_MODE", "true").strip().lower() in ("1", "true", "yes")

# Universo de mercado (TAM) p/ Território (A2): antes uma chamada HTTP a um
# projeto irmão separado, agora consolidado neste repositório
# (sources/rfb_real.py + sources/mercado_publico_cache.py). Flag só para
# desligar em teste/CI; API é pública e sem chave, então não há "não
# configurado" de verdade em produção.
RFB_DESATIVADO = os.getenv("VENDALYTICS_RFB_DESATIVADO", "").strip().lower() in ("1", "true", "yes")

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile").strip()
GROQ_BASE_URL = os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1").strip()

WHAPI_TOKEN = os.getenv("WHAPI_TOKEN", "").strip()
WHAPI_WEBHOOK_SECRET = os.getenv("WHAPI_WEBHOOK_SECRET", "").strip()
WHAPI_BASE_URL = os.getenv("WHAPI_BASE_URL", "https://gate.whapi.cloud").strip()

# CRM real (spec A6) — nenhum tem valor padrão: ausente = conector
# `configurado() == False`, degrada honesto (ver integracoes/*_real.py).
SALESFORCE_LOGIN_URL = os.getenv("SALESFORCE_LOGIN_URL", "https://login.salesforce.com").strip()
SALESFORCE_CLIENT_ID = os.getenv("SALESFORCE_CLIENT_ID", "").strip()
SALESFORCE_CLIENT_SECRET = os.getenv("SALESFORCE_CLIENT_SECRET", "").strip()
SALESFORCE_USERNAME = os.getenv("SALESFORCE_USERNAME", "").strip()
SALESFORCE_PASSWORD = os.getenv("SALESFORCE_PASSWORD", "").strip()
SALESFORCE_SECURITY_TOKEN = os.getenv("SALESFORCE_SECURITY_TOKEN", "").strip()

HUBSPOT_ACCESS_TOKEN = os.getenv("HUBSPOT_ACCESS_TOKEN", "").strip()
HUBSPOT_BASE_URL = os.getenv("HUBSPOT_BASE_URL", "https://api.hubapi.com").strip()

# Mídia/imprensa real (spec C1) — referência sobre NewsAPI.org (REST simples
# por chave, sem OAuth) por ser o provedor mais acessível para validar depois;
# trocar por um agregador de clipping licenciado é outro conector no mesmo
# contrato (`integracoes/mentions_base.py`), não uma mudança de arquitetura.
NEWSAPI_KEY = os.getenv("NEWSAPI_KEY", "").strip()
NEWSAPI_BASE_URL = os.getenv("NEWSAPI_BASE_URL", "https://newsapi.org/v2").strip()

HTTP_TIMEOUT_S = float(os.getenv("VENDALYTICS_HTTP_TIMEOUT_S", "15"))

# Banco operacional (usuários, auditoria, scores, sinais, menções, CRM...).
# Padrão: SQLite local (USERS_DB_PATH), configurável por env para que teste
# e CI não escrevam no banco real da instalação.
#
# Se DATABASE_URL estiver setada (ex.: Postgres do Render), o banco
# operacional passa a ser esse Postgres — ver infra/db.py. Motivo de trocar:
# o disco do Render free tier é EFÊMERO (a base já foi zerada em deploy
# antes, ver commit "Fix empty dashboard... Render's ephemeral disk") — um
# SQLite de usuários/auditoria/score se perde a cada deploy exatamente pelo
# mesmo motivo que os dados de demonstração se perdiam. Postgres gerenciado
# resolve isso; SQLite continua sendo o padrão para quem roda local/CI, sem
# exigir um Postgres só para rodar teste.
USERS_DB_PATH = Path(os.getenv("VENDALYTICS_USERS_DB", str(PROJECT_ROOT / "usuarios.sqlite")))
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()

# Staging do write-back de CRM (integracoes/csv_connector.py). Mesma razão do
# USERS_DB_PATH: sem isto, rodar a suíte de teste grava arquivo real dentro
# do projeto a cada execução.
CRM_STAGING_DIR = Path(os.getenv("VENDALYTICS_CRM_STAGING", str(PROJECT_ROOT / "var" / "crm_staging")))
