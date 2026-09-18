"""Reset one local account password without exposing it in shell history."""

import argparse
from getpass import getpass

import bcrypt

from app.database import connect


def main() -> None:
    parser = argparse.ArgumentParser(description="Reimposta la password di un account locale")
    parser.add_argument("email")
    args = parser.parse_args()
    first = getpass("Nuova password (minimo 6 caratteri): ")
    second = getpass("Ripeti la nuova password: ")
    if len(first) < 6 or first != second:
        raise SystemExit("Password non valide o non coincidenti.")
    password_hash = bcrypt.hashpw(first.encode(), bcrypt.gensalt()).decode()
    with connect() as connection:
        result = connection.execute(
            'UPDATE "User" SET "passwordHash" = %s WHERE LOWER("email") = LOWER(%s)',
            (password_hash, args.email.strip()),
        )
        if result.rowcount != 1:
            raise SystemExit("Account non trovato.")
        connection.commit()
    print("Password reimpostata correttamente.")


if __name__ == "__main__":
    main()
