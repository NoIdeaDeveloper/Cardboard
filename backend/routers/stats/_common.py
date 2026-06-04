"""Shared helpers for the stats router package."""
import logging
from datetime import date, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

import models
import schemas

logger = logging.getLogger("cardboard.stats")


def _status_counts(db: Session) -> dict:
    rows = db.query(models.Game.status, func.count(models.Game.id)).group_by(models.Game.status).all()
    result: dict = {"owned": 0, "wishlist": 0, "sold": 0}
    for status, count in rows:
        key = status or "owned"
        result[key] = result.get(key, 0) + count
    return result

def _trade_sell_candidates(db: Session, today: date, session_counts_rows: list) -> list[schemas.TradeSellEntry]:
    """Return curated list of owned games that might be good trade/sell candidates."""
    six_months_ago = today - timedelta(days=180)
    three_months_ago = today - timedelta(days=90)
    sc_map = {gid: cnt for gid, cnt in session_counts_rows}

    games = (
        db.query(
            models.Game.id,
            models.Game.name,
            models.Game.purchase_price,
            models.Game.sale_price,
            models.Game.user_rating,
            models.Game.last_played,
        )
        .filter(models.Game.status == "owned")
        .filter(models.Game.parent_game_id.is_(None))
        .all()
    )

    scored = []
    for g in games:
        score = 0
        reasons = []
        session_count = sc_map.get(g.id, 0)

        if session_count == 0:
            score += 40
            reasons.append("Never played")
        elif g.last_played and g.last_played < six_months_ago:
            score += 20
            reasons.append("Not played in 6+ months")
        elif g.last_played and g.last_played < three_months_ago:
            score += 10
            reasons.append("Not played in 3+ months")

        if g.user_rating is not None and g.user_rating < 5:
            score += 25
            reasons.append(f"Low rating ({g.user_rating}/10)")
        elif g.user_rating is not None and g.user_rating < 7:
            score += 10
            reasons.append(f"Mediocre rating ({g.user_rating}/10)")

        if g.purchase_price and g.purchase_price > 0 and session_count > 0:
            cpp = g.purchase_price / session_count
            if cpp > 20:
                score += 15
                reasons.append(f"High cost per play (${cpp:.0f})")
            elif cpp > 10:
                score += 5
                reasons.append(f"Costly per play (${cpp:.0f})")

        if score > 0:
            scored.append(schemas.TradeSellEntry(
                id=g.id,
                name=g.name,
                purchase_price=g.purchase_price,
                sale_price=g.sale_price,
                user_rating=g.user_rating,
                last_played=g.last_played,
                session_count=session_count,
                score=score,
                reason="; ".join(reasons),
            ))

    scored.sort(key=lambda x: x.score, reverse=True)
    return scored[:10]
