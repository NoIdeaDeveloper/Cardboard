"""Collection CRUD plus per-game image and instructions endpoints."""
import difflib
import glob
import logging
import os
import re
from typing import List, Optional

from fastapi import (
    APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, Request, UploadFile,
)
from fastapi.responses import FileResponse, JSONResponse, Response
from sqlalchemy import and_, asc, case, desc, exists, func, or_
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas
from utils import (
    get_game_or_404, validate_file_extension, collection_etag,
    safe_write_file, safe_delete_file, validate_image_content,
)
from constants import (
    MAX_IMAGE_SIZE, ALLOWED_IMAGE_EXTENSIONS,
    MAX_INSTRUCTIONS_SIZE, ALLOWED_INSTRUCTIONS_EXTENSIONS,
    NO_LOCATION_SENTINEL,
)
from routers.game_images import delete_all_gallery_images
from routers.games._common import (
    IMAGES_DIR, INSTRUCTIONS_DIR,
    build_game_responses, _attach_parent_name, _load_tags, _save_tags,
    _cache_game_image, _delete_cached_image, _safe_header_filename,
    _TAG_FIELD_NAMES,
)

logger = logging.getLogger("cardboard.games")
router = APIRouter(prefix="/api/games", tags=["games"])


def _safe_filename(name: str) -> str:
    """Strip path components and replace unsafe characters."""
    name = os.path.basename(name)
    name = re.sub(r"[^\w.\-]", "_", name)
    # Strip leading dots to prevent hidden/special files
    name = name.lstrip(".")
    return name[:200] if name else "unnamed"

def _instructions_path(game_id: int, filename: str) -> str:
    return os.path.join(INSTRUCTIONS_DIR, f"{game_id}_{os.path.basename(filename)}")

def _verify_within(path: str, directory: str) -> str:
    """Resolve *path* and verify it lives inside *directory*; raise 404 otherwise."""
    real = os.path.realpath(path)
    if not real.startswith(os.path.realpath(directory) + os.sep):
        raise HTTPException(status_code=404, detail="File not found")
    return real

def _tag_exists(pivot_model, pivot_fk_col, tag_model, name_expr):
    """EXISTS subquery: game has at least one tag row matching name_expr."""
    return exists().where(
        and_(
            pivot_model.game_id == models.Game.id,
            pivot_fk_col == tag_model.id,
            name_expr,
        )
    )

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
        query = query.filter(models.Game.user_rating <= rating_max)

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

@router.post("/", response_model=schemas.GameResponse, status_code=201)
def create_game(
    game: schemas.GameCreate,
    background_tasks: BackgroundTasks,
    allow_duplicate: bool = False,
    db: Session = Depends(get_db),
):
    _validate_parent_game_id(game.parent_game_id, None, db)
    data = game.model_dump()

    # Separate tag fields — they live only in junction tables, not on the model
    tag_data = {k: data.pop(k) for k in list(data) if k in _TAG_FIELD_NAMES}

    # Duplicate check: match by BGG ID (if provided) or case-insensitive name
    if not allow_duplicate:
        name = (data.get("name") or "").strip()
        dup_filters = []
        if data.get("bgg_id"):
            dup_filters.append(models.Game.bgg_id == data["bgg_id"])
        if name:
            dup_filters.append(func.lower(models.Game.name) == name.lower())
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

@router.post("/{game_id}/image", status_code=204)
async def upload_image(game_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)):
    db_game = get_game_or_404(game_id, db)

    safe_name = _safe_filename(file.filename or "image.jpg")
    ext = validate_file_extension(safe_name, ALLOWED_IMAGE_EXTENSIONS, "Only image files (.jpg, .png, .gif, .webp) are allowed")

    content = await file.read()
    if len(content) > MAX_IMAGE_SIZE:
        raise HTTPException(status_code=413, detail="File exceeds 10 MB limit")

    if not validate_image_content(content):
        raise HTTPException(status_code=400, detail="File content does not match a valid image format")

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
