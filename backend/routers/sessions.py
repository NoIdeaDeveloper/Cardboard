import logging
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import desc, func
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas
from utils import get_game_or_404, get_session_or_404

logger = logging.getLogger("cardboard.sessions")
router = APIRouter(tags=["sessions"])


def _sync_last_played(game_id: int, db: Session, commit: bool = True) -> None:
    """Recalculate game.last_played from remaining sessions and touch
    date_modified so the collection ETag changes.

    Forcing date_modified is required even when last_played is unchanged
    (e.g. deleting a non-latest session, editing a session's duration):
    SQLAlchemy's onupdate hook only fires on dirty rows, and a no-op
    assignment to last_played leaves the row clean.
    """
    latest = (
        db.query(models.PlaySession.played_at)
        .filter(models.PlaySession.game_id == game_id)
        .order_by(desc(models.PlaySession.played_at))
        .first()
    )
    game = db.query(models.Game).filter(models.Game.id == game_id).first()
    if game:
        game.last_played = latest.played_at if latest else None
        game.date_modified = datetime.now(timezone.utc)
        if commit:
            db.commit()
    else:
        logger.warning("_sync_last_played: game_id=%d not found", game_id)


def _get_session_players(session_id: int, db: Session):
    """Return (player names, player_scores dict) linked to a session."""
    rows = (
        db.query(models.Player.name, models.SessionPlayer.score)
        .join(models.SessionPlayer, models.Player.id == models.SessionPlayer.player_id)
        .filter(models.SessionPlayer.session_id == session_id)
        .all()
    )
    names = [r.name for r in rows]
    scores = {r.name: r.score for r in rows if r.score is not None}
    return names, scores


def _attach_players(session: models.PlaySession, db: Session) -> schemas.PlaySessionResponse:
    """Build PlaySessionResponse with player names and scores populated."""
    resp = schemas.PlaySessionResponse.model_validate(session)
    resp.players, resp.player_scores = _get_session_players(session.id, db)
    return resp


def _link_players(session_id: int, player_names: List[str], db: Session, scores: dict = None) -> None:
    """Create players if needed and link them to a session."""
    # Clear existing links
    db.query(models.SessionPlayer).filter(models.SessionPlayer.session_id == session_id).delete()
    names = [n.strip() for n in player_names if n.strip()]
    if not names:
        db.flush()
        return
    scores = scores or {}
    # Batch-fetch existing players
    existing = {p.name: p for p in db.query(models.Player).filter(models.Player.name.in_(names)).all()}
    for name in names:
        player = existing.get(name)
        if not player:
            player = models.Player(name=name)
            db.add(player)
            db.flush()
            existing[name] = player
        db.add(models.SessionPlayer(session_id=session_id, player_id=player.id, score=scores.get(name)))
    db.flush()


@router.get("/api/games/{game_id}/sessions", response_model=List[schemas.PlaySessionResponse])
def get_sessions(game_id: int, db: Session = Depends(get_db)):
    get_game_or_404(game_id, db)

    sessions = (
        db.query(models.PlaySession)
        .filter(models.PlaySession.game_id == game_id)
        .order_by(desc(models.PlaySession.played_at))
        .all()
    )
    if not sessions:
        return []

    # Batch-load all player names and scores for these sessions in one query
    session_ids = [s.id for s in sessions]
    player_rows = (
        db.query(models.SessionPlayer.session_id, models.Player.name, models.SessionPlayer.score)
        .join(models.Player, models.Player.id == models.SessionPlayer.player_id)
        .filter(models.SessionPlayer.session_id.in_(session_ids))
        .all()
    )
    players_by_session = {}
    scores_by_session = {}
    for sid, name, score in player_rows:
        players_by_session.setdefault(sid, []).append(name)
        if score is not None:
            scores_by_session.setdefault(sid, {})[name] = score

    results = []
    for s in sessions:
        resp = schemas.PlaySessionResponse.model_validate(s)
        resp.players = players_by_session.get(s.id, [])
        resp.player_scores = scores_by_session.get(s.id, {})
        results.append(resp)
    return results


