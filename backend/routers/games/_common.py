"""Shared helpers for the games router package.

Image caching, tag junction-table sync, and GameResponse assembly used across
the crud / bgg / imports / backup / recommend submodules. Single source of
truth for the mutable module state (image-cache semaphore, HTTP opener) and the
GameResponse builders re-used by routers.sharing and routers.stats.
"""
import glob
import json
import logging
import os
import tempfile
import threading as _threading
import urllib.request
from datetime import date as _date

import models
import schemas
from constants import MAX_IMAGE_SIZE
from database import SessionLocal
from fastapi import HTTPException
from PIL import Image
from sqlalchemy import func
from sqlalchemy.orm import Session
from utils import build_safe_opener, safe_delete_file, safe_image_ext, strip_image_metadata, validate_url_safety

logger = logging.getLogger("cardboard.games")

IMAGES_DIR = os.getenv("IMAGES_DIR", "/app/data/images")
INSTRUCTIONS_DIR = os.getenv("INSTRUCTIONS_DIR", "/app/data/instructions")

# Plain (non SSL-pinned) opener used by the background image-cache downloader.
_safe_opener = build_safe_opener()

# Limit concurrent image caching to avoid exhausting the SQLite connection pool
_cache_semaphore = _threading.BoundedSemaphore(2)

_safe_ext = safe_image_ext  # backward-compatible alias

THUMB_MAX_SIZE = 400  # max width/height in pixels for thumbnails


def _heat_level(last_played) -> int:
    if not last_played:
        return 0
    days = (_date.today() - last_played).days
    return 3 if days <= 14 else 2 if days <= 60 else 1 if days <= 180 else 0

def _delete_cached_image(game_id: int) -> None:
    for path in glob.glob(os.path.join(IMAGES_DIR, f"{game_id}.*")):
        safe_delete_file(path)
    # Also delete thumbnail
    for path in glob.glob(os.path.join(IMAGES_DIR, f"{game_id}_thumb.*")):
        safe_delete_file(path)


def _generate_thumbnail(src_path: str, game_id: int) -> str | None:
    """Generate a ~400px WebP thumbnail from src_path. Returns thumbnail filename or None on failure."""
    try:
        thumb_path = os.path.join(IMAGES_DIR, f"{game_id}_thumb.webp")
        with Image.open(src_path) as img:
            img.thumbnail((THUMB_MAX_SIZE, THUMB_MAX_SIZE), Image.LANCZOS)
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            img.save(thumb_path, "WEBP", quality=80)
        return f"{game_id}_thumb.webp"
    except Exception:
        logger.warning("Thumbnail generation failed for game %d", game_id, exc_info=True)
        return None

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
                # Strip EXIF/metadata from the downloaded image before persisting.
                # Handles user-supplied URLs that may serve phone photos with GPS.
                try:
                    with open(tmp_path, "rb") as f:
                        raw = f.read()
                    stripped = strip_image_metadata(raw, ext)
                    if stripped != raw:
                        with open(tmp_path, "wb") as f:
                            f.write(stripped)
                except Exception:
                    logger.warning("EXIF stripping failed for cached game %d image", game_id, exc_info=True)
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
                # Generate thumbnail
                thumb_filename = _generate_thumbnail(dest, game_id)
                if thumb_filename:
                    game.thumbnail_url = f"/api/games/{game_id}/thumbnail"
                db.commit()
                logger.info("Image cached for game %d", game_id)
            else:
                _delete_cached_image(game_id)
                logger.info("Image cache discarded for game %d: URL changed during download", game_id)
    finally:
        _cache_semaphore.release()

def _safe_header_filename(name: str) -> str:
    """Strip characters that could enable HTTP header injection from a filename."""
    return name.replace('"', '').replace('\r', '').replace('\n', '')

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

