"""Add missing demo activities without deleting application data."""

from datetime import UTC
from uuid import uuid4

from app.database import connect
from scripts.seed import ACTIVITIES, month_windows


def main() -> None:
    additions = [activity for activity in ACTIVITIES if activity[1] in {"gastronomia", "natura"}]
    created_activities = 0
    created_slots = 0
    windows = month_windows()
    with connect() as connection:
        destinations = connection.execute(
            'SELECT "id", "country", "city" FROM "Destination"'
        ).fetchall()
        for destination_id, country, city in destinations:
            for name, category, description, target, cost, start, end in additions:
                activity_name = f"{name} - {city}"
                row = connection.execute(
                    'SELECT "id" FROM "Activity" WHERE "destinationId" = %s AND "name" = %s',
                    (destination_id, activity_name),
                ).fetchone()
                if row:
                    activity_id = row[0]
                else:
                    activity_id = str(uuid4())
                    connection.execute(
                        'INSERT INTO "Activity" ("id", "name", "destinationId", "country", "city", "category", "description", "target") '
                        'VALUES (%s, %s, %s, %s, %s, %s, %s, %s)',
                        (activity_id, activity_name, destination_id, country, city, category, description, target),
                    )
                    created_activities += 1
                for _year, _month, _departures, coverage in windows:
                    for day in coverage:
                        existing = connection.execute(
                            'SELECT 1 FROM "ActivityAvailability" WHERE "activityId" = %s AND "date" = %s',
                            (activity_id, day),
                        ).fetchone()
                        if existing:
                            continue
                        connection.execute(
                            'INSERT INTO "ActivityAvailability" ("id", "activityId", "date", "startMinute", "endMinute", "cost", "capacity", "booked", "version") '
                            'VALUES (%s, %s, %s, %s, %s, %s, 15, 0, 0)',
                            (str(uuid4()), activity_id, day, start, end, cost),
                        )
                        created_slots += 1
        connection.commit()
    print(f"Catalogo esteso: {created_activities} attività, {created_slots} disponibilità aggiunte.")


if __name__ == "__main__":
    main()
