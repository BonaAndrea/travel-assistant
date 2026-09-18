from datetime import date, datetime, UTC, timedelta
import re
from pathlib import Path
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from .database import connect
from .domain.requirements import (
    extract_budget, extract_dates, extract_duration, extract_participants, extract_single_date,
    is_complete, missing_fields, normalize_month, validate_consistency,
)
from .security import current_user_id
from .llm import enrich_requirements
from .config import get_settings
from psycopg.types.json import Jsonb


router = APIRouter(prefix="/chat", tags=["chat"])
UserId = Annotated[str, Depends(current_user_id)]

FIELD_LABELS = {
    "budget": "il budget totale", "country": "la destinazione", "departureAirport": "l'aeroporto di partenza",
    "activityPreferences": "le preferenze sulle attività", "travelMonth": "il periodo di viaggio",
    "durationDays": "la durata", "participants": "il numero di partecipanti",
}
DESTINATIONS = {
    "barcellona": ("Spagna", "Barcellona"), "barcelona": ("Spagna", "Barcellona"),
    "madrid": ("Spagna", "Madrid"), "lisbona": ("Portogallo", "Lisbona"),
    "lisbon": ("Portogallo", "Lisbona"), "parigi": ("Francia", "Parigi"),
    "nizza": ("Francia", "Nizza"), "nice": ("Francia", "Nizza"),
    "paris": ("Francia", "Parigi"), "atene": ("Grecia", "Atene"),
    "athens": ("Grecia", "Atene"), "praga": ("Repubblica Ceca", "Praga"),
    "prague": ("Repubblica Ceca", "Praga"),
}
AIRPORTS = {
    "fco": "FCO", "roma fiumicino": "FCO", "fiumicino": "FCO", "roma": "FCO",
    "mxp": "MXP", "milano malpensa": "MXP", "malpensa": "MXP", "milano": "MXP",
    "blq": "BLQ", "bologna": "BLQ", "nap": "NAP", "napoli": "NAP",
}
ACTIVITIES = ("cultura", "sport", "relax", "nightlife", "vita notturna", "natura", "mare", "gastronomia", "buon cibo", "passeggiate")


def _confirmation(text: str) -> bool:
    return bool(re.search(r"\b(?:si|sì|confermo|conferma|ok|va bene|procedi)\b", text.lower()))


def _rejection(text: str) -> bool:
    return bool(re.search(r"\b(?:no|non confermo|modifica|cambia)\b", text.lower()))


def _extract_requirements(text: str, previous: dict) -> dict:
    requirements = dict(previous)
    budget = extract_budget(text)
    year_match = re.search(r"\b(20\d{2})\b", text)
    if year_match:
        requirements["travelYear"] = int(year_match.group(1))
    reference = date(int(requirements.get("travelYear", date.today().year)), 1, 1)
    dates = extract_dates(text, reference=reference)
    duration = extract_duration(text)
    participants = extract_participants(text)
    if budget is not None:
        requirements["budget"] = budget
    if dates:
        departure, arrival = dates
        requirements.update({
            "outboundDate": departure.isoformat(), "returnDate": arrival.isoformat(),
            "durationDays": (arrival - departure).days + 1, "travelMonth": normalize_month(departure.strftime("%B")),
        })
    elif duration is not None:
        requirements["durationDays"] = duration
    else:
        single_date = extract_single_date(text, reference=reference)
        if single_date and re.search(r"\b(?:ritorno|rientro|rientrare|tornare|fino)\b|\b\d{1,2}[/-]\d{1,2}\b", lowered := text.lower()):
            if requirements.get("outboundDate"):
                requirements["returnDate"] = single_date.isoformat()
                departure = date.fromisoformat(str(requirements["outboundDate"])[:10])
                requirements["durationDays"] = (single_date - departure).days + 1
                requirements["travelMonth"] = normalize_month(single_date.strftime("%B"))
            elif requirements.get("durationDays"):
                departure = single_date - timedelta(days=int(requirements["durationDays"]) - 1)
                requirements.update({
                    "outboundDate": departure.isoformat(), "returnDate": single_date.isoformat(),
                    "travelMonth": normalize_month(departure.strftime("%B")),
                })
    if participants is not None:
        requirements["participants"] = participants
    lowered = text.lower()
    explicit_city = False
    for name, (country, city) in DESTINATIONS.items():
        if re.search(rf"\b{re.escape(name)}\b", lowered):
            requirements.update({"country": country, "destinationCity": city})
            explicit_city = True
            break
    for name, code in AIRPORTS.items():
        if name in lowered:
            requirements["departureAirport"] = code
            break
    activities = [activity for activity in ACTIVITIES if activity in lowered]
    if activities:
        requirements["activityPreferences"] = sorted(set(activities))
    if "country" not in requirements:
        for country in ("spagna", "portogallo", "francia", "grecia"):
            if country in lowered:
                requirements["country"] = country.title()
                break
    else:
        country_aliases = {"spagna": "Spagna", "portogallo": "Portogallo", "francia": "Francia", "grecia": "Grecia"}
        for country, normalized_country in country_aliases.items():
            if country in lowered:
                requirements["country"] = normalized_country
                if not explicit_city:
                    requirements.pop("destinationCity", None)
                break
    if "travelMonth" not in requirements:
        month = normalize_month(text)
        if month:
            requirements["travelMonth"] = month
    destination = requirements.get("destinationCity")
    if destination and requirements.get("country"):
        known_destination = next(
            (country for city_country, city in DESTINATIONS.values() if city.casefold() == str(destination).casefold() for country in (city_country,)),
            None,
        )
        if known_destination and known_destination.casefold() != str(requirements["country"]).casefold():
            requirements.pop("destinationCity", None)
    return requirements


