"""Deterministic demo catalog seed, fully implemented in Python.

This command is intentionally destructive for catalog/demo data. It preserves
users and refresh tokens, but removes conversations, bookings, itineraries,
jobs and the catalog before rebuilding them.
"""

from datetime import UTC, datetime, timedelta
import argparse
import json
from pathlib import Path
import tempfile
from uuid import uuid4

from app.database import connect


MONTHS = ("gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre")
DEPARTURE_DAYS = (1, 4, 8, 11, 15, 18, 22, 25)
ORIGINS = [
    ("FCO", "Aeroporto di Roma Fiumicino", "Roma", "IT", 0),
    ("MXP", "Aeroporto di Milano Malpensa", "Milano", "IT", 8),
    ("BLQ", "Aeroporto di Bologna", "Bologna", "IT", 5),
    ("NAP", "Aeroporto di Napoli", "Napoli", "IT", 6),
    ("VCE", "Aeroporto di Venezia Marco Polo", "Venezia", "IT", 7),
    ("TRN", "Aeroporto di Torino Caselle", "Torino", "IT", 6),
    ("BRI", "Aeroporto di Bari Karol Wojtyła", "Bari", "IT", 9),
]
DESTINATIONS = [
    ("Spagna", "ES", "Barcellona", "BCN", 90), ("Spagna", "ES", "Madrid", "MAD", 82),
    ("Spagna", "ES", "Valencia", "VLC", 86), ("Portogallo", "PT", "Lisbona", "LIS", 78),
    ("Portogallo", "PT", "Porto", "OPO", 80), ("Francia", "FR", "Parigi", "CDG", 95),
    ("Francia", "FR", "Nizza", "NCE", 92), ("Grecia", "GR", "Atene", "ATH", 110),
    ("Repubblica Ceca", "CZ", "Praga", "PRG", 88), ("Paesi Bassi", "NL", "Amsterdam", "AMS", 105),
    ("Germania", "DE", "Berlino", "BER", 92), ("Austria", "AT", "Vienna", "VIE", 90),
    ("Ungheria", "HU", "Budapest", "BUD", 84), ("Irlanda", "IE", "Dublino", "DUB", 112),
    ("Danimarca", "DK", "Copenaghen", "CPH", 118), ("Svezia", "SE", "Stoccolma", "STO", 122),
    ("Turchia", "TR", "Istanbul", "IST", 108), ("Croazia", "HR", "Dubrovnik", "DBV", 104),
    ("Polonia", "PL", "Cracovia", "KRK", 86), ("Belgio", "BE", "Bruxelles", "BRU", 98),
]
ACTIVITIES = [
    ("Tour culturale del centro storico", "cultura", "Visita guidata a monumenti e quartieri storici.", "famiglie, appassionati d'arte", 25, 540, 660),
    ("Escursione in bici", "sport", "Giro panoramico in bicicletta, adatto a tutti i livelli.", "sportivi, giovani", 20, 690, 810),
    ("Giornata spa e relax", "relax", "Percorso benessere con sauna, bagno turco e piscina.", "coppie, chi cerca relax", 40, 900, 1020),
    ("Tour della vita notturna", "nightlife", "Serata guidata tra locali e punti panoramici della citta.", "giovani, nightlife", 30, 1200, 1320),
    ("Museo di arte moderna", "cultura", "Visita a una collezione permanente di arte moderna.", "appassionati d'arte, famiglie", 15, 570, 690),
    ("Escursione naturalistica", "sport", "Attivita outdoor in paesaggi naturali vicino alla citta.", "sportivi, avventurosi", 45, 840, 960),
    ("Degustazione gastronomica locale", "gastronomia", "Percorso tra prodotti tipici e cucina locale.", "appassionati di cibo, coppie", 35, 720, 840),
    ("Passeggiata panoramica", "natura", "Passeggiata guidata tra punti panoramici e quartieri caratteristici.", "amanti delle passeggiate, famiglie", 18, 600, 720),
    ("Laboratorio di cucina locale", "gastronomia", "Esperienza pratica per imparare ricette e sapori della tradizione.", "appassionati di cibo, coppie", 42, 780, 900),
    ("Mercati e sapori della città", "gastronomia", "Itinerario tra mercati storici e specialità locali.", "amanti del cibo, curiosi", 22, 630, 750),
]


def month_windows(reference: datetime | None = None) -> list[tuple[int, int, list[datetime], list[datetime]]]:
    reference = reference or datetime.now(UTC)
    first = datetime(reference.year + (reference.month == 12), 1 if reference.month == 12 else reference.month + 1, 1, tzinfo=UTC)
    windows = []
    for offset in range(12):
        month_start = (first.replace(day=1) + timedelta(days=32 * offset)).replace(day=1)
        year, month = month_start.year, month_start.month
        next_month = (month_start + timedelta(days=32)).replace(day=1)
        days = (next_month - month_start).days
        coverage_length = days + (4 if offset == 11 else 0)
        departures = [datetime(year, month, day, 8, tzinfo=UTC) for day in DEPARTURE_DAYS]
        coverage = [datetime(year, month, 1, tzinfo=UTC) + timedelta(days=index) for index in range(coverage_length)]
        windows.append((year, month, departures, coverage))
    return windows


def clear_catalog(connection: object) -> None:
    for table in ("Message", "PreferenceImage", "ShareLink", "Booking", "ItineraryGenerationJob", "Itinerary", "Conversation", "ActivityAvailability", "Activity", "HotelAvailability", "Hotel", "Flight", "Airport", "Destination"):
        connection.execute(f'DELETE FROM "{table}"')