@router.post("/api/games/{game_id}/sessions", response_model=schemas.PlaySessionResponse, status_code=201)
def add_session(game_id: int, session: schemas.PlaySessionCreate, db: Session = Depends(get_db)):
    get_game_or_404(game_id, db)

    data = session.model_dump(exclude={"player_names", "scores"})
    db_session = models.PlaySession(game_id=game_id, **data)
    db.add(db_session)
    db.flush()

    if session.player_names:
        _link_players(db_session.id, session.player_names, db, session.scores)

    _sync_last_played(game_id, db, commit=False)
    db.commit()
    db.refresh(db_session)
    logger.info("Session logged: game_id=%d played_at=%s", game_id, session.played_at)

    agg = (
        db.query(func.count(models.PlaySession.id), func.coalesce(func.sum(models.PlaySession.duration_minutes), 0))
        .filter(models.PlaySession.game_id == game_id)
        .first()
    )
    resp = _attach_players(db_session, db)
    resp.game_session_count = int(agg[0] or 0)
    resp.game_total_minutes = int(agg[1] or 0)
    return resp


@router.patch("/api/sessions/{session_id}", response_model=schemas.PlaySessionResponse)
def update_session(session_id: int, data: schemas.PlaySessionUpdate, db: Session = Depends(get_db)):
    db_session = get_session_or_404(session_id, db)

    update_data = data.model_dump(exclude_unset=True)
    player_names = update_data.pop("player_names", None)
    scores = update_data.pop("scores", None)
    for field, value in update_data.items():
        setattr(db_session, field, value)

    if player_names is not None:
        _link_players(db_session.id, player_names, db, scores)

    _sync_last_played(db_session.game_id, db, commit=False)
    db.commit()
    db.refresh(db_session)

    logger.info("Session updated: id=%d", session_id)
    return _attach_players(db_session, db)


@router.delete("/api/sessions/{session_id}", status_code=204)
def delete_session(session_id: int, db: Session = Depends(get_db)):
    db_session = get_session_or_404(session_id, db)

    game_id = db_session.game_id
    db.delete(db_session)
    db.flush()
    _sync_last_played(game_id, db, commit=False)
    db.commit()
    logger.info("Session deleted: id=%d game_id=%d", session_id, game_id)


@router.post("/api/sessions/bulk", response_model=List[schemas.PlaySessionResponse], status_code=201)
def add_bulk_session(body: schemas.BulkSessionCreate, db: Session = Depends(get_db)):
    if not body.game_ids:
        raise HTTPException(status_code=400, detail="No game IDs provided")
    for game_id in body.game_ids:
        get_game_or_404(game_id, db)
    data = body.model_dump(exclude={"game_ids", "player_names", "scores"})
    db_sessions = []
    for game_id in body.game_ids:
        db_session = models.PlaySession(game_id=game_id, **data)
        db.add(db_session)
        db.flush()
        if body.player_names:
            _link_players(db_session.id, body.player_names, db, body.scores)
        _sync_last_played(game_id, db, commit=False)
        db_sessions.append((game_id, db_session))
    db.commit()
    responses = []
    for game_id, db_session in db_sessions:
        db.refresh(db_session)
        logger.info("Bulk session logged: game_id=%d played_at=%s", game_id, body.played_at)
        agg = (
            db.query(func.count(models.PlaySession.id), func.coalesce(func.sum(models.PlaySession.duration_minutes), 0))
            .filter(models.PlaySession.game_id == game_id)
            .first()
        )
        resp = _attach_players(db_session, db)
        resp.game_session_count = int(agg[0] or 0)
        resp.game_total_minutes = int(agg[1] or 0)
        responses.append(resp)
    return responses
