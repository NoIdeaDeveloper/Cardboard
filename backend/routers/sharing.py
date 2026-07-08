import collections as _collections
import hashlib
import logging
import os
import secrets
import threading as _threading
import time
from datetime import datetime, timedelta, timezone
from typing import List, Optional

import models
import schemas
from database import get_db
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import func
from sqlalchemy.orm import Session
from utils import get_client_ip, get_game_or_404

from routers.games import _attach_parent_name, _load_tags, build_game_responses

logger = logging.getLogger("cardboard.sharing")
router = APIRouter(prefix="/api/share", tags=["sharing"])


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ----- Want-to-play per-IP rate limiter (token bucket, 10 / hour per IP) -----
_WTP_RATE_LIMIT = 10
_WTP_RATE_WINDOW = 3600.0
_wtp_buckets: dict[str, list[float]] = _collections.defaultdict(list)
_wtp_lock = _threading.Lock()


def _check_wtp_rate_limit(request: Request) -> None:
    ip = get_client_ip(request)
    now = time.time()
    cutoff = now - _WTP_RATE_WINDOW
    with _wtp_lock:
        _wtp_buckets[ip] = [t for t in _wtp_buckets[ip] if t > cutoff]
        if len(_wtp_buckets[ip]) >= _WTP_RATE_LIMIT:
            raise HTTPException(status_code=429, detail="Too many requests from your IP — please try again later")
        _wtp_buckets[ip].append(now)
        if len(_wtp_buckets) > 50:
            stale = [k for k, v in _wtp_buckets.items() if not v]
            for k in stale:
                del _wtp_buckets[k]


# ----- Retention sweep: delete want-to-play requests older than N days -----
_WTP_RETENTION_DAYS = int(os.getenv("WANT_TO_PLAY_RETENTION_DAYS", "90"))


def _sweep_expired_requests(db: Session) -> int:
    """Delete want-to-play requests older than the retention window. Returns count."""
    if _WTP_RETENTION_DAYS <= 0:
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(days=_WTP_RETENTION_DAYS)
    deleted = (
        db.query(models.WantToPlayRequest)
        .filter(models.WantToPlayRequest.created_at < cutoff)
        .delete(synchronize_session=False)
    )
    if deleted:
        db.commit()
        logger.info("Retention sweep deleted %d expired want-to-play requests", deleted)
    return deleted


def _build_game_list(db: Session) -> List[schemas.GameShareResponse]:
    games = db.query(models.Game).filter(models.Game.share_hidden == False).order_by(models.Game.name).all()
    return build_game_responses(games, db, response_cls=schemas.GameShareResponse)


@router.get("/tokens", response_model=List[schemas.ShareTokenResponse])
def list_tokens(db: Session = Depends(get_db)):
    return db.query(models.ShareToken).all()


ALLOWED_EXPIRY_MINUTES = (10, 30, 60)


@router.post("/tokens", response_model=schemas.ShareTokenResponse, status_code=201)
def create_token(label: Optional[str] = None, expires_in: Optional[int] = None, db: Session = Depends(get_db)):
    if expires_in is not None and expires_in not in ALLOWED_EXPIRY_MINUTES:
        raise HTTPException(status_code=400, detail=f"expires_in must be one of {ALLOWED_EXPIRY_MINUTES} or omitted")
    raw_token = secrets.token_urlsafe(32)
    token_hash = _hash_token(raw_token)
    expires_at = None
    if expires_in is not None:
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=expires_in)
    share = models.ShareToken(token=token_hash, label=label, expires_at=expires_at)
    db.add(share)
    db.commit()
    db.refresh(share)
    logger.info("Share token created (label=%r, expires: %s)", label, expires_at or "never")
    return schemas.ShareTokenResponse(
        token=raw_token,
        token_hash=token_hash,
        label=share.label,
        created_at=share.created_at,
        expires_at=share.expires_at,
    )


@router.delete("/tokens/{token}", status_code=204)
def delete_token(token: str, db: Session = Depends(get_db)):
    share = db.query(models.ShareToken).filter(models.ShareToken.token == token).first()
    if not share:
        raise HTTPException(status_code=404, detail="Token not found")
    db.delete(share)
    db.commit()
    logger.info("Share token revoked (label=%r)", share.label)


def _validate_token(token: str, db: Session) -> models.ShareToken:
    token_hash = _hash_token(token)
    share = db.query(models.ShareToken).filter(models.ShareToken.token == token_hash).first()
    if not share:
        raise HTTPException(status_code=404, detail="Invalid share link")
    if share.expires_at:
        exp = share.expires_at if share.expires_at.tzinfo else share.expires_at.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) > exp:
            db.delete(share)
            db.commit()
            logger.info("Expired share token deleted during validation")
            raise HTTPException(status_code=404, detail="This share link has expired")
    return share


