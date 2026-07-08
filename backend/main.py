import logging
import os
import re
import shutil
import time
from contextlib import asynccontextmanager

from database import Base, engine, get_db
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from routers import game_images, games, goals, maintenance, notifications, players, sessions, settings, sharing, stats
from sqlalchemy import text
from sqlalchemy.orm import Session
from utils import require_api_key

# Regex patterns for redacting share tokens from logged request paths.
# Matches /api/share/{token}/games[/{game_id}[/want-to-play]] and /api/share/tokens/{token}
_SHARE_TOKEN_PATH_RE = re.compile(r"^(/api/share/)([^/]+)(/games.*)$")
_SHARE_TOKEN_DELETE_RE = re.compile(r"^(/api/share/tokens/)([^/]+)$")


def _redact_path(path: str) -> str:
    """Redact share tokens from /api/share/... paths so they never appear in logs."""
    m = _SHARE_TOKEN_PATH_RE.match(path)
    if m:
        return f"{m.group(1)}***{m.group(3)}"
    m = _SHARE_TOKEN_DELETE_RE.match(path)
    if m:
        return f"{m.group(1)}***"
    return path

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


app = FastAPI(
    title="Cardboard API",
    version="1.0.0",
    docs_url="/api/docs" if os.getenv("ENABLE_DOCS", "").lower() in ("1", "true", "yes") else None,
    redoc_url="/redoc" if os.getenv("ENABLE_DOCS", "").lower() in ("1", "true", "yes") else None,
    openapi_url="/openapi.json" if os.getenv("ENABLE_DOCS", "").lower() in ("1", "true", "yes") else None,
    lifespan=lifespan,
)


@app.get("/health", include_in_schema=False)
def health_check(db: Session = Depends(get_db)):
    db.execute(text("SELECT 1"))
    return {"status": "ok"}


@app.get("/robots.txt", include_in_schema=False, response_class=PlainTextResponse)
def robots_txt():
    return "User-agent: *\nDisallow: /\n"

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
    allow_headers=["Content-Type", "X-API-Key"],
)


@app.exception_handler(Exception)
async def _unhandled_exception(request: Request, exc: Exception):
    logger.exception("Unhandled exception on %s %s", request.method, _redact_path(request.url.path))
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob: https:; "
        "connect-src 'self'; "
        "font-src 'self'; "
        "object-src 'none';"
    )
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
            _redact_path(request.url.path),
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
app.include_router(notifications.router)
app.include_router(maintenance.router)


class WipeConfirm(BaseModel):
    confirm: str


_MEDIA_SUBDIRS = ["images", "instructions", "gallery", "avatars"]


@app.delete("/api/everything", status_code=200)
def wipe_all_data(body: WipeConfirm, request: Request, db: Session = Depends(get_db)):
    """Factory-reset endpoint: drop all rows from every table and delete all media files.

    Requires a confirmation payload ``{"confirm": "DELETE EVERYTHING"}`` to prevent
    accidental triggers. Documented under "Uninstall" in the README. When
    ``CARDBOARD_API_KEY`` is set, an ``X-API-Key`` header is also required.
    """
    require_api_key(request)
    if body.confirm != "DELETE EVERYTHING":
        raise HTTPException(status_code=400, detail="Confirmation string mismatch")

    # Validate DATA_DIR before any mutation so a bad config doesn't half-wipe.
    data_dir = os.getenv("DATA_DIR", "/app/data")
    real_data_dir = os.path.realpath(data_dir)
    # Refuse to wipe if DATA_DIR resolves to a filesystem root or system path.
    _system_paths = {os.path.realpath(p) for p in (
        "/", "/app", "/etc", "/usr", "/var", "/tmp", os.path.expanduser("~"),
    )}
    if real_data_dir in _system_paths or real_data_dir == os.path.dirname(real_data_dir):
        raise HTTPException(
            status_code=500,
            detail="DATA_DIR resolves to a system path; refusing to wipe",
        )
    # Resolve every subdir up front and verify it stays inside DATA_DIR.
    resolved_subdirs = []
    for subdir in _MEDIA_SUBDIRS:
        dir_path = os.path.realpath(os.path.join(data_dir, subdir))
        if os.path.commonpath([real_data_dir, dir_path]) != real_data_dir:
            raise HTTPException(
                status_code=500,
                detail=f"Refusing to wipe path outside DATA_DIR: {subdir}",
            )
        resolved_subdirs.append(dir_path)

    # Delete all rows in FK-safe order (children first, parents last).
    tables = list(reversed(Base.metadata.sorted_tables))
    tables_cleared = 0
    for table in tables:
        db.execute(table.delete())
        tables_cleared += 1
    db.commit()

    # Delete media files from each subdir, then recreate empty dirs.
    media_dirs_cleared = 0
    for dir_path in resolved_subdirs:
        if os.path.isdir(dir_path):
            shutil.rmtree(dir_path)
        os.makedirs(dir_path, exist_ok=True)
        media_dirs_cleared += 1

    logger.warning("Factory reset completed: %d tables cleared, %d media dirs wiped", tables_cleared, media_dirs_cleared)
    return {
        "message": "All data wiped",
        "tables_cleared": tables_cleared,
        "media_dirs_cleared": media_dirs_cleared,
    }

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
