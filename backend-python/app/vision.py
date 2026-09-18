import base64
import json
import os
from typing import Any

import httpx


VISION_URL = "https://api.groq.com/openai/v1/chat/completions"


def _json_payload(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        start, end = value.find("{"), value.rfind("}")
        if start >= 0 and end > start:
            try:
                parsed = json.loads(value[start:end + 1])
                return parsed if isinstance(parsed, dict) else {}
            except json.JSONDecodeError:
                pass
        return {}


async def analyze_image(data: bytes, mime_type: str) -> dict[str, Any]:
    groq_enabled = os.getenv("GROQ_VISION_ENABLED", "false").lower() == "true" and os.getenv("GROQ_VISION_FREE_TIER_CONFIRMED", "false").lower() == "true" and bool(os.getenv("GROQ_API_KEY"))
    gemini_enabled = os.getenv("GEMINI_ENABLED", "false").lower() == "true" and os.getenv("GEMINI_FREE_TIER_CONFIRMED", "false").lower() == "true" and os.getenv("GEMINI_VISION_ENABLED", "false").lower() == "true" and bool(os.getenv("GEMINI_API_KEY"))
    if not groq_enabled and not gemini_enabled:
        if os.getenv("GROQ_VISION_ENABLED", "false").lower() != "true" and not gemini_enabled:
            return {"status": "skipped", "reason": "vision_disabled"}
        return {"status": "skipped", "reason": "api_key_missing"}
    payload = {
        "model": os.getenv("GROQ_VISION_MODEL", "qwen/qwen3.6-27b"),
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "Descrivi questa immagine per suggerire un viaggio. Rispondi JSON con description e tags (massimo 8 tag brevi). Non dedurre dati personali o requisiti certi."},
            {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{base64.b64encode(data).decode()}"}},
        ]}],
    }
    async def parse(content: str) -> dict[str, Any]:
        parsed = _json_payload(content)
        description = str(parsed.get("description", "")).strip()[:2000]
        tags = [str(tag).strip().lower()[:64] for tag in parsed.get("tags", []) if str(tag).strip()][:8]
        if not description and not tags:
            return {"status": "skipped", "reason": "invalid_provider_output"}
        return {"status": "completed", "description": description or None, "tags": tags}

    if groq_enabled:
        try:
            async with httpx.AsyncClient(timeout=float(os.getenv("GROQ_VISION_TIMEOUT_MS", "15000")) / 1000) as client:
                response = await client.post(VISION_URL, headers={"Authorization": f"Bearer {os.getenv('GROQ_API_KEY')}"}, json=payload)
                response.raise_for_status()
                return await parse(response.json()["choices"][0]["message"]["content"])
        except (httpx.HTTPError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            pass

    if gemini_enabled:
        try:
            gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/{os.getenv('GEMINI_MODEL', 'gemini-2.5-flash-lite')}:generateContent"
            gemini_payload = {"contents": [{"role": "user", "parts": [{"text": payload["messages"][0]["content"][0]["text"]}, {"inline_data": {"mime_type": mime_type, "data": base64.b64encode(data).decode()}}]}], "generationConfig": {"responseMimeType": "application/json"}}
            async with httpx.AsyncClient(timeout=float(os.getenv("GEMINI_TIMEOUT_MS", "10000")) / 1000) as client:
                response = await client.post(gemini_url, params={"key": os.getenv("GEMINI_API_KEY")}, json=gemini_payload)
                response.raise_for_status()
                return await parse(response.json()["candidates"][0]["content"]["parts"][0]["text"])
        except (httpx.HTTPError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            pass
    return {"status": "skipped", "reason": "provider_unavailable"}
