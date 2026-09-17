from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, Field
from psycopg.types.json import Jsonb

from .database import connect
from .generator import run_job
from .security import current_user_id


router = APIRouter(prefix="/itinerary-jobs", tags=["itinerary-jobs"])
UserId = Annotated[str, Depends(current_user_id)]


class JobRequest(BaseModel):
    conversationId: str
    idempotencyKey: str = Field(min_length=8, max_length=128)


def job_json(row: tuple) -> dict:
    return {"id": row[0], "conversationId": row[1], "status": row[2], "progress": row[3], "progressLabel": row[4], "result": row[5], "error": row[6], "createdAt": row[7], "startedAt": row[8], "completedAt": row[9], "updatedAt": row[10]}


@router.post("", status_code=status.HTTP_202_ACCEPTED)
def create_job(payload: JobRequest, user_id: UserId, background: BackgroundTasks) -> dict:
    with connect() as connection:
        conversation = connection.execute('SELECT "state" FROM "Conversation" WHERE "id" = %s AND "userId" = %s', (payload.conversationId, user_id)).fetchone()
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversazione non trovata")
        existing = connection.execute('SELECT "id", "conversationId", "status", "progress", "progressLabel", "result", "error", "createdAt", "startedAt", "completedAt", "updatedAt" FROM "ItineraryGenerationJob" WHERE "userId" = %s AND "idempotencyKey" = %s', (user_id, payload.idempotencyKey)).fetchone()
        if existing:
            if existing[1] != payload.conversationId:
                raise HTTPException(status_code=409, detail="Chiave di idempotenza già usata")
            return {"job": job_json(existing)}
        job_id = str(uuid4())
        snapshot = {"requirementsSnapshot": (conversation[0] or {}).get("requirements", {})}
        connection.execute('INSERT INTO "ItineraryGenerationJob" ("id", "userId", "conversationId", "idempotencyKey", "status", "progress", "progressLabel", "result", "createdAt", "updatedAt") VALUES (%s, %s, %s, %s, \'queued\', 0, \'In coda\', %s, NOW(), NOW())', (job_id, user_id, payload.conversationId, payload.idempotencyKey, Jsonb(snapshot)))
        connection.commit()
    background.add_task(run_job, job_id)
    return {"job": {"id": job_id, "conversationId": payload.conversationId, "status": "queued", "progress": 0, "progressLabel": "In coda", "result": snapshot, "error": None}}


@router.get("/{job_id}")
def get_job(job_id: str, user_id: UserId) -> dict:
    with connect() as connection:
        row = connection.execute('SELECT "id", "conversationId", "status", "progress", "progressLabel", "result", "error", "createdAt", "startedAt", "completedAt", "updatedAt" FROM "ItineraryGenerationJob" WHERE "id" = %s AND "userId" = %s', (job_id, user_id)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Job non trovato")
    return {"job": job_json(row)}