@router.get("/{token}/games", response_model=List[schemas.GameShareResponse])
def get_shared_games(token: str, db: Session = Depends(get_db)):
    _validate_token(token, db)
    return _build_game_list(db)


@router.get("/{token}/games/{game_id}", response_model=schemas.GameShareResponse)
def get_shared_game(token: str, game_id: int, db: Session = Depends(get_db)):
    _validate_token(token, db)
    game = get_game_or_404(game_id, db)
    if game.share_hidden:
        raise HTTPException(status_code=404, detail="Game not found")
    _load_tags([game], db)
    return _attach_parent_name(game, db, response_cls=schemas.GameShareResponse)


@router.post("/{token}/games/{game_id}/want-to-play", status_code=201)
def submit_want_to_play(
    token: str,
    game_id: int,
    data: schemas.WantToPlayCreate,
    request: Request,
    db: Session = Depends(get_db),
):
    _validate_token(token, db)
    _check_wtp_rate_limit(request)
    game = get_game_or_404(game_id, db)
    if game.share_hidden:
        raise HTTPException(status_code=404, detail="Game not found")
    vname = data.visitor_name.strip() if data.visitor_name else None
    client_ip = get_client_ip(request)
    token_hash = _hash_token(token)
    total_count = (
        db.query(func.count())
        .select_from(models.WantToPlayRequest)
        .filter(
            models.WantToPlayRequest.token == token_hash,
            models.WantToPlayRequest.game_id == game_id,
            models.WantToPlayRequest.visitor_name == vname,
        )
        .scalar()
    )
    if total_count >= 3:
        raise HTTPException(status_code=429, detail="Too many requests for this game")
    req = models.WantToPlayRequest(
        token=token_hash,
        game_id=game_id,
        visitor_name=vname,
        visitor_ip=client_ip,
        message=data.message.strip() if data.message else None,
    )
    db.add(req)
    db.commit()
    logger.info("Want-to-play request: game_id=%d visitor=%r ip=%s", game_id, req.visitor_name, client_ip)
    return {"detail": "Request submitted"}


# ===== Header-based share endpoints (token via X-Share-Token header, not in URL path) =====

@router.get("/games", response_model=List[schemas.GameShareResponse])
def get_shared_games_header(
    db: Session = Depends(get_db),
    x_share_token: str = Header(..., alias="X-Share-Token"),
):
    _validate_token(x_share_token, db)
    return _build_game_list(db)


@router.get("/games/{game_id}", response_model=schemas.GameShareResponse)
def get_shared_game_header(
    game_id: int,
    db: Session = Depends(get_db),
    x_share_token: str = Header(..., alias="X-Share-Token"),
):
    _validate_token(x_share_token, db)
    game = get_game_or_404(game_id, db)
    if game.share_hidden:
        raise HTTPException(status_code=404, detail="Game not found")
    _load_tags([game], db)
    return _attach_parent_name(game, db, response_cls=schemas.GameShareResponse)


@router.post("/games/{game_id}/want-to-play", status_code=201)
def submit_want_to_play_header(
    game_id: int,
    data: schemas.WantToPlayCreate,
    request: Request,
    db: Session = Depends(get_db),
    x_share_token: str = Header(..., alias="X-Share-Token"),
):
    _validate_token(x_share_token, db)
    _check_wtp_rate_limit(request)
    game = get_game_or_404(game_id, db)
    if game.share_hidden:
        raise HTTPException(status_code=404, detail="Game not found")
    vname = data.visitor_name.strip() if data.visitor_name else None
    client_ip = get_client_ip(request)
    token_hash = _hash_token(x_share_token)
    total_count = (
        db.query(func.count())
        .select_from(models.WantToPlayRequest)
        .filter(
            models.WantToPlayRequest.token == token_hash,
            models.WantToPlayRequest.game_id == game_id,
            models.WantToPlayRequest.visitor_name == vname,
        )
        .scalar()
    )
    if total_count >= 3:
        raise HTTPException(status_code=429, detail="Too many requests for this game")
    req = models.WantToPlayRequest(
        token=token_hash,
        game_id=game_id,
        visitor_name=vname,
        visitor_ip=client_ip,
        message=data.message.strip() if data.message else None,
    )
    db.add(req)
    db.commit()
    logger.info("Want-to-play request: game_id=%d visitor=%r ip=%s", game_id, req.visitor_name, client_ip)
    return {"detail": "Request submitted"}


@router.get("/requests", response_model=List[schemas.WantToPlayResponse])
def get_want_to_play_requests(db: Session = Depends(get_db)):
    _sweep_expired_requests(db)
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
            visitor_ip=req.visitor_ip,
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


@router.delete("/requests/{request_id}", status_code=204)
def delete_want_to_play_request(request_id: int, db: Session = Depends(get_db)):
    req = db.query(models.WantToPlayRequest).filter(models.WantToPlayRequest.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")
    db.delete(req)
    db.commit()
    logger.info("Want-to-play request deleted: id=%d", request_id)
    return None
