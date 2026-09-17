from datetime import date, datetime, timedelta
from typing import Any, Callable

from psycopg.types.json import Jsonb

from .database import connect
from .rag import indexed_relevance, relevance


def _date(value: Any) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def generate(requirements: dict, progress: Callable[[int, str], None] | None = None) -> dict:
    progress = progress or (lambda _value, _label: None)
    participants = int(requirements.get("participants", 1))
    departure = _date(requirements.get("outboundDate"))
    arrival = _date(requirements.get("returnDate"))
    duration = int(requirements.get("durationDays", 0) or 0)
    if departure and arrival and arrival <= departure:
        return {"error": "Date di viaggio incomplete o non valide.", "errorCode": "invalid_dates"}
    month_start = month_end = None
    if not departure or not arrival:
        month = str(requirements.get("travelMonth", "")).lower()
        month_index = {name: index for index, name in enumerate(("gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"))}.get(month)
        if month_index is None or duration < 2:
            return {"error": "Indica date oppure mese e durata del viaggio.", "errorCode": "invalid_dates"}
        year = datetime.utcnow().year
        if month_index < datetime.utcnow().month - 1:
            year += 1
        month_start = date(year, month_index + 1, 1)
        month_end = date(year + 1, 1, 1) if month_index == 11 else date(year, month_index + 2, 1)
    nights = (arrival - departure).days if departure and arrival else duration - 1
    origin = str(requirements.get("departureAirport", "")).upper()
    destination = str(requirements.get("destinationCity") or requirements.get("country", ""))
    preferences = [str(item).lower() for item in requirements.get("activityPreferences", [])]

    with connect() as connection:
        progress(10, "Ricerca voli")
        outbound = connection.execute(
            'SELECT f."id", f."date", f."cost", oa."iataCode", oa."city", '
            'da."id", da."iataCode", da."city", da."destinationId" '
            'FROM "Flight" f JOIN "Airport" oa ON oa."id" = f."originAirportId" '
            'JOIN "Airport" da ON da."id" = f."destinationAirportId" '
            'JOIN "Destination" d ON d."id" = da."destinationId" '
            'WHERE f."direction" = \'outbound\' AND oa."iataCode" = %s '
            'AND (LOWER(da."city") = LOWER(%s) OR LOWER(d."country") = LOWER(%s)) '
            'AND f."date" >= %s AND f."date" < %s AND f."seatsAvailable" >= %s '
            'ORDER BY f."cost" ASC LIMIT 1',
            (origin, destination, destination, departure or month_start, (arrival + timedelta(days=1)) if arrival else month_end, participants),
        ).fetchone()
        if not outbound:
            return {"error": "Non sono disponibili voli di andata compatibili.", "errorCode": "no_outbound"}
        departure = outbound[1].date() if hasattr(outbound[1], "date") else outbound[1]
        expected_return = arrival or (departure + timedelta(days=nights))
        arrival = expected_return
        inbound = connection.execute(
            'SELECT f."id", f."date", f."cost", oa."iataCode", oa."city", '
            'da."iataCode", da."city" FROM "Flight" f '
            'JOIN "Airport" oa ON oa."id" = f."originAirportId" '
            'JOIN "Airport" da ON da."id" = f."destinationAirportId" '
            'WHERE f."direction" = \'return\' AND oa."id" = %s AND da."iataCode" = %s '
            'AND f."date" >= %s AND f."date" < %s AND f."seatsAvailable" >= %s '
            'ORDER BY f."cost" ASC LIMIT 1',
            (outbound[5], origin, expected_return, expected_return + timedelta(days=1), participants),
        ).fetchone()
        if not inbound:
            return {"error": "Non è disponibile un volo di ritorno nella data richiesta.", "errorCode": "no_return"}

        progress(35, "Ricerca hotel")
        hotel = connection.execute(
            'SELECT h."id", h."name", h."city" FROM "Hotel" h '
            'JOIN "Destination" d ON d."id" = h."destinationId" '
            'WHERE LOWER(h."city") = LOWER(%s) OR LOWER(d."country") = LOWER(%s) '
            'ORDER BY h."name" LIMIT 1', (destination, destination),
        ).fetchone()
        if not hotel:
            return {"error": "Non sono disponibili hotel nella destinazione richiesta.", "errorCode": "no_hotel"}
        rooms = connection.execute(
            'SELECT "date", "pricePerNight", "roomsAvailable" FROM "HotelAvailability" '
            'WHERE "hotelId" = %s AND "date" >= %s AND "date" < %s AND "roomsAvailable" >= 1 '
            'ORDER BY "date"', (hotel[0], departure, arrival),
        ).fetchall()
        if len(rooms) != nights:
            return {"error": "Non ci sono camere disponibili per tutte le notti richieste.", "errorCode": "no_hotel_availability"}

        progress(60, "Ricerca attività")
        activities = []
        retrieval_query = " ".join(preferences)
        for offset in range(nights):
            day = departure + timedelta(days=offset)
            preference_clause = " OR ".join(["LOWER(a.\"category\") = %s"] * len(preferences)) or "TRUE"
            params = [hotel[0], *preferences, day, day + timedelta(days=1)]
            activity_rows = connection.execute(
                f'SELECT s."id", s."activityId", a."name", a."category", s."date", s."cost" FROM "ActivityAvailability" s '
                f'JOIN "Activity" a ON a."id" = s."activityId" WHERE a."destinationId" = '
                f'(SELECT "destinationId" FROM "Hotel" WHERE "id" = %s) AND ({preference_clause}) '
                'AND s."date" >= %s AND s."date" < %s AND s."capacity" > s."booked" '
                'ORDER BY s."cost" LIMIT 30', params,
            ).fetchall()
            if not activity_rows:
                return {"error": f"Non ci sono attività disponibili per il giorno {day.isoformat()}.", "errorCode": "activity_coverage_incomplete"}
            scored = []
            for candidate in activity_rows:
                score = indexed_relevance(candidate[1], retrieval_query)
                if score is None:
                    score = relevance(retrieval_query, category=candidate[3], name=candidate[2])
                scored.append((score, float(candidate[5]), candidate))
            activity = max(scored, key=lambda item: (item[0], -item[1]))[2]
            activities.append({"availabilityId": activity[0], "activityId": activity[1], "name": activity[2], "category": activity[3], "date": activity[4].isoformat(), "cost": activity[5] * participants})

        progress(90, "Salvataggio proposta")
        flight_cost = (outbound[2] + inbound[2]) * participants
        hotel_cost = sum(room[1] for room in rooms)
        activity_cost = sum(item["cost"] for item in activities)
        total = flight_cost + hotel_cost + activity_cost
        result = {
            "status": "ok", "requirementsSnapshot": requirements,
            "primary": {
                "status": "ok", "totalCost": total,
                "breakdown": {"flightCost": flight_cost, "hotelCost": hotel_cost, "activityCost": activity_cost},
                "flights": {"outbound": {"id": outbound[0], "direction": "outbound", "date": outbound[1].isoformat(), "cost": outbound[2] * participants, "origin": outbound[3], "destination": outbound[6]},
                            "inbound": {"id": inbound[0], "direction": "return", "date": inbound[1].isoformat(), "cost": inbound[2] * participants, "origin": inbound[3], "destination": inbound[5]}},
                "hotel": {"id": hotel[0], "name": hotel[1], "city": hotel[2], "nights": [room[0].isoformat() for room in rooms],
                          "prices": {room[0].isoformat(): room[1] for room in rooms}, "pricePerNight": rooms[0][1]},
                "activities": activities, "compromises": [],
            },
        }
        budget = requirements.get("budget")
        if budget is not None:
            result["primary"]["withinBudget"] = total <= float(budget)
            result["primary"]["budgetDelta"] = total - float(budget)
        return result


