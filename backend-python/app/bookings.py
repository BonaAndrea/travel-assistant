from datetime import date, datetime
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from .database import connect
from .security import current_user_id


router = APIRouter(prefix="/bookings", tags=["bookings"])
UserId = Annotated[str, Depends(current_user_id)]


class BookingRequest(BaseModel):
    itineraryId: str
    idempotencyKey: str = Field(min_length=8, max_length=128)


class CancelRequest(BaseModel):
    reason: str | None = None


class ModifyRequest(BaseModel):
    newItineraryId: str


def _parse_day(value: object) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _date_range(details: dict) -> tuple[date, date] | None:
    dates = []
    flights = details.get("flights", {})
    for flight in (flights.get("outbound"), flights.get("inbound")):
        parsed = _parse_day((flight or {}).get("date"))
        if parsed:
            dates.append(parsed)
    dates.extend(filter(None, (_parse_day(item) for item in (details.get("hotel") or {}).get("nights", []))))
    dates.extend(filter(None, (_parse_day(item.get("date")) for item in details.get("activities", []))))
    return (min(dates), max(dates)) if dates else None


def _assert_snapshot(details: dict) -> None:
    flights = details.get("flights", {})
    hotel = details.get("hotel", {})
    if not flights.get("outbound", {}).get("id") or not flights.get("inbound", {}).get("id") or not hotel.get("id") or not hotel.get("nights"):
        raise HTTPException(status_code=400, detail="Snapshot itinerario non valido")


def _price_changed(expected: object, actual: object) -> bool:
    try:
        return abs(float(expected) - float(actual)) > 0.0001
    except (TypeError, ValueError):
        return True


def _assert_current_prices(connection: object, details: dict) -> None:
    participants = max(1, int(details.get("participants", 1)))
    for flight in ((details.get("flights") or {}).get("outbound"), (details.get("flights") or {}).get("inbound")):
        row = connection.execute('SELECT "cost" FROM "Flight" WHERE "id" = %s', (flight.get("id"),)).fetchone()
        if not row or _price_changed(float(flight.get("cost", 0)) / participants, row[0]):
            raise HTTPException(status_code=409, detail="Il prezzo del volo è cambiato, aggiorna l’itinerario")
    hotel = details.get("hotel") or {}
    prices = hotel.get("prices") or {}
    for night in hotel.get("nights", []):
        row = connection.execute('SELECT "pricePerNight" FROM "HotelAvailability" WHERE "hotelId" = %s AND "date" = %s', (hotel.get("id"), night)).fetchone()
        expected = prices.get(str(night), prices.get(str(night)[:10], hotel.get("pricePerNight")))
        if not row or _price_changed(expected, row[0]):
            raise HTTPException(status_code=409, detail="Il prezzo dell’hotel è cambiato, aggiorna l’itinerario")
    for activity in details.get("activities", []):
        row = connection.execute('SELECT "cost" FROM "ActivityAvailability" WHERE "id" = %s', (activity.get("availabilityId"),)).fetchone()
        if not row or _price_changed(float(activity.get("cost", 0)) / participants, row[0]):
            raise HTTPException(status_code=409, detail="Il prezzo di un’attività è cambiato, aggiorna l’itinerario")


def _booking_json(row: tuple) -> dict:
    return {"id": row[0], "userId": row[1], "itineraryId": row[2], "status": row[3], "idempotencyKey": row[4], "failureReason": row[5], "cancelledAt": row[6], "cancellationReason": row[7], "createdAt": row[8]}


