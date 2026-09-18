"""Dependency-free catalog retrieval used to rank activity candidates."""

import json
import re
from pathlib import Path
from typing import Any


def _tokens(value: str) -> set[str]:
    return {token for token in re.findall(r"[a-zàèéìòù0-9]+", value.lower()) if len(token) > 2}


def relevance(query: str, *, category: str = "", name: str = "", description: str = "", target: str = "") -> float:
    wanted = _tokens(query)
    if not wanted:
        return 0.0
    text = _tokens(" ".join((category, name, description, target)))
    return round(len(wanted & text) / len(wanted), 4)


def load_catalog_index() -> list[dict[str, Any]]:
    for path in (Path("/app/data/vector-index.json"), Path(__file__).parents[2] / "data" / "vector-index.json"):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            continue
    return []


def indexed_relevance(activity_id: str, query: str) -> float | None:
    for document in load_catalog_index():
        if document.get("type") == "activity" and document.get("id") == activity_id:
            metadata = document.get("metadata") or {}
            return relevance(query, category=str(metadata.get("category", "")), name=str(metadata.get("name", "")), description=str(document.get("text", "")))
    return None
