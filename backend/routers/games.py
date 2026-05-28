import base64
import difflib
import certifi
import csv
import glob
import io
import json
import logging
import math
import os
import re
import sqlite3
import ssl
import tempfile
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
import atexit
from datetime import date as _date, datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from sqlalchemy import and_, asc, case, desc, exists, func, or_
from sqlalchemy.orm import Session

from database import SessionLocal, get_db, engine
import models
import schemas
from routers.game_images import delete_all_gallery_images
from utils import validate_url_safety, safe_image_ext, get_game_or_404, validate_file_extension, collection_etag, parse_json_list, safe_write_file, safe_delete_file, build_safe_opener
from constants import (
    MAX_IMAGE_SIZE, ALLOWED_IMAGE_EXTENSIONS,
    MAX_INSTRUCTIONS_SIZE, ALLOWED_INSTRUCTIONS_EXTENSIONS,
    BGG_IMPORT_MAX_BYTES, BGG_PLAYS_MAX_BYTES, NOTES_MAX_LENGTH,
    CSV_IMPORT_MAX_BYTES, NO_LOCATION_SENTINEL,
    FRONTEND_PATH,
)

logger = logging.getLogger("cardboard.games")
router = APIRouter(prefix="/api/games", tags=["games"])


# ---------------------------------------------------------------------------
# BGG rate limiter — token bucket, 10 requests / minute per IP
# ---------------------------------------------------------------------------
import threading as _threading
import collections as _collections

_BGG_RATE_LIMIT = 10          # requests
_BGG_RATE_WINDOW = 60.0       # seconds
_bgg_buckets: dict[str, list[float]] = _collections.defaultdict(list)
_bgg_lock = _threading.Lock()
_bgg_ssl_ctx = ssl.create_default_context(cafile=certifi.where())

_safe_opener = build_safe_opener()
_safe_opener_ssl = build_safe_opener(context=_bgg_ssl_ctx)

# Limit concurrent image caching to avoid exhausting the SQLite connection pool
_cache_semaphore = _threading.BoundedSemaphore(2)


