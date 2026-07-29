"""
tenant.py — identidade da instalação (nome da empresa, cores, filiais,
segmentação de mercado, textos de bot/IA), carregada de UM ARQUIVO YAML
(config/tenant_config.yaml) em vez de hardcoded no código. Isso é o que
permite o mesmo código atender clientes diferentes: o que muda entre eles é
só este arquivo.

Se o arquivo real (tenant_config.yaml) não existir, cai no
tenant_config.example.yaml — assim o projeto roda "out of the box" para
demonstração, sem exigir configurar nada antes do primeiro `uvicorn`.
"""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

import yaml

from . import config

_EXEMPLO = config.PROJECT_ROOT / "config" / "tenant_config.example.yaml"


class Tenant:
    def __init__(self, dados: dict):
        self._d = dados or {}

    @property
    def nome(self) -> str:
        return self._d.get("empresa", {}).get("nome", "Vendalytics")

    @property
    def nome_curto(self) -> str:
        return self._d.get("empresa", {}).get("nome_curto", self.nome)

    @property
    def cor_primaria(self) -> str:
        return self._d.get("empresa", {}).get("cor_primaria", "#2563eb")

    @property
    def cor_secundaria(self) -> str:
        return self._d.get("empresa", {}).get("cor_secundaria", "#f59e0b")

    @property
    def logo_path(self) -> str:
        return self._d.get("empresa", {}).get("logo_path", "")

    @property
    def admin_email(self) -> str:
        return self._d.get("empresa", {}).get("admin_email", "admin@localhost")

    @property
    def filiais(self) -> list[dict]:
        return self._d.get("filiais", []) or []

    def grupos_cnae(self) -> dict:
        """{chave: {nome, prefixos, padrao}} — substitui GRUPOS_CNAE hardcoded."""
        return (self._d.get("segmentacao", {}) or {}).get("grupos_cnae", {}) or {}

    def grupos_por_ramo_regex(self) -> dict:
        """{nome_do_grupo: regex} — mapa de segmentação configurável por tenant."""
        return (self._d.get("segmentacao", {}) or {}).get("grupos_por_ramo_regex", {}) or {}

    def grupo_do_ramo(self, ramo: str) -> str:
        """Casa o texto livre do RAMO cadastral do cliente com um grupo de
        segmentação configurado, via regex — os padrões vêm do tenant_config,
        nunca hardcoded no código."""
        r = (ramo or "").upper()
        for grupo, padrao in self.grupos_por_ramo_regex().items():
            if re.search(padrao, r):
                return grupo
        return ""

    def prompt_ia(self, **variaveis) -> str:
        tpl = (self._d.get("assistente_ia", {}) or {}).get(
            "system_prompt_template", "Você é um assistente comercial.")
        out = tpl
        for k, v in variaveis.items():
            out = out.replace("{{" + k + "}}", str(v))
        return out

    def whatsapp_boas_vindas(self) -> str:
        tpl = (self._d.get("whatsapp_bot", {}) or {}).get(
            "boas_vindas", "Olá! Bem-vindo(a).")
        return tpl.replace("{{empresa_nome}}", self.nome)

    def whatsapp_menu_vendedor(self) -> list[str]:
        return (self._d.get("whatsapp_bot", {}) or {}).get("menu_vendedor", []) or []

    def branding_publico(self) -> dict:
        """Único subconjunto exposto ao frontend via /api/tenant/branding —
        nunca inclui admin_email nem nada sensível."""
        return {
            "nome": self.nome,
            "nome_curto": self.nome_curto,
            "cor_primaria": self.cor_primaria,
            "cor_secundaria": self.cor_secundaria,
            "logo_path": self.logo_path,
        }


@lru_cache(maxsize=1)
def carregar() -> Tenant:
    caminho = config.TENANT_CONFIG_PATH if config.TENANT_CONFIG_PATH.exists() else _EXEMPLO
    with open(caminho, "r", encoding="utf-8") as f:
        dados = yaml.safe_load(f) or {}
    return Tenant(dados)
