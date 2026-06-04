"""Collection breakdown stats endpoint (GET /api/collection/stats)."""
import logging
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from constants import NO_LOCATION_SENTINEL
from database import get_db
import models
import schemas
from utils import collection_etag

logger = logging.getLogger("cardboard.stats")
router = APIRouter(prefix="/api", tags=["stats"])


from routers.stats._common import _status_counts


@router.get("/collection/stats")
def get_collection_stats(request: Request, db: Session = Depends(get_db)):
    etag = collection_etag(db)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)
    # Status counts
    by_status = _status_counts(db)

    # Total hours from all sessions
    total_minutes_raw = (
        db.query(func.coalesce(func.sum(models.PlaySession.duration_minutes), 0))
        .scalar() or 0
    )
    total_hours = round(int(total_minutes_raw) / 60, 1)

    # Base game vs expansion counts
    expansion_count = (
        db.query(func.count(models.Game.id))
        .filter(models.Game.parent_game_id.isnot(None))
        .scalar() or 0
    )
    base_game_count = by_status["owned"] + by_status["wishlist"] + by_status["sold"] - expansion_count

    # Unplayed owned base games (no sessions ever logged)
    unplayed_count = (
        db.query(func.count(models.Game.id))
        .outerjoin(models.PlaySession, models.PlaySession.game_id == models.Game.id)
        .filter(models.PlaySession.id.is_(None))
        .filter(models.Game.status == "owned", models.Game.parent_game_id.is_(None))
        .scalar() or 0
    )

    # Rated owned games
    rated_count = (
        db.query(func.count(models.Game.id))
        .filter(models.Game.user_rating.isnot(None))
        .filter(models.Game.status == "owned")
        .scalar() or 0
    )

    # Storage locations for owned games, grouped server-side so the frontend
    # can render the full set of rooms regardless of which filter is currently
    # applied to the games list.
    location_rows = (
        db.query(models.Game.location, func.count(models.Game.id))
        .filter(models.Game.status == "owned")
        .group_by(models.Game.location)
        .all()
    )
    locations: dict[str, int] = {}
    for raw_loc, count in location_rows:
        label = (raw_loc or "").strip()
        key = label or NO_LOCATION_SENTINEL
        locations[key] = locations.get(key, 0) + int(count)

    # Mechanic and category frequency counts across all owned games (for filter chips)
    mechanic_count_rows = (
        db.query(models.Mechanic.name, func.count(models.GameMechanic.game_id).label("cnt"))
        .join(models.GameMechanic, models.GameMechanic.mechanic_id == models.Mechanic.id)
        .join(models.Game, models.Game.id == models.GameMechanic.game_id)
        .filter(models.Game.status == "owned")
        .group_by(models.Mechanic.name)
        .order_by(func.count(models.GameMechanic.game_id).desc())
        .all()
    )
    mechanic_counts: dict[str, int] = {name: int(cnt) for name, cnt in mechanic_count_rows}

    category_count_rows = (
        db.query(models.Category.name, func.count(models.GameCategory.game_id).label("cnt"))
        .join(models.GameCategory, models.GameCategory.category_id == models.Category.id)
        .join(models.Game, models.Game.id == models.GameCategory.game_id)
        .filter(models.Game.status == "owned")
        .group_by(models.Category.name)
        .order_by(func.count(models.GameCategory.game_id).desc())
        .all()
    )
    category_counts: dict[str, int] = {name: int(cnt) for name, cnt in category_count_rows}

    # Label, designer, and publisher frequency counts across all owned games —
    # eliminates the client-side O(n) pass over all game records in buildDataLists().
    label_count_rows = (
        db.query(models.Label.name, func.count(models.GameLabel.game_id).label("cnt"))
        .join(models.GameLabel, models.GameLabel.label_id == models.Label.id)
        .join(models.Game, models.Game.id == models.GameLabel.game_id)
        .filter(models.Game.status == "owned")
        .group_by(models.Label.name)
        .order_by(func.count(models.GameLabel.game_id).desc())
        .all()
    )
    label_counts: dict[str, int] = {name: int(cnt) for name, cnt in label_count_rows}

    designer_count_rows = (
        db.query(models.Designer.name, func.count(models.GameDesigner.game_id).label("cnt"))
        .join(models.GameDesigner, models.GameDesigner.designer_id == models.Designer.id)
        .join(models.Game, models.Game.id == models.GameDesigner.game_id)
        .filter(models.Game.status == "owned")
        .group_by(models.Designer.name)
        .order_by(func.count(models.GameDesigner.game_id).desc())
        .all()
    )
    designer_counts: dict[str, int] = {name: int(cnt) for name, cnt in designer_count_rows}

    publisher_count_rows = (
        db.query(models.Publisher.name, func.count(models.GamePublisher.game_id).label("cnt"))
        .join(models.GamePublisher, models.GamePublisher.publisher_id == models.Publisher.id)
        .join(models.Game, models.Game.id == models.GamePublisher.game_id)
        .filter(models.Game.status == "owned")
        .group_by(models.Publisher.name)
        .order_by(func.count(models.GamePublisher.game_id).desc())
        .all()
    )
    publisher_counts: dict[str, int] = {name: int(cnt) for name, cnt in publisher_count_rows}

    # ── Neglected favorite (most-played owned game, not played in 6+ months) ─
    today = date.today()
    six_months_ago = today - timedelta(days=180)
    neglected_favorite = None
    if by_status["owned"] > 0:
        session_counts_rows = (
            db.query(models.PlaySession.game_id, func.count(models.PlaySession.id))
            .join(models.Game, models.Game.id == models.PlaySession.game_id)
            .filter(models.Game.status == "owned")
            .group_by(models.PlaySession.game_id)
            .all()
        )
        if session_counts_rows:
            sc_map_all: dict[int, int] = {gid: cnt for gid, cnt in session_counts_rows}
            neglected_rows = (
                db.query(models.Game.id, models.Game.name, models.Game.last_played)
                .filter(
                    models.Game.status == "owned",
                    models.Game.parent_game_id.is_(None),
                    models.Game.last_played.isnot(None),
                    models.Game.last_played <= six_months_ago,
                )
                .all()
            )
            if neglected_rows:
                best = max(neglected_rows, key=lambda r: (sc_map_all.get(r.id, 0), -r.last_played.toordinal()))
                months_ago = max(1, round((today - best.last_played).days / 30))
                neglected_favorite = schemas.NeglectedFavoriteEntry(
                    id=best.id, name=best.name, months_ago=months_ago
                )

    data = schemas.CollectionStatsResponse(
        total_owned=by_status["owned"],
        total_wishlist=by_status["wishlist"],
        total_sold=by_status["sold"],
        base_game_count=base_game_count,
        expansion_count=expansion_count,
        total_hours=total_hours,
        unplayed_count=unplayed_count,
        rated_count=rated_count,
        locations=locations,
        mechanic_counts=mechanic_counts,
        category_counts=category_counts,
        label_counts=label_counts,
        designer_counts=designer_counts,
        publisher_counts=publisher_counts,
        play_pct=round(((by_status["owned"] - unplayed_count) / by_status["owned"]) * 100) if by_status["owned"] else 0,
        neglected_favorite=neglected_favorite,
    )
    resp = JSONResponse(content=data.model_dump())
    resp.headers["ETag"] = etag
    resp.headers["Cache-Control"] = "private, no-cache"
    return resp


# ── Play This Next ───────────────────────────────────────────────────────

