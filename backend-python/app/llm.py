"""Optional Groq-compatible conversational provider.

The provider is deliberately advisory: deterministic extraction and validation
remain authoritative, so a model response cannot invent or silently mutate
critical travel constraints.
"""

import json
import os
from typing import Any

import httpx


GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODEL = "llama-3.3-70b-versatile"


def _extract_json(text: str) -> dict[str, Any]:
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            return {}
        try:
            value = json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            return {}
    return value if isinstance(value, dict) else {}


async def enrich_requirements(history: list[dict], requirements: dict) -> tuple[dict, str | None]:
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        return {}, None
    model = os.getenv("GROQ_MODEL", DEFAULT_MODEL)
    prompt = {
        "role": "system",
        "content": (
            "Sei un estrattore di requisiti per un assistente viaggi italiano. "
            "Rispondi esclusivamente JSON con le chiavi fields e reply. "
            "fields può contenere solo country, destinationCity, departureAirport, "
            "activityPreferences, travelMonth, durationDays, participants, budget. "
            "Inserisci in fields solo valori dichiarati esplicitamente dall'utente; "
            "non inventare dati. reply è una breve risposta in italiano."
        ),
    }
    messages = [prompt, *history[-12:]]
    try:
        async with httpx.AsyncClient(timeout=float(os.getenv("GROQ_TIMEOUT_MS", "10000")) / 1000) as client:
            response = await client.post(
                GROQ_URL,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": model, "messages": messages, "temperature": 0,
                    "response_format": {"type": "json_object"},
                },
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            result = _extract_json(content)
            fields = result.get("fields") if isinstance(result.get("fields"), dict) else {}
            allowed = {
                key: value for key, value in fields.items()
                if key in {"country", "destinationCity", "departureAirport", "activityPreferences", "travelMonth", "durationDays", "participants", "budget"}
            }
            return allowed, str(result.get("reply")) if result.get("reply") else None
    except (httpx.HTTPError, KeyError, TypeError, ValueError):
        return {}, None

