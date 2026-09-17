from contextlib import asynccontextmanager
import logging
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import get_settings
from .database import check_database
from .auth import router as auth_router
from .conversations import router as conversations_router
from .itineraries import router as itineraries_router
from .shares import router as shares_router
from .bookings import router as bookings_router
from .jobs import resume_pending_jobs, router as jobs_router
from .images import router as images_router
from .migrations import apply_migrations
from .metrics import increment, observe, metrics_endpoint, request_started


settings = get_settings()
logger = logging.getLogger("travel-assistant-python")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        apply_migrations()
    except Exception as error:
        # Liveness must remain available while readiness reports the external
        # dependency state. The error is intentionally not exposed to clients.
        print(f"Python migration skipped: {error}")
    try:
        await resume_pending_jobs()
    except Exception as error:
        logger.warning("pending job recovery skipped: %s", error)
    yield


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://localhost:8081", "http://127.0.0.1:8080", "http://127.0.0.1:8081"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def request_logging(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or str(uuid4())
    started = request_started()
    response = await call_next(request)
    labels = {"method": request.method, "route": request.url.path, "status": response.status_code}
    increment("http_requests_total", labels)
    observe("http_request_duration_ms", (request_started() - started) * 1000, labels)
    response.headers["x-request-id"] = request_id
    logger.info("request method=%s path=%s status=%s request_id=%s", request.method, request.url.path, response.status_code, request_id)
    return response
app.include_router(auth_router, prefix=settings.api_prefix)
app.include_router(conversations_router, prefix=settings.api_prefix)
app.include_router(itineraries_router, prefix=settings.api_prefix)
app.include_router(shares_router, prefix=settings.api_prefix)
app.include_router(bookings_router, prefix=settings.api_prefix)
app.include_router(jobs_router, prefix=settings.api_prefix)
app.include_router(images_router, prefix=settings.api_prefix)


@app.get(f"{settings.api_prefix}/metrics", tags=["system"])
def metrics(request: Request) -> dict:
    return metrics_endpoint(request)


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, _exception: RequestValidationError) -> JSONResponse:
    return JSONResponse({"error": "Dati non validi"}, status_code=400)


@app.exception_handler(HTTPException)
async def http_error(_request: Request, exception: HTTPException) -> JSONResponse:
    return JSONResponse({"error": exception.detail}, status_code=exception.status_code)


@app.exception_handler(Exception)
async def unhandled_error(_request: Request, _exception: Exception) -> JSONResponse:
    return JSONResponse({"error": "Errore interno del server"}, status_code=500)


@app.get("/health", tags=["system"])
@app.get(f"{settings.api_prefix}/health", tags=["system"], include_in_schema=False)
def health() -> dict[str, str]:
    """Liveness check: this endpoint intentionally has no external dependency."""
    return {"status": "ok", "service": "python-backend"}


@app.get("/health/live", tags=["system"])
def live() -> dict[str, str]:
    return {"status": "ok", "check": "liveness"}


@app.get("/health/ready", tags=["system"])
@app.get(f"{settings.api_prefix}/ready", tags=["system"], include_in_schema=False)
def ready() -> JSONResponse:
    if check_database(settings.database_url):
        return JSONResponse({"status": "ok", "check": "readiness"})
    return JSONResponse(
        {"status": "unavailable", "check": "readiness"},
        status_code=503,
    )
