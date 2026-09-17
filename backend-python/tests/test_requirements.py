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
from app.conversations import _extract_requirements
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


def test_complete_requirements_and_budget_validation() -> None:
    requirements = {
        "budget": 1500, "country": "Spagna", "departureAirport": "FCO",
        "activityPreferences": ["cultura"], "travelMonth": "novembre",
        "durationDays": 5, "participants": 2,
    }
    assert is_complete(requirements)
    assert not is_complete({**requirements, "budget": 100})


def test_database_url_drops_prisma_schema_parameter() -> None:
    assert psycopg_url("postgresql://travel:travel@localhost:5432/travel_assistant?schema=public") == "postgresql://travel:travel@localhost:5432/travel_assistant"


def test_vision_is_opt_in(monkeypatch) -> None:
    monkeypatch.setenv("GROQ_VISION_ENABLED", "false")

    result = asyncio.run(analyze_image(b"not-an-image", "image/png"))

    assert result == {"status": "skipped", "reason": "vision_disabled"}
