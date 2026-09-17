from contextlib import closing
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import psycopg

from .config import get_settings


def psycopg_url(database_url: str) -> str:
    """Remove Prisma-only query options before handing the URL to psycopg."""
    parsed = urlsplit(database_url)
    query = [(key, value) for key, value in parse_qsl(parsed.query) if key != "schema"]
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))


def check_database(database_url: str | None) -> bool:
    """Run the smallest possible PostgreSQL probe for readiness checks."""
    if not database_url:
        return False

    try:
        with closing(psycopg.connect(psycopg_url(database_url), connect_timeout=2)) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                return cursor.fetchone() == (1,)
    except psycopg.Error:
        return False


def connect() -> psycopg.Connection:
    database_url = get_settings().database_url
    if not database_url:
        raise RuntimeError("DATABASE_URL non configurato")
    return psycopg.connect(psycopg_url(database_url))
