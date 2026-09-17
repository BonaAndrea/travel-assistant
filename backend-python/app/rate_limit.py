from collections import defaultdict, deque
from threading import Lock
from time import monotonic

from fastapi import HTTPException, Request


_WINDOW_SECONDS = 60.0
_MAX_ATTEMPTS = 12
_attempts: dict[str, deque[float]] = defaultdict(deque)
_lock = Lock()


def auth_rate_limit(request: Request) -> None:
    """Small process-local limiter for auth endpoints.

    It protects the demo deployment without adding another service. Production
    deployments should keep a reverse-proxy/distributed limiter in front.
    """
    address = request.client.host if request.client else "unknown"
    now = monotonic()
    with _lock:
        bucket = _attempts[address]
        while bucket and now - bucket[0] > _WINDOW_SECONDS:
            bucket.popleft()
        if len(bucket) >= _MAX_ATTEMPTS:
            raise HTTPException(status_code=429, detail="Troppi tentativi, riprova tra poco")
        bucket.append(now)