def build_index(connection: object, output: Path) -> int:
    activities = connection.execute('SELECT "id", "name", "category", "city", "country", "description", "target", "destinationId" FROM "Activity"').fetchall()
    hotels = connection.execute('SELECT "id", "name", "city", "country", "description", "target" FROM "Hotel"').fetchall()
    documents = []
    for row in activities:
        text = f"{row[1]} ({row[2]}) a {row[3]}, {row[4]}. {row[5]} Target ideale: {row[6]}."
        documents.append({"id": row[0], "type": "activity", "text": text, "metadata": {"name": row[1], "category": row[2], "city": row[3], "country": row[4], "target": row[6], "destinationId": row[7]}})
    for row in hotels:
        text = f"{row[1]} a {row[2]}, {row[3]}. {row[4]} Target ideale: {row[5]}."
        documents.append({"id": row[0], "type": "hotel", "text": text, "metadata": {"name": row[1], "city": row[2], "country": row[3], "target": row[5]}})
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(documents, ensure_ascii=False), encoding="utf-8")
    return len(documents)


def main() -> None:
    parser = argparse.ArgumentParser(description="Carica il catalogo demo Python")
    parser.add_argument("--dry-run", action="store_true", help="esegue tutte le query e poi annulla la transazione")
    options = parser.parse_args()
    windows = month_windows()
    with connect() as connection:
        clear_catalog(connection)
        origins = {}
        for code, name, city, country_code, _bias in ORIGINS:
            airport_id = str(uuid4())
            connection.execute('INSERT INTO "Airport" ("id", "iataCode", "name", "city", "countryCode") VALUES (%s, %s, %s, %s, %s)', (airport_id, code, name, city, country_code))
            origins[code] = airport_id
        for country, country_code, city, destination_iata, flight_base in DESTINATIONS:
            destination_id = str(uuid4())
            connection.execute('INSERT INTO "Destination" ("id", "country", "countryCode", "city") VALUES (%s, %s, %s, %s)', (destination_id, country, country_code, city))
            destination_airport_id = str(uuid4())
            connection.execute('INSERT INTO "Airport" ("id", "iataCode", "name", "city", "countryCode", "destinationId") VALUES (%s, %s, %s, %s, %s, %s)', (destination_airport_id, destination_iata, f"Aeroporto di {city}", city, country_code, destination_id))
            for _code, _name, _origin_city, _origin_country, bias in ORIGINS:
                for _year, _month, departures, _coverage in windows:
                    for day_index, departure in enumerate(departures):
                        cost = flight_base + bias + (day_index % 3) * 4
                        connection.execute('INSERT INTO "Flight" ("id", "originAirportId", "destinationAirportId", "direction", "date", "seatsAvailable", "cost", "version") VALUES (%s, %s, %s, \'outbound\', %s, 6, %s, 0)', (str(uuid4()), origins[_code], destination_airport_id, departure, cost))
                        connection.execute('INSERT INTO "Flight" ("id", "originAirportId", "destinationAirportId", "direction", "date", "seatsAvailable", "cost", "version") VALUES (%s, %s, %s, \'return\', %s, 6, %s, 0)', (str(uuid4()), destination_airport_id, origins[_code], departure + timedelta(days=5), cost + 8 + (day_index % 2) * 3))
            hotel_ids = []
            for hotel_name, description, target, rooms in ((f"Hostal {city}", "Sistemazione centrale per budget contenuti.", "giovani, budget contenuto", 4), (f"Hotel Plaza {city}", "Hotel comodo per famiglie e visite culturali.", "famiglie, cultura", 3)):
                hotel_id = str(uuid4())
                hotel_ids.append(hotel_id)
                connection.execute('INSERT INTO "Hotel" ("id", "name", "destinationId", "country", "city", "description", "target") VALUES (%s, %s, %s, %s, %s, %s, %s)', (hotel_id, hotel_name, destination_id, country, city, description, target))
                for _year, _month, _departures, coverage in windows:
                    for day in coverage:
                        connection.execute('INSERT INTO "HotelAvailability" ("id", "hotelId", "date", "pricePerNight", "roomsAvailable", "version") VALUES (%s, %s, %s, %s, %s, 0)', (str(uuid4()), hotel_id, day, (35 if rooms == 4 else 70) + (day.day % 4), rooms))
            for name, category, description, target, cost, start, end in ACTIVITIES:
                activity_id = str(uuid4())
                connection.execute('INSERT INTO "Activity" ("id", "name", "destinationId", "country", "city", "category", "description", "target") VALUES (%s, %s, %s, %s, %s, %s, %s, %s)', (activity_id, f"{name} - {city}", destination_id, country, city, category, description, target))
                for _year, _month, _departures, coverage in windows:
                    for day in coverage:
                        connection.execute('INSERT INTO "ActivityAvailability" ("id", "activityId", "date", "startMinute", "endMinute", "cost", "capacity", "booked", "version") VALUES (%s, %s, %s, %s, %s, %s, 15, 0, 0)', (str(uuid4()), activity_id, day, start, end, cost))
        index_path = Path(__file__).parents[1] / "data" / "vector-index.json"
        if options.dry_run:
            with tempfile.NamedTemporaryFile(suffix=".json") as temporary_index:
                count = build_index(connection, Path(temporary_index.name))
            connection.rollback()
            print(f"Dry-run seed Python completato: {len(DESTINATIONS)} destinazioni, indice RAG {count} documenti; nessuna modifica persistita.")
        else:
            count = build_index(connection, index_path)
            connection.commit()
            print(f"Seed Python completato: {len(DESTINATIONS)} destinazioni, indice RAG {count} documenti.")


if __name__ == "__main__":
    main()
