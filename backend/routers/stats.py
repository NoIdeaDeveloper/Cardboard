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


def _status_counts(db: Session) -> dict:
    rows = db.query(models.Game.status, func.count(models.Game.id)).group_by(models.Game.status).all()
    result: dict = {"owned": 0, "wishlist": 0, "sold": 0}
    for status, count in rows:
        key = status or "owned"
        result[key] = result.get(key, 0) + count
    return result


def _iso_month_to_label(iso_month: str) -> str:
    """Convert a 'YYYY-MM' string to a display label like 'Jan 2025'."""
    return date(int(iso_month[:4]), int(iso_month[5:7]), 1).strftime("%b %Y")


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


@router.get("/stats", response_model=schemas.StatsResponse)
def get_stats(db: Session = Depends(get_db)):
    # ── Game counts ──────────────────────────────────────────────────────────
    by_status = _status_counts(db)
    total_games = sum(by_status.values())

    # ── Session aggregates ───────────────────────────────────────────────────
    session_agg = db.query(
        func.count(models.PlaySession.id),
        func.coalesce(func.sum(models.PlaySession.duration_minutes), 0),
    ).first()
    total_sessions = int(session_agg[0] or 0)
    total_minutes = int(session_agg[1] or 0)
    total_hours = round(total_minutes / 60, 1)
    avg_session_minutes = round(total_minutes / total_sessions, 1) if total_sessions else 0.0

    # ── Most played (top 5 by session count) ────────────────────────────────
    most_played_rows = (
        db.query(
            models.Game.id,
            models.Game.name,
            func.count(models.PlaySession.id).label("count"),
            func.coalesce(func.sum(models.PlaySession.duration_minutes), 0).label("total_minutes"),
        )
        .join(models.PlaySession, models.PlaySession.game_id == models.Game.id)
        .group_by(models.Game.id, models.Game.name)
        .order_by(func.count(models.PlaySession.id).desc())
        .limit(5)
        .all()
    )
    most_played = [
        schemas.MostPlayedEntry(id=gid, name=name, count=count, total_minutes=int(tot_min))
        for gid, name, count, tot_min in most_played_rows
    ]

    # ── Never played ─────────────────────────────────────────────────────────
    never_played_count = (
        db.query(func.count(models.Game.id))
        .outerjoin(models.PlaySession, models.PlaySession.game_id == models.Game.id)
        .filter(models.PlaySession.id.is_(None))
        .filter(models.Game.status == "owned")
        .scalar() or 0
    )

    # ── Average rating ───────────────────────────────────────────────────────
    avg_rating_raw = (
        db.query(func.avg(models.Game.user_rating))
        .filter(models.Game.user_rating.isnot(None))
        .scalar()
    )
    avg_rating = round(float(avg_rating_raw), 1) if avg_rating_raw is not None else None

    # ── Total spent ──────────────────────────────────────────────────────────
    total_spent_raw = (
        db.query(func.sum(models.Game.purchase_price))
        .filter(models.Game.purchase_price.isnot(None))
        .scalar()
    )
    total_spent = round(float(total_spent_raw), 2) if total_spent_raw is not None else None

    # ── Label counts (via junction tables) ──────────────────────────────────────
    label_rows = (
        db.query(models.Label.name, func.count(models.GameLabel.game_id))
        .join(models.GameLabel, models.Label.id == models.GameLabel.label_id)
        .group_by(models.Label.name)
        .all()
    )
    label_counts: dict = {name: count for name, count in label_rows}

    # ── Rating distribution ───────────────────────────────────────────────────
    r = models.Game.user_rating
    (b1, b2, b3, b4, b5) = db.query(
        func.count(case((r < 3,  1))),
        func.count(case(((r >= 3) & (r < 5),  1))),
        func.count(case(((r >= 5) & (r < 7),  1))),
        func.count(case(((r >= 7) & (r < 9),  1))),
        func.count(case((r >= 9,  1))),
    ).filter(r.isnot(None)).one()
    buckets = {"1–2": b1, "3–4": b2, "5–6": b3, "7–8": b4, "9–10": b5}

    # ── Build 12-month skeleton (reused for games and sessions) ──────────────
    today = date.today()
    month_keys: list = []
    window_start = None
    for i in range(11, -1, -1):
        year = today.year
        month = today.month - i
        while month <= 0:
            month += 12
            year -= 1
        d = date(year, month, 1)
        if window_start is None:
            window_start = d
        month_keys.append(d.strftime("%b %Y"))

    # ── Added by month (SQL GROUP BY — avoids full table scan in Python) ──────
    month_counts: dict = {k: 0 for k in month_keys}
    for iso_month, count in db.query(
        func.strftime("%Y-%m", models.Game.date_added).label("month"),
        func.count(models.Game.id).label("count"),
    ).filter(
        models.Game.date_added.isnot(None),
        models.Game.date_added >= window_start,
    ).group_by("month").all():
        key = _iso_month_to_label(iso_month)
        if key in month_counts:
            month_counts[key] += count

    added_by_month = [
        schemas.AddedByMonthEntry(month=m, count=c)
        for m, c in month_counts.items()
    ]

    # ── Sessions by month (SQL GROUP BY) ──────────────────────────────────────
    session_month_counts: dict = {k: 0 for k in month_keys}
    session_month_game_ids: dict = {k: set() for k in month_keys}
    for game_id, iso_month, count in db.query(
        models.PlaySession.game_id,
        func.strftime("%Y-%m", models.PlaySession.played_at).label("month"),
        func.count(models.PlaySession.id).label("count"),
    ).filter(
        models.PlaySession.played_at.isnot(None),
        models.PlaySession.played_at >= window_start,
    ).group_by(
        models.PlaySession.game_id, "month"
    ).all():
        key = _iso_month_to_label(iso_month)
        if key in session_month_counts:
            session_month_counts[key] += count
            session_month_game_ids[key].add(game_id)

    sessions_by_month = [
        schemas.SessionsByMonthEntry(month=m, count=c, game_ids=sorted(session_month_game_ids[m]))
        for m, c in session_month_counts.items()
    ]

    # ── Recent sessions (last 10) ─────────────────────────────────────────────
    recent_rows = (
        db.query(models.PlaySession, models.Game.name)
        .join(models.Game, models.PlaySession.game_id == models.Game.id)
        .order_by(models.PlaySession.played_at.desc(), models.PlaySession.date_added.desc())
        .limit(10)
        .all()
    )
    recent_sessions = [
        schemas.RecentSessionEntry(
            game_id=s.game_id,
            game_name=name,
            played_at=s.played_at,
            player_count=s.player_count,
            duration_minutes=s.duration_minutes,
        )
        for s, name in recent_rows
    ]

    # ── Session counts per game ─────────────────────────────────────────────
    session_counts_rows = (
        db.query(models.PlaySession.game_id, func.count(models.PlaySession.id))
        .group_by(models.PlaySession.game_id)
        .all()
    )
    session_counts = {str(gid): count for gid, count in session_counts_rows}

    # ── Collection value stats ────────────────────────────────────────────────
    owned_priced = (
        db.query(models.Game.id, models.Game.name, models.Game.purchase_price,
                 models.Game.last_played, models.Game.date_added)
        .filter(models.Game.status == "owned", models.Game.purchase_price.isnot(None),
                models.Game.purchase_price > 0)
        .all()
    )
    collection_value = schemas.CollectionValueStats()
    if owned_priced:
        all_prices = [r.purchase_price for r in owned_priced]
        collection_value.owned_total = round(sum(all_prices), 2)
        collection_value.avg_price   = round(sum(all_prices) / len(all_prices), 2)
        unplayed_prices = [r.purchase_price for r in owned_priced if not r.last_played]
        collection_value.unplayed_total = round(sum(unplayed_prices), 2) if unplayed_prices else 0.0

        sc_map: dict[int, int] = {gid: cnt for gid, cnt in session_counts_rows}

        # Best Value by Play: lowest $/session (owned games with ≥1 session)
        bvp = sorted(
            [r for r in owned_priced if sc_map.get(r.id, 0) > 0],
            key=lambda r: r.purchase_price / sc_map[r.id],
        )[:5]
        collection_value.best_value_by_play = [
            schemas.ValueGameEntry(
                id=r.id, name=r.name, purchase_price=r.purchase_price,
                sessions=sc_map[r.id],
                cpp=round(r.purchase_price / sc_map[r.id], 2),
            )
            for r in bvp
        ]

        # Best Value by Time: lowest $/hr (games with logged duration)
        minutes_map: dict[int, int] = {
            gid: int(tot)
            for gid, tot in db.query(
                models.PlaySession.game_id,
                func.coalesce(func.sum(models.PlaySession.duration_minutes), 0),
            )
            .filter(models.PlaySession.game_id.in_([r.id for r in owned_priced]))
            .group_by(models.PlaySession.game_id)
            .all()
            if tot and tot > 0
        }
        bvt = sorted(
            [r for r in owned_priced if minutes_map.get(r.id, 0) > 0],
            key=lambda r: r.purchase_price / (minutes_map[r.id] / 60),
        )[:5]
        collection_value.best_value_by_time = [
            schemas.ValueGameEntry(
                id=r.id, name=r.name, purchase_price=r.purchase_price,
                total_minutes=minutes_map[r.id],
                cph=round(r.purchase_price / (minutes_map[r.id] / 60), 2),
            )
            for r in bvt
        ]

        # Most Expensive Unplayed: top 5 priciest owned, never played
        meu = sorted(
            [r for r in owned_priced if not r.last_played],
            key=lambda r: -r.purchase_price,
        )[:5]
        collection_value.most_expensive_unplayed = [
            schemas.ValueGameEntry(
                id=r.id, name=r.name, purchase_price=r.purchase_price,
                date_added=r.date_added,
            )
            for r in meu
        ]

    # ── Expansion count ──────────────────────────────────────────────────────
    total_expansions = (
        db.query(func.count(models.Game.id))
        .filter(models.Game.parent_game_id.isnot(None))
        .scalar() or 0
    )

    # ── Top players (top 5 by session count) ────────────────────────────────
    top_player_rows = (
        db.query(
            models.Player.id,
            models.Player.name,
            models.Player.avatar_ext,
            models.Player.avatar_preset,
            func.count(models.SessionPlayer.session_id).label("session_count"),
        )
        .join(models.SessionPlayer, models.SessionPlayer.player_id == models.Player.id)
        .group_by(models.Player.id, models.Player.name, models.Player.avatar_ext, models.Player.avatar_preset)
        .order_by(func.count(models.SessionPlayer.session_id).desc())
        .limit(5)
        .all()
    )
    # Get win counts for these players
    top_player_ids = [r.id for r in top_player_rows]
    win_rows = (
        db.query(models.Player.id, func.count(models.PlaySession.id).label("wins"))
        .join(models.PlaySession, models.PlaySession.winner == models.Player.name)
        .filter(models.Player.id.in_(top_player_ids), models.PlaySession.winner.isnot(None))
        .group_by(models.Player.id)
        .all()
    ) if top_player_ids else []
    win_by_id = {r.id: r.wins for r in win_rows}
    top_players = [
        schemas.TopPlayerEntry(
            player_id=r.id,
            player_name=r.name,
            session_count=r.session_count,
            win_count=win_by_id.get(r.id, 0),
            win_rate=round(win_by_id.get(r.id, 0) / r.session_count * 100) if r.session_count else 0,
            avatar_url=(f"/api/players/{r.id}/avatar" if r.avatar_ext else f"/avatars/{r.avatar_preset}.svg" if r.avatar_preset else None),
        )
        for r in top_player_rows
    ]

    # ── Sessions by day of week ──────────────────────────────────────────────
    dow_rows = (
        db.query(
            func.strftime("%w", models.PlaySession.played_at).label("dow"),
            func.count(models.PlaySession.id).label("count"),
        )
        .group_by("dow")
        .all()
    )
    # Collect distinct game_ids per DOW for drill-down
    dow_game_rows = (
        db.query(
            func.strftime("%w", models.PlaySession.played_at).label("dow"),
            models.PlaySession.game_id,
        )
        .distinct()
        .all()
    )
    dow_game_ids: dict[int, list[int]] = {}
    for dow_str, game_id in dow_game_rows:
        d = int(dow_str)
        dow_game_ids.setdefault(d, []).append(game_id)
    sessions_by_dow = [
        schemas.SessionsByDowEntry(dow=int(dow), count=count, game_ids=dow_game_ids.get(int(dow), []))
        for dow, count in dow_rows
    ]

    # ── Sessions by day — last 52 weeks ──────────────────────────────────────
    cutoff = today - timedelta(weeks=52)
    day_rows = (
        db.query(
            func.strftime("%Y-%m-%d", models.PlaySession.played_at).label("day"),
            func.count(models.PlaySession.id).label("count"),
        )
        .filter(models.PlaySession.played_at >= cutoff)
        .group_by("day")
        .all()
    )
    # Collect distinct game_ids per day for drill-down
    day_game_rows = (
        db.query(
            func.strftime("%Y-%m-%d", models.PlaySession.played_at).label("day"),
            models.PlaySession.game_id,
        )
        .filter(models.PlaySession.played_at >= cutoff)
        .distinct()
        .all()
    )
    day_game_ids: dict[str, list[int]] = {}
    for day_str, game_id in day_game_rows:
        day_game_ids.setdefault(day_str, []).append(game_id)
    sessions_by_day = [
        schemas.SessionsByDayEntry(date=r.day, count=r.count, game_ids=day_game_ids.get(r.day, []))
        for r in day_rows
    ]

    # ── Shelf warmers (owned base games last played 90–365 days ago) ─────────
    # Sits between "recently played" and the 12+ month "Dormant" section: an
    # actionable nudge for games cooling off but not yet abandoned.
    shelf_cold = today - timedelta(days=90)
    shelf_dormant = today - timedelta(days=365)
    shelf_rows = (
        db.query(models.Game.id, models.Game.name, models.Game.last_played)
        .filter(
            models.Game.status == "owned",
            models.Game.parent_game_id.is_(None),
            models.Game.last_played.isnot(None),
            models.Game.last_played < shelf_cold,
            models.Game.last_played >= shelf_dormant,
        )
        .order_by(models.Game.last_played.asc())
        .limit(5)
        .all()
    )
    shelf_warmers = [
        schemas.ShelfWarmerEntry(
            id=r.id, name=r.name, last_played=r.last_played,
            days_since=(today - r.last_played).days,
        )
        for r in shelf_rows
    ]

    # ── Top mechanics (owned base games via junction table) ───────────────────
    top_mechanic_rows = (
        db.query(models.Mechanic.name, func.count(models.GameMechanic.game_id).label("cnt"))
        .join(models.GameMechanic, models.GameMechanic.mechanic_id == models.Mechanic.id)
        .join(models.Game, models.Game.id == models.GameMechanic.game_id)
        .filter(models.Game.status == "owned")
        .group_by(models.Mechanic.name)
        .order_by(func.count(models.GameMechanic.game_id).desc())
        .limit(10)
        .all()
    )
    top_mechanics = [schemas.TopMechanicEntry(name=name, count=cnt) for name, cnt in top_mechanic_rows]
    top_mechanic = top_mechanics[0].name if top_mechanics else None

    # ── Dormant games (owned, last played 12+ months ago) ────────────────────
    dormant_cutoff = today - timedelta(days=365)
    dormant_rows = (
        db.query(models.Game.id, models.Game.name, models.Game.last_played)
        .filter(
            models.Game.status == "owned",
            models.Game.parent_game_id.is_(None),
            models.Game.last_played.isnot(None),
            models.Game.last_played < dormant_cutoff,
        )
        .order_by(models.Game.last_played.asc())
        .all()
    )
    dormant_games = [
        schemas.DormantGameEntry(id=r.id, name=r.name, last_played=r.last_played)
        for r in dormant_rows
    ]

    # ── Recently added (top 5 owned/sold base games by date_added) ───────────
    recently_added_rows = (
        db.query(models.Game.id, models.Game.name, models.Game.date_added)
        .filter(
            models.Game.status != "wishlist",
            models.Game.parent_game_id.is_(None),
        )
        .order_by(models.Game.date_added.desc())
        .limit(5)
        .all()
    )
    recently_added = [
        schemas.RecentlyAddedEntry(id=r.id, name=r.name, date_added=r.date_added)
        for r in recently_added_rows
    ]

    # ── Never-played list (owned base games, no sessions ever) ───────────────
    never_played_rows = (
        db.query(models.Game.id, models.Game.name, models.Game.date_added)
        .outerjoin(models.PlaySession, models.PlaySession.game_id == models.Game.id)
        .filter(
            models.Game.status == "owned",
            models.Game.parent_game_id.is_(None),
            models.PlaySession.id.is_(None),
        )
        .order_by(models.Game.date_added.asc())
        .all()
    )
    never_played_list = [
        schemas.NeverPlayedEntry(id=r.id, name=r.name, date_added=r.date_added)
        for r in never_played_rows
    ]

    # ── Neglected favorite (most-played owned game, not played in 6+ months) ─
    neglected_favorite = None
    six_months_ago = today - timedelta(days=180)
    if session_counts_rows:
        sc_map_all: dict[int, int] = {gid: cnt for gid, cnt in session_counts_rows}
        neglected_rows = (
            db.query(models.Game.id, models.Game.name, models.Game.last_played)
            .filter(
                models.Game.status == "owned",
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

    # ── Rating vs BGG delta (top 8 by abs delta, games with both ratings) ────
    delta_rows = (
        db.query(models.Game.id, models.Game.name, models.Game.user_rating, models.Game.bgg_rating)
        .filter(
            models.Game.user_rating.isnot(None),
            models.Game.bgg_rating.isnot(None),
        )
        .all()
    )
    rating_vs_bgg = sorted(
        [schemas.RatingDeltaEntry(id=r.id, name=r.name, delta=round(r.user_rating - r.bgg_rating, 1))
         for r in delta_rows],
        key=lambda e: abs(e.delta),
        reverse=True,
    )[:8]

    # ── Collection health score ───────────────────────────────────────────────
    owned_base_count = (
        db.query(func.count(models.Game.id))
        .filter(models.Game.status == "owned", models.Game.parent_game_id.is_(None))
        .scalar() or 0
    )
    played_base_count = (
        db.query(func.count(models.Game.id))
        .filter(
            models.Game.status == "owned",
            models.Game.parent_game_id.is_(None),
            models.Game.last_played.isnot(None),
        )
        .scalar() or 0
    )
    avg_rating_owned_raw = (
        db.query(func.avg(models.Game.user_rating))
        .filter(models.Game.status == "owned", models.Game.parent_game_id.is_(None), models.Game.user_rating.isnot(None))
        .scalar() or 0.0
    )
    unique_mechanics_count = (
        db.query(func.count(func.distinct(models.GameMechanic.mechanic_id)))
        .join(models.Game, models.Game.id == models.GameMechanic.game_id)
        .filter(models.Game.status == "owned", models.Game.parent_game_id.is_(None))
        .scalar() or 0
    )
    _play_pct = (played_base_count / owned_base_count) if owned_base_count else 0.0
    _rating_score = float(avg_rating_owned_raw) / 10.0
    _diversity_score = min(1.0, unique_mechanics_count / 20.0)
    _health_score = round((_play_pct * 0.4 + _rating_score * 0.4 + _diversity_score * 0.2) * 100)
    collection_health = schemas.CollectionHealth(
        score=_health_score,
        play_pct=round(_play_pct * 100),
        rating_score=round(_rating_score * 100),
        diversity_score=round(_diversity_score * 100),
        played_count=played_base_count,
        owned_base_count=owned_base_count,
        avg_rating_raw=round(float(avg_rating_owned_raw), 1),
        unique_mechanics=unique_mechanics_count,
    )

    # ── Added by month — owned+sold only (no wishlist) ────────────────────────
    owned_month_counts: dict = {k: 0 for k in month_keys}
    for iso_month, count in db.query(
        func.strftime("%Y-%m", models.Game.date_added).label("month"),
        func.count(models.Game.id).label("count"),
    ).filter(
        models.Game.date_added.isnot(None),
        models.Game.date_added >= window_start,
        models.Game.status != "wishlist",
    ).group_by("month").all():
        key = _iso_month_to_label(iso_month)
        if key in owned_month_counts:
            owned_month_counts[key] += count

    added_by_month_owned_only = [
        schemas.AddedByMonthEntry(month=m, count=c)
        for m, c in owned_month_counts.items()
    ]

    # ── Play streaks (derived from sessions_by_day set) ──────────────────────
    day_set = {r.day for r in day_rows}
    # Daily streak — count consecutive days backwards from today
    daily_streak = 0
    check_day = today
    while check_day.strftime("%Y-%m-%d") in day_set:
        daily_streak += 1
        check_day -= timedelta(days=1)

    # Weekly streak — max consecutive ISO weeks with at least one session
    def _iso_week(d: date) -> tuple:
        return d.isocalendar()[:2]  # (year, week_number)

    weeks_with_sessions: set = set()
    for ds in day_set:
        weeks_with_sessions.add(_iso_week(date.fromisoformat(ds)))
    max_weekly_streak = 0
    run_weekly = 0
    for w in range(52):
        week_key = _iso_week(today - timedelta(weeks=w))
        if week_key in weeks_with_sessions:
            run_weekly += 1
            max_weekly_streak = max(max_weekly_streak, run_weekly)
        else:
            run_weekly = 0
    best_weekly_streak = max_weekly_streak

    # ── Top wishlist game (highest priority) ─────────────────────────────────
    wishlist_row = (
        db.query(models.Game.id, models.Game.name)
        .filter(models.Game.status == "wishlist")
        .order_by(models.Game.priority.desc().nulls_last(), models.Game.date_added.desc())
        .first()
    )
    top_wishlist_game = (
        schemas.TopWishlistEntry(id=wishlist_row.id, name=wishlist_row.name)
        if wishlist_row else None
    )

    # ── Unplayed owned games with the top mechanic ────────────────────────────
    unplayed_with_top_mechanic = 0
    if top_mechanic:
        unplayed_with_top_mechanic = (
            db.query(func.count(models.Game.id))
            .join(models.GameMechanic, models.GameMechanic.game_id == models.Game.id)
            .join(models.Mechanic, models.Mechanic.id == models.GameMechanic.mechanic_id)
            .filter(
                models.Game.status == "owned",
                models.Game.last_played.is_(None),
                models.Mechanic.name == top_mechanic,
            )
            .scalar() or 0
        )

    # ── Best at X Players ──────────────────────────────────────────────────
    # Requires at least 2 sessions at a given player count to be meaningful.
    player_count_ratings = (
        db.query(
            models.PlaySession.game_id,
            models.PlaySession.player_count,
            func.avg(models.PlaySession.session_rating).label("avg_r"),
            func.count(models.PlaySession.id).label("cnt"),
        )
        .join(models.Game, models.Game.id == models.PlaySession.game_id)
        .filter(
            models.PlaySession.session_rating.isnot(None),
            models.PlaySession.player_count.isnot(None),
            models.Game.status == "owned",
            models.Game.parent_game_id.is_(None),
        )
        .group_by(models.PlaySession.game_id, models.PlaySession.player_count)
        .having(func.count(models.PlaySession.id) >= 2)
        .all()
    )
    best_by_game: dict[int, tuple[int, float, int]] = {}
    for gid, pc, avg_r, cnt in player_count_ratings:
        prev = best_by_game.get(gid)
        if prev is None or avg_r > prev[1] or (avg_r == prev[1] and cnt > prev[2]):
            best_by_game[gid] = (pc, float(avg_r), cnt)
    if best_by_game:
        game_rows = (
            db.query(models.Game.id, models.Game.name, models.Game.image_url)
            .filter(
                models.Game.id.in_(best_by_game.keys()),
                models.Game.status == "owned",
                models.Game.parent_game_id.is_(None),
            )
            .all()
        )
        game_info = {g.id: (g.name, g.image_url) for g in game_rows}
        best_at_player_counts = sorted(
            [
                schemas.BestPlayerCountEntry(
                    game_id=gid,
                    game_name=game_info[gid][0],
                    player_count=pc,
                    avg_rating=avg_r,
                    total_sessions=cnt,
                    image_url=game_info[gid][1],
                )
                for gid, (pc, avg_r, cnt) in best_by_game.items()
                if gid in game_info
            ],
            key=lambda e: -e.avg_rating,
        )[:10]
    else:
        best_at_player_counts = []

    # ── Play Projection ────────────────────────────────────────────────────
    play_projection = None
    if total_sessions > 0 and never_played_count > 0:
        avg_plays_per_week = total_sessions / 52.0
        weeks_to_clear = never_played_count / avg_plays_per_week
        projected_clear_date = today + timedelta(weeks=weeks_to_clear)
        play_projection = schemas.PlayProjection(
            unplayed_count=never_played_count,
            avg_plays_per_week=round(avg_plays_per_week, 1),
            projected_clear_date=projected_clear_date,
            weeks_to_clear=round(weeks_to_clear, 1),
        )

    # ── Collection Churn Dashboard ─────────────────────────────────────────
    ever_acquired = by_status["owned"] + by_status["sold"]
    current_year = str(today.year)
    acquired_this_year, sold_this_year = db.query(
        func.count(case((
            models.Game.status.in_(["owned", "sold"]) & (func.strftime("%Y", models.Game.date_added) == current_year),
            1,
        ))),
        func.count(case((
            (models.Game.status == "sold") & (func.strftime("%Y", models.Game.date_added) == current_year),
            1,
        ))),
    ).one()
    collection_churn = schemas.CollectionChurn(
        total_ever_acquired=ever_acquired,
        total_sold=by_status["sold"],
        current_owned=by_status["owned"],
        churn_rate=round(by_status["sold"] / ever_acquired, 3) if ever_acquired else 0.0,
        acquired_this_year=acquired_this_year,
        sold_this_year=sold_this_year,
    )

    # ── Collection Health Notifications ────────────────────────────────────
    health_notifications: list[str] = []
    if ch := collection_health:
        if ch.play_pct < 50 and by_status["owned"] >= 5:
            health_notifications.append(f"Only {ch.play_pct}% of your collection has been played — dust off those boxes!")
        if ch.diversity_score < 50:
            health_notifications.append("Your collection is concentrated in a few mechanics — try branching out")
    if neglected_favorite:
        health_notifications.append(
            f"{neglected_favorite.name} was your most-played game but hasn't hit the table in "
            f"{neglected_favorite.months_ago} months"
        )
    if unplayed_with_top_mechanic > 0 and top_mechanic:
        health_notifications.append(f"You have {unplayed_with_top_mechanic} unplayed {top_mechanic} game{'s' if unplayed_with_top_mechanic > 1 else ''}")
    if daily_streak == 0 and best_weekly_streak == 0 and total_sessions >= 10:
        health_notifications.append("No plays recently — your streaks have reset")
    elif daily_streak > 0:
        health_notifications.append(f"Keep it going — you're on a {daily_streak}-day play streak!")
    if unplayed_with_top_mechanic > 0 and collection_value.unplayed_total and collection_value.unplayed_total > 0:
        health_notifications.append(
            f"${collection_value.unplayed_total:,.2f} worth of games are still unplayed"
        )
    health_notifications = health_notifications[:4]

    # ── Trade / Sell Curation ──────────────────────────────────────────────
    trade_sell_games = _trade_sell_candidates(db, today, session_counts_rows)

    logger.info("Stats computed: %d games, %d sessions, %d expansions", total_games, total_sessions, total_expansions)

    return schemas.StatsResponse(
        total_games=total_games,
        by_status=by_status,
        total_sessions=total_sessions,
        total_hours=total_hours,
        avg_session_minutes=avg_session_minutes,
        most_played=most_played,
        never_played_count=never_played_count,
        avg_rating=avg_rating,
        total_spent=total_spent,
        label_counts=dict(sorted(label_counts.items(), key=lambda x: -x[1])),
        ratings_distribution=buckets,
        added_by_month=added_by_month,
        sessions_by_month=sessions_by_month,
        recent_sessions=recent_sessions,
        session_counts=session_counts,
        total_expansions=total_expansions,
        top_players=top_players,
        sessions_by_dow=sessions_by_dow,
        sessions_by_day=sessions_by_day,
        collection_value=collection_value,
        shelf_warmers=shelf_warmers,
        top_mechanic=top_mechanic,
        top_mechanics=top_mechanics,
        dormant_games=dormant_games,
        recently_added=recently_added,
        never_played_list=never_played_list,
        neglected_favorite=neglected_favorite,
        rating_vs_bgg=rating_vs_bgg,
        collection_health=collection_health,
        added_by_month_owned_only=added_by_month_owned_only,
        daily_streak=daily_streak,
        best_weekly_streak=best_weekly_streak,
        top_wishlist_game=top_wishlist_game,
        unplayed_with_top_mechanic=unplayed_with_top_mechanic,
        best_at_player_counts=best_at_player_counts,
        play_projection=play_projection,
        collection_churn=collection_churn,
        health_notifications=health_notifications,
        trade_sell=trade_sell_games,
    )


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
        .filter(models.Game.status == "owned")
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
        ).filter(models.Mechanic.name == mechanic)
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
