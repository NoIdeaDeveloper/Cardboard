import logging
import os
import secrets
import time
from contextlib import asynccontextmanager
from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from database import engine, get_db
from routers import games, sessions, stats, game_images, players, sharing, goals, settings

# force=True ensures our format wins even if another library called basicConfig first.
# PYTHONUNBUFFERED=1 (set in Docker env) makes stdout unbuffered so logs appear immediately.
_log_level_name = os.getenv("LOG_LEVEL", "INFO").upper()
_log_level = getattr(logging, _log_level_name, None)
logging.basicConfig(
    level=_log_level if isinstance(_log_level, int) else logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    force=True,
)
logger = logging.getLogger("cardboard")
if not isinstance(_log_level, int):
    logger.warning("Invalid LOG_LEVEL=%r, defaulting to INFO", os.getenv("LOG_LEVEL"))

# Ensure data directories exist
for subdir in ["", "images", "instructions", "gallery", "avatars"]:
    path = os.path.join(os.getenv("DATA_DIR", "/app/data"), subdir)
    os.makedirs(path, exist_ok=True)
    if subdir:
        logger.info("Data sub-directory ready: %s", path)

logger.info("Data directory: %s", os.path.abspath(os.getenv("DATA_DIR", "/app/data")))

# Verify DB is actually reachable before serving traffic
try:
    with engine.connect() as _probe:
        _probe.execute(text("SELECT 1"))
    logger.info("Database connectivity verified")
except Exception as _exc:
    logger.error("Cannot connect to database at startup: %s", _exc)
    raise SystemExit(1)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    engine.dispose()
    logger.info("Cardboard shutting down — connections closed")


app = FastAPI(title="Cardboard API", version="1.0.0", docs_url="/api/docs", lifespan=lifespan)


@app.get("/health", include_in_schema=False)
def health_check(db: Session = Depends(get_db)):
    db.execute(text("SELECT 1"))
    return {"status": "ok"}

_raw_origins = os.getenv("ALLOWED_ORIGINS", "").split(",")
_ALLOWED_ORIGINS = [o.strip() for o in _raw_origins if o.strip()]
if not _ALLOWED_ORIGINS:
    _ALLOWED_ORIGINS = ["http://localhost", "http://127.0.0.1"]
    logger.warning("ALLOWED_ORIGINS not set — defaulting to localhost only. Set ALLOWED_ORIGINS for production.")
if "*" in _ALLOWED_ORIGINS:
    logger.warning("CORS is open to ALL origins — set ALLOWED_ORIGINS for production")
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.exception_handler(Exception)
async def _unhandled_exception(request: Request, exc: Exception):
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    nonce = secrets.token_urlsafe(16)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        f"script-src 'self' 'nonce-{nonce}'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob: https:; "
        "connect-src 'self'; "
        "font-src 'self'; "
        "object-src 'none';"
    )
    response.headers["X-CSP-Nonce"] = nonce
    return response


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Log every request with method, path, status code and response time."""
    start = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - start) * 1000
    if request.url.path.startswith("/api/"):
        logger.info(
            "%s %s -> %d (%.1f ms)",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
        )
    return response


app.include_router(games.router)
app.include_router(game_images.router)
app.include_router(sessions.router)
app.include_router(stats.router)
app.include_router(players.router)
app.include_router(sharing.router)
app.include_router(goals.router)
app.include_router(settings.router)

# Serve frontend static files
FRONTEND_PATH = os.getenv("FRONTEND_PATH", "/app/frontend")

if os.path.exists(FRONTEND_PATH):
    for static_dir in ["css", "js"]:
        dir_path = os.path.join(FRONTEND_PATH, static_dir)
        if os.path.exists(dir_path):
            app.mount(f"/{static_dir}", StaticFiles(directory=dir_path), name=static_dir)

    @app.get("/")
    async def serve_index():
        return FileResponse(os.path.join(FRONTEND_PATH, "index.html"))

    @app.get("/{path:path}")
    async def serve_frontend(path: str):
        frontend_real = os.path.realpath(FRONTEND_PATH)
        file_path = os.path.realpath(os.path.join(FRONTEND_PATH, path))
        if file_path.startswith(frontend_real + os.sep) and os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(FRONTEND_PATH, "index.html"))

    logger.info("Frontend serving from: %s", FRONTEND_PATH)
else:
    logger.warning("Frontend path not found: %s — only API will be served", FRONTEND_PATH)

logger.info("Cardboard application ready")
