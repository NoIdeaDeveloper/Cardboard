import logging
from datetime import datetime, date, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func

from database import get_db
import models
import schemas
from utils import get_goal_or_404

logger = logging.getLogger("cardboard.goals")
router = APIRouter(prefix="/api/goals", tags=["goals"])


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

    results = []
    for goal in goals:
        current = _compute_current_value(goal, db)
        results.append(_build_response(goal, current, game_names.get(goal.game_id)))
    return results


@router.post("/check", response_model=List[schemas.GoalResponse])
def check_goals(db: Session = Depends(get_db)):
    goals = db.query(models.Goal).order_by(models.Goal.created_at).all()
    game_ids = {g.game_id for g in goals if g.game_id}
    game_names = {}
    if game_ids:
        rows = db.query(models.Game.id, models.Game.name).filter(models.Game.id.in_(game_ids)).all()
        game_names = {r.id: r.name for r in rows}

    results = []
    changed = False
    for goal in goals:
        current = _compute_current_value(goal, db)
        if not goal.is_complete and current >= goal.target_value:
            goal.is_complete = True
            goal.completed_at = datetime.now(timezone.utc)
            changed = True
        results.append(_build_response(goal, current, game_names.get(goal.game_id)))
    if changed:
        db.commit()
    return results


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
    if current >= goal.target_value:
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
