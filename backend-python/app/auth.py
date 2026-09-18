from datetime import UTC, datetime, timedelta
from hashlib import sha256
import secrets
from typing import Annotated
from uuid import uuid4

import bcrypt
import jwt
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, field_validator

from .config import get_settings
from .database import connect
from .rate_limit import auth_rate_limit


router = APIRouter(prefix="/auth", tags=["auth"], dependencies=[Depends(auth_rate_limit)])
REFRESH_COOKIE = "refresh_token"
REFRESH_TTL = timedelta(days=30)


class Credentials(BaseModel):
    email: str
    password: str = Field(min_length=6)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        value = value.strip().lower()
        if "@" not in value or value.startswith("@"):
            raise ValueError("email non valida")
        return value


class Registration(Credentials):
    name: str = Field(min_length=1)


def public_user(user: tuple[str, str, str]) -> dict[str, str]:
    return {"id": user[0], "email": user[1], "name": user[2]}


def access_token(user_id: str) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {"sub": user_id, "typ": "access", "iat": now, "exp": now + timedelta(minutes=15)},
        get_settings().jwt_secret,
        algorithm="HS256",
    )


def token_hash(token: str) -> str:
    return sha256(token.encode()).hexdigest()


def issue_refresh_token(connection: object, user_id: str) -> str:
    token = secrets.token_urlsafe(64)
    connection.execute(
        'INSERT INTO "RefreshToken" ("id", "tokenHash", "userId", "expiresAt", "createdAt") '
        "VALUES (%s, %s, %s, %s, %s)",
        (str(uuid4()), token_hash(token), user_id, datetime.now(UTC) + REFRESH_TTL, datetime.now(UTC)),
    )
    return token


def set_refresh_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        REFRESH_COOKIE, token, max_age=int(REFRESH_TTL.total_seconds()), httponly=True,
        secure=settings.environment == "production", samesite="lax", path="/api/auth",
    )


def clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, httponly=True, samesite="lax", path="/api/auth")


def create_session(response: Response, user: tuple[str, str, str], connection: object) -> dict:
    refresh = issue_refresh_token(connection, user[0])
    connection.commit()
    set_refresh_cookie(response, refresh)
    return {"token": access_token(user[0]), "user": public_user(user)}


@router.post("/register", status_code=status.HTTP_201_CREATED)
def register(payload: Registration, response: Response) -> dict:
    try:
        with connect() as connection:
            existing = connection.execute(
                'SELECT "id" FROM "User" WHERE "email" = %s', (payload.email,)
            ).fetchone()
            if existing:
                raise HTTPException(status_code=409, detail="Email già registrata")
            user = (str(uuid4()), payload.email, payload.name.strip())
            if not user[2]:
                raise HTTPException(status_code=400, detail="Dati non validi")
            password_hash = bcrypt.hashpw(payload.password.encode(), bcrypt.gensalt()).decode()
            connection.execute(
                'INSERT INTO "User" ("id", "email", "passwordHash", "name", "createdAt") '
                "VALUES (%s, %s, %s, %s, %s)",
                (*user, password_hash, datetime.now(UTC)),
            )
            return create_session(response, user, connection)
    except HTTPException:
        raise
    except Exception as error:
        if "unique" in str(error).lower():
            raise HTTPException(status_code=409, detail="Email già registrata") from error
        raise HTTPException(status_code=503, detail="Database non disponibile") from error


@router.post("/login")
def login(payload: Credentials, response: Response) -> dict:
    try:
        with connect() as connection:
            user = connection.execute(
                'SELECT "id", "email", "name", "passwordHash" FROM "User" WHERE "email" = %s',
                (payload.email,),
            ).fetchone()
            if not user:
                raise HTTPException(status_code=401, detail="Credenziali non valide")
            try:
                password_valid = bcrypt.checkpw(payload.password.encode(), user[3].encode())
            except (ValueError, TypeError):
                password_valid = False
            if not password_valid:
                raise HTTPException(status_code=401, detail="Credenziali non valide")
            return create_session(response, user[:3], connection)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=503, detail="Database non disponibile") from error


@router.post("/refresh")
def refresh(response: Response, refresh_token: Annotated[str | None, Cookie()] = None) -> dict:
    if not refresh_token:
        raise HTTPException(status_code=401, detail="Refresh token mancante")

    # The legacy schema stores timestamps without timezone information.
    # Compare using the same representation returned by psycopg.
    now = datetime.now(UTC).replace(tzinfo=None)
    try:
        with connect() as connection:
            stored = connection.execute(
                'SELECT r."id", r."userId", r."expiresAt", r."revokedAt", '
                'u."email", u."name" FROM "RefreshToken" r '
                'JOIN "User" u ON u."id" = r."userId" WHERE r."tokenHash" = %s',
                (token_hash(refresh_token),),
            ).fetchone()
            expires_at = stored[2].replace(tzinfo=None) if stored and stored[2].tzinfo else (stored[2] if stored else None)
            if not stored or expires_at <= now:
                clear_refresh_cookie(response)
                raise HTTPException(status_code=401, detail="Refresh token non valido o scaduto")
            if stored[3]:
                connection.execute(
                    'UPDATE "RefreshToken" SET "revokedAt" = %s '
                    'WHERE "userId" = %s AND "revokedAt" IS NULL',
                    (now, stored[1]),
                )
                connection.commit()
                clear_refresh_cookie(response)
                raise HTTPException(status_code=401, detail="Refresh token già utilizzato")

            updated = connection.execute(
                'UPDATE "RefreshToken" SET "revokedAt" = %s '
                'WHERE "id" = %s AND "revokedAt" IS NULL',
                (now, stored[0]),
            )
            if updated.rowcount != 1:
                connection.rollback()
                clear_refresh_cookie(response)
                raise HTTPException(status_code=401, detail="Refresh token già utilizzato")
            user = (stored[1], stored[4], stored[5])
            next_token = issue_refresh_token(connection, user[0])
            connection.commit()
            set_refresh_cookie(response, next_token)
            return {"token": access_token(user[0]), "user": public_user(user)}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=503, detail="Database non disponibile") from error


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(response: Response, refresh_token: Annotated[str | None, Cookie()] = None) -> None:
    if refresh_token:
        try:
            with connect() as connection:
                connection.execute(
                    'UPDATE "RefreshToken" SET "revokedAt" = %s '
                    'WHERE "tokenHash" = %s AND "revokedAt" IS NULL',
                    (datetime.now(UTC), token_hash(refresh_token)),
                )
                connection.commit()
        except Exception:
            pass
    clear_refresh_cookie(response)
