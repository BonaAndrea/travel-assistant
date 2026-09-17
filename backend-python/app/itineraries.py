from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from psycopg.types.json import Jsonb

from .database import connect
from .security import current_user_id


router = APIRouter(prefix="/itineraries", tags=["itineraries"])
UserId = Annotated[str, Depends(current_user_id)]


class ItineraryChoice(BaseModel):
    conversationId: UUID
    choice: str = Field(pattern="^(primary|alternative)$")


def serialize(row: tuple) -> dict:
    return {
        "id": row[0], "userId": row[1], "conversationId": row[2], "status": row[3],
        "details": row[4], "totalCost": row[5], "flightCost": row[6],
        "hotelCost": row[7], "activityCost": row[8], "compromises": row[9],
        "createdAt": row[10],
    }


@router.post("", status_code=status.HTTP_201_CREATED)
def save_itinerary(payload: ItineraryChoice, user_id: UserId) -> dict:
    with connect() as connection:
        conversation = connection.execute(
            'SELECT "state" FROM "Conversation" WHERE "id" = %s AND "userId" = %s',
            (str(payload.conversationId), user_id),
        ).fetchone()
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversazione non trovata")
        state = conversation[0] or {}
        result = state.get("lastResult", {}) if isinstance(state, dict) else {}
        option = result.get(payload.choice) if isinstance(result, dict) else None
        if not option or option.get("status") != "ok":
            raise HTTPException(status_code=400, detail="Nessuna opzione valida da salvare per questa scelta")
        breakdown = option.get("breakdown", {})
        requirements = result.get("requirementsSnapshot", {})
        hotel_option = option.get("hotel") or {}
        hotel_info = hotel_option.get("hotel") or hotel_option
        details = {
            "flights": option.get("flights", []),
            "destinationMedia": option.get("destinationMedia"),
            "hotel": {
                "id": hotel_info.get("id"),
                "name": hotel_info.get("name"),
                "nights": hotel_option.get("nights", []),
                "prices": hotel_option.get("prices", {}),
                "pricePerNight": hotel_option.get("pricePerNight"),
            },
            "activities": option.get("activities", []),
            "participants": requirements.get("participants"),
            "requirementsSnapshot": requirements,
        }
        itinerary_id = str(uuid4())
        row = connection.execute(
            'INSERT INTO "Itinerary" ("id", "userId", "conversationId", "status", "details", '
            '"totalCost", "flightCost", "hotelCost", "activityCost", "compromises", "createdAt") '
            'VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW()) '
            'RETURNING "id", "userId", "conversationId", "status", "details", "totalCost", '
            '"flightCost", "hotelCost", "activityCost", "compromises", "createdAt"',
            (itinerary_id, user_id, str(payload.conversationId), "draft", Jsonb(details),
             option.get("totalCost", 0), breakdown.get("flightCost", 0),
             breakdown.get("hotelCost", 0), breakdown.get("activityCost", 0),
             Jsonb(option.get("compromises", []))),
        ).fetchone()
        connection.commit()
    return serialize(row)


@router.get("/{itinerary_id}")
def get_itinerary(itinerary_id: UUID, user_id: UserId) -> dict:
    with connect() as connection:
        row = connection.execute(
            'SELECT "id", "userId", "conversationId", "status", "details", "totalCost", '
            '"flightCost", "hotelCost", "activityCost", "compromises", "createdAt" '
            'FROM "Itinerary" WHERE "id" = %s AND "userId" = %s',
            (str(itinerary_id), user_id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Itinerario non trovato")
    return serialize(row)
