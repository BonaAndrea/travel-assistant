from pathlib import Path

from .database import connect


def apply_migrations() -> None:
    migrations_dir = Path(__file__).resolve().parents[1] / "prisma-migrations"
    if not migrations_dir.is_dir():
        return
    with connect() as connection:
        prisma_migrations = connection.execute(
            "SELECT to_regclass('public._prisma_migrations')"
        ).fetchone()[0]
        # Existing installations are already managed by the versioned Prisma
        # migrations from the legacy service; never replay those CREATE TABLEs.
        if prisma_migrations:
            return
        connection.execute(
            'CREATE TABLE IF NOT EXISTS "PythonMigration" ("name" TEXT PRIMARY KEY, "appliedAt" TIMESTAMP NOT NULL DEFAULT NOW())'
        )
        for migration in sorted(path for path in migrations_dir.iterdir() if path.is_dir()):
            name = migration.name
            already_applied = connection.execute(
                'SELECT 1 FROM "PythonMigration" WHERE "name" = %s', (name,)
            ).fetchone()
            if already_applied:
                continue
            sql_path = migration / "migration.sql"
            if not sql_path.is_file():
                continue
            for statement in sql_path.read_text(encoding="utf-8").split(";"):
                statement = statement.strip()
                if statement:
                    connection.execute(statement)
            connection.execute(
                'INSERT INTO "PythonMigration" ("name") VALUES (%s)', (name,)
            )
            connection.commit()
