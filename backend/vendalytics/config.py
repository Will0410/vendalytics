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

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
WHAPI_TOKEN = os.getenv("WHAPI_TOKEN", "").strip()
WHAPI_WEBHOOK_SECRET = os.getenv("WHAPI_WEBHOOK_SECRET", "").strip()

USERS_DB_PATH = PROJECT_ROOT / "usuarios.sqlite"