def _merge_advisory_requirements(text: str, deterministic: dict, advisory: dict) -> dict:
    """Merge optional LLM hints without allowing invented critical values."""
    merged = {**advisory, **deterministic}
    explicit_month = normalize_month(text)
    if explicit_month:
        merged["travelMonth"] = explicit_month
    explicit_city = deterministic.get("destinationCity")
    if not explicit_city and advisory.get("destinationCity"):
        # A provider may infer a plausible city from a country. Keep the
        # country-level request instead until the user names a city explicitly.
        merged.pop("destinationCity", None)
    return merged


def _summary(requirements: dict) -> str:
    destination = requirements.get("destinationCity") or requirements.get("country")
    period = requirements.get("outboundDate")
    if period and requirements.get("returnDate"):
        period = f"dal {period} al {requirements['returnDate']}"
    else:
        period = requirements.get("travelMonth", "periodo da definire")
    activities = ", ".join(requirements.get("activityPreferences", []))
    return (f"Ho raccolto: {destination}, {period}, {requirements.get('durationDays')} giorni, "
            f"{requirements.get('participants')} partecipanti, budget {requirements.get('budget')}€. "
            f"Preferenze: {activities}. Confermi questi requisiti?")


def conversation_exists(connection: object, conversation_id: str, user_id: str) -> bool:
    row = connection.execute(
        'SELECT 1 FROM "Conversation" WHERE "id" = %s AND "userId" = %s',
        (conversation_id, user_id),
    ).fetchone()
    return row is not None


def _apply_catalog_locations(connection: object, text: str, requirements: dict) -> dict:
    """Resolve locations from the relational catalog, not only the demo map."""
    lowered = text.casefold()
    destinations = connection.execute('SELECT "city", "country" FROM "Destination"').fetchall()
    for city, country in sorted(destinations, key=lambda item: len(str(item[0])), reverse=True):
        if re.search(rf"\b{re.escape(str(city).casefold())}\b", lowered):
            requirements.update({"country": country, "destinationCity": city})
            break
    airports = connection.execute('SELECT "iataCode", "city" FROM "Airport"').fetchall()
    departure_context = re.search(r"\b(?:da|partenza|parto|aeroporto)\b", lowered)
    for code, city in sorted(airports, key=lambda item: len(str(item[1])), reverse=True):
        city_match = re.search(rf"\b{re.escape(str(city).casefold())}\b", lowered)
        code_match = re.search(rf"\b{re.escape(str(code).casefold())}\b", lowered)
        if "departureAirport" not in requirements and departure_context and (code_match or city_match):
            requirements["departureAirport"] = code
            break
    return requirements


