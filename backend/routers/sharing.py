import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas
from sqlalchemy import func
from routers.games import _heat_level, _load_tags, _attach_parent_name, build_game_responses
from utils import get_game_or_404

logger = logging.getLogger("cardboard.sharing")
router = APIRouter(prefix="/api/share", tags=["sharing"])


def _build_game_list(db: Session) -> List[schemas.GameResponse]:
    games = db.query(models.Game).filter(models.Game.share_hidden == False).order_by(models.Game.name).all()
    return build_game_responses(games, db)


@router.get("/tokens", response_model=List[schemas.ShareTokenResponse])
def list_tokens(db: Session = Depends(get_db)):
    return db.query(models.ShareToken).all()


ALLOWED_EXPIRY_MINUTES = (10, 30, 60)


@router.post("/tokens", response_model=schemas.ShareTokenResponse, status_code=201)
def create_token(label: Optional[str] = None, expires_in: Optional[int] = None, db: Session = Depends(get_db)):
    if expires_in is not None and expires_in not in ALLOWED_EXPIRY_MINUTES:
        raise HTTPException(status_code=400, detail=f"expires_in must be one of {ALLOWED_EXPIRY_MINUTES} or omitted")
    token = secrets.token_urlsafe(32)
    expires_at = None
    if expires_in is not None:
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=expires_in)
    share = models.ShareToken(token=token, label=label, expires_at=expires_at)
    db.add(share)
    db.commit()
    db.refresh(share)
    logger.info("Share token created (label=%r, expires: %s)", label, expires_at or "never")
    return share


@router.delete("/tokens/{token}", status_code=204)
def delete_token(token: str, db: Session = Depends(get_db)):
    share = db.query(models.ShareToken).filter(models.ShareToken.token == token).first()
    if not share:
        raise HTTPException(status_code=404, detail="Token not found")
    db.delete(share)
    db.commit()
    logger.info("Share token revoked (label=%r)", share.label)


def _validate_token(token: str, db: Session) -> models.ShareToken:
    share = db.query(models.ShareToken).filter(models.ShareToken.token == token).first()
    if not share:
        raise HTTPException(status_code=404, detail="Invalid share link")
    if share.expires_at:
        exp = share.expires_at if share.expires_at.tzinfo else share.expires_at.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) > exp:
            raise HTTPException(status_code=404, detail="This share link has expired")
    return share


@router.get("/{token}/games", response_model=List[schemas.GameResponse])
def get_shared_games(token: str, db: Session = Depends(get_db)):
    _validate_token(token, db)
    return _build_game_list(db)


@router.get("/{token}/games/{game_id}", response_model=schemas.GameResponse)
def get_shared_game(token: str, game_id: int, db: Session = Depends(get_db)):
    _validate_token(token, db)
    game = get_game_or_404(game_id, db)
    if game.share_hidden:
        raise HTTPException(status_code=404, detail="Game not found")
    _load_tags([game], db)
    return _attach_parent_name(game, db)


@router.post("/{token}/games/{game_id}/want-to-play", status_code=201)
def submit_want_to_play(
    token: str,
    game_id: int,
    data: schemas.WantToPlayCreate,
    db: Session = Depends(get_db),
):
    _validate_token(token, db)
    game = get_game_or_404(game_id, db)
    if game.share_hidden:
        raise HTTPException(status_code=404, detail="Game not found")
    vname = data.visitor_name.strip() if data.visitor_name else None
    total_count = (
        db.query(func.count())
        .select_from(models.WantToPlayRequest)
        .filter(
            models.WantToPlayRequest.token == token,
            models.WantToPlayRequest.game_id == game_id,
            models.WantToPlayRequest.visitor_name == vname,
        )
        .scalar()
    )
    if total_count >= 3:
        raise HTTPException(status_code=429, detail="Too many requests for this game")
    req = models.WantToPlayRequest(
        token=token,
        game_id=game_id,
        visitor_name=vname,
        message=data.message.strip() if data.message else None,
    )
    db.add(req)
    db.commit()
    logger.info("Want-to-play request: game_id=%d visitor=%r", game_id, req.visitor_name)
    return {"detail": "Request submitted"}


@router.get("/requests", response_model=List[schemas.WantToPlayResponse])
def get_want_to_play_requests(db: Session = Depends(get_db)):
    rows = (
        db.query(models.WantToPlayRequest, models.Game.name.label("game_name"))
        .join(models.Game, models.Game.id == models.WantToPlayRequest.game_id)
        .order_by(models.WantToPlayRequest.seen, models.WantToPlayRequest.created_at.desc())
        .all()
    )
    results = []
    for req, game_name in rows:
        r = schemas.WantToPlayResponse(
            id=req.id,
            game_id=req.game_id,
            game_name=game_name,
            visitor_name=req.visitor_name,
            message=req.message,
            seen=req.seen,
            created_at=req.created_at,
        )
        results.append(r)
    return results


@router.patch("/requests/{request_id}/seen", status_code=200)
def mark_request_seen(request_id: int, db: Session = Depends(get_db)):
    req = db.query(models.WantToPlayRequest).filter(models.WantToPlayRequest.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")
    req.seen = True
    db.commit()
    return {"detail": "Marked as seen"}