def _attach_parent_name(game: models.Game, db: Session, response_cls=schemas.GameResponse):
    """Build a response object with parent_game_name, heat_level, expansion_count, and session_count populated.

    Uses a single query with scalar subqueries instead of 3 separate round-trips.
    """
    data = response_cls.model_validate(game)
    if hasattr(data, 'heat_level'):
        data.heat_level = _heat_level(game.last_played)
    # Single query fetches parent name, expansion count, and session count together.
    needs_parent = bool(game.parent_game_id) and hasattr(data, 'parent_game_name')
    needs_expansion = hasattr(data, 'expansion_count')
    needs_session = hasattr(data, 'session_count')
    needs_rolled = hasattr(data, 'rolled_up_session_count')
    # rolled_up_session_count needs both the game's own sessions and its
    # expansions' sessions, so always compute both when needs_rolled.
    if needs_parent or needs_expansion or needs_session or needs_rolled:
        parent_name_sub = (
            db.query(models.Game.name)
            .filter(models.Game.id == game.parent_game_id)
            .scalar_subquery()
            if needs_parent else None
        )
        expansion_sub = (
            db.query(func.count(models.Game.id))
            .filter(models.Game.parent_game_id == game.id)
            .scalar_subquery()
            if needs_expansion else None
        )
        own_session_sub = (
            db.query(func.count(models.PlaySession.id))
            .filter(models.PlaySession.game_id == game.id)
            .scalar_subquery()
            if (needs_session or needs_rolled) else None
        )
        expansion_session_sub = (
            db.query(func.count(models.PlaySession.id))
            .join(models.Game, models.Game.id == models.PlaySession.game_id)
            .filter(models.Game.parent_game_id == game.id)
            .scalar_subquery()
            if needs_rolled else None
        )
        cols = []
        if needs_parent:
            cols.append(parent_name_sub.label("parent_name"))
        if needs_expansion:
            cols.append(expansion_sub.label("expansion_count"))
        if needs_session or needs_rolled:
            cols.append(own_session_sub.label("session_count"))
        if needs_rolled:
            cols.append(expansion_session_sub.label("expansion_session_count"))
        row = db.query(*cols).one()
        if needs_parent:
            data.parent_game_name = row.parent_name
        if needs_expansion:
            data.expansion_count = row.expansion_count or 0
        if needs_session:
            data.session_count = row.session_count or 0
        if needs_rolled:
            data.rolled_up_session_count = (row.session_count or 0) + (row.expansion_session_count or 0)
    return data


def build_game_responses(games: list, db: Session, response_cls=schemas.GameResponse) -> list:
    """Batch-populate tags, parent names, expansion counts, and heat levels for a list of Game objects.

    Used by both get_games() and sharing._build_game_list() to avoid duplicating this logic.
    Pass response_cls=schemas.GameShareResponse for public share-token responses to strip private fields.
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

    # Rolled-up session counts: for base games, sum their own sessions + all
    # direct expansion sessions. Expansions are not nestable (validated at
    # create/update), so one level of children is sufficient.
    expansion_session_rows = (
        db.query(models.Game.parent_game_id, func.count(models.PlaySession.id))
        .join(models.PlaySession, models.PlaySession.game_id == models.Game.id)
        .filter(models.Game.parent_game_id.isnot(None))
        .filter(models.Game.parent_game_id.in_(game_ids))
        .group_by(models.Game.parent_game_id)
        .all()
    )
    expansion_session_counts = {pid: cnt for pid, cnt in expansion_session_rows}

    results = []
    for g in games:
        row = response_cls.model_validate(g)
        if g.parent_game_id and hasattr(row, 'parent_game_name'):
            row.parent_game_name = parent_names.get(g.parent_game_id)
        if hasattr(row, 'heat_level'):
            row.heat_level = _heat_level(g.last_played)
        if hasattr(row, 'expansion_count'):
            row.expansion_count = expansion_counts.get(g.id, 0)
        if hasattr(row, 'session_count'):
            row.session_count = session_counts.get(g.id, 0)
        if hasattr(row, 'rolled_up_session_count'):
            row.rolled_up_session_count = (
                session_counts.get(g.id, 0) + expansion_session_counts.get(g.id, 0)
            )
        results.append(row)
    return results