@router.post("", status_code=status.HTTP_201_CREATED)
def confirm_booking(payload: BookingRequest, user_id: UserId) -> dict:
    try:
        with connect() as connection:
            existing = connection.execute(
                'SELECT "id", "userId", "itineraryId", "status", "idempotencyKey", "failureReason", "cancelledAt", "cancellationReason", "createdAt" FROM "Booking" WHERE "idempotencyKey" = %s',
                (payload.idempotencyKey,),
            ).fetchone()
            if existing:
                if existing[1] != user_id or existing[2] != payload.itineraryId:
                    raise HTTPException(status_code=409, detail="Chiave di idempotenza già utilizzata per un’altra richiesta")
                return {"booking": _booking_json(existing), "alreadyProcessed": True}
            itinerary = connection.execute(
                'SELECT "id", "userId", "status", "details" FROM "Itinerary" WHERE "id" = %s AND "userId" = %s',
                (payload.itineraryId, user_id),
            ).fetchone()
            if not itinerary:
                raise HTTPException(status_code=404, detail="Itinerario non trovato")
            if itinerary[2] != "draft":
                raise HTTPException(status_code=409, detail="Itinerario già prenotato o non disponibile")
            details = itinerary[3] or {}
            _assert_snapshot(details)
            _assert_current_prices(connection, details)
            candidate = _date_range(details)
            connection.execute("SELECT pg_advisory_xact_lock(748291)")
            confirmed = connection.execute(
                'SELECT i."details" FROM "Booking" b JOIN "Itinerary" i ON i."id" = b."itineraryId" WHERE b."userId" = %s AND b."status" = \'confirmed\'',
                (user_id,),
            ).fetchall()
            if candidate and any((_date_range(row[0] or {}) and candidate[0] <= _date_range(row[0] or {})[1] and _date_range(row[0] or {})[0] <= candidate[1]) for row in confirmed):
                raise HTTPException(status_code=409, detail="Le date dell’itinerario si sovrappongono a una prenotazione già confermata")
            flights = details["flights"]
            for flight in (flights["outbound"], flights["inbound"]):
                row = connection.execute('UPDATE "Flight" SET "seatsAvailable" = "seatsAvailable" - %s WHERE "id" = %s AND "seatsAvailable" >= %s', (details.get("participants", 1), flight["id"], details.get("participants", 1)))
                if row.rowcount != 1:
                    raise HTTPException(status_code=409, detail="Posti volo non più disponibili al momento della conferma")
            for night in details["hotel"]["nights"]:
                row = connection.execute('UPDATE "HotelAvailability" SET "roomsAvailable" = "roomsAvailable" - 1 WHERE "hotelId" = %s AND "date" = %s AND "roomsAvailable" >= 1', (details["hotel"]["id"], night))
                if row.rowcount != 1:
                    raise HTTPException(status_code=409, detail=f"Camera non più disponibile per la notte del {night}")
            for activity in details.get("activities", []):
                row = connection.execute('UPDATE "ActivityAvailability" SET "booked" = "booked" + %s WHERE "id" = %s AND "booked" + %s <= "capacity"', (details.get("participants", 1), activity.get("availabilityId"), details.get("participants", 1)))
                if row.rowcount != 1:
                    raise HTTPException(status_code=409, detail=f"Capacità non più disponibile per l’attività {activity.get('name', '')}")
            claimed = connection.execute('UPDATE "Itinerary" SET "status" = \'confirmed\' WHERE "id" = %s AND "userId" = %s AND "status" = \'draft\'', (payload.itineraryId, user_id))
            if claimed.rowcount != 1:
                raise HTTPException(status_code=409, detail="Itinerario già prenotato")
            booking_id = str(uuid4())
            booking = connection.execute('INSERT INTO "Booking" ("id", "userId", "itineraryId", "status", "idempotencyKey", "createdAt") VALUES (%s, %s, %s, \'confirmed\', %s, NOW()) RETURNING "id", "userId", "itineraryId", "status", "idempotencyKey", "failureReason", "cancelledAt", "cancellationReason", "createdAt"', (booking_id, user_id, payload.itineraryId, payload.idempotencyKey)).fetchone()
            connection.commit()
            return {"booking": _booking_json(booking), "alreadyProcessed": False}
    except HTTPException as error:
        # The connection context rolled the transaction back. Preserve the
        # original business error; no partial reservation survives.
        raise error


