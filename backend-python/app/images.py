from hashlib import sha256
from pathlib import Path
import re
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from psycopg.types.json import Jsonb

from .config import get_settings
from .database import connect
from .security import current_user_id
from .vision import analyze_image


router = APIRouter(prefix="/chat", tags=["preference-images"])
UserId = Annotated[str, Depends(current_user_id)]
MAX_BYTES = 5 * 1024 * 1024
MIME_EXTENSIONS = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}


def detect_mime(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def safe_name(value: str) -> str:
    name = re.sub(r"[\x00-\x1f\x7f]", "", value or "image")[:255]
    return name or "image"


def public_image(row: tuple) -> dict:
    return {"id": row[0], "conversationId": row[1], "originalName": row[2], "mimeType": row[3], "sizeBytes": row[4], "analysisStatus": row[5], "description": row[6], "tags": row[7], "createdAt": row[8]}


def _check_uuid(value: str) -> None:
    try:
        UUID(value)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Conversazione non trovata") from error


@router.post("/conversations/{conversation_id}/preferences/images", status_code=status.HTTP_201_CREATED)
async def upload_image(conversation_id: str, user_id: UserId, image: UploadFile = File(...)) -> dict:
    _check_uuid(conversation_id)
    data = await image.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="L’immagine supera il limite di 5 MiB")
    mime = detect_mime(data)
    if not mime or (image.content_type and image.content_type != mime):
        raise HTTPException(status_code=400, detail="Formato immagine non valido")
    with connect() as connection:
        exists = connection.execute('SELECT 1 FROM "Conversation" WHERE "id" = %s AND "userId" = %s', (conversation_id, user_id)).fetchone()
        if not exists:
            connection.execute('INSERT INTO "Conversation" ("id", "userId", "state", "createdAt", "updatedAt") VALUES (%s, %s, %s, NOW(), NOW())', (conversation_id, user_id, Jsonb({"phase": "collecting", "requirements": {}})))
        image_id = str(uuid4())
        storage_key = f"{image_id}{MIME_EXTENSIONS[mime]}"
        target_dir = Path(get_settings().preference_image_dir)
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / storage_key
        target.write_bytes(data)
        checksum = sha256(data).hexdigest()
        try:
            row = connection.execute(
                'INSERT INTO "PreferenceImage" ("id", "userId", "conversationId", "storageKey", "originalName", "mimeType", "sizeBytes", "sha256", "analysisStatus", "tags", "createdAt") VALUES (%s, %s, %s, %s, %s, %s, %s, %s, \'metadata_only\', %s, NOW()) RETURNING "id", "conversationId", "originalName", "mimeType", "sizeBytes", "analysisStatus", "description", "tags", "createdAt"',
                (image_id, user_id, conversation_id, storage_key, safe_name(image.filename or "image"), mime, len(data), checksum, Jsonb([])),
            ).fetchone()
            connection.commit()
        except Exception:
            target.unlink(missing_ok=True)
            raise
    analysis = await analyze_image(data, mime)
    if analysis.get("status") == "completed":
        with connect() as connection:
            row = connection.execute(
                'UPDATE "PreferenceImage" SET "analysisStatus" = \'completed\', "description" = %s, "tags" = %s, "analyzedAt" = NOW() WHERE "id" = %s RETURNING "id", "conversationId", "originalName", "mimeType", "sizeBytes", "analysisStatus", "description", "tags", "createdAt"',
                (analysis.get("description"), Jsonb(analysis.get("tags", [])), image_id),
            ).fetchone()
            connection.commit()
    result = public_image(row)
    if analysis.get("status") != "completed":
        result["analysisReason"] = analysis.get("reason")
    return {"image": result}


@router.get("/conversations/{conversation_id}/preferences/images/{image_id}/content")
def image_content(conversation_id: str, image_id: str, user_id: UserId) -> FileResponse:
    with connect() as connection:
        row = connection.execute('SELECT "storageKey", "mimeType", "originalName" FROM "PreferenceImage" WHERE "id" = %s AND "conversationId" = %s AND "userId" = %s', (image_id, conversation_id, user_id)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Immagine non trovata")
    path = Path(get_settings().preference_image_dir) / row[0]
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File immagine non disponibile")
    return FileResponse(path, media_type=row[1], filename=f"preference-image{MIME_EXTENSIONS.get(row[1], '')}", content_disposition_type="inline")


@router.delete("/conversations/{conversation_id}/preferences/images/{image_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_image(conversation_id: str, image_id: str, user_id: UserId) -> None:
    with connect() as connection:
        row = connection.execute('SELECT "storageKey" FROM "PreferenceImage" WHERE "id" = %s AND "conversationId" = %s AND "userId" = %s', (image_id, conversation_id, user_id)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Immagine non trovata")
        connection.execute('DELETE FROM "PreferenceImage" WHERE "id" = %s', (image_id,))
        connection.commit()
    (Path(get_settings().preference_image_dir) / row[0]).unlink(missing_ok=True)
