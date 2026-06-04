"""Trade/sell curation endpoint (GET /api/stats/trade-sell)."""
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


from routers.stats._common import _trade_sell_candidates


@router.get("/stats/trade-sell", response_model=schemas.TradeSellResponse)
def get_trade_sell_candidates(db: Session = Depends(get_db)):
    """Return a curated list of owned games that might be good trade/sell candidates."""
    today = date.today()
    session_counts_rows = (
        db.query(models.PlaySession.game_id, func.count(models.PlaySession.id))
        .group_by(models.PlaySession.game_id)
        .all()
    )
    games = _trade_sell_candidates(db, today, session_counts_rows)
    return schemas.TradeSellResponse(games=games)