@router.delete("/{booking_id}")
def cancel_booking(booking_id: str, user_id: UserId, payload: CancelRequest | None = None) -> dict:
    reason = (payload.reason if payload else None) or "Cancellata dall'utente"
    with connect() as connection:
        booking = connection.execute(
            'SELECT b."id", b."itineraryId", b."status", i."details" FROM "Booking" b JOIN "Itinerary" i ON i."id" = b."itineraryId" WHERE b."id" = %s AND b."userId" = %s',
            (booking_id, user_id),
        ).fetchone()
        if not booking:
            raise HTTPException(status_code=404, detail="Prenotazione non trovata")
        if booking[2] != "confirmed":
            raise HTTPException(status_code=409, detail="È possibile cancellare solo una prenotazione confermata")
        details = booking[3] or {}
        connection.execute("SELECT pg_advisory_xact_lock(748291)")
        updated = connection.execute('UPDATE "Booking" SET "status" = \'cancelled\', "cancelledAt" = NOW(), "cancellationReason" = %s WHERE "id" = %s AND "userId" = %s AND "status" = \'confirmed\'', (reason, booking_id, user_id))
        if updated.rowcount != 1:
            raise HTTPException(status_code=409, detail="La prenotazione è stata modificata da un'altra operazione")
        participants = details.get("participants", 1)
        for flight in ((details.get("flights") or {}).get("outbound"), (details.get("flights") or {}).get("inbound")):
            if flight:
                connection.execute('UPDATE "Flight" SET "seatsAvailable" = "seatsAvailable" + %s WHERE "id" = %s', (participants, flight["id"]))
        for night in (details.get("hotel") or {}).get("nights", []):
            connection.execute('UPDATE "HotelAvailability" SET "roomsAvailable" = "roomsAvailable" + 1 WHERE "hotelId" = %s AND "date" = %s', (details["hotel"]["id"], night))
        for activity in details.get("activities", []):
            connection.execute('UPDATE "ActivityAvailability" SET "booked" = "booked" - %s WHERE "id" = %s AND "booked" >= %s', (participants, activity.get("availabilityId"), participants))
        connection.execute('UPDATE "Itinerary" SET "status" = \'cancelled\' WHERE "id" = %s', (booking[1],))
        row = connection.execute('SELECT "id", "userId", "itineraryId", "status", "idempotencyKey", "failureReason", "cancelledAt", "cancellationReason", "createdAt" FROM "Booking" WHERE "id" = %s', (booking_id,)).fetchone()
        connection.commit()
    return {"booking": _booking_json(row)}


