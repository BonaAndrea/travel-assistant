from collections import defaultdict
from datetime import UTC, datetime
from threading import Lock
from time import perf_counter

from fastapi import HTTPException, Request


_lock = Lock()
_counters: dict[tuple[str, tuple[tuple[str, str], ...]], int] = defaultdict(int)
_durations: dict[tuple[str, tuple[tuple[str, str], ...]], dict[str, float | int]] = defaultdict(lambda: {"count": 0, "sum": 0.0})


def _key(name: str, labels: dict[str, object]) -> tuple[str, tuple[tuple[str, str], ...]]:
    allowed = {key: str(value) for key, value in labels.items() if key in {"method", "route", "status", "outcome", "reason", "operation", "error", "cache"}}
    return name, tuple(sorted(allowed.items()))


def increment(name: str, labels: dict[str, object] | None = None) -> None:
    with _lock:
        _counters[_key(name, labels or {})] += 1


def observe(name: str, value: float, labels: dict[str, object] | None = None) -> None:
    with _lock:
        item = _durations[_key(name, labels or {})]
        item["count"] = int(item["count"]) + 1
        item["sum"] = float(item["sum"]) + value


def snapshot() -> dict:
    with _lock:
        return {
            "generatedAt": datetime.now(UTC).isoformat(),
            "counters": [{"name": name, "labels": dict(labels), "value": value} for (name, labels), value in _counters.items()],
            "histograms": [{"name": name, "labels": dict(labels), **values} for (name, labels), values in _durations.items()],
        }


def metrics_endpoint(request: Request) -> dict:
    import os
    token = os.getenv("METRICS_TOKEN")
    if not token:
        raise HTTPException(status_code=404, detail="Metriche non abilitate")
    if request.headers.get("authorization") != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="Autorizzazione richiesta")
    return snapshot()


def request_started() -> float:
    return perf_counter()
