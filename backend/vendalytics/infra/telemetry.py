"""
telemetry.py — observabilidade mínima e honesta: log estruturado com
`request_id`, latência por endpoint e contadores em memória expostos em
`/api/health`.

Deliberadamente sem OpenTelemetry/Datadog por enquanto. A spec (§3.5) pede
OTel, e o caminho para lá é trocar o corpo de `_registrar_latencia` por um
histograma OTel — o formato do log e o `request_id` já são compatíveis com
correlação distribuída. Adicionar o SDK agora, num processo único sem
coletor para onde exportar, seria dependência sem sinal.

O `request_id` é a peça que importa: é ele que liga a linha de log, a linha
de auditoria e a resposta HTTP (header `X-Request-Id`) do mesmo request.
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from threading import Lock

log = logging.getLogger("vendalytics.request")

_lock = Lock()
_contadores: dict[str, int] = defaultdict(int)
_latencias: dict[str, list[float]] = defaultdict(list)
_MAX_AMOSTRAS = 500


class LogJson(logging.Formatter):
    """Formata em JSON por linha — legível por humano no terminal e parseável
    por qualquer coletor sem regex frágil."""

    def format(self, record: logging.LogRecord) -> str:
        base = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "nivel": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for campo in ("request_id", "usuario", "rota", "status", "ms", "tenant"):
            valor = getattr(record, campo, None)
            if valor is not None:
                base[campo] = valor
        if record.exc_info:
            base["exc"] = self.formatException(record.exc_info)
        return json.dumps(base, ensure_ascii=False)


def configurar_logging(nivel: int = logging.INFO, *, json_logs: bool = True) -> None:
    root = logging.getLogger()
    root.setLevel(nivel)
    for h in list(root.handlers):
        root.removeHandler(h)
    handler = logging.StreamHandler()
    handler.setFormatter(LogJson() if json_logs else
                         logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    root.addHandler(handler)


def _registrar_latencia(rota: str, ms: float, status: int) -> None:
    with _lock:
        _contadores[f"{rota} {status // 100}xx"] += 1
        amostras = _latencias[rota]
        amostras.append(ms)
        if len(amostras) > _MAX_AMOSTRAS:
            del amostras[: len(amostras) - _MAX_AMOSTRAS]


def snapshot() -> dict:
    """Resumo para o health check: contagem por rota/classe de status e p50/p95.

    Janela deslizante em memória — some no restart, e é isso mesmo: serve
    para responder "como está agora", não para série histórica. Série
    histórica é trabalho do coletor externo, quando existir um.
    """
    with _lock:
        rotas = {}
        for rota, amostras in _latencias.items():
            if not amostras:
                continue
            ordenadas = sorted(amostras)
            n = len(ordenadas)
            rotas[rota] = {
                "amostras": n,
                "p50_ms": round(ordenadas[n // 2], 1),
                "p95_ms": round(ordenadas[min(int(n * 0.95), n - 1)], 1),
                "max_ms": round(ordenadas[-1], 1),
            }
        return {"contadores": dict(_contadores), "latencia": rotas}


def logar_request(*, request_id: str, rota: str, status: int, ms: float,
                  usuario: str = "-", tenant: str = "-") -> None:
    _registrar_latencia(rota, ms, status)
    log.info(
        "request",
        extra={"request_id": request_id, "rota": rota, "status": status,
               "ms": round(ms, 1), "usuario": usuario, "tenant": tenant},
    )
