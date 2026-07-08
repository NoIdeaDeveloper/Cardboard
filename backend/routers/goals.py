import logging
from datetime import date, datetime, timezone
from typing import Dict, List

import models
import schemas
from database import get_db
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case, func
from sqlalchemy.orm import Session
from utils import get_goal_or_404

logger = logging.getLogger("cardboard.goals")
router = APIRouter(prefix="/api/goals", tags=["goals"])


def _compute_goal_values_batch(goals, db: Session) -> Dict[int, int]:
    """Compute current_value for all goals in a single batch.

    Returns ``{goal.id: current_value}``. Runs at most one query per goal type
    (plus one grouped query per distinct year for year-keyed types), so the
    total query count is ``O(goal types)`` rather than ``O(goals)`` — e.g.
    a collection with 50 goals issues ~12 queries instead of 50-100.
    """
    if not goals:
        return {}

    by_type: Dict[str, list] = {}
    for g in goals:
        by_type.setdefault(g.type, []).append(g)

    results: Dict[int, int] = {}

    def _assign_all(type_name: str, value: int) -> None:
        for g in by_type.get(type_name, ()):  # type: ignore[arg-type]
            results[g.id] = value

    # --- Global, single-value goal types (one query each) ---
    if "sessions_total" in by_type:
        v = db.query(func.count()).select_from(models.PlaySession).scalar() or 0
        _assign_all("sessions_total", v)

    if "play_all_owned" in by_type:
        v = (
            db.query(func.count(func.distinct(models.PlaySession.game_id)))
            .join(models.Game, models.Game.id == models.PlaySession.game_id)
            .filter(models.Game.status == "owned")
            .scalar() or 0
        )
        _assign_all("play_all_owned", v)

    if "unique_mechanics" in by_type:
        v = (
            db.query(func.count(func.distinct(models.Mechanic.id)))
            .join(models.GameMechanic, models.GameMechanic.mechanic_id == models.Mechanic.id)
            .join(models.Game, models.Game.id == models.GameMechanic.game_id)
            .filter(models.Game.status == "owned")
            .scalar() or 0
        )
        _assign_all("unique_mechanics", v)

    if "total_hours" in by_type:
        total_minutes = (
            db.query(func.sum(models.PlaySession.duration_minutes))
            .filter(models.PlaySession.duration_minutes.isnot(None))
            .scalar() or 0
        )
        _assign_all("total_hours", int(total_minutes // 60))

    if "category_coverage" in by_type:
        played_game_ids = {
            row[0] for row in
            db.query(func.distinct(models.PlaySession.game_id))
            .join(models.Game, models.Game.id == models.PlaySession.game_id)
            .filter(models.Game.status == "owned")
            .all()
        }
        category_rows = (
            db.query(models.GameCategory.game_id, models.Category.name)
            .join(models.Category, models.GameCategory.category_id == models.Category.id)
            .join(models.Game, models.Game.id == models.GameCategory.game_id)
            .filter(models.Game.status == "owned")
            .all()
        )
        played_categories = {
            cat for game_id, cat in category_rows if game_id in played_game_ids
        }
        _assign_all("category_coverage", len(played_categories))

    if "win_rate_target" in by_type:
        wins_expr = func.sum(case((func.lower(models.PlaySession.winner) == "me", 1), else_=0))
        row = (
            db.query(wins_expr, func.count())
            .select_from(models.PlaySession)
            .filter(models.PlaySession.winner.isnot(None), models.PlaySession.winner != "")
            .first()
        )
        total = row[1] if row else 0
        v = int((row[0] or 0) / total * 100) if total else 0
        _assign_all("win_rate_target", v)

    if "distinct_games" in by_type:
        v = (
            db.query(func.count(func.distinct(models.PlaySession.game_id)))
            .scalar() or 0
        )
        _assign_all("distinct_games", v)

    if "solo_sessions" in by_type:
        v = (
            db.query(func.count())
            .select_from(models.PlaySession)
            .filter(models.PlaySession.solo == True)  # noqa: E712
            .scalar() or 0
        )
        _assign_all("solo_sessions", v)

    if "cost_per_play" in by_type:
        total_price = (
            db.query(func.sum(models.Game.purchase_price))
            .filter(models.Game.status == "owned", models.Game.purchase_price.isnot(None))
            .scalar() or 0
        )
        total_sessions = (
            db.query(func.count())
            .select_from(models.PlaySession)
            .join(models.Game, models.Game.id == models.PlaySession.game_id)
            .filter(models.Game.status == "owned", models.Game.purchase_price.isnot(None))
            .scalar() or 0
        )
        if total_sessions == 0:
            v = int(total_price * 100)
        else:
            v = int((total_price / total_sessions) * 100)
        _assign_all("cost_per_play", v)

    # --- Year-keyed goal types (one query per distinct year) ---
    current_year = datetime.now(timezone.utc).year

    def _year_keyed(type_name: str, query_builder) -> None:
        goals_of_type = by_type.get(type_name)
        if not goals_of_type:
            return
        years = {g.year or current_year for g in goals_of_type}
        year_values: Dict[int, int] = {}
        for year in years:
            start = date(year, 1, 1)
            end = date(year + 1, 1, 1)
            year_values[year] = query_builder(start, end) or 0
        for g in goals_of_type:
            results[g.id] = year_values[g.year or current_year]

    _year_keyed("sessions_year", lambda start, end: (
        db.query(func.count())
        .select_from(models.PlaySession)
        .filter(models.PlaySession.played_at >= start, models.PlaySession.played_at < end)
        .scalar()
    ))
    _year_keyed("unique_games_year", lambda start, end: (
        db.query(func.count(func.distinct(models.PlaySession.game_id)))
        .filter(models.PlaySession.played_at >= start, models.PlaySession.played_at < end)
        .scalar()
    ))

    # --- game_id-keyed goal type (one grouped query) ---
    if "game_sessions" in by_type:
        game_ids = {g.game_id for g in by_type["game_sessions"] if g.game_id}
        game_values: Dict[int, int] = {}
        if game_ids:
            rows = (
                db.query(models.PlaySession.game_id, func.count())
                .filter(models.PlaySession.game_id.in_(game_ids))
                .group_by(models.PlaySession.game_id)
                .all()
            )
            game_values = {gid: cnt for gid, cnt in rows}
        for g in by_type["game_sessions"]:
            results[g.id] = game_values.get(g.game_id, 0) if g.game_id else 0

    return results


def _compute_current_value(goal: models.Goal, db: Session) -> int:
    if goal.type == "sessions_total":
        return db.query(func.count()).select_from(models.PlaySession).scalar() or 0

    elif goal.type == "sessions_year":
        year = goal.year or datetime.now(timezone.utc).year
        start = date(year, 1, 1)
        end = date(year + 1, 1, 1)
        return (
            db.query(func.count())
            .select_from(models.PlaySession)
            .filter(models.PlaySession.played_at >= start, models.PlaySession.played_at < end)
            .scalar() or 0
        )

    elif goal.type == "play_all_owned":
        return (
            db.query(func.count(func.distinct(models.PlaySession.game_id)))
            .join(models.Game, models.Game.id == models.PlaySession.game_id)
            .filter(models.Game.status == "owned")
            .scalar() or 0
        )

    elif goal.type == "game_sessions":
        if not goal.game_id:
            return 0
        return (
            db.query(func.count())
            .select_from(models.PlaySession)
            .filter(models.PlaySession.game_id == goal.game_id)
            .scalar() or 0
        )

    elif goal.type == "unique_mechanics":
        return (
            db.query(func.count(func.distinct(models.Mechanic.id)))
            .join(models.GameMechanic, models.GameMechanic.mechanic_id == models.Mechanic.id)
            .join(models.Game, models.Game.id == models.GameMechanic.game_id)
            .filter(models.Game.status == "owned")
            .scalar() or 0
        )

    elif goal.type == "unique_games_year":
        year = goal.year or datetime.now(timezone.utc).year
        start = date(year, 1, 1)
        end = date(year + 1, 1, 1)
        return (
            db.query(func.count(func.distinct(models.PlaySession.game_id)))
            .filter(models.PlaySession.played_at >= start, models.PlaySession.played_at < end)
            .scalar() or 0
        )

    elif goal.type == "total_hours":
        total_minutes = (
            db.query(func.sum(models.PlaySession.duration_minutes))
            .filter(models.PlaySession.duration_minutes.isnot(None))
            .scalar() or 0
        )
        return int(total_minutes // 60)

    elif goal.type == "category_coverage":
        # Count how many distinct categories among owned games have been played at least once
        played_game_ids = {
            row[0] for row in
            db.query(func.distinct(models.PlaySession.game_id))
            .join(models.Game, models.Game.id == models.PlaySession.game_id)
            .filter(models.Game.status == "owned")
            .all()
        }
        category_rows = (
            db.query(models.GameCategory.game_id, models.Category.name)
            .join(models.Category, models.GameCategory.category_id == models.Category.id)
            .join(models.Game, models.Game.id == models.GameCategory.game_id)
            .filter(models.Game.status == "owned")
            .all()
        )
        played_categories = set()
        for game_id, cat in category_rows:
            if game_id in played_game_ids:
                played_categories.add(cat)
        return len(played_categories)

    elif goal.type == "win_rate_target":
        # Return current win rate as integer percentage (0-100)
        total = (
            db.query(func.count())
            .select_from(models.PlaySession)
            .filter(models.PlaySession.winner.isnot(None), models.PlaySession.winner != "")
            .scalar() or 0
        )
        if not total:
            return 0
        # Sessions where winner == 'Me' (case-insensitive)
        wins = (
            db.query(func.count())
            .select_from(models.PlaySession)
            .filter(func.lower(models.PlaySession.winner) == "me")
            .scalar() or 0
        )
        return int(wins / total * 100)

    elif goal.type == "distinct_games":
        return (
            db.query(func.count(func.distinct(models.PlaySession.game_id)))
            .scalar() or 0
        )

    elif goal.type == "solo_sessions":
        return (
            db.query(func.count())
            .select_from(models.PlaySession)
            .filter(models.PlaySession.solo == True)
            .scalar() or 0
        )

    elif goal.type == "cost_per_play":
        # Average cost per play across all owned games with purchase price
        # Stored as cents (integer) to match target_value format
        total_price = (
            db.query(func.sum(models.Game.purchase_price))
            .filter(models.Game.status == "owned", models.Game.purchase_price.isnot(None))
            .scalar() or 0
        )
        # Count only sessions of owned, priced games so this matches the
        # dashboard's collection-wide avg_cost_per_play denominator.
        total_sessions = (
            db.query(func.count())
            .select_from(models.PlaySession)
            .join(models.Game, models.Game.id == models.PlaySession.game_id)
            .filter(models.Game.status == "owned", models.Game.purchase_price.isnot(None))
            .scalar() or 0
        )
        if total_sessions == 0:
            return int(total_price * 100)  # No plays yet = full price
        # Average cost per play = total_price / total_sessions
        return int((total_price / total_sessions) * 100)

    return 0


def _build_response(goal: models.Goal, current: int, game_name: str | None) -> schemas.GoalResponse:
    return schemas.GoalResponse(
        id=goal.id,
        title=goal.title,
        type=goal.type,
        target_value=goal.target_value,
        game_id=goal.game_id,
        game_name=game_name,
        year=goal.year,
        current_value=current,
        is_complete=goal.is_complete,
        completed_at=goal.completed_at,
        created_at=goal.created_at,
    )


@router.get("/", response_model=List[schemas.GoalResponse])
def list_goals(db: Session = Depends(get_db)):
    goals = db.query(models.Goal).order_by(models.Goal.created_at).all()
    # Batch load game names
    game_ids = {g.game_id for g in goals if g.game_id}
    game_names = {}
    if game_ids:
        rows = db.query(models.Game.id, models.Game.name).filter(models.Game.id.in_(game_ids)).all()
        game_names = {r.id: r.name for r in rows}

    # Batch-compute current values to avoid N+1 (one query per goal type
    # instead of one per goal).
    current_values = _compute_goal_values_batch(goals, db)

    return [
        _build_response(goal, current_values.get(goal.id, 0), game_names.get(goal.game_id))
        for goal in goals
    ]


@router.post("/check", response_model=List[schemas.GoalResponse])
def check_goals(db: Session = Depends(get_db)):
    goals = db.query(models.Goal).order_by(models.Goal.created_at).all()
    game_ids = {g.game_id for g in goals if g.game_id}
    game_names = {}
    if game_ids:
        rows = db.query(models.Game.id, models.Game.name).filter(models.Game.id.in_(game_ids)).all()
        game_names = {r.id: r.name for r in rows}

    current_values = _compute_goal_values_batch(goals, db)

    changed = False
    for goal in goals:
        current = current_values.get(goal.id, 0)
        if not goal.is_complete:
            # cost_per_play is a "lower is better" metric — complete when current <= target
            if goal.type == "cost_per_play":
                if current <= goal.target_value:
                    goal.is_complete = True
                    goal.completed_at = datetime.now(timezone.utc)
                    changed = True
            elif current >= goal.target_value:
                goal.is_complete = True
                goal.completed_at = datetime.now(timezone.utc)
                changed = True
    if changed:
        db.commit()
    return [
        _build_response(goal, current_values.get(goal.id, 0), game_names.get(goal.game_id))
        for goal in goals
    ]


@router.post("/", response_model=schemas.GoalResponse, status_code=201)
def create_goal(data: schemas.GoalCreate, db: Session = Depends(get_db)):
    if data.type == "game_sessions" and not data.game_id:
        raise HTTPException(status_code=422, detail="game_id required for game_sessions goals")
    game_name = None
    if data.game_id:
        game = db.query(models.Game).filter(models.Game.id == data.game_id).first()
        if not game:
            raise HTTPException(status_code=404, detail="Game not found")
        game_name = game.name
    goal = models.Goal(
        title=data.title.strip(),
        type=data.type,
        target_value=data.target_value,
        game_id=data.game_id,
        year=data.year,
    )
    db.add(goal)
    db.commit()
    db.refresh(goal)
    current = _compute_current_value(goal, db)
    # cost_per_play is "lower is better" — complete when current <= target
    if goal.type == "cost_per_play":
        if current <= goal.target_value:
            goal.is_complete = True
            goal.completed_at = datetime.now(timezone.utc)
            db.commit()
    elif current >= goal.target_value:
        goal.is_complete = True
        goal.completed_at = datetime.now(timezone.utc)
        db.commit()
    logger.info("Goal created: %r type=%s target=%d", goal.title, goal.type, goal.target_value)
    return _build_response(goal, current, game_name)


@router.delete("/{goal_id}", status_code=204)
def delete_goal(goal_id: int, db: Session = Depends(get_db)):
    goal = get_goal_or_404(goal_id, db)
    db.delete(goal)
    db.commit()
    logger.info("Goal deleted: id=%d", goal_id)