@router.patch("/{booking_id}")
def modify_booking(booking_id: str, payload: ModifyRequest, user_id: UserId) -> dict:
    with connect() as connection:
        current = connection.execute(
            'SELECT b."id", b."itineraryId", b."status", old."details" FROM "Booking" b '
            'JOIN "Itinerary" old ON old."id" = b."itineraryId" '
            'WHERE b."id" = %s AND b."userId" = %s', (booking_id, user_id),
        ).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="Prenotazione non trovata")
        if current[2] != "confirmed":
            raise HTTPException(status_code=409, detail="È possibile modificare solo una prenotazione confermata")
        if current[1] == payload.newItineraryId:
            raise HTTPException(status_code=400, detail="Il nuovo itinerario deve essere diverso da quello attuale")
        target = connection.execute(
            'SELECT "id", "status", "details" FROM "Itinerary" WHERE "id" = %s AND "userId" = %s',
            (payload.newItineraryId, user_id),
        ).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="Nuovo itinerario non trovato")
        if target[1] != "draft":
            raise HTTPException(status_code=409, detail="Il nuovo itinerario deve essere in stato draft")
        old_details, new_details = current[3] or {}, target[2] or {}
        _assert_snapshot(new_details)
        _assert_current_prices(connection, new_details)
        old_range, new_range = _date_range(old_details), _date_range(new_details)
        connection.execute("SELECT pg_advisory_xact_lock(748291)")
        confirmed = connection.execute(
            'SELECT i."details" FROM "Booking" b JOIN "Itinerary" i ON i."id" = b."itineraryId" WHERE b."userId" = %s AND b."status" = \'confirmed\' AND b."id" <> %s',
            (user_id, booking_id),
        ).fetchall()
        if new_range and any((_date_range(row[0] or {}) and new_range[0] <= _date_range(row[0] or {})[1] and _date_range(row[0] or {})[0] <= new_range[1]) for row in confirmed):
            raise HTTPException(status_code=409, detail="Le date del nuovo itinerario si sovrappongono a una prenotazione già confermata")
        participants = new_details.get("participants", 1)
        flights = new_details["flights"]
        for flight in (flights["outbound"], flights["inbound"]):
            row = connection.execute('UPDATE "Flight" SET "seatsAvailable" = "seatsAvailable" - %s WHERE "id" = %s AND "seatsAvailable" >= %s', (participants, flight["id"], participants))
            if row.rowcount != 1:
                raise HTTPException(status_code=409, detail="Posti volo non più disponibili per il nuovo itinerario")
        for night in new_details["hotel"]["nights"]:
            row = connection.execute('UPDATE "HotelAvailability" SET "roomsAvailable" = "roomsAvailable" - 1 WHERE "hotelId" = %s AND "date" = %s AND "roomsAvailable" >= 1', (new_details["hotel"]["id"], night))
            if row.rowcount != 1:
                raise HTTPException(status_code=409, detail=f"Camera non più disponibile per la notte del {night}")
        for activity in new_details.get("activities", []):
            row = connection.execute('UPDATE "ActivityAvailability" SET "booked" = "booked" + %s WHERE "id" = %s AND "booked" + %s <= "capacity"', (participants, activity.get("availabilityId"), participants))
            if row.rowcount != 1:
                raise HTTPException(status_code=409, detail=f"Capacità non più disponibile per l’attività {activity.get('name', '')}")
        old_participants = old_details.get("participants", 1)
        for flight in ((old_details.get("flights") or {}).get("outbound"), (old_details.get("flights") or {}).get("inbound")):
            if flight:
                connection.execute('UPDATE "Flight" SET "seatsAvailable" = "seatsAvailable" + %s WHERE "id" = %s', (old_participants, flight["id"]))
        for night in (old_details.get("hotel") or {}).get("nights", []):
            connection.execute('UPDATE "HotelAvailability" SET "roomsAvailable" = "roomsAvailable" + 1 WHERE "hotelId" = %s AND "date" = %s', (old_details["hotel"]["id"], night))
        for activity in old_details.get("activities", []):
            connection.execute('UPDATE "ActivityAvailability" SET "booked" = "booked" - %s WHERE "id" = %s AND "booked" >= %s', (old_participants, activity.get("availabilityId"), old_participants))
        connection.execute('UPDATE "Booking" SET "itineraryId" = %s WHERE "id" = %s AND "userId" = %s AND "status" = \'confirmed\'', (payload.newItineraryId, booking_id, user_id))
        connection.execute('UPDATE "Itinerary" SET "status" = \'cancelled\' WHERE "id" = %s', (current[1],))
        connection.execute('UPDATE "Itinerary" SET "status" = \'confirmed\' WHERE "id" = %s AND "status" = \'draft\'', (payload.newItineraryId,))
        row = connection.execute('SELECT "id", "userId", "itineraryId", "status", "idempotencyKey", "failureReason", "cancelledAt", "cancellationReason", "createdAt" FROM "Booking" WHERE "id" = %s', (booking_id,)).fetchone()
        connection.commit()
    return {"booking": _booking_json(row)}


@router.get("")
def list_bookings(user_id: UserId) -> list[dict]:
    with connect() as connection:
        rows = connection.execute(
            'SELECT b."id", b."userId", b."itineraryId", b."status", b."idempotencyKey", '
            'b."failureReason", b."cancelledAt", b."cancellationReason", b."createdAt", '
            'i."details", i."totalCost" FROM "Booking" b '
            'JOIN "Itinerary" i ON i."id" = b."itineraryId" '
            'WHERE b."userId" = %s ORDER BY b."createdAt" DESC', (user_id,),
        ).fetchall()
    return [
        {
            "id": row[0], "userId": row[1], "itineraryId": row[2], "status": row[3],
            "idempotencyKey": row[4], "failureReason": row[5], "cancelledAt": row[6],
            "cancellationReason": row[7], "createdAt": row[8],
            "itinerary": {"details": row[9], "totalCost": row[10]},
        }
        for row in rows
    ]
