"""Optional Groq-compatible conversational provider.

The provider is deliberately advisory: deterministic extraction and validation
remain authoritative, so a model response cannot invent or silently mutate
critical travel constraints.
"""

import json
import os
import asyncio
import time
import base64
from typing import Any

import httpx


GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODEL = "qwen/qwen3.8-27b"
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


async def enrich_requirements(
    history: list[dict],
    requirements: dict,
    image_attachments: list[dict] | None = None,
) -> tuple[dict, str | None]:
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
            "non inventare dati e non correggere i valori già presenti nei requisiti. "
            "reply deve essere naturale, empatica e breve: riconosci ciò che l'utente "
            "ha già indicato e chiedi solo i requisiti ancora mancanti. Se tutti i "
            "requisiti sono completi, ricapitolali in modo chiaro e chiedi conferma. "
            "Non dire di non vedere un'immagine se i requisiti contengono già una "
            "destinazione ricavata dall'analisi vision."
        ),
    }
    messages = [prompt, *history[-12:]]
    attachments = image_attachments or []
    if attachments and messages and messages[-1].get("role") == "user":
        content = [{"type": "text", "text": str(messages[-1].get("content", ""))}]
        for image in attachments[:5]:
            content.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:{image['mimeType']};base64,{base64.b64encode(image['data']).decode()}"
                },
            })
        messages[-1] = {**messages[-1], "content": content}
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
                    response = await client.post(GROQ_URL, headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}, json={"model": model, "messages": messages, "temperature": 0.4, "response_format": {"type": "json_object"}})
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
        contents = []
        for item in messages:
            if not item.get("content"):
                continue
            raw_content = item["content"]
            parts = []
            if isinstance(raw_content, list):
                for part in raw_content:
                    if part.get("type") == "text":
                        parts.append({"text": str(part.get("text", ""))})
                    elif part.get("type") == "image_url":
                        encoded = str(part.get("image_url", {}).get("url", ""))
                        header, _, data = encoded.partition(",")
                        mime_type = header.removeprefix("data:").removesuffix(";base64")
                        if data and mime_type:
                            parts.append({"inline_data": {"mime_type": mime_type, "data": data}})
            else:
                parts.append({"text": str(raw_content)})
            if parts:
                contents.append({"role": "model" if item.get("role") == "assistant" else "user", "parts": parts})
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{os.getenv('GEMINI_MODEL', 'gemini-3.5-flash-lite')}:generateContent"
        async with httpx.AsyncClient(timeout=float(os.getenv("GEMINI_TIMEOUT_MS", "10000")) / 1000) as client:
            response = await client.post(url, params={"key": os.getenv("GEMINI_API_KEY")}, json={"contents": contents, "generationConfig": {"responseMimeType": "application/json", "temperature": 0.4}})
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