def _unknown_destination_requested(text: str, requirements: dict) -> bool:
    if requirements.get("country"):
        return False
    lowered = text.casefold()
    return bool(
        re.search(r"destinazione\s+(?:non\s+)?(?:presente|disponibile|conosciuta)", lowered)
        or re.search(r"destinazione\s+fuori\s+catalogo", lowered)
    )


@router.post("/conversations", status_code=status.HTTP_201_CREATED)
def create_conversation(_user_id: UserId) -> dict[str, str]:
    # La creazione è transitoria: la riga viene
    # materializzata solo quando arriva il primo messaggio.
    return {"conversationId": str(uuid4())}


@router.post("/conversations/{conversation_id}/messages")
async def send_message(conversation_id: str, payload: dict, user_id: UserId) -> dict:
    message = str(payload.get("message") or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="Campo 'message' non valido")
    try:
        UUID(conversation_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Conversazione non trovata") from error

    with connect() as connection:
        locked = connection.execute(
            "SELECT pg_try_advisory_xact_lock(hashtextextended(%s, 0))",
            (f"conversation:{conversation_id}",),
        ).fetchone()[0]
        if not locked:
            raise HTTPException(status_code=409, detail="La conversazione è già impegnata da un'altra richiesta")
        row = connection.execute(
            'SELECT "state" FROM "Conversation" WHERE "id" = %s AND "userId" = %s',
            (conversation_id, user_id),
        ).fetchone()
        if not row:
            connection.execute(
                'INSERT INTO "Conversation" ("id", "userId", "state", "createdAt", "updatedAt") '
                'VALUES (%s, %s, %s, NOW(), NOW())',
                (conversation_id, user_id, Jsonb({"phase": "collecting", "requirements": {}})),
            )
            state = {"phase": "collecting", "requirements": {}}
        else:
            state = row[0] or {"phase": "collecting", "requirements": {}}
        requirements = state.get("requirements", {})
        connection.execute(
            'INSERT INTO "Message" ("id", "conversationId", "role", "content", "createdAt") '
            'VALUES (%s, %s, %s, %s, NOW())',
            (str(uuid4()), conversation_id, "user", message),
        )
        history_rows = connection.execute(
            'SELECT "role", "content" FROM "Message" WHERE "conversationId" = %s '
            'ORDER BY "createdAt" DESC LIMIT 12',
            (conversation_id,),
        ).fetchall()
        history = [{"role": row[0], "content": row[1]} for row in reversed(history_rows)]
        image_rows = connection.execute(
            'SELECT "description", "tags" FROM "PreferenceImage" '
            'WHERE "conversationId" = %s AND "userId" = %s AND "analysisStatus" = \'completed\' '
            'ORDER BY "createdAt" DESC LIMIT 5',
            (conversation_id, user_id),
        ).fetchall()
        image_context_parts = []
        for description, tags in image_rows:
            image_context_parts.extend([str(description or ""), *[str(tag) for tag in (tags or [])]])
        image_context = " ".join(image_context_parts)
        if state.get("phase") == "confirming" and _rejection(message):
            state["phase"] = "collecting"
            response = {
                "reply": "Va bene, cosa vuoi modificare: destinazione, budget, date, durata, partecipanti o preferenze?",
                "phase": state["phase"], "requirements": requirements,
                "missing": missing_fields(requirements), "issues": validate_consistency(requirements),
            }
        elif state.get("phase") == "confirming" and _confirmation(message) and is_complete(requirements):
            reply = "Perfetto: i requisiti sono confermati. Avvio la generazione dell’itinerario."
            state["phase"] = "confirmed"
            response = {
                "reply": reply, "phase": state["phase"], "requirements": requirements,
                "generationReady": True,
                "nextAction": {"type": "start_itinerary_generation", "method": "POST", "path": "/api/itinerary-jobs", "conversationId": conversation_id, "requiresIdempotencyKey": True},
            }
        else:
            extraction_text = f"{message} {image_context}".strip()
            requirements = _extract_requirements(extraction_text, requirements)
            requirements = _apply_catalog_locations(connection, extraction_text, requirements)
            if _unknown_destination_requested(message, requirements):
                state["requirements"] = requirements
                state["phase"] = "collecting"
                response = {
                    "reply": "Non riconosco la destinazione indicata nel catalogo locale. Indica una destinazione supportata, ad esempio Madrid, Barcellona, Valencia, Lisbona, Parigi o Nizza.",
                    "phase": state["phase"],
                    "requirements": requirements,
                    "missing": missing_fields(requirements),
                    "issues": [],
                }
                connection.execute(
                    'INSERT INTO "Message" ("id", "conversationId", "role", "content", "createdAt") VALUES (%s, %s, %s, %s, NOW())',
                    (str(uuid4()), conversation_id, "assistant", response["reply"]),
                )
                connection.execute(
                    'UPDATE "Conversation" SET "state" = %s, "updatedAt" = NOW() WHERE "id" = %s',
                    (Jsonb(state), conversation_id),
                )
                connection.commit()
                return response
            llm_fields, llm_reply = await enrich_requirements(
                history, requirements,
            )
            # Deterministic values win over model suggestions when the user
            # explicitly supplied them in this turn.
            requirements = _merge_advisory_requirements(message, requirements, llm_fields)
            state["requirements"] = requirements
            missing = missing_fields(requirements)
            issues = validate_consistency(requirements)
            if issues:
                state["phase"] = "collecting"
                reply = " ".join(issues)
            elif missing:
                state["phase"] = "collecting"
                labels = ", ".join(FIELD_LABELS[field] for field in missing)
                reply = llm_reply or f"Mi mancano ancora {labels}. Puoi indicarmeli?"
            else:
                state["phase"] = "confirming"
                reply = _summary(requirements)
            response = {"reply": reply, "phase": state["phase"], "requirements": requirements, "missing": missing, "issues": issues}
        connection.execute(
            'INSERT INTO "Message" ("id", "conversationId", "role", "content", "createdAt") VALUES (%s, %s, %s, %s, NOW())',
            (str(uuid4()), conversation_id, "assistant", response["reply"]),
        )
        connection.execute(
            'UPDATE "Conversation" SET "state" = %s, "updatedAt" = NOW() WHERE "id" = %s',
            (Jsonb(state), conversation_id),
        )
        connection.commit()
    return response


@router.get("/conversations")
def list_conversations(
    user_id: UserId,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, alias="pageSize", ge=1, le=50),
) -> dict:
    with connect() as connection:
        total = connection.execute(
            'SELECT COUNT(*) FROM "Conversation" c WHERE c."userId" = %s '
            'AND EXISTS (SELECT 1 FROM "Message" m WHERE m."conversationId" = c."id")',
            (user_id,),
        ).fetchone()[0]
        offset = (page - 1) * page_size
        rows = connection.execute(
            'SELECT c."id", c."state", c."createdAt", c."updatedAt", '
            '(SELECT COUNT(*) FROM "Message" m WHERE m."conversationId" = c."id") AS message_count, '
            '(SELECT COUNT(*) FROM "Itinerary" i WHERE i."conversationId" = c."id") AS itinerary_count, '
            '(SELECT COUNT(*) FROM "PreferenceImage" p WHERE p."conversationId" = c."id") AS image_count, '
            '(SELECT json_build_object(\'id\', i."id", \'status\', i."status", \'totalCost\', i."totalCost") '
            ' FROM "Itinerary" i WHERE i."conversationId" = c."id" ORDER BY i."createdAt" DESC LIMIT 1) AS latest_itinerary, '
            '(SELECT json_build_object(\'role\', m."role", \'content\', m."content", \'createdAt\', m."createdAt") '
            ' FROM "Message" m WHERE m."conversationId" = c."id" ORDER BY m."createdAt" DESC LIMIT 1) AS last_message '
            'FROM "Conversation" c WHERE c."userId" = %s '
            'AND EXISTS (SELECT 1 FROM "Message" m WHERE m."conversationId" = c."id") '
            'ORDER BY c."updatedAt" DESC, c."id" DESC LIMIT %s OFFSET %s',
            (user_id, page_size, offset),
        ).fetchall()
    total_pages = (total + page_size - 1) // page_size
    return {
        "items": [
            {
                "id": row[0], "status": (row[1] or {}).get("phase", "collecting"),
                "requirements": (row[1] or {}).get("requirements", {}),
                "createdAt": row[2], "updatedAt": row[3],
                "messageCount": row[4], "itineraryCount": row[5], "preferenceImageCount": row[6],
                "latestItinerary": row[7], "lastMessage": row[8],
            }
            for row in rows
        ],
        "pagination": {
            "page": page, "pageSize": page_size, "totalItems": total,
            "totalPages": total_pages, "hasPreviousPage": page > 1,
            "hasNextPage": page < total_pages,
        },
    }


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: str, user_id: UserId) -> dict:
    try:
        UUID(conversation_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Conversazione non trovata") from error
    with connect() as connection:
        conversation = connection.execute(
            'SELECT "id", "state", "createdAt", "updatedAt" FROM "Conversation" '
            'WHERE "id" = %s AND "userId" = %s', (conversation_id, user_id),
        ).fetchone()
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversazione non trovata")
        messages = connection.execute(
            'SELECT "id", "role", "content", "createdAt" FROM "Message" '
            'WHERE "conversationId" = %s ORDER BY "createdAt" ASC', (conversation_id,),
        ).fetchall()
        images = connection.execute(
            'SELECT "id", "conversationId", "originalName", "mimeType", "sizeBytes", "analysisStatus", "description", "tags", "createdAt" FROM "PreferenceImage" WHERE "conversationId" = %s AND "userId" = %s ORDER BY "createdAt" ASC',
            (conversation_id, user_id),
        ).fetchall()
        itineraries = connection.execute(
            'SELECT "id", "status", "details", "totalCost", "flightCost", "hotelCost", "activityCost", "compromises", "createdAt" FROM "Itinerary" WHERE "conversationId" = %s AND "userId" = %s ORDER BY "createdAt" DESC',
            (conversation_id, user_id),
        ).fetchall()
    return {
        "id": conversation[0], "state": conversation[1],
        "createdAt": conversation[2], "updatedAt": conversation[3],
        "messages": [
            {"id": row[0], "role": row[1], "content": row[2], "createdAt": row[3]}
            for row in messages
        ],
        "preferenceImages": [
            {"id": row[0], "conversationId": row[1], "originalName": row[2], "mimeType": row[3], "sizeBytes": row[4], "analysisStatus": row[5], "description": row[6], "tags": row[7], "createdAt": row[8]}
            for row in images
        ],
        "itineraries": [
            {"id": row[0], "status": row[1], "details": row[2], "totalCost": row[3], "flightCost": row[4], "hotelCost": row[5], "activityCost": row[6], "compromises": row[7], "createdAt": row[8]}
            for row in itineraries
        ],
    }


@router.delete("/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_conversation(conversation_id: str, user_id: UserId) -> Response:
    with connect() as connection:
        if not conversation_exists(connection, conversation_id, user_id):
            raise HTTPException(status_code=404, detail="Conversazione non trovata")
        connection.execute('DELETE FROM "Message" WHERE "conversationId" = %s', (conversation_id,))
        connection.execute('DELETE FROM "ItineraryGenerationJob" WHERE "conversationId" = %s AND "userId" = %s', (conversation_id, user_id))
        image_rows = connection.execute('SELECT "storageKey" FROM "PreferenceImage" WHERE "conversationId" = %s AND "userId" = %s', (conversation_id, user_id)).fetchall()
        connection.execute('DELETE FROM "PreferenceImage" WHERE "conversationId" = %s AND "userId" = %s', (conversation_id, user_id))
        connection.execute('UPDATE "Itinerary" SET "conversationId" = NULL WHERE "conversationId" = %s AND "userId" = %s', (conversation_id, user_id))
        connection.execute('DELETE FROM "Conversation" WHERE "id" = %s AND "userId" = %s', (conversation_id, user_id))
        connection.commit()
    image_dir = Path(get_settings().preference_image_dir)
    for (storage_key,) in image_rows:
        (image_dir / storage_key).unlink(missing_ok=True)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
