from fastapi.testclient import TestClient

from app.main import app
from app.main import settings
from app import main


client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "python-backend"}


def test_live() -> None:
    response = client.get("/health/live")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "check": "liveness"}


def test_ready() -> None:
    main.check_database = lambda _url: True
    response = client.get("/api/ready")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "check": "readiness"}


def test_ready_returns_503_when_database_is_unavailable() -> None:
    main.check_database = lambda _url: False
    response = client.get("/health/ready")

    assert response.status_code == 503
    assert response.json() == {"status": "unavailable", "check": "readiness"}


def test_chat_requires_bearer_token() -> None:
    response = client.get("/api/chat/conversations")

    assert response.status_code == 401
    assert response.json() == {"error": "Autenticazione richiesta"}
