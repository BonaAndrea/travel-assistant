"""Deterministic travel-requirement parsing and validation.

This module intentionally has no HTTP, database or LLM dependency. It is the
Python counterpart of the existing requirement state machine's safest core.
"""

from datetime import date, timedelta
import re
import unicodedata


MONTHS = (
    "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
    "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
)
MONTH_ALIASES = {
    "january": "gennaio", "february": "febbraio", "march": "marzo", "april": "aprile",
    "may": "maggio", "june": "giugno", "july": "luglio", "august": "agosto",
    "september": "settembre", "october": "ottobre", "november": "novembre", "december": "dicembre",
}
REQUIRED_FIELDS = (
    "budget", "country", "departureAirport", "activityPreferences",
    "travelMonth", "durationDays", "participants",
)


def clean(value: object) -> str:
    return "".join(
        char for char in unicodedata.normalize("NFD", str(value or "")).lower()
        if unicodedata.category(char) != "Mn"
    ).strip()


def normalize_month(value: object) -> str | None:
    words = re.findall(r"[a-z]+", clean(value))
    for word in words:
        if word in MONTHS:
            return word
        if word in MONTH_ALIASES:
            return MONTH_ALIASES[word]
    return None


def _parse_day_month(day: str, month: str, year: int) -> date | None:
    normalized = normalize_month(month)
    if not normalized or normalized not in MONTHS:
        return None
    try:
        return date(year, MONTHS.index(normalized) + 1, int(day))
    except (TypeError, ValueError):
        return None


def extract_dates(value: object, reference: date | None = None) -> tuple[date, date] | None:
    text = clean(value)
    today = reference or date.today()
    month_pattern = "|".join((*MONTHS, *MONTH_ALIASES))
    named = re.search(
        rf"(\d{{1,2}})\s+({month_pattern})(?:\s+(20\d{{2}}))?\s*"
        rf"(?:-|a|al|fino\s+a)\s*(\d{{1,2}})\s+({month_pattern})(?:\s+(20\d{{2}}))?",
        text,
    )
    if named:
        year = int(named.group(3) or named.group(6) or today.year)
        departure = _parse_day_month(named.group(1), named.group(2), year)
        return_year = int(named.group(6) or named.group(3) or today.year)
        arrival = _parse_day_month(named.group(4), named.group(5), return_year)
        return (departure, arrival) if departure and arrival else None
    abbreviated = re.search(
        rf"(?:dal\s+)?(\d{{1,2}})\s*(?:-|a|al|fino\s+a)\s*"
        rf"(\d{{1,2}})\s+({month_pattern})(?:\s+(20\d{{2}}))?",
        text,
    )
    if abbreviated:
        year = int(abbreviated.group(4) or today.year)
        departure = _parse_day_month(abbreviated.group(1), abbreviated.group(3), year)
        arrival = _parse_day_month(abbreviated.group(2), abbreviated.group(3), year)
        return (departure, arrival) if departure and arrival else None
    numeric = re.search(
        r"(\d{1,2})[/-](\d{1,2})(?:[/-](20\d{2}))?\s*"
        r"(?:-|a|al|fino\s+a)\s*(\d{1,2})[/-](\d{1,2})(?:[/-](20\d{2}))?",
        text,
    )
    if not numeric:
        return None
    departure = _parse_day_month(numeric.group(1), MONTHS[int(numeric.group(2)) - 1], int(numeric.group(3) or today.year)) if 1 <= int(numeric.group(2)) <= 12 else None
    arrival = _parse_day_month(numeric.group(4), MONTHS[int(numeric.group(5)) - 1], int(numeric.group(6) or numeric.group(3) or today.year)) if 1 <= int(numeric.group(5)) <= 12 else None
    return (departure, arrival) if departure and arrival else None


def extract_budget(value: object) -> float | None:
    text = str(value or "").replace(".", "").replace(",", ".")
    match = re.search(r"(?:budget|spesa|spendere|costo)[^0-9]{0,20}(\d+(?:\.\d{1,2})?)", text, re.I)
    match = match or re.search(r"\b(\d+(?:\.\d{1,2})?)\s*(?:€|euro)\b", text, re.I)
    if not match:
        return None
    budget = float(match.group(1))
    return budget if budget > 0 else None


def extract_duration(value: object) -> int | None:
    match = re.search(r"(?:durata|vacanza|soggiorno|viaggio)[^0-9]{0,40}(\d{1,2})\s*giorni?", clean(value), re.I)
    match = match or re.search(r"\b(\d{1,2})\s*giorni?\b", clean(value), re.I)
    if not match:
        return None
    days = int(match.group(1))
    return days if 0 < days <= 60 else None


def extract_participants(value: object) -> int | None:
    match = re.search(r"\b(\d{1,2})\s*(?:persone|partecipanti|adulti)\b", str(value or ""), re.I)
    if not match:
        return None
    participants = int(match.group(1))
    return participants if participants > 0 else None


def missing_fields(requirements: dict) -> list[str]:
    return [field for field in REQUIRED_FIELDS if not requirements.get(field)]


def validate_consistency(requirements: dict) -> list[str]:
    issues = []
    budget = requirements.get("budget")
    duration = requirements.get("durationDays")
    participants = requirements.get("participants")
    if budget is not None and budget <= 0:
        issues.append("Il budget deve essere maggiore di zero.")
    if duration is not None and not 0 < duration <= 60:
        issues.append("La durata deve essere tra 1 e 60 giorni.")
    if participants is not None and participants <= 0:
        issues.append("Il numero di partecipanti deve essere almeno 1.")
    if budget is not None and duration and participants:
        minimum = participants * (150 + duration * 40)
        if budget < minimum:
            issues.append(f"Il budget indicato ({budget}€) sembra insufficiente.")
    return issues


def is_complete(requirements: dict) -> bool:
    return not missing_fields(requirements) and not validate_consistency(requirements)
