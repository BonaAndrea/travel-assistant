"""Optional Groq-compatible conversational provider.

The provider is deliberately advisory: deterministic extraction and validation
remain authoritative, so a model response cannot invent or silently mutate
critical travel constraints.
"""

import json
import os
import asyncio
import time
from typing import Any

import httpx


GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODEL = "llama-3.3-70b-versatile"
_failures = 0
_circuit_open_until = 0.0


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
    gemini_enabled = os.getenv("GEMINI_ENABLED") == "true" and os.getenv("GEMINI_FREE_TIER_CONFIRMED") == "true" and bool(os.getenv("GEMINI_API_KEY"))
    if not api_key and not gemini_enabled:
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
    global _failures, _circuit_open_until

    async def parse_result(content: str) -> tuple[dict, str | None]:
        result = _extract_json(content)
        fields = result.get("fields") if isinstance(result.get("fields"), dict) else {}
        allowed = {key: value for key, value in fields.items() if key in {"country", "destinationCity", "departureAirport", "activityPreferences", "travelMonth", "durationDays", "participants", "budget"}}
        return allowed, str(result.get("reply")) if result.get("reply") else None

    async def groq_call() -> tuple[dict, str | None]:
        global _failures, _circuit_open_until
        if time.monotonic() < _circuit_open_until:
            raise RuntimeError("GROQ_CIRCUIT_OPEN")
        retries = max(0, int(os.getenv("GROQ_MAX_RETRIES", os.getenv("LLM_MAX_RETRIES", "1"))))
        for attempt in range(retries + 1):
            try:
                async with httpx.AsyncClient(timeout=float(os.getenv("GROQ_TIMEOUT_MS", "10000")) / 1000) as client:
                    response = await client.post(GROQ_URL, headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}, json={"model": model, "messages": messages, "temperature": 0, "response_format": {"type": "json_object"}})
                    response.raise_for_status()
                    value = await parse_result(response.json()["choices"][0]["message"]["content"])
                    _failures = 0
                    return value
            except (httpx.HTTPError, KeyError, TypeError, ValueError) as error:
                if attempt >= retries:
                    _failures += 1
                    threshold = max(1, int(os.getenv("LLM_CIRCUIT_FAILURE_THRESHOLD", "3")))
                    if _failures >= threshold:
                        _circuit_open_until = time.monotonic() + max(1, int(os.getenv("LLM_CIRCUIT_COOLDOWN_MS", "30000"))) / 1000
                    raise error
                delay = min(float(os.getenv("LLM_RETRY_MAX_DELAY_MS", "2000")) / 1000, float(os.getenv("LLM_RETRY_BASE_DELAY_MS", "250")) / 1000 * (2 ** attempt))
                await asyncio.sleep(delay)
        raise RuntimeError("Groq non disponibile")

    async def gemini_call() -> tuple[dict, str | None]:
        contents = [{"role": "model" if item.get("role") == "assistant" else "user", "parts": [{"text": str(item.get("content", ""))}]} for item in messages if item.get("content")]
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{os.getenv('GEMINI_MODEL', 'gemini-2.5-flash-lite')}:generateContent"
        async with httpx.AsyncClient(timeout=float(os.getenv("GEMINI_TIMEOUT_MS", "10000")) / 1000) as client:
            response = await client.post(url, params={"key": os.getenv("GEMINI_API_KEY")}, json={"contents": contents, "generationConfig": {"responseMimeType": "application/json"}})
            response.raise_for_status()
            content = response.json()["candidates"][0]["content"]["parts"][0]["text"]
            return await parse_result(content)

    try:
        if api_key:
            return await groq_call()
    except (httpx.HTTPError, RuntimeError, KeyError, TypeError, ValueError):
        pass
    if gemini_enabled:
        try:
            return await gemini_call()
        except (httpx.HTTPError, KeyError, TypeError, ValueError):
            pass
    return {}, None
