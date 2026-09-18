from datetime import date
import asyncio

from app.domain.requirements import (
    extract_budget,
    extract_dates,
    extract_duration,
    extract_participants,
    is_complete,
    normalize_month,
)
from app.conversations import _apply_catalog_locations, _extract_requirements, _merge_advisory_requirements
from app.database import psycopg_url
from app.vision import analyze_image


def test_extracts_italian_travel_requirements() -> None:
    text = "Barcellona dal 22 novembre al 6 dicembre 2026, budget 1500 euro, 2 persone, 14 giorni"

    assert normalize_month("November") == "novembre"
    assert extract_dates(text) == (date(2026, 11, 22), date(2026, 12, 6))
    assert extract_budget(text) == 1500
    assert extract_duration(text) == 14
    assert extract_participants(text) == 2


def test_chat_requirement_update_preserves_existing_fields() -> None:
    requirements = _extract_requirements(
        "Parto da Roma Fiumicino per Barcellona dal 1 al 6 ottobre 2026, budget 1500 euro, 2 persone, cultura e relax",
        {},
    )

    assert requirements["departureAirport"] == "FCO"
    assert requirements["destinationCity"] == "Barcellona"
    assert requirements["durationDays"] == 6
    assert requirements["activityPreferences"] == ["cultura", "relax"]


def test_catalog_location_resolution_supports_destinations_beyond_static_map() -> None:
    class Result:
        def __init__(self, rows):
            self.rows = rows

        def fetchall(self):
            return self.rows

    class Connection:
        def __init__(self):
            self.results = [Result([("Valencia", "Spagna")]), Result([("VLC", "Valencia"), ("FCO", "Roma")])]

        def execute(self, _query):
            return self.results.pop(0)

    text = "Parto da Roma per Valencia"
    resolved = _apply_catalog_locations(Connection(), text, _extract_requirements(text, {}))
    assert resolved["destinationCity"] == "Valencia"
    assert resolved["departureAirport"] == "FCO"


def test_complete_requirements_and_budget_validation() -> None:
    requirements = {
        "budget": 1500, "country": "Spagna", "departureAirport": "FCO",
        "activityPreferences": ["cultura"], "travelMonth": "novembre",
        "durationDays": 5, "participants": 2,
    }
    assert is_complete(requirements)
    assert not is_complete({**requirements, "budget": 100})


def test_separate_month_messages_are_preserved_without_inventing_city() -> None:
    requirements = _extract_requirements("Vorrei organizzare un viaggio in Spagna", {})
    requirements = _extract_requirements(
        "Parto da Roma, budget 1500 euro, siamo in 2 persone e 5 giorni",
        requirements,
    )
    requirements = _extract_requirements(
        "Cultura, buon cibo e passeggiate, con un hotel centrale",
        requirements,
    )
    requirements = _extract_requirements("Giugno", requirements)
    merged = _merge_advisory_requirements(
        "Giugno",
        requirements,
        {"destinationCity": "Nizza", "travelMonth": "luglio"},
    )

    assert merged["country"] == "Spagna"
    assert "destinationCity" not in merged
    assert merged["travelMonth"] == "giugno"


def test_explicit_city_wins_over_advisory_city() -> None:
    deterministic = _extract_requirements("Parto da Roma per Barcellona", {})
    merged = _merge_advisory_requirements(
        "Parto da Roma per Barcellona",
        deterministic,
        {"destinationCity": "Nizza"},
    )
    assert merged["destinationCity"] == "Barcellona"


def test_country_update_removes_stale_city_and_keeps_food_walks_preferences() -> None:
    requirements = _extract_requirements("Parto da Roma per Nizza", {})
    updated = _extract_requirements(
        "In realtà voglio visitare la Spagna: buon cibo e passeggiate",
        requirements,
    )
    assert updated["country"] == "Spagna"
    assert "destinationCity" not in updated
    assert "buon cibo" in updated["activityPreferences"]
    assert "passeggiate" in updated["activityPreferences"]


def test_database_url_drops_prisma_schema_parameter() -> None:
    assert psycopg_url("postgresql://travel:travel@localhost:5432/travel_assistant?schema=public") == "postgresql://travel:travel@localhost:5432/travel_assistant"


def test_vision_is_opt_in(monkeypatch) -> None:
    monkeypatch.setenv("GROQ_VISION_ENABLED", "false")

    result = asyncio.run(analyze_image(b"not-an-image", "image/png"))

    assert result == {"status": "skipped", "reason": "vision_disabled"}


def test_vision_can_fallback_to_gemini(monkeypatch) -> None:
    monkeypatch.setenv("GEMINI_ENABLED", "true")
    monkeypatch.setenv("GEMINI_FREE_TIER_CONFIRMED", "true")
    monkeypatch.setenv("GEMINI_VISION_ENABLED", "true")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": '{"description":"mare","tags":["relax"]}'}]}}]}

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr("app.vision.httpx.AsyncClient", Client)
    result = asyncio.run(analyze_image(b"image", "image/png"))
    assert result == {"status": "completed", "description": "mare", "tags": ["relax"]}