def run_job(job_id: str) -> None:
    with connect() as connection:
        job = connection.execute(
            'SELECT "userId", "conversationId", "result" FROM "ItineraryGenerationJob" WHERE "id" = %s', (job_id,)
        ).fetchone()
        if not job:
            return
        connection.execute('UPDATE "ItineraryGenerationJob" SET "status" = \'running\', "progress" = 10, "progressLabel" = \'Generazione avviata\', "startedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = %s', (job_id,))
        connection.commit()
    try:
        requirements = (job[2] or {}).get("requirementsSnapshot", {})
        result = generate(requirements)
        with connect() as connection:
            if result.get("error"):
                connection.execute(
                    'UPDATE "ItineraryGenerationJob" SET "status" = \'failed\', "progress" = 100, "progressLabel" = \'Generazione non riuscita\', "error" = %s, "result" = %s, "completedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = %s',
                    (result["error"], Jsonb(result), job_id),
                )
            else:
                connection.execute(
                    'UPDATE "ItineraryGenerationJob" SET "status" = \'completed\', "progress" = 100, "progressLabel" = \'Itinerario pronto\', "result" = %s, "completedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = %s',
                    (Jsonb(result), job_id),
                )
                connection.execute(
                    'UPDATE "Conversation" SET "state" = jsonb_set(jsonb_set("state", \'{phase}\', \'"itinerary_proposed"\'), \'{lastResult}\', %s) WHERE "id" = %s AND "userId" = %s',
                    (Jsonb(result), job[1], job[0]),
                )
            connection.commit()
    except Exception as error:
        with connect() as connection:
            connection.execute(
                'UPDATE "ItineraryGenerationJob" SET "status" = \'failed\', "progress" = 100, "progressLabel" = \'Errore durante la generazione\', "error" = %s, "completedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = %s',
                (str(error)[:1000], job_id),
            )
            connection.commit()
