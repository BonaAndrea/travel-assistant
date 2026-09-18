from hashlib import sha256
import secrets
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status

from .database import connect
from .security import current_user_id


router = APIRouter(prefix="/share", tags=["sharing"])
UserId = Annotated[str, Depends(current_user_id)]


def hash_token(token: str) -> str:
    return sha256(token.encode()).hexdigest()


@router.post("/itineraries/{itinerary_id}", status_code=status.HTTP_201_CREATED)
def create_share_link(itinerary_id: UUID, user_id: UserId) -> dict[str, str]:
    token = secrets.token_urlsafe(32)
    with connect() as connection:
        exists = connection.execute(
            'SELECT 1 FROM "Itinerary" WHERE "id" = %s AND "userId" = %s',
            (str(itinerary_id), user_id),
        ).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="Itinerario non trovato")
        connection.execute(
            'INSERT INTO "ShareLink" ("id", "tokenHash", "userId", "itineraryId", "createdAt") '
            'VALUES (%s, %s, %s, %s, NOW())',
            (str(uuid4()), hash_token(token), user_id, str(itinerary_id)),
        )
        connection.commit()
    return {"token": token, "itineraryId": str(itinerary_id)}


@router.get("/public/{token}")
def get_shared_itinerary(token: str) -> dict:
    with connect() as connection:
        row = connection.execute(
            'SELECT i."id", i."status", i."details", i."totalCost", i."flightCost", '
            'i."hotelCost", i."activityCost", i."compromises", i."createdAt" '
            'FROM "ShareLink" s JOIN "Itinerary" i ON i."id" = s."itineraryId" '
            'WHERE s."tokenHash" = %s AND s."revokedAt" IS NULL',
            (hash_token(token),),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Link non trovato")
    return {
        "id": row[0], "status": row[1], "details": row[2], "totalCost": row[3],
        "flightCost": row[4], "hotelCost": row[5], "activityCost": row[6],
        "compromises": row[7], "createdAt": row[8],
    }

