"""Recommendation endpoints: similar games, game-night suggestions, group matchmaking."""
import logging
import math
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas
from utils import get_game_or_404
from routers.games._common import _load_tags

logger = logging.getLogger("cardboard.games")
router = APIRouter(prefix="/api/games", tags=["games"])


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