def _check_bgg_rate_limit(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    cutoff = now - _BGG_RATE_WINDOW
    with _bgg_lock:
        # Evict old timestamps for this IP
        timestamps = _bgg_buckets[ip]
        _bgg_buckets[ip] = [t for t in timestamps if t > cutoff]
        if len(_bgg_buckets[ip]) >= _BGG_RATE_LIMIT:
            raise HTTPException(status_code=429, detail="Too many BGG requests — please wait a moment")
        _bgg_buckets[ip].append(now)
        if len(_bgg_buckets) > 50:
            stale = [k for k, v in _bgg_buckets.items() if not v]
            for k in stale:
                del _bgg_buckets[k]


def _heat_level(last_played) -> int:
    if not last_played:
        return 0
    days = (_date.today() - last_played).days
    return 3 if days <= 14 else 2 if days <= 60 else 1 if days <= 180 else 0

IMAGES_DIR = os.getenv("IMAGES_DIR", "/app/data/images")
INSTRUCTIONS_DIR = os.getenv("INSTRUCTIONS_DIR", "/app/data/instructions")

# ---------------------------------------------------------------------------
# Image caching
# ---------------------------------------------------------------------------

def _safe_filename(name: str) -> str:
    """Strip path components and replace unsafe characters."""
    name = os.path.basename(name)
    name = re.sub(r"[^\w.\-]", "_", name)
    return name[:200]  # cap length


_safe_ext = safe_image_ext  # backward-compatible alias


def _cache_game_image(game_id: int, image_url: str) -> None:
    """Download image_url and store locally; update game record. Runs as a background task."""
    if not image_url or image_url.startswith("/api/"):
        return  # already local or empty

    is_valid, err_msg = validate_url_safety(image_url)
    if not is_valid:
        logger.warning("Image cache refused for game %d: %s", game_id, err_msg)
        return

    acquired = _cache_semaphore.acquire(blocking=False)
    if not acquired:
        logger.warning("Image cache deferred for game %d: too many concurrent downloads", game_id)
        return

    try:
        # Abort early if the URL has already been changed (e.g. user uploaded a file
        # or changed the URL before this background task ran).
        with SessionLocal() as db:
            game = db.query(models.Game).filter(models.Game.id == game_id).first()
            if not game or game.image_url != image_url:
                logger.info("Image cache skipped for game %d: URL has changed", game_id)
                return
            # Mark as pending while the download is in progress
            game.image_cache_status = "pending"
            db.commit()

        os.makedirs(IMAGES_DIR, exist_ok=True)

        try:
            req = urllib.request.Request(image_url, headers={"User-Agent": "Cardboard/1.0"})
            with _safe_opener.open(req, timeout=15) as resp:
                content_type = resp.headers.get("Content-Type", "image/jpeg")
                ext = _safe_ext(image_url, content_type)
                dest = os.path.join(IMAGES_DIR, f"{game_id}{ext}")
                downloaded = 0
                # Write to a temp file first so the destination is never partial.
                with tempfile.NamedTemporaryFile(dir=IMAGES_DIR, delete=False) as tmp:
                    tmp_path = tmp.name
                    try:
                        while True:
                            chunk = resp.read(65536)
                            if not chunk:
                                break
                            downloaded += len(chunk)
                            if downloaded > MAX_IMAGE_SIZE:
                                raise ValueError("Remote image exceeds size limit")
                            tmp.write(chunk)
                    except Exception:
                        os.unlink(tmp_path)
                        raise
                os.replace(tmp_path, dest)
        except Exception:
            logger.exception("Image cache failed for game %d", game_id)
            _delete_cached_image(game_id)
            with SessionLocal() as db:
                game = db.query(models.Game).filter(models.Game.id == game_id).first()
                if game and game.image_url == image_url:
                    game.image_cache_status = "failed"
                    db.commit()
            return

        # Verify the URL is still current before updating the DB — the user may have
        # changed or uploaded a new image while we were downloading.
        with SessionLocal() as db:
            game = db.query(models.Game).filter(models.Game.id == game_id).first()
            if game and game.image_url == image_url:
                game.image_url = f"/api/games/{game_id}/image"
                game.image_cached = True
                game.image_ext = ext
                game.image_cache_status = "cached"
                db.commit()
                logger.info("Image cached for game %d", game_id)
            else:
                _delete_cached_image(game_id)
                logger.info("Image cache discarded for game %d: URL changed during download", game_id)
    finally:
        _cache_semaphore.release()


def _instructions_path(game_id: int, filename: str) -> str:
    return os.path.join(INSTRUCTIONS_DIR, f"{game_id}_{os.path.basename(filename)}")


def _verify_within(path: str, directory: str) -> str:
    """Resolve *path* and verify it lives inside *directory*; raise 404 otherwise."""
    real = os.path.realpath(path)
    if not real.startswith(os.path.realpath(directory) + os.sep):
        raise HTTPException(status_code=404, detail="File not found")
    return real


def _safe_header_filename(name: str) -> str:
    """Strip characters that could enable HTTP header injection from a filename."""
    return name.replace('"', '').replace('\r', '').replace('\n', '')


def _delete_cached_image(game_id: int) -> None:
    for path in glob.glob(os.path.join(IMAGES_DIR, f"{game_id}.*")):
        safe_delete_file(path)


# ---------------------------------------------------------------------------
# Tag junction-table helpers
# ---------------------------------------------------------------------------

# (game_field, tag_model, pivot_model, fk_attr)
_TAG_FIELDS = [
    ("categories", models.Category, models.GameCategory, "category_id"),
    ("mechanics",  models.Mechanic,  models.GameMechanic,  "mechanic_id"),
    ("designers",  models.Designer,  models.GameDesigner,  "designer_id"),
    ("publishers", models.Publisher, models.GamePublisher, "publisher_id"),
    ("labels",     models.Label,     models.GameLabel,     "label_id"),
]


_TAG_FIELD_NAMES = frozenset(f for f, *_ in _TAG_FIELDS)


def _save_tags(game_id: int, data_dict: dict, db: Session) -> None:
    """Sync junction tables for any tag fields present in *data_dict*."""
    try:
        for field, TagModel, PivotModel, fk_attr in _TAG_FIELDS:
            if field not in data_dict:
                continue
            json_str = data_dict[field]
            try:
                raw = json.loads(json_str) if json_str else []
                if not isinstance(raw, list):
                    continue
                # Deduplicate and clean in one pass
                seen: dict[str, None] = {}
                for n in raw:
                    clean = (str(n) if n else "").strip()
                    if clean:
                        seen[clean] = None
                names = list(seen)
            except (json.JSONDecodeError, TypeError):
                logger.warning("Invalid JSON for tag field %s on game %d: %.80s", field, game_id, str(json_str))
                continue

            # Clear existing pivot rows for this game + tag type
            db.query(PivotModel).filter(PivotModel.game_id == game_id).delete()

            if not names:
                continue

            # Batch-fetch all existing tags in one query
            existing = {
                tag.name: tag
                for tag in db.query(TagModel).filter(TagModel.name.in_(names)).all()
            }

            # Bulk-create any tags that don't exist yet, then flush once for IDs
            new_tags = [TagModel(name=name) for name in names if name not in existing]
            if new_tags:
                db.add_all(new_tags)
                db.flush()
                for tag in new_tags:
                    existing[tag.name] = tag

            # Bulk-insert all pivot rows
            db.add_all([PivotModel(game_id=game_id, **{fk_attr: existing[name].id}) for name in names])

        db.flush()
    except Exception as e:
        logger.error("Failed to save tags for game %d: %s", game_id, str(e))
        raise HTTPException(status_code=500, detail="Failed to save tags") from e


def _load_tags(games, db: Session) -> None:
    """Populate tag attributes on game objects from junction tables (batch).

    Modifies games in-place. Sets each tag field to a JSON-encoded sorted list
    of names; games with no tags get an empty JSON array.
    """
    if not games:
        return
    game_ids = [g.id for g in games]

    for field, TagModel, PivotModel, fk_attr in _TAG_FIELDS:
        # Single batch query per tag type
        rows = (
            db.query(PivotModel.game_id, TagModel.name)
            .join(TagModel, getattr(PivotModel, fk_attr) == TagModel.id)
            .filter(PivotModel.game_id.in_(game_ids))
            .all()
        )
        by_game: dict[int, list[str]] = {}
        for gid, name in rows:
            by_game.setdefault(gid, []).append(name)

        for g in games:
            setattr(g, field, json.dumps(sorted(by_game.get(g.id, []))))


# ---------------------------------------------------------------------------
# Collection CRUD
# ---------------------------------------------------------------------------

def _attach_parent_name(game: models.Game, db: Session) -> schemas.GameResponse:
    """Build a GameResponse with parent_game_name, heat_level, and expansion_count populated."""
    data = schemas.GameResponse.model_validate(game)
    if game.parent_game_id:
        parent = db.query(models.Game).filter(models.Game.id == game.parent_game_id).first()
        data.parent_game_name = parent.name if parent else None
    data.heat_level = _heat_level(game.last_played)
    data.expansion_count = (
        db.query(func.count(models.Game.id))
        .filter(models.Game.parent_game_id == game.id)
        .scalar() or 0
    )
    return data


def build_game_responses(games: list, db: Session) -> list:
    """Batch-populate tags, parent names, expansion counts, and heat levels for a list of Game objects.

    Used by both get_games() and sharing._build_game_list() to avoid duplicating this logic.
    """
    _load_tags(games, db)

    parent_ids = {g.parent_game_id for g in games if g.parent_game_id}
    parent_names: dict[int, str] = {}
    if parent_ids:
        parents = db.query(models.Game.id, models.Game.name).filter(models.Game.id.in_(parent_ids)).all()
        parent_names = {p.id: p.name for p in parents}

    game_ids = [g.id for g in games]
    exp_rows = (
        db.query(models.Game.parent_game_id, func.count(models.Game.id))
        .filter(models.Game.parent_game_id.isnot(None))
        .filter(models.Game.parent_game_id.in_(game_ids))
        .group_by(models.Game.parent_game_id)
        .all()
    )
    expansion_counts = {pid: cnt for pid, cnt in exp_rows}

    session_rows = (
        db.query(models.PlaySession.game_id, func.count(models.PlaySession.id))
        .filter(models.PlaySession.game_id.in_(game_ids))
        .group_by(models.PlaySession.game_id)
        .all()
    )
    session_counts = {gid: cnt for gid, cnt in session_rows}

    results = []
    for g in games:
        row = schemas.GameResponse.model_validate(g)
        if g.parent_game_id:
            row.parent_game_name = parent_names.get(g.parent_game_id)
        row.heat_level = _heat_level(g.last_played)
        row.expansion_count = expansion_counts.get(g.id, 0)
        row.session_count = session_counts.get(g.id, 0)
        results.append(row)
    return results


def _tag_exists(pivot_model, pivot_fk_col, tag_model, name_expr):
    """EXISTS subquery: game has at least one tag row matching name_expr."""
    return exists().where(
        and_(
            pivot_model.game_id == models.Game.id,
            pivot_fk_col == tag_model.id,
            name_expr,
        )
    )


@router.get("/")
def get_games(
    request: Request,
    search: Optional[str] = Query(None, max_length=200),
    sort_by: Optional[str] = Query(None, pattern="^(name|min_playtime|max_playtime|min_players|max_players|difficulty|user_rating|date_added|last_played|status|purchase_price|purchase_date)$"),
    sort_dir: Optional[str] = Query("asc", pattern="^(asc|desc)$"),
    include_expansions: bool = True,
    status: Optional[str] = Query(None, pattern="^(owned|wishlist|sold)$"),
    never_played: bool = False,
    min_players: Optional[int] = Query(None, ge=1),
    max_players: Optional[int] = Query(None, ge=1),
    min_playtime: Optional[int] = Query(None, ge=1),
    max_playtime: Optional[int] = Query(None, ge=1),
    rating_min: Optional[float] = Query(None, ge=1, le=10),
    rating_max: Optional[float] = Query(None, ge=1, le=10),
    added_month: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}$"),
    mechanics: Optional[str] = Query(None, max_length=1000),
    categories: Optional[str] = Query(None, max_length=1000),
    location: Optional[str] = Query(None, max_length=255),
    limit: Optional[int] = Query(None, ge=1, le=10000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    etag = collection_etag(db)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)

    query = db.query(models.Game)

    if not include_expansions:
        query = query.filter(models.Game.parent_game_id.is_(None))

    if search:
        # Split into tokens so "deck building" matches a "Deck Building" mechanic
        # and "catan" inside "Settlers of Catan" still works. Tokens shorter than
        # 2 chars are dropped as noise (stop words like "of", "a"). Cap to 8 tokens
        # to bound the per-token EXISTS subquery cost.
        tokens = [t for t in search.split() if len(t) >= 2][:8]
        if not tokens and search.strip():
            tokens = [search.strip()]  # all-short input — fall back to whole string
        for token in tokens:
            like = f"%{token}%"
            query = query.filter(
                or_(
                    models.Game.name.ilike(like),
                    _tag_exists(models.GameDesigner, models.GameDesigner.designer_id, models.Designer, models.Designer.name.ilike(like)),
                    _tag_exists(models.GameMechanic, models.GameMechanic.mechanic_id, models.Mechanic, models.Mechanic.name.ilike(like)),
                    _tag_exists(models.GameCategory, models.GameCategory.category_id, models.Category, models.Category.name.ilike(like)),
                )
            )

    if status:
        query = query.filter(models.Game.status == status)

    if never_played:
        query = query.filter(
            models.Game.last_played.is_(None),
            models.Game.status == "owned",
        )

    if min_players is not None:
        query = query.filter(
            or_(models.Game.max_players.is_(None), models.Game.max_players >= min_players)
        )

    if max_players is not None:
        query = query.filter(
            or_(models.Game.min_players.is_(None), models.Game.min_players <= max_players)
        )

    if min_playtime is not None:
        query = query.filter(
            or_(models.Game.max_playtime.is_(None), models.Game.max_playtime >= min_playtime)
        )

    if max_playtime is not None:
        query = query.filter(
            or_(models.Game.min_playtime.is_(None), models.Game.min_playtime <= max_playtime)
        )

    if rating_min is not None:
        query = query.filter(models.Game.user_rating >= rating_min)

    if rating_max is not None:
        query = query.filter(
            or_(models.Game.user_rating.is_(None), models.Game.user_rating <= rating_max)
        )

    if added_month is not None:
        query = query.filter(func.strftime("%Y-%m", models.Game.date_added) == added_month)

    if mechanics:
        mechanic_list = [m.strip() for m in mechanics.split(",") if m.strip()]
        if len(mechanic_list) > 50:
            raise HTTPException(status_code=422, detail="Too many mechanics specified (max 50)")
        if mechanic_list:
            query = query.filter(
                or_(*(_tag_exists(models.GameMechanic, models.GameMechanic.mechanic_id, models.Mechanic, models.Mechanic.name == m) for m in mechanic_list))
            )

    if location is not None:
        if location == NO_LOCATION_SENTINEL:
            query = query.filter(or_(models.Game.location.is_(None), models.Game.location == ""))
        else:
            query = query.filter(models.Game.location == location)

    if categories:
        category_list = [c.strip() for c in categories.split(",") if c.strip()]
        if len(category_list) > 50:
            raise HTTPException(status_code=422, detail="Too many categories specified (max 50)")
        if category_list:
            query = query.filter(
                or_(*(_tag_exists(models.GameCategory, models.GameCategory.category_id, models.Category, models.Category.name == c) for c in category_list))
            )

    SORT_COLUMNS = {
        "min_playtime": models.Game.min_playtime,
        "max_playtime": models.Game.max_playtime,
        "min_players": models.Game.min_players,
        "max_players": models.Game.max_players,
        "difficulty": models.Game.difficulty,
        "user_rating": models.Game.user_rating,
        "date_added": models.Game.date_added,
        "last_played": models.Game.last_played,
        "status": models.Game.status,
        "purchase_price": models.Game.purchase_price,
        "purchase_date": models.Game.purchase_date,
    }
    if not sort_by or sort_by == 'name':
        sort_column = case(
            (func.lower(models.Game.name).like('the %'), func.substr(models.Game.name, 5)),
            else_=models.Game.name,
        )
    else:
        sort_column = SORT_COLUMNS.get(sort_by, models.Game.name)
    if sort_dir == "desc":
        query = query.order_by(desc(sort_column))
    else:
        query = query.order_by(asc(sort_column))

    total_count = query.count()
    if limit is not None:
        query = query.offset(offset).limit(limit)
    games = query.all()
    results = build_game_responses(games, db)

    resp = JSONResponse(content=[r.model_dump(mode="json") for r in results])
    resp.headers["ETag"] = etag
    resp.headers["X-Total-Count"] = str(total_count)
    resp.headers["Cache-Control"] = "private, no-cache"
    return resp


@router.get("/recently-played", response_model=List[schemas.GameResponse])
def get_recently_played(
    limit: int = Query(8, ge=1, le=50),
    db: Session = Depends(get_db),
):
    """Return the most recently played owned base games, sorted by last_played desc."""
    games = (
        db.query(models.Game)
        .filter(
            models.Game.status == "owned",
            models.Game.parent_game_id.is_(None),
            models.Game.last_played.isnot(None),
        )
        .order_by(models.Game.last_played.desc())
        .limit(limit)
        .all()
    )
    return build_game_responses(games, db)


# ===== Backup =====

# Track temporary backup files so they are cleaned up on shutdown even if the
# background task that normally removes them never runs (e.g. server crash).
_temp_backup_files: set[str] = set()

def _cleanup_temp_backups():
    for path in list(_temp_backup_files):
        safe_delete_file(path)
    _temp_backup_files.clear()

atexit.register(_cleanup_temp_backups)


@router.get("/backup")
def download_backup(background_tasks: BackgroundTasks):
    """
    Create a ZIP backup of the database and media files (images, instructions, gallery).
    The ZIP is streamed directly — nothing is persisted to disk permanently.
    """
    data_dir = os.getenv("DATA_DIR", "/app/data")
    db_url = os.getenv("DATABASE_URL", "sqlite:///./data/cardboard.db")

    # Strip SQLite URL prefix to get the file path
    db_path = db_url.replace("sqlite+aiosqlite:///", "").replace("sqlite:///", "")
    if not os.path.isabs(db_path):
        db_path = os.path.join("/app", db_path)

    if not os.path.isfile(db_path):
        raise HTTPException(status_code=500, detail="Database file not found")

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    zip_filename = f"cardboard-backup-{ts}.zip"

    # Write to a named temp file so FileResponse can seek/stat it
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    _temp_backup_files.add(tmp.name)

    # Use SQLite backup API — safe with active connections
    db_tmp = tmp.name + ".db"
    try:
        src = sqlite3.connect(db_path)
        dst = sqlite3.connect(db_tmp)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()

        with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(db_tmp, "cardboard.db")
            for subdir in ["images", "instructions", "gallery", "avatars"]:
                dir_path = os.path.join(data_dir, subdir)
                for f in glob.glob(os.path.join(dir_path, "**"), recursive=True):
                    if os.path.isfile(f):
                        zf.write(f, os.path.relpath(f, data_dir))
    finally:
        if os.path.exists(db_tmp):
            os.remove(db_tmp)

    size_mb = round(os.path.getsize(tmp.name) / 1_048_576, 1)
    logger.info("Backup created: %s (%.1f MB)", zip_filename, size_mb)

    try:
        response = FileResponse(
            tmp.name,
            media_type="application/zip",
            filename=zip_filename,
        )
    except Exception:
        safe_delete_file(tmp.name)
        _temp_backup_files.discard(tmp.name)
        raise
    background_tasks.add_task(os.remove, tmp.name)
    background_tasks.add_task(_temp_backup_files.discard, tmp.name)
    return response


@router.get("/backup/json")
def download_json_backup(background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Export all games and sessions as JSON inside a ZIP (human-readable backup)."""
    data_dir = os.getenv("DATA_DIR", "/app/data")
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    zip_filename = f"cardboard-json-backup-{ts}.zip"

    games = db.query(models.Game).all()
    sessions = db.query(models.PlaySession).all()
    session_players = db.query(models.SessionPlayer, models.Player.name).join(
        models.Player, models.Player.id == models.SessionPlayer.player_id
    ).all()

    # Build player names by session
    players_by_session = {}
    for sp, name in session_players:
        players_by_session.setdefault(sp.session_id, []).append(name)

    games_data = [
        {k: v for k, v in g.__dict__.items() if not k.startswith('_')}
        for g in games
    ]
    sessions_data = [
        {
            **{k: v for k, v in s.__dict__.items() if not k.startswith('_')},
            "players": players_by_session.get(s.id, []),
        }
        for s in sessions
    ]

    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    _temp_backup_files.add(tmp.name)
    try:
        with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("games.json", json.dumps(games_data, default=str, indent=2))
            zf.writestr("sessions.json", json.dumps(sessions_data, default=str, indent=2))
            for subdir in ["images", "gallery"]:
                dir_path = os.path.join(data_dir, subdir)
                for f_path in glob.glob(os.path.join(dir_path, "**"), recursive=True):
                    if os.path.isfile(f_path):
                        zf.write(f_path, os.path.join("media", os.path.relpath(f_path, data_dir)))
    except Exception as exc:
        safe_delete_file(tmp.name)
        _temp_backup_files.discard(tmp.name)
        logger.error("JSON backup failed: %s", exc)
        raise HTTPException(status_code=500, detail="Backup failed. Check server logs for details.")

    logger.info("JSON backup created: %s", zip_filename)

    try:
        response = FileResponse(
            tmp.name,
            media_type="application/zip",
            filename=zip_filename,
        )
    except Exception:
        safe_delete_file(tmp.name)
        raise
    background_tasks.add_task(os.remove, tmp.name)
    background_tasks.add_task(_temp_backup_files.discard, tmp.name)
    return response


@router.get("/export/static-html")
def export_static_html(db: Session = Depends(get_db)):
    """
    Export the collection as a self-contained static HTML page.
    CSS, shared-utils.js, and game data are all inlined so the file works
    when opened directly from disk with no server.
    Only games with share_hidden=False are included.
    """
    # ── 1. Query games ────────────────────────────────────────────────────────
    games = db.query(models.Game).filter(models.Game.share_hidden == False).all()
    results = build_game_responses(games, db)
    games_json = [r.model_dump(mode="json") for r in results]

    _MIME_MAP = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                 '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp'}

    for game_data in games_json:
        game_id = game_data.get('id')
        if game_data.get('image_cached') and game_data.get('image_ext'):
            image_path = os.path.join(IMAGES_DIR, f"{game_id}{game_data['image_ext']}")
            if os.path.isfile(image_path):
                try:
                    with open(image_path, 'rb') as fh:
                        b64 = base64.b64encode(fh.read()).decode('ascii')
                    mime = _MIME_MAP.get(game_data['image_ext'].lower(), 'image/jpeg')
                    game_data['image_url'] = f"data:{mime};base64,{b64}"
                except Exception as exc:
                    logger.warning("Failed to embed image for game %s: %s", game_id, exc)
                    game_data['image_url'] = None
            else:
                game_data['image_url'] = None
        # Any remaining /api/ URL is a server-relative path that won't work offline
        elif (game_data.get('image_url') or '').startswith('/api/'):
            game_data['image_url'] = None
        game_data.pop('image_cached', None)
        game_data.pop('image_ext', None)
        game_data.pop('image_cache_status', None)

    # ── 2. Read share.html template ───────────────────────────────────────────
    share_html_path = os.path.join(FRONTEND_PATH, "share.html")
    if not os.path.isfile(share_html_path):
        raise HTTPException(status_code=500, detail="share.html template not found")
    with open(share_html_path, 'r', encoding='utf-8') as fh:
        html = fh.read()

    # ── 3. Inline CSS (replace <link href="/css/style.css">) ─────────────────
    css_path = os.path.join(FRONTEND_PATH, "css", "style.css")
    if os.path.isfile(css_path):
        with open(css_path, 'r', encoding='utf-8') as fh:
            css_content = fh.read()
        html = html.replace(
            '<link rel="stylesheet" href="/css/style.css" />',
            f'<style>\n{css_content}\n</style>',
            1,
        )

    # ── 4. Inline shared-utils.js AND inject data variable ───────────────────
    # The data variable must be defined before the main <script> block that
    # reads window.__STATIC_COLLECTION__ at line 2 of that block.
    utils_path = os.path.join(FRONTEND_PATH, "js", "shared-utils.js")
    json_payload = json.dumps(games_json, separators=(',', ':'))
    # Prevent </script> in any string value from breaking out of the script block
    json_payload = json_payload.replace('</', '<\\/')
    data_assignment = f'window.__STATIC_COLLECTION__ = {json_payload};'
    if os.path.isfile(utils_path):
        with open(utils_path, 'r', encoding='utf-8') as fh:
            utils_content = fh.read()
        # Replace external script tag with inlined content + data variable
        inline_block = f'<script>\n{utils_content}\n{data_assignment}\n</script>'
        html = html.replace('<script src="/js/shared-utils.js"></script>', inline_block, 1)
    else:
        # Fallback: inject data variable before the main script block
        html = html.replace(
            '<script src="/js/shared-utils.js"></script>',
            f'<script>{data_assignment}</script>',
            1,
        )

    # ── 5. Remove absolute-path references that break offline use ─────────────
    # Favicon — just drop it; no functional impact
    html = html.replace('<link rel="icon" type="image/png" href="/cardboard-icon.png" />', '', 1)

    # Logo icon — embed as base64 if available, otherwise remove the <img>
    icon_path = os.path.join(FRONTEND_PATH, "cardboard-icon.png")
    if os.path.isfile(icon_path):
        with open(icon_path, 'rb') as fh:
            icon_b64 = base64.b64encode(fh.read()).decode('ascii')
        html = html.replace(
            'src="/cardboard-icon.png"',
            f'src="data:image/png;base64,{icon_b64}"',
        )
    else:
        html = html.replace('<img class="logo-icon" src="/cardboard-icon.png" alt="Cardboard" />', '', 1)

    # ── 6. Return as download ─────────────────────────────────────────────────
    ts = _date.today().strftime("%Y-%m-%d")
    filename = f"cardboard-collection-{ts}.html"
    return Response(
        content=html,
        media_type="text/html",
        headers={
            "Content-Disposition": f'attachment; filename="{_safe_header_filename(filename)}"',
            "Cache-Control": "no-cache",
        },
    )


@router.get("/export/pdf")
def export_pdf(db: Session = Depends(get_db)):
    """
    Export the collection as a PDF with cover image, title, description,
    difficulty, playtime, and player count for each game.
    Only games with share_hidden=False are included.
    """
    from html import escape as _html_escape, unescape as _html_unescape
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.lib import colors
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Image as RLImage,
        Table, TableStyle, HRFlowable, KeepTogether,
    )

    def _safe(text: str) -> str:
        """Strip HTML tags, collapse whitespace, then XML-escape for reportlab Paragraph."""
        text = _html_unescape(text)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        return _html_escape(text)

    games = db.query(models.Game).filter(models.Game.share_hidden == False).all()
    results = build_game_responses(games, db)

    buffer = io.BytesIO()
    PAGE_W, _ = letter
    MARGIN = 0.75 * inch
    IMG_W = 1.25 * inch
    IMG_H = 1.5 * inch        # portrait-friendly; most board game covers are taller than wide
    IMG_COL_W = IMG_W + 0.15 * inch  # image column width, gap between image and text
    TEXT_COL_W = PAGE_W - 2 * MARGIN - IMG_COL_W

    # Brand colours — warm palette matching the web app
    C_HEADING = colors.HexColor("#2b1d0e")
    C_SUB     = colors.HexColor("#8a7055")
    C_ACCENT  = colors.HexColor("#c9a84c")
    C_TITLE   = colors.HexColor("#2b1d0e")
    C_META    = colors.HexColor("#5c4535")
    C_DESC    = colors.HexColor("#3c2e22")
    C_DIVIDER = colors.HexColor("#e0c898")

    doc = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN,
        bottomMargin=MARGIN,
    )

    styles = getSampleStyleSheet()
    heading_style = ParagraphStyle(
        "CollHeading",
        parent=styles["Normal"],
        fontSize=22,
        leading=28,
        fontName="Times-Bold",   # closest PDF-standard serif to the app's Playfair Display
        textColor=C_HEADING,
        alignment=1,
        spaceAfter=4,
    )
    sub_style = ParagraphStyle(
        "CollSub",
        parent=styles["Normal"],
        fontSize=9,
        leading=13,
        fontName="Helvetica",
        textColor=C_SUB,
        alignment=1,
        spaceAfter=16,
    )
    title_style = ParagraphStyle(
        "GameTitle",
        parent=styles["Normal"],
        fontSize=13,
        leading=17,
        fontName="Times-Bold",
        textColor=C_TITLE,
        spaceAfter=3,
    )
    meta_style = ParagraphStyle(
        "GameMeta",
        parent=styles["Normal"],
        fontSize=8,
        leading=11,
        fontName="Helvetica",
        textColor=C_META,
        spaceAfter=5,
    )
    desc_style = ParagraphStyle(
        "GameDesc",
        parent=styles["Normal"],
        fontSize=8,
        leading=12,
        fontName="Helvetica",
        textColor=C_DESC,
    )

    def difficulty_label(d):
        if d is None:
            return None
        if d <= 1.5:
            label = "Very Easy"
        elif d <= 2.5:
            label = "Easy"
        elif d <= 3.5:
            label = "Medium"
        elif d <= 4.5:
            label = "Hard"
        else:
            label = "Very Hard"
        return f"{d:.1f}/5 ({label})"

    def load_cover(game):
        """Load a cached cover image and scale it to fit IMG_W × IMG_H preserving aspect ratio.

        Mirrors the fallback logic in GET /{game_id}/image: if image_ext is not stored
        (records cached before that column was introduced), glob for any file matching
        {game_id}.* so those images are not silently skipped.
        """
        try:
            if game.image_cached:
                # Primary path — extension is known
                if game.image_ext:
                    path = os.path.join(IMAGES_DIR, f"{game.id}{game.image_ext}")
                else:
                    # Fallback for legacy records where image_ext was not yet stored
                    matches = glob.glob(os.path.join(IMAGES_DIR, f"{game.id}.*"))
                    path = matches[0] if matches else None

                if path and os.path.isfile(path):
                    img = RLImage(path)
                    iw, ih = img.imageWidth, img.imageHeight
                    if iw > 0 and ih > 0:
                        scale = min(IMG_W / iw, IMG_H / ih)
                        img.drawWidth = iw * scale
                        img.drawHeight = ih * scale
                    else:
                        img.drawWidth = IMG_W
                        img.drawHeight = IMG_H
                    img.hAlign = "CENTER"
                    return img
        except Exception as exc:
            logger.warning("PDF: image load failed for game %s: %s", game.id, exc)
        return None

    story = []

    ts_display = _date.today().strftime("%B %d, %Y")
    story.append(Paragraph("Board Game Collection", heading_style))
    story.append(Paragraph(f"Generated {ts_display} · {len(results)} games", sub_style))
    story.append(HRFlowable(width="100%", thickness=2, color=C_DIVIDER, spaceAfter=10))

    GOLD = "#c9a84c"

    for game in results:
        meta_parts = []

        if game.min_players and game.max_players:
            val = str(game.min_players) if game.min_players == game.max_players else f"{game.min_players}–{game.max_players}"
            meta_parts.append(f'<font color="{GOLD}">Players</font> {val}')
        elif game.min_players:
            meta_parts.append(f'<font color="{GOLD}">Players</font> {game.min_players}+')

        if game.min_playtime and game.max_playtime:
            val = f"{game.min_playtime} min" if game.min_playtime == game.max_playtime else f"{game.min_playtime}–{game.max_playtime} min"
            meta_parts.append(f'<font color="{GOLD}">Time</font> {val}')
        elif game.min_playtime:
            meta_parts.append(f'<font color="{GOLD}">Time</font> {game.min_playtime}+ min')

        diff = difficulty_label(game.difficulty)
        if diff:
            meta_parts.append(f'<font color="{GOLD}">Difficulty</font> {diff}')

        desc = (game.description or "").strip()

        text_cells = [Paragraph(_safe(game.name), title_style)]
        if meta_parts:
            text_cells.append(Paragraph("  ·  ".join(meta_parts), meta_style))
        if desc:
            text_cells.append(Paragraph(_safe(desc), desc_style))

        cover = load_cover(game)
        if cover:
            row = [[cover, text_cells]]
            col_widths = [IMG_COL_W, TEXT_COL_W]
        else:
            row = [[text_cells]]
            col_widths = [PAGE_W - 2 * MARGIN]

        tbl = Table(row, colWidths=col_widths)
        tbl.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ("ALIGN", (0, 0), (0, 0), "CENTER"),
        ]))

        story.append(KeepTogether([tbl, Spacer(1, 6)]))
        story.append(HRFlowable(width="100%", thickness=0.5, color=C_DIVIDER, spaceAfter=8))

    doc.build(story)
    buffer.seek(0)

    filename = f"cardboard-collection-{_date.today().strftime('%Y-%m-%d')}.pdf"
    return Response(
        content=buffer.read(),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{_safe_header_filename(filename)}"',
            "Cache-Control": "no-cache",
        },
    )


@router.get("/export/json")
def export_json(db: Session = Depends(get_db)):
    """Export the full collection, sessions, and players as a JSON download."""
    games = db.query(models.Game).all()
    game_results = build_game_responses(games, db)
    sessions = db.query(models.PlaySession).all()
    # Pre-load all session-player rows with a single JOIN to avoid N+1 queries
    # and attribute access on non-existent ORM relationships.
    sp_rows = (
        db.query(models.SessionPlayer, models.Player)
        .join(models.Player, models.Player.id == models.SessionPlayer.player_id)
        .all()
    )
    sp_map: dict[int, list[dict]] = {}
    for sp, player in sp_rows:
        sp_map.setdefault(sp.session_id, []).append({"name": player.name, "score": sp.score})
    session_rows = []
    for s in sessions:
        d = schemas.PlaySessionResponse.model_validate(s).model_dump(mode="json")
        d["players"] = sp_map.get(s.id, [])
        session_rows.append(d)
    players = db.query(models.Player).all()
    player_rows = [schemas.PlayerResponse.model_validate(p).model_dump(mode="json") for p in players]
    payload = {
        "export_date": datetime.now(timezone.utc).isoformat(),
        "version": "1.0",
        "games": [r.model_dump(mode="json") for r in game_results],
        "sessions": session_rows,
        "players": player_rows,
    }
    ts = _date.today().strftime("%Y-%m-%d")
    filename = f"cardboard-export-{ts}.json"
    return Response(
        content=json.dumps(payload, default=str, indent=2),
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{_safe_header_filename(filename)}"',
            "Cache-Control": "no-cache",
        },
    )


@router.get("/export/csv")
def export_csv(db: Session = Depends(get_db)):
    """Export the full collection as a CSV download."""
    games = db.query(models.Game).all()
    results = build_game_responses(games, db)
    fields = ["name", "status", "year_published", "min_players", "max_players",
              "min_playtime", "max_playtime", "difficulty", "user_rating",
              "bgg_id", "bgg_rating", "purchase_price", "purchase_date",
              "purchase_location", "location", "condition", "edition",
              "last_played", "categories", "mechanics", "designers",
              "publishers", "labels", "user_notes"]
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fields, extrasaction='ignore')
    writer.writeheader()
    for r in results:
        row = r.model_dump(mode="json")
        for key in ("categories", "mechanics", "designers", "publishers", "labels"):
            val = row.get(key)
            if isinstance(val, str):
                try:
                    parsed = json.loads(val)
                    if isinstance(parsed, list):
                        row[key] = ";".join(parsed)
                except (json.JSONDecodeError, TypeError):
                    pass
        writer.writerow(row)
    ts = _date.today().strftime("%Y-%m-%d")
    filename = f"cardboard-collection-{ts}.csv"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{_safe_header_filename(filename)}"',
            "Cache-Control": "no-cache",
        },
    )


@router.get("/export/images")
def export_images(background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Export all locally-stored game images as a ZIP download."""
    games = db.query(models.Game).filter(models.Game.image_url.isnot(None)).all()
    ts = _date.today().strftime("%Y-%m-%d")
    filename = f"cardboard-images-{ts}.zip"
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as zf:
        for game in games:
            url = game.image_url
            if not url or url.startswith("http"):
                continue
            path = os.path.join(FRONTEND_PATH or ".", url.lstrip("/"))
            if os.path.isfile(path):
                arcname = f"game-{game.id}-{os.path.basename(path)}"
                zf.write(path, arcname)
    tmp.close()
    background_tasks.add_task(os.remove, tmp.name)
    return FileResponse(
        tmp.name,
        media_type="application/zip",
        filename=filename,
    )


RESTORE_MAX_BYTES = 500 * 1024 * 1024  # 500 MB
_MEDIA_DIRS = ["images", "gallery", "instructions", "avatars"]


async def _stream_backup_to_tempfile(file: UploadFile, suffix: str = ".zip", dir: str = None) -> tempfile.NamedTemporaryFile:
    """Stream an uploaded file to a temp file, enforcing RESTORE_MAX_BYTES."""
    kwargs = {"suffix": suffix, "delete": False}
    if dir:
        kwargs["dir"] = dir
    tmp = tempfile.NamedTemporaryFile(**kwargs)
    total = 0
    try:
        while True:
            chunk = await file.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > RESTORE_MAX_BYTES:
                tmp.close()
                os.unlink(tmp.name)
                raise HTTPException(status_code=413, detail="Backup file too large (max 500 MB)")
            tmp.write(chunk)
    except HTTPException:
        tmp.close()
        os.unlink(tmp.name)
        raise
    except Exception:
        tmp.close()
        os.unlink(tmp.name)
        raise
    tmp.close()
    return tmp


def _extract_and_validate_db(zf: zipfile.ZipFile, tmp_zip_name: str, db_suffix: str) -> tuple[sqlite3.Connection, str]:
    """Extract cardboard.db from a ZIP and return an open, integrity-checked connection."""
    if "cardboard.db" not in zf.namelist():
        raise HTTPException(status_code=422, detail="Invalid backup: cardboard.db not found in ZIP")
    db_tmp = tmp_zip_name + db_suffix
    with zf.open("cardboard.db") as src, open(db_tmp, "wb") as dst:
        dst.write(src.read())
    conn = sqlite3.connect(db_tmp)
    try:
        integrity = conn.execute("PRAGMA integrity_check").fetchone()
        if not integrity or integrity[0] != "ok":
            raise HTTPException(status_code=422, detail="Backup database failed integrity check")
    except HTTPException:
        conn.close()
        safe_delete_file(db_tmp)
        raise
    except sqlite3.DatabaseError:
        conn.close()
        safe_delete_file(db_tmp)
        raise HTTPException(status_code=422, detail="Backup database is corrupt or not a valid SQLite file")
    return conn, db_tmp


@router.post("/restore", status_code=200)
async def restore_backup(file: UploadFile = File(...)):
    """
    Restore from a ZIP backup created by GET /api/games/backup.
    The ZIP must contain a `cardboard.db` file.  Media files
    (images/, gallery/, instructions/) are also restored if present.
    The server restarts the database connection after the restore.
    """
    data_dir = os.getenv("DATA_DIR", "/app/data")
    db_url = os.getenv("DATABASE_URL", "sqlite:///./data/cardboard.db")
    db_path = db_url.replace("sqlite+aiosqlite:///", "").replace("sqlite:///", "")
    if not os.path.isabs(db_path):
        db_path = os.path.join("/app", db_path)

    validate_file_extension(file.filename or "", {".zip"}, "Only .zip backup files are allowed")

    db_tmp = None
    tmp_zip = None
    try:
        tmp_zip = await _stream_backup_to_tempfile(file, dir=data_dir)
        with zipfile.ZipFile(tmp_zip.name, "r") as zf:
            conn, db_tmp = _extract_and_validate_db(zf, tmp_zip.name, ".restore.db")
            conn.close()

            # Atomically replace the database — temp file is in same dir as db_path
            os.replace(db_tmp, db_path)
            db_tmp = None  # os.replace consumed it

            # Invalidate the connection pool so all future requests open fresh
            # connections against the restored file (old pooled connections still
            # point to the previous inode via SQLite WAL).
            engine.dispose()

            # Restore media directories (optional — skip missing)
            safe_data_dir = os.path.realpath(data_dir) + os.sep
            for arc_path in zf.namelist():
                if not any(arc_path.startswith(d + "/") for d in _MEDIA_DIRS):
                    continue
                dest = os.path.realpath(os.path.join(data_dir, arc_path))
                if not dest.startswith(safe_data_dir):
                    continue
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with zf.open(arc_path) as src, open(dest, "wb") as dst:
                    dst.write(src.read())

        logger.info("Restore completed from uploaded backup")
        return {"detail": "Restore successful. Reload the page to see your restored data."}

    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Restore failed: %s", exc)
        raise HTTPException(status_code=500, detail="Restore failed. The backup may be invalid.")
    finally:
        if tmp_zip:
            safe_delete_file(tmp_zip.name)
        if db_tmp:
            safe_delete_file(db_tmp)


@router.post("/restore/preview", status_code=200)
async def preview_restore(file: UploadFile = File(...)):
    """
    Preview a ZIP backup before restoring. Returns counts and game list
    so the user can verify they are uploading the right backup.
    Does NOT modify any data.
    """
    validate_file_extension(file.filename or "", {".zip"}, "Only .zip backup files are allowed")

    tmp_zip = None
    db_tmp = None
    try:
        tmp_zip = await _stream_backup_to_tempfile(file)
        with zipfile.ZipFile(tmp_zip.name, "r") as zf:
            names = zf.namelist()
            conn, db_tmp = _extract_and_validate_db(zf, tmp_zip.name, ".preview.db")
            try:
                game_count = conn.execute("SELECT COUNT(*) FROM games").fetchone()[0]
                session_count = conn.execute("SELECT COUNT(*) FROM play_sessions").fetchone()[0]
                player_count = conn.execute("SELECT COUNT(*) FROM players").fetchone()[0]

                status_counts = {}
                try:
                    for status, cnt in conn.execute(
                        "SELECT status, COUNT(*) FROM games GROUP BY status"
                    ).fetchall():
                        status_counts[status] = cnt
                except Exception:
                    pass

                try:
                    games_preview = [
                        row[0] for row in
                        conn.execute("SELECT name FROM games ORDER BY name LIMIT 15").fetchall()
                    ]
                except Exception:
                    games_preview = []

                media_count = sum(
                    1 for n in names
                    if any(n.startswith(d + "/") for d in _MEDIA_DIRS) and not n.endswith("/")
                )
            finally:
                conn.close()

        return {
            "game_count": game_count,
            "session_count": session_count,
            "player_count": player_count,
            "owned_count": status_counts.get("owned", 0),
            "wishlist_count": status_counts.get("wishlist", 0),
            "sold_count": status_counts.get("sold", 0),
            "games_preview": games_preview,
            "media_file_count": media_count,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Preview failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to preview backup")
    finally:
        if tmp_zip:
            safe_delete_file(tmp_zip.name)
        if db_tmp:
            safe_delete_file(db_tmp)


@router.get("/bgg-search")
def bgg_search(request: Request, q: str = Query(..., min_length=1, max_length=200)):
    _check_bgg_rate_limit(request)
    """Search BGG for boardgames matching the query string."""
    url = f"https://boardgamegeek.com/xmlapi2/search?query={urllib.parse.quote(q)}&type=boardgame"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Cardboard/1.0"})
        with _safe_opener_ssl.open(req, timeout=10) as resp:
            content = resp.read(2 * 1024 * 1024)
        root = ET.fromstring(content)
        results = []
        for item in root.findall("item")[:8]:
            bgg_id = int(item.get("id", 0))
            name_el = item.find("name[@type='primary']") or item.find("name")
            name = name_el.get("value", "").strip() if name_el is not None else ""
            year_el = item.find("yearpublished")
            year = year_el.get("value") if year_el is not None else None
            thumb_val = item.get("thumbnail") or item.findtext("thumbnail")
            thumbnail = ("https:" + thumb_val) if thumb_val and thumb_val.startswith("//") else thumb_val
            if bgg_id and name:
                results.append({"bgg_id": bgg_id, "name": name, "year_published": int(year) if year else None, "thumbnail": thumbnail})
        return results
    except Exception as exc:
        logger.warning("BGG search failed (%s): %s", type(exc).__name__, exc)
        raise HTTPException(status_code=502, detail="BGG search temporarily unavailable")


@router.get("/bgg-fetch/{bgg_id}")
def bgg_fetch(request: Request, bgg_id: int):
    _check_bgg_rate_limit(request)
    """Fetch full BGG metadata for a given BGG ID and return as game fields."""
    item = _fetch_bgg_thing(bgg_id)
    if item is None:
        raise HTTPException(status_code=502, detail="Failed to fetch from BGG")
    data = _parse_bgg_item(item)
    data["bgg_id"] = bgg_id
    return data


@router.get("/{game_id}", response_model=schemas.GameResponse)
def get_game(game_id: int, db: Session = Depends(get_db)):
    game = get_game_or_404(game_id, db)
    _load_tags([game], db)
    return _attach_parent_name(game, db)


@router.get("/{game_id}/session-summary", response_model=schemas.SessionSummaryResponse)
def get_session_summary(game_id: int, db: Session = Depends(get_db)):
    get_game_or_404(game_id, db)
    row = (
        db.query(
            func.count(models.PlaySession.id),
            func.coalesce(func.sum(models.PlaySession.duration_minutes), 0),
        )
        .filter(models.PlaySession.game_id == game_id)
        .first()
    )
    return schemas.SessionSummaryResponse(
        session_count=int(row[0] or 0),
        total_minutes=int(row[1] or 0),
    )


@router.get("/{game_id}/similar", response_model=List[schemas.GameSuggestion])
def get_similar_games(game_id: int, db: Session = Depends(get_db)):
    game = get_game_or_404(game_id, db)

    # Load tags for the source game from junction tables
    game_categories = set(
        name for (name,) in
        db.query(models.Category.name)
        .join(models.GameCategory, models.GameCategory.category_id == models.Category.id)
        .filter(models.GameCategory.game_id == game_id)
        .all()
    )
    game_mechanics = set(
        name for (name,) in
        db.query(models.Mechanic.name)
        .join(models.GameMechanic, models.GameMechanic.mechanic_id == models.Mechanic.id)
        .filter(models.GameMechanic.game_id == game_id)
        .all()
    )

    candidates = (
        db.query(
            models.Game.id, models.Game.name,
            models.Game.min_players, models.Game.max_players,
            models.Game.difficulty, models.Game.image_url,
            models.Game.min_playtime, models.Game.max_playtime,
            models.Game.user_rating, models.Game.last_played,
        )
        .filter(models.Game.id != game_id, models.Game.status == 'owned')
        .all()
    )

    # Batch-load categories and mechanics for all candidates
    candidate_ids = [c.id for c in candidates]
    cat_rows = (
        db.query(models.GameCategory.game_id, models.Category.name)
        .join(models.Category, models.GameCategory.category_id == models.Category.id)
        .filter(models.GameCategory.game_id.in_(candidate_ids))
        .all()
    )
    mech_rows = (
        db.query(models.GameMechanic.game_id, models.Mechanic.name)
        .join(models.Mechanic, models.GameMechanic.mechanic_id == models.Mechanic.id)
        .filter(models.GameMechanic.game_id.in_(candidate_ids))
        .all()
    )
    cats_by_game: dict[int, set] = {}
    for gid, name in cat_rows:
        cats_by_game.setdefault(gid, set()).add(name)
    mechs_by_game: dict[int, set] = {}
    for gid, name in mech_rows:
        mechs_by_game.setdefault(gid, set()).add(name)

    # IDF: count how many games carry each tag across the whole candidate pool
    total_games = len(candidates) + 1  # +1 for source game
    cat_freq: dict[str, int] = {}
    for _, name in cat_rows:
        cat_freq[name] = cat_freq.get(name, 0) + 1
    mech_freq: dict[str, int] = {}
    for _, name in mech_rows:
        mech_freq[name] = mech_freq.get(name, 0) + 1

    def _idf(tag: str, freq_map: dict[str, int]) -> float:
        df = freq_map.get(tag, 1)
        return math.log(total_games / df) + 1.0

    scored = []
    for c in candidates:
        shared_cats = game_categories & cats_by_game.get(c.id, set())
        shared_mechs = game_mechanics & mechs_by_game.get(c.id, set())

        cat_score = sum(_idf(t, cat_freq) for t in shared_cats)
        mech_score = sum(_idf(t, mech_freq) * 1.5 for t in shared_mechs)

        # Normalize by tag-set sizes so games with many tags don't dominate
        total_tags_source = len(game_categories) + len(game_mechanics)
        total_tags_cand = len(cats_by_game.get(c.id, set())) + len(mechs_by_game.get(c.id, set()))
        denom = math.sqrt(total_tags_source + total_tags_cand) if (total_tags_source + total_tags_cand) > 0 else 1.0
        score = (cat_score + mech_score) / denom

        # Player-count Jaccard overlap
        if all(x is not None for x in [game.min_players, game.max_players, c.min_players, c.max_players]):
            overlap_lo = max(game.min_players, c.min_players)
            overlap_hi = min(game.max_players, c.max_players)
            if overlap_hi >= overlap_lo:
                overlap = overlap_hi - overlap_lo + 1
                union = (game.max_players - game.min_players + 1) + (c.max_players - c.min_players + 1) - overlap
                score += overlap / union

        # Graduated difficulty — linear decay from +1.5 (identical) to 0 (gap ≥ 2.0)
        if game.difficulty and c.difficulty:
            diff_gap = abs(game.difficulty - c.difficulty)
            score += max(0.0, 1.5 * (1.0 - diff_gap / 2.0))

        if score > 0:
            scored.append((score, c))

    scored.sort(key=lambda x: -x[0])
    return [
        schemas.GameSuggestion(
            id=c.id,
            name=c.name,
            image_url=c.image_url,
            min_players=c.min_players,
            max_players=c.max_players,
            min_playtime=c.min_playtime,
            max_playtime=c.max_playtime,
            difficulty=c.difficulty,
            user_rating=c.user_rating,
            last_played=c.last_played,
        )
        for _, c in scored[:4]
    ]


def _validate_parent_game_id(parent_id: Optional[int], self_id: Optional[int], db: Session) -> None:
    """Validate parent_game_id: must exist, not self, not itself an expansion."""
    if parent_id is None:
        return
    if self_id is not None and parent_id == self_id:
        raise HTTPException(status_code=400, detail="A game cannot be its own parent")
    parent = db.query(models.Game).filter(models.Game.id == parent_id).first()
    if not parent:
        raise HTTPException(status_code=400, detail="Parent game not found")
    if parent.parent_game_id is not None:
        raise HTTPException(status_code=400, detail="Cannot nest expansions — the target game is already an expansion")


@router.get("/check-duplicate", response_model=schemas.DuplicateCheckResponse)
def check_duplicate(
    name: str = Query(..., min_length=1, max_length=255),
    bgg_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
):
    """Check for potential duplicate games before adding a new one."""
    name_lower = name.strip().lower()
    if not name_lower:
        return schemas.DuplicateCheckResponse(duplicates=[])

    # Fetch all games for comparison (collection is typically small enough)
    games = db.query(models.Game.id, models.Game.name, models.Game.status, models.Game.bgg_id).all()

    results: list[schemas.DuplicateCheckEntry] = []

    for g in games:
        reason = None
        g_name_lower = (g.name or "").lower()

        if g_name_lower == name_lower:
            reason = "exact_name"
        elif bgg_id is not None and g.bgg_id == bgg_id:
            reason = "same_bgg_id"
        elif _possible_expansion(name_lower, g_name_lower):
            reason = "possible_expansion"
        elif _fuzzy_match(name_lower, g_name_lower):
            reason = "similar_name"

        if reason:
            results.append(schemas.DuplicateCheckEntry(
                id=g.id, name=g.name, status=g.status or "owned",
                bgg_id=g.bgg_id, reason=reason,
            ))

    return schemas.DuplicateCheckResponse(duplicates=results[:5])


def _fuzzy_match(a: str, b: str) -> bool:
    """Simple fuzzy match: one contains the other (min 3 chars) or similarity ratio > 0.8."""
    if (a in b or b in a) and len(a) > 2 and len(b) > 2:
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() > 0.8


def _possible_expansion(name: str, candidate: str) -> bool:
    """Detect if name looks like an expansion of candidate or vice versa."""
    exp_markers = ["mini expansion", "expansion for", "expansion:", "expansion", "promo", "exp"]
    name_has_marker = any(m in name for m in exp_markers)
    cand_has_marker = any(m in candidate for m in exp_markers)
    if not name_has_marker and not cand_has_marker:
        return False
    # Strip markers and compare core names
    core_name = name
    core_cand = candidate
    for m in exp_markers:
        core_name = core_name.replace(m, "").strip(" :-")
        core_cand = core_cand.replace(m, "").strip(" :-")
    return core_name == core_cand or core_name in core_cand or core_cand in core_name


@router.post("/", response_model=schemas.GameResponse, status_code=201)
def create_game(
    game: schemas.GameCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    _validate_parent_game_id(game.parent_game_id, None, db)
    data = game.model_dump()

    # Separate tag fields — they live only in junction tables, not on the model
    tag_data = {k: data.pop(k) for k in list(data) if k in _TAG_FIELD_NAMES}

    # Duplicate check: match by BGG ID (if provided) or case-insensitive name
    name = (data.get("name") or "").strip()
    dup_filters = []
    if data.get("bgg_id"):
        dup_filters.append(models.Game.bgg_id == data["bgg_id"])
    if name:
        dup_filters.append(models.Game.name.ilike(name))
    if dup_filters:
        existing = db.query(models.Game).filter(or_(*dup_filters)).first()
        if existing:
            if data.get("bgg_id") and existing.bgg_id == data["bgg_id"]:
                raise HTTPException(
                    status_code=409,
                    detail=f"A game with BGG ID {data['bgg_id']} already exists ('{existing.name}').",
                )
            raise HTTPException(
                status_code=409,
                detail=f"A game named '{existing.name}' already exists.",
            )

    db_game = models.Game(**data)
    db.add(db_game)
    db.flush()
    _save_tags(db_game.id, tag_data, db)
    db.commit()
    db.refresh(db_game)
    _load_tags([db_game], db)
    logger.info("Game added: id=%d name=%r", db_game.id, db_game.name)

    if db_game.image_url and not db_game.image_url.startswith("/api/"):
        db_game.image_cache_status = "pending"
        db.commit()
        background_tasks.add_task(_cache_game_image, db_game.id, db_game.image_url)
    else:
        db_game.image_cache_status = None

    return _attach_parent_name(db_game, db)


@router.patch("/{game_id}", response_model=schemas.GameResponse)
def update_game(
    game_id: int,
    game: schemas.GameUpdate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    db_game = get_game_or_404(game_id, db)

    update_data = game.model_dump(exclude_unset=True)

    if "parent_game_id" in update_data:
        _validate_parent_game_id(update_data["parent_game_id"], game_id, db)

    # If image_url is being explicitly changed, clean up the old cached file first.
    new_image_url = None
    if "image_url" in update_data:
        new_image_url = update_data["image_url"] or None
        update_data["image_url"] = new_image_url  # normalise empty string → None
        if not new_image_url or not new_image_url.startswith("/api/"):
            _delete_cached_image(game_id)
            db_game.image_cached = False

    # Separate tag fields — they live only in junction tables, not on the model
    tag_data = {k: update_data.pop(k) for k in list(update_data) if k in _TAG_FIELD_NAMES}

    for field, value in update_data.items():
        setattr(db_game, field, value)

    _save_tags(game_id, tag_data, db)
    db.commit()
    db.refresh(db_game)
    _load_tags([db_game], db)
    logger.info("Game updated: id=%d name=%r", db_game.id, db_game.name)

    if new_image_url and not new_image_url.startswith("/api/"):
        db_game.image_cache_status = "pending"
        db.commit()
        background_tasks.add_task(_cache_game_image, game_id, new_image_url)
    elif "image_url" in update_data:
        # image_url was explicitly cleared or set to a local path
        db_game.image_cache_status = None
        db.commit()

    return _attach_parent_name(db_game, db)


@router.delete("/{game_id}", status_code=204)
def delete_game(game_id: int, db: Session = Depends(get_db)):
    db_game = get_game_or_404(game_id, db)

    logger.info("Game deleted: id=%d name=%r", db_game.id, db_game.name)

    # Clean up files
    _delete_cached_image(game_id)
    if db_game.instructions_filename:
        safe_delete_file(_instructions_path(game_id, db_game.instructions_filename))
    delete_all_gallery_images(game_id, db)

    # Detach any expansions that had this game as their parent
    db.query(models.Game).filter(models.Game.parent_game_id == game_id)\
        .update({"parent_game_id": None})

    # Delete associated play sessions
    db.query(models.PlaySession).filter(models.PlaySession.game_id == game_id).delete()

    db.delete(db_game)
    db.commit()


# ---------------------------------------------------------------------------
# Cached image endpoint
# ---------------------------------------------------------------------------

@router.get("/{game_id}/image")
def get_game_image(game_id: int, db: Session = Depends(get_db)):
    db_game = db.query(models.Game).filter(models.Game.id == game_id).first()
    if db_game and db_game.image_ext:
        base_dir = os.path.realpath(IMAGES_DIR)
        candidate = os.path.realpath(os.path.join(IMAGES_DIR, f"{game_id}{db_game.image_ext}"))
        if not candidate.startswith(base_dir + os.sep) or not os.path.isfile(candidate):
            raise HTTPException(status_code=404, detail="Image not cached")
        return FileResponse(candidate, headers={"Cache-Control": "public, max-age=604800"})
    # Fallback: glob for images cached before image_ext was introduced
    matches = glob.glob(os.path.join(IMAGES_DIR, f"{game_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Image not cached")
    base_dir = os.path.realpath(IMAGES_DIR)
    candidate = os.path.realpath(matches[0])
    if not candidate.startswith(base_dir + os.sep) or not os.path.isfile(candidate):
        raise HTTPException(status_code=404, detail="Image not cached")
    return FileResponse(candidate, headers={"Cache-Control": "public, max-age=604800"})


# ---------------------------------------------------------------------------
# Image upload endpoint
# ---------------------------------------------------------------------------

@router.post("/{game_id}/image", status_code=204)
async def upload_image(game_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)):
    db_game = get_game_or_404(game_id, db)

    safe_name = _safe_filename(file.filename or "image.jpg")
    ext = validate_file_extension(safe_name, ALLOWED_IMAGE_EXTENSIONS, "Only image files (.jpg, .png, .gif, .webp) are allowed")

    content = await file.read()
    if len(content) > MAX_IMAGE_SIZE:
        raise HTTPException(status_code=413, detail="File exceeds 10 MB limit")

    os.makedirs(IMAGES_DIR, exist_ok=True)
    _delete_cached_image(game_id)

    dest = os.path.join(IMAGES_DIR, f"{game_id}{ext}")
    safe_write_file(dest, content, f"Failed to write image for game {game_id}", "Failed to save image to disk")

    db_game.image_url = f"/api/games/{game_id}/image"
    db_game.image_cached = True
    db_game.image_ext = ext
    db.commit()
    logger.info("Image uploaded for game %d: %s", game_id, safe_name)


@router.delete("/{game_id}/image", status_code=204)
def delete_image(game_id: int, db: Session = Depends(get_db)):
    db_game = get_game_or_404(game_id, db)

    _delete_cached_image(game_id)
    db_game.image_url = None
    db_game.image_cached = False
    db_game.image_ext = None
    db.commit()
    logger.info("Image deleted for game %d", game_id)


# ---------------------------------------------------------------------------
# Instructions endpoints
# ---------------------------------------------------------------------------

@router.post("/{game_id}/instructions", status_code=204)
async def upload_instructions(game_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)):
    db_game = get_game_or_404(game_id, db)

    safe_name = _safe_filename(file.filename or "instructions")
    validate_file_extension(safe_name, ALLOWED_INSTRUCTIONS_EXTENSIONS, "Only .pdf and .txt files are allowed")

    content = await file.read()
    if len(content) > MAX_INSTRUCTIONS_SIZE:
        raise HTTPException(status_code=413, detail="File exceeds 20 MB limit")

    os.makedirs(INSTRUCTIONS_DIR, exist_ok=True)

    # Remove old file if present
    if db_game.instructions_filename:
        safe_delete_file(_instructions_path(game_id, db_game.instructions_filename))

    dest = _instructions_path(game_id, safe_name)
    safe_write_file(dest, content, f"Failed to write instructions for game {game_id}", "Failed to save instructions to disk")

    db_game.instructions_filename = safe_name
    db.commit()
    logger.info("Instructions uploaded for game %d: %s", game_id, safe_name)


@router.get("/{game_id}/instructions")
def get_instructions(game_id: int, db: Session = Depends(get_db)):
    db_game = get_game_or_404(game_id, db)
    if not db_game.instructions_filename:
        raise HTTPException(status_code=404, detail="No instructions uploaded")

    path = _instructions_path(game_id, db_game.instructions_filename)
    path = _verify_within(path, INSTRUCTIONS_DIR)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Instructions file not found")

    ext = os.path.splitext(db_game.instructions_filename)[1].lower()
    media_type = "application/pdf" if ext == ".pdf" else "text/plain"
    disposition = "inline" if ext == ".pdf" else "attachment"

    return FileResponse(
        path,
        media_type=media_type,
        headers={
            "Content-Disposition": f'{disposition}; filename="{_safe_header_filename(db_game.instructions_filename)}"',
            "Cache-Control": "public, max-age=604800",
        },
    )


@router.delete("/{game_id}/instructions", status_code=204)
def delete_instructions(game_id: int, db: Session = Depends(get_db)):
    db_game = get_game_or_404(game_id, db)
    if not db_game.instructions_filename:
        raise HTTPException(status_code=404, detail="No instructions to delete")

    safe_delete_file(_instructions_path(game_id, db_game.instructions_filename))
    db_game.instructions_filename = None
    db.commit()
    logger.info("Instructions deleted for game %d", game_id)


# ===== BGG XML Import =====


@router.post("/import/bgg")
async def import_bgg(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Import a BoardGameGeek XML collection export (collectionlist format)."""
    content = await file.read(BGG_IMPORT_MAX_BYTES + 1)
    if len(content) > BGG_IMPORT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 10 MB)")

    try:
        root = ET.fromstring(content)
    except ET.ParseError as exc:
        logger.warning("BGG XML import parse error: %s", exc)
        raise HTTPException(status_code=400, detail="Invalid XML file")

    # BGG exports use <items> as root with <item> children, or <boardgames> with <boardgame>
    items = root.findall("item") or root.findall("boardgame")
    if not items:
        raise HTTPException(status_code=400, detail="No game items found in XML — is this a BGG collection export?")

    results = {"imported": 0, "skipped": 0, "errors": []}

    for item in items:
        try:
            # Name: BGG exports have <name sortindex="1">Title</name>
            name_el = item.find("name[@sortindex='1']")
            if name_el is None:
                name_el = item.find("name")
            name = (name_el.text or "").strip() if name_el is not None else ""
            if not name:
                results["skipped"] += 1
                continue

            # Skip duplicates (case-insensitive by name)
            if db.query(models.Game).filter(
                models.Game.name.ilike(name)
            ).first():
                results["skipped"] += 1
                continue

            # BGG object ID — extract early to skip duplicates before expensive parsing
            bgg_id = None
            try:
                bgg_id_str = item.get("objectid") or ""
                bgg_id = int(bgg_id_str) if bgg_id_str else None
            except (ValueError, TypeError):
                pass

            if bgg_id and db.query(models.Game).filter(models.Game.bgg_id == bgg_id).first():
                results["skipped"] += 1
                continue

            # Status
            status_el = item.find("status")
            status = "owned"
            if status_el is not None:
                if status_el.get("wishlist") == "1":
                    status = "wishlist"
                elif status_el.get("prevowned") == "1":
                    status = "sold"

            # Year
            year_text = item.findtext("yearpublished", "").strip()
            try:
                year = int(year_text) or None
            except ValueError:
                year = None
            if year is not None and not (1800 <= year <= 2099):
                year = None

            # Players / playtime from <stats> attributes
            stats_el = item.find("stats")
            def _int_attr(el, attr):
                if el is None:
                    return None
                try:
                    v = int(el.get(attr, "0") or "0")
                    return v if v > 0 else None
                except ValueError:
                    return None

            min_players  = _int_attr(stats_el, "minplayers")
            max_players  = _int_attr(stats_el, "maxplayers")
            min_playtime = _int_attr(stats_el, "minplaytime")
            max_playtime = _int_attr(stats_el, "maxplaytime")

            # User rating
            user_rating = None
            bgg_rating = None
            rating_el = item.find(".//stats/rating") if stats_el is not None else None
            if rating_el is not None:
                val = rating_el.get("value", "N/A")
                if val not in ("N/A", "0", ""):
                    try:
                        user_rating = round(min(10.0, max(1.0, float(val))), 1)
                    except ValueError:
                        pass
                # BGG community average
                avg_el = rating_el.find("average")
                if avg_el is not None:
                    try:
                        avg_val = float(avg_el.get("value", "0") or "0")
                        bgg_rating = round(min(10.0, max(1.0, avg_val)), 2) if avg_val > 0 else None
                    except (ValueError, TypeError):
                        pass

            # Notes / comment
            notes = (item.findtext("comment") or "").strip() or None

            # Image URL
            image_url = (item.findtext("image") or "").strip()
            if image_url.startswith("//"):
                image_url = "https:" + image_url
            image_url = image_url or None

            game = models.Game(
                name=name,
                status=status,
                year_published=year,
                min_players=min_players,
                max_players=max_players,
                min_playtime=min_playtime,
                max_playtime=max_playtime,
                user_rating=user_rating,
                bgg_id=bgg_id,
                bgg_rating=bgg_rating,
                user_notes=notes,
                image_url=image_url,
            )
            db.add(game)
            results["imported"] += 1

        except (AttributeError, ValueError, TypeError, KeyError, OSError) as exc:
            row_name = locals().get("name") or "unknown"
            results["errors"].append(f"Skipped '{row_name}': {type(exc).__name__}")
            logger.debug("BGG import row error for '%s': %s", row_name, exc)

    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error("BGG import commit failed: %s", exc)
        results["errors"].append("Database commit failed — no games were saved")
    logger.info("BGG import: imported=%d skipped=%d errors=%d", results["imported"], results["skipped"], len(results["errors"]))
    return results


# ===== BGG Metadata Refresh =====

BGG_API_URL = "https://boardgamegeek.com/xmlapi2/thing?id={bgg_id}&stats=1"
BGG_SEARCH_URL = "https://boardgamegeek.com/xmlapi2/search?query={query}&type=boardgame&exact=1"


def _fetch_bgg_thing(bgg_id: int) -> Optional[ET.Element]:
    """Fetch BGG XML for a thing ID. Returns the <item> element or None.

    BGG returns HTTP 202 when the request is queued for processing — retries
    up to 3 times with a 2-second delay before giving up.
    """
    url = BGG_API_URL.format(bgg_id=bgg_id)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Cardboard/1.0"})
        content = None
        for attempt in range(3):
            with _safe_opener_ssl.open(req, timeout=15) as resp:
                if resp.status == 202:
                    logger.info("BGG returned 202 for id=%d, retry %d/3", bgg_id, attempt + 1)
                    time.sleep(2)
                    continue
                content = resp.read(5 * 1024 * 1024)
                break
        if content is None:
            logger.warning("BGG fetch gave up after 3 x 202 for id=%d", bgg_id)
            return None
        root = ET.fromstring(content)
        return root.find("item")
    except Exception as exc:
        logger.warning("BGG fetch failed for id=%d: %s", bgg_id, exc)
        return None


def _parse_bgg_item(item: ET.Element) -> dict:
    """Extract game fields from a BGG <item> element."""
    def _int_val(tag, attr="value"):
        el = item.find(tag)
        if el is None:
            return None
        try:
            v = int(el.get(attr, "0") or el.text or "0")
            return v if v > 0 else None
        except (ValueError, TypeError):
            return None

    def _float_val(tag, attr="value"):
        el = item.find(tag)
        if el is None:
            return None
        try:
            return float(el.get(attr) or el.text or "0")
        except (ValueError, TypeError):
            return None

    # Primary name
    name_el = item.find("name[@type='primary']") or item.find("name")
    name = name_el.get("value", "").strip() if name_el is not None else ""

    # Description
    desc_el = item.find("description")
    description = (desc_el.text or "").strip()[:5000] if desc_el is not None else None

    # Year
    year = _int_val("yearpublished")

    # Players / playtime / difficulty
    min_players = _int_val("minplayers")
    max_players = _int_val("maxplayers")
    min_playtime = _int_val("minplaytime")
    max_playtime = _int_val("maxplaytime")

    difficulty = None
    weight_el = item.find(".//averageweight")
    if weight_el is not None:
        try:
            w = float(weight_el.get("value", "0"))
            difficulty = round(min(5.0, max(1.0, w)), 2) if w > 0 else None
        except (ValueError, TypeError):
            pass

    # BGG community rating
    bgg_rating = None
    avg_el = item.find(".//average")
    if avg_el is not None:
        try:
            r = float(avg_el.get("value", "0"))
            bgg_rating = round(min(10.0, max(1.0, r)), 2) if r > 0 else None
        except (ValueError, TypeError):
            pass

    # Tags
    def _links(link_type):
        return json.dumps([el.get("value", "") for el in item.findall(f"link[@type='{link_type}']") if el.get("value")])

    categories = _links("boardgamecategory")
    mechanics = _links("boardgamemechanic")
    designers = _links("boardgamedesigner")
    publishers = _links("boardgamepublisher")

    # Image
    img_el = item.find("image")
    image_url = (img_el.text or "").strip() if img_el is not None else None
    if image_url and image_url.startswith("//"):
        image_url = "https:" + image_url

    return {
        "name": name,
        "description": description,
        "year_published": year,
        "min_players": min_players,
        "max_players": max_players,
        "min_playtime": min_playtime,
        "max_playtime": max_playtime,
        "difficulty": difficulty,
        "bgg_rating": bgg_rating,
        "categories": categories,
        "mechanics": mechanics,
        "designers": designers,
        "publishers": publishers,
        "image_url": image_url,
    }


@router.post("/{game_id}/refresh-bgg", response_model=schemas.GameResponse)
def refresh_from_bgg(
    game_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Re-fetch metadata from BGG and update the game record."""
    db_game = get_game_or_404(game_id, db)
    if not db_game.bgg_id:
        raise HTTPException(status_code=400, detail="Game has no BGG ID — add it manually first")

    item = _fetch_bgg_thing(db_game.bgg_id)
    if item is None:
        raise HTTPException(status_code=502, detail="Could not fetch data from BoardGameGeek")

    data = _parse_bgg_item(item)
    tag_data = {k: data.pop(k) for k in ["categories", "mechanics", "designers", "publishers"]}

    for field, value in data.items():
        if value is not None:
            setattr(db_game, field, value)

    db.flush()
    _save_tags(game_id, tag_data, db)
    db.commit()
    db.refresh(db_game)
    _load_tags([db_game], db)

    new_image = db_game.image_url
    if new_image and not new_image.startswith("/api/"):
        background_tasks.add_task(_cache_game_image, game_id, new_image)

    logger.info("BGG refresh: game_id=%d bgg_id=%d", game_id, db_game.bgg_id)
    return _attach_parent_name(db_game, db)


# ===== Game Night Suggest =====

@router.post("/suggest", response_model=List[schemas.GameSuggestion])
def suggest_games(body: schemas.SuggestRequest, db: Session = Depends(get_db)):
    """Return up to 5 game suggestions ranked for a game night."""
    from datetime import date, timedelta

    query = db.query(models.Game).filter(
        models.Game.status == "owned",
        models.Game.parent_game_id.is_(None),
    )

    if body.player_count:
        query = query.filter(
            (models.Game.min_players.is_(None)) | (models.Game.min_players <= body.player_count),
            (models.Game.max_players.is_(None)) | (models.Game.max_players >= body.player_count),
        )

    if body.max_minutes:
        query = query.filter(
            (models.Game.min_playtime.is_(None)) | (models.Game.min_playtime <= body.max_minutes),
        )

    games = query.all()

    # Count sessions per game
    session_counts = {
        row.game_id: row.count
        for row in db.query(
            models.PlaySession.game_id,
            func.count(models.PlaySession.id).label("count")
        ).group_by(models.PlaySession.game_id).all()
    }

    # Average per-session rating per game (1–5 scale)
    session_avg_ratings = {
        row.game_id: row.avg_rating
        for row in db.query(
            models.PlaySession.game_id,
            func.avg(models.PlaySession.session_rating).label("avg_rating")
        )
        .filter(models.PlaySession.session_rating.isnot(None))
        .group_by(models.PlaySession.game_id)
        .all()
    }

    today = date.today()
    recent_cutoff = today - timedelta(days=30)

    def _difficulty_band(d: Optional[float]) -> str:
        if d is None:   return "unknown"
        if d <= 2.0:    return "light"
        if d <= 3.5:    return "medium"
        return "heavy"

    scored = []
    for g in games:
        score = 0.0
        reasons = []
        count = session_counts.get(g.id, 0)

        if count == 0:
            # Scale discovery bonus by BGG quality hint so unplayed games don't unconditionally crowd out loved ones
            quality_hint = g.bgg_rating / 10.0 if g.bgg_rating else 0.5
            score += 1.5 + quality_hint  # range 1.5–2.5
            reasons.append("Never Played")

        # Priority-ordered quality signal: user rating > session avg > BGG rating > neutral prior
        avg_session = session_avg_ratings.get(g.id)
        if g.user_rating is not None:
            quality_score = g.user_rating / 2.0          # 0.5–5.0
        elif avg_session is not None:
            quality_score = float(avg_session)            # 1.0–5.0
        elif g.bgg_rating is not None:
            quality_score = g.bgg_rating / 2.0 * 0.7     # up to 3.5 (discounted: community, not personal)
        else:
            quality_score = 2.5                           # neutral prior

        score += quality_score

        if (g.user_rating or 0) >= 8 or (avg_session or 0) >= 4:
            reasons.append("High Rating")

        # Penalize games the user has explicitly disliked
        if g.user_rating is not None and g.user_rating <= 4:
            score -= (5 - g.user_rating) * 0.4           # rating 4 → -0.4, rating 1 → -1.6

        if g.last_played and g.last_played >= recent_cutoff:
            score -= 1  # played recently, penalise slightly
        elif count > 0 and g.last_played:
            reasons.append("Long Overdue" if (today - g.last_played).days > 180 else "Not Recently Played")

        if body.max_minutes and g.min_playtime and g.min_playtime <= body.max_minutes // 2:
            reasons.append("Quick Game")

        if g.difficulty and g.difficulty <= 2.0:
            reasons.append("Easy to Learn")

        scored.append((score, g, reasons))

    scored.sort(key=lambda x: -x[0])

    # Diversity cap: at most 3 results from the same difficulty band
    results = []
    band_counts: dict[str, int] = {}
    for score, g, reasons in scored:
        if len(results) >= 5:
            break
        band = _difficulty_band(g.difficulty)
        if band != "unknown" and band_counts.get(band, 0) >= 3:
            continue
        band_counts[band] = band_counts.get(band, 0) + 1
        results.append(schemas.GameSuggestion(
            id=g.id,
            name=g.name,
            image_url=g.image_url,
            min_players=g.min_players,
            max_players=g.max_players,
            min_playtime=g.min_playtime,
            max_playtime=g.max_playtime,
            difficulty=g.difficulty,
            user_rating=g.user_rating,
            last_played=g.last_played,
            reasons=reasons[:3],
        ))
    return results


# ===== Group Recommend (Player Matchmaking) =====

@router.post("/group-recommend", response_model=schemas.GroupRecommendResponse)
def group_recommend(body: schemas.GroupRecommendRequest, db: Session = Depends(get_db)):
    """Recommend games for a specific group of players."""
    from datetime import date, timedelta

    player_ids = body.player_ids
    player_count = len(player_ids)
    today = date.today()
    six_months_ago = today - timedelta(days=180)

    # Candidate games: owned, supports player count, not expansions
    query = db.query(models.Game).filter(
        models.Game.status == "owned",
        models.Game.parent_game_id.is_(None),
    )
    query = query.filter(
        (models.Game.min_players.is_(None)) | (models.Game.min_players <= player_count),
        (models.Game.max_players.is_(None)) | (models.Game.max_players >= player_count),
    )
    if body.max_minutes:
        query = query.filter(
            (models.Game.min_playtime.is_(None)) | (models.Game.min_playtime <= body.max_minutes),
        )
    if body.mechanic:
        query = query.join(models.GameMechanic, models.GameMechanic.game_id == models.Game.id).join(
            models.Mechanic, models.Mechanic.id == models.GameMechanic.mechanic_id
        ).filter(models.Mechanic.name == body.mechanic)

    games = query.all()
    if not games:
        return schemas.GroupRecommendResponse(recommendations=[])
    _load_tags(games, db)

    game_ids = [g.id for g in games]

    # Session counts per game
    session_counts = {
        row.game_id: row.count
        for row in db.query(
            models.PlaySession.game_id,
            func.count(models.PlaySession.id).label("count")
        ).filter(models.PlaySession.game_id.in_(game_ids)).group_by(models.PlaySession.game_id).all()
    }

    # For each game, find sessions where ALL requested players participated
    # and compute average session rating among those sessions
    all_sessions = (
        db.query(models.PlaySession.game_id, models.PlaySession.id, models.PlaySession.session_rating,
                 models.PlaySession.played_at)
        .filter(models.PlaySession.game_id.in_(game_ids))
        .all()
    )

    session_ids = [s.id for s in all_sessions]
    # Which sessions have which players
    session_players = (
        db.query(models.SessionPlayer.session_id, models.SessionPlayer.player_id)
        .filter(models.SessionPlayer.session_id.in_(session_ids))
        .all()
    )
    session_player_set: dict[int, set[int]] = {}
    for sid, pid in session_players:
        session_player_set.setdefault(sid, set()).add(pid)

    # Group stats per game
    group_stats: dict[int, dict] = {gid: {"group_sessions": 0, "avg_rating": None, "last_group_play": None}
                                     for gid in game_ids}
    for s in all_sessions:
        players_in_session = session_player_set.get(s.id, set())
        if player_ids and players_in_session.issuperset(set(player_ids)):
            gs = group_stats[s.game_id]
            gs["group_sessions"] += 1
            if s.session_rating is not None:
                if gs["avg_rating"] is None:
                    gs["avg_rating"] = []
                gs["avg_rating"].append(s.session_rating)
            if s.played_at and (gs["last_group_play"] is None or s.played_at > gs["last_group_play"]):
                gs["last_group_play"] = s.played_at

    for gid in group_stats:
        ar = group_stats[gid]["avg_rating"]
        if ar:
            group_stats[gid]["avg_rating"] = sum(ar) / len(ar)

    scored = []
    for g in games:
        score = 0.0
        reasons = []
        gs = group_stats.get(g.id, {"group_sessions": 0, "avg_rating": None, "last_group_play": None})
        group_sessions = gs["group_sessions"]
        avg_rating = gs["avg_rating"]
        last_group_play = gs["last_group_play"]
        total_sessions = session_counts.get(g.id, 0)

        # Unplayed by group = strong recommendation
        if group_sessions == 0:
            score += 30.0
            reasons.append("New for this group")
            if total_sessions > 0:
                reasons.append("Proven with others")
        else:
            score += 10.0
            if avg_rating is not None and avg_rating >= 4.0:
                score += 15.0
                reasons.append(f"Group loves it ({avg_rating:.1f}/5)")
            elif avg_rating is not None and avg_rating >= 3.0:
                score += 5.0
                reasons.append("Group enjoys it")
            else:
                reasons.append("Played before")

        # Recency penalty
        if last_group_play:
            days_since = (today - last_group_play).days
            if days_since < 30:
                score -= 15.0
            elif days_since < 90:
                score -= 5.0
            elif days_since > 180:
                score += 10.0
                reasons.append("Not played in 6+ months")

        # Player count exact fit bonus
        if g.min_players is not None and g.max_players is not None:
            if g.min_players == player_count or g.max_players == player_count:
                score += 5.0

        # User rating bonus
        if g.user_rating and g.user_rating >= 8:
            score += 10.0
            reasons.append("Personal favorite")
        elif g.user_rating and g.user_rating >= 6:
            score += 3.0

        scored.append((score, g, reasons))

    scored.sort(key=lambda x: -x[0])

    # Deduplicate reasons and cap results
    results = []
    seen_reasons: set[str] = set()
    for score, g, reasons in scored:
        if len(results) >= 5:
            break
        key_reason = reasons[0] if reasons else ""
        if key_reason and key_reason in seen_reasons and len(results) >= 2:
            continue
        if key_reason:
            seen_reasons.add(key_reason)
        confidence = max(0.0, min(1.0, score / 80.0))
        results.append(schemas.GroupRecommendEntry(
            game=schemas.GameOut.model_validate(g),
            reason=" · ".join(reasons[:2]) if reasons else "A good fit for your group",
            confidence=round(confidence, 2),
        ))

    return schemas.GroupRecommendResponse(recommendations=results)


# ===== BGG Play History Import =====


@router.post("/import/bgg-plays")
async def import_bgg_plays(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Import play history from a BGG plays XML export."""
    from routers.sessions import _sync_last_played

    content = await file.read(BGG_PLAYS_MAX_BYTES + 1)
    if len(content) > BGG_PLAYS_MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 20 MB)")

    try:
        root = ET.fromstring(content)
    except ET.ParseError as exc:
        logger.warning("BGG plays XML import parse error: %s", exc)
        raise HTTPException(status_code=400, detail="Invalid XML file")

    plays = root.findall("play")
    if not plays:
        raise HTTPException(status_code=400, detail="No play records found — is this a BGG plays export?")

    results = {"imported": 0, "skipped": 0, "errors": []}
    affected_game_ids = set()

    for play in plays:
        try:
            item_el = play.find("item")
            if item_el is None:
                results["skipped"] += 1
                continue

            game_name = (item_el.get("name") or "").strip()
            bgg_object_id = item_el.get("objectid")

            # Match game by bgg_id first, then by name
            game = None
            if bgg_object_id:
                try:
                    game = db.query(models.Game).filter(models.Game.bgg_id == int(bgg_object_id)).first()
                except (ValueError, TypeError):
                    pass
            if not game and game_name:
                game = db.query(models.Game).filter(models.Game.name.ilike(game_name)).first()

            if not game:
                results["skipped"] += 1
                continue

            affected_game_ids.add(game.id)

            date_str = play.get("date", "")
            try:
                from datetime import date as date_cls
                played_at = date_cls.fromisoformat(date_str)
            except (ValueError, TypeError):
                results["skipped"] += 1
                continue

            quantity = min(int(play.get("quantity", "1") or "1"), 50)
            player_count = None
            players_el = play.find("players")
            if players_el is not None:
                player_count = len(players_el.findall("player")) or None

            duration = None
            try:
                dur = int(play.get("length", "0") or "0")
                duration = dur if dur > 0 else None
            except (ValueError, TypeError):
                pass

            comment = (play.findtext("comments") or "").strip() or None

            existing_count = (
                db.query(func.count(models.PlaySession.id))
                .filter(
                    models.PlaySession.game_id == game.id,
                    models.PlaySession.played_at == played_at,
                )
                .scalar() or 0
            )
            for i in range(quantity):
                if i < existing_count:
                    results["skipped"] += 1
                    continue
                db_session = models.PlaySession(
                    game_id=game.id,
                    played_at=played_at,
                    player_count=player_count,
                    duration_minutes=duration,
                    notes=comment,
                )
                db.add(db_session)
                results["imported"] += 1

        except Exception as exc:
            row_name = locals().get("game_name") or "unknown"
            results["errors"].append(f"Skipped '{row_name}': {type(exc).__name__}")
            logger.debug("BGG plays import row error for '%s': %s", row_name, exc)

    db.flush()
    for gid in affected_game_ids:
        _sync_last_played(gid, db, commit=False)
    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error("BGG plays import commit failed: %s", exc)
        results["errors"].append("Database commit failed — no plays were saved")
        logger.info("BGG plays import: imported=%d skipped=%d errors=%d", results["imported"], results["skipped"], len(results["errors"]))
        return results

    logger.info("BGG plays import: imported=%d skipped=%d errors=%d", results["imported"], results["skipped"], len(results["errors"]))
    return results


# ===== CSV Import =====


@router.post("/import/csv")
async def import_csv(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Import games from a CSV file. Columns: name, status, user_rating, notes, labels, categories, mechanics."""
    content = await file.read(CSV_IMPORT_MAX_BYTES + 1)
    if len(content) > CSV_IMPORT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 5 MB)")

    try:
        text_content = content.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(text_content))
    except Exception as exc:
        logger.warning("CSV import parse error: %s", exc)
        raise HTTPException(status_code=400, detail="Could not parse CSV file")

    results = {"imported": 0, "skipped": 0, "errors": []}

    VALID_STATUSES = {"owned", "wishlist", "sold"}

    for row in reader:
        name = ""
        try:
            name = (row.get("name") or row.get("Name") or "").strip()
            if not name:
                results["skipped"] += 1
                continue

            if db.query(models.Game).filter(models.Game.name.ilike(name)).first():
                results["skipped"] += 1
                continue

            status_raw = (row.get("status") or row.get("Status") or "owned").strip().lower()
            status = status_raw if status_raw in VALID_STATUSES else "owned"

            user_rating = None
            rating_raw = (row.get("user_rating") or row.get("rating") or "").strip()
            if rating_raw:
                try:
                    user_rating = round(min(10.0, max(1.0, float(rating_raw))), 1)
                except ValueError:
                    pass

            notes_raw = (row.get("notes") or row.get("comment") or "").strip()
            notes = notes_raw[:NOTES_MAX_LENGTH] if notes_raw else None

            def _csv_to_json(val):
                val = (val or "").strip()
                if not val:
                    return None
                items = [x.strip() for x in val.split(";") if x.strip()]
                return json.dumps(items) if items else None

            categories = _csv_to_json(row.get("categories") or row.get("Categories"))
            mechanics = _csv_to_json(row.get("mechanics") or row.get("Mechanics"))
            labels = _csv_to_json(row.get("labels") or row.get("Labels"))

            # DB operations inside a savepoint so a row failure doesn't break the batch
            savepoint = db.begin_nested()
            try:
                game = models.Game(
                    name=name,
                    status=status,
                    user_rating=user_rating,
                    user_notes=notes,
                )
                db.add(game)
                db.flush()

                tag_data = {}
                if categories:
                    tag_data["categories"] = categories
                if mechanics:
                    tag_data["mechanics"] = mechanics
                if labels:
                    tag_data["labels"] = labels
                if tag_data:
                    _save_tags(game.id, tag_data, db)

                savepoint.commit()
                results["imported"] += 1
            except Exception:
                savepoint.rollback()
                raise

        except HTTPException as http_exc:
            results["errors"].append(f"Row '{name}': {http_exc.detail}")
        except Exception as exc:
            logger.debug("CSV import row error for '%s': %s", name, exc)
            results["errors"].append(f"Row '{name}': {type(exc).__name__}")

    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error("CSV import commit failed: %s", exc)
        results["errors"].append("Database commit failed — no games were saved")
        results["imported"] = 0
    logger.info("CSV import: imported=%d skipped=%d errors=%d", results["imported"], results["skipped"], len(results["errors"]))
    return results
