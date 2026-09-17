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
    if os.getenv("GROQ_VISION_ENABLED", "false").lower() != "true":
        return {"status": "skipped", "reason": "vision_disabled"}
    if os.getenv("GROQ_VISION_FREE_TIER_CONFIRMED", "false").lower() != "true":
        return {"status": "skipped", "reason": "vision_plan_not_confirmed"}
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
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
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(VISION_URL, headers={"Authorization": f"Bearer {api_key}"}, json=payload)
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            parsed = _json_payload(content)
            description = str(parsed.get("description", "")).strip()[:2000]
            tags = [str(tag).strip().lower()[:64] for tag in parsed.get("tags", []) if str(tag).strip()][:8]
            if not description and not tags:
                return {"status": "skipped", "reason": "invalid_provider_output"}
            return {"status": "completed", "description": description or None, "tags": tags}
    except (httpx.HTTPError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return {"status": "skipped", "reason": "provider_unavailable"}

