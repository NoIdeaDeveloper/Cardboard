"""Play-this-next recommendation endpoint (GET /api/recommend)."""
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


@router.get("/recommend", response_model=schemas.RecommendGameResponse)
def recommend_game(
    players: Optional[int] = None,
    minutes: Optional[int] = None,
    mechanic: Optional[str] = None,
    exclude: Optional[str] = Query(None, description="Comma-separated game IDs to exclude"),
    db: Session = Depends(get_db),
):
    """Suggest a single best game to play right now."""
    excluded_ids = [int(x) for x in exclude.split(",") if x.strip().isdigit()] if exclude else []
    today = date.today()

    cq = (
        db.query(models.Game)
        .filter(models.Game.status == "owned")
        .filter(models.Game.id.notin_(excluded_ids) if excluded_ids else True)
    )
    if mechanic:
        cq = cq.join(models.GameMechanic, models.GameMechanic.game_id == models.Game.id).join(
            models.Mechanic, models.Mechanic.id == models.GameMechanic.mechanic_id
        ).filter(models.Mechanic.name == mechanic).distinct()
    candidates = cq.all()

    if not candidates:
        raise HTTPException(status_code=404, detail="No suitable game found")

    from routers.games import _load_tags
    _load_tags(candidates, db)

    # Pre-load session counts for all candidates
    game_ids = [g.id for g in candidates]
    session_counts_rows = (
        db.query(models.PlaySession.game_id, func.count(models.PlaySession.id))
        .filter(models.PlaySession.game_id.in_(game_ids))
        .group_by(models.PlaySession.game_id)
        .all()
    )
    sc_map = {gid: cnt for gid, cnt in session_counts_rows}

    scored = []
    for g in candidates:
        score = 0.0
        session_count = sc_map.get(g.id, 0)
        last_played = g.last_played

        # Base scoring
        if session_count == 0:
            score += 40.0
            reason = "unplayed"
            added_date = g.date_added.date() if g.date_added else today
            detail = f"You bought this {max(1, round((today - added_date).days / 30))} month(s) ago but haven't played it yet."
        elif last_played and (today - last_played).days > 90:
            score += 25.0
            reason = "neglected"
            detail = f"Last played {max(1, round((today - last_played).days / 30))} month(s) ago."
        else:
            reason = "player_count_match"
            detail = "A solid fit for your group."

        if g.user_rating and g.user_rating >= 8:
            score += 15.0

        # Constraint fit (multiplicative)
        fit = 1.0
        if players is not None:
            min_p = g.min_players
            max_p = g.max_players
            if (min_p is None or min_p <= players) and (max_p is None or max_p >= players):
                fit *= 1.3
                if reason == "player_count_match":
                    detail = f"Perfect for {players} players."
            else:
                fit *= 0.3
        if minutes is not None and g.min_playtime:
            if g.min_playtime <= minutes:
                fit *= 1.2
            else:
                fit *= 0.2

        scored.append((g, score * fit, reason, detail))

    scored.sort(key=lambda x: x[1], reverse=True)
    top = scored[0]
    confidence = min(1.0, top[1] / 100.0)

    # Build alternatives (next 3 distinct reasons, if any)
    alternatives = []
    seen_reasons = {top[2]}
    for g, s, r, d in scored[1:]:
        if r not in seen_reasons and len(alternatives) < 3:
            seen_reasons.add(r)
            alternatives.append(g)

    return schemas.RecommendGameResponse(
        game=schemas.GameOut.model_validate(top[0]),
        reason=top[2],
        reason_detail=top[3],
        confidence=round(confidence, 2),
        alternatives=[schemas.GameOut.model_validate(a) for a in alternatives],
    )


# ── Trade / Sell Curation ────────────────────────────────────────────────

