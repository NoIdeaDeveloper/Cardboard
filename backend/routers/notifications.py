"""In-app notification center.

Notifications are materialized from existing data signals (dormant favorites,
unplayed owned games, goal progress, stale collection, streak risk). The sweep
is idempotent via dedup_key — re-running it won't create duplicates for signals
that already have an unread notification.
"""
import logging
from datetime import date, datetime, timedelta, timezone
from typing import List

import models
import schemas
from database import get_db
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

logger = logging.getLogger("cardboard.notifications")
router = APIRouter(prefix="/api/notifications", tags=["notifications"])


def _sweep_notifications(db: Session) -> int:
    """Materialize notifications from existing data signals.

    Returns the number of new notifications created. Idempotent: won't create
    a duplicate if an unread notification with the same dedup_key already exists.
    """
    today = date.today()
    now = datetime.now(timezone.utc)
    created = 0

    # Get existing unread dedup keys to avoid duplicates. Include dismissed
    # tombstones so a user-dismissed notification won't be resurrected by
    # later sweeps (the dedup_key is retained on the dismissed row).
    existing_unread = {
        row[0]
        for row in db.query(models.Notification.dedup_key)
        .filter(models.Notification.read_at.is_(None))
        .filter(models.Notification.dismissed_at.is_(None))
        .filter(models.Notification.dedup_key.isnot(None))
        .all()
    }
    dismissed_keys = {
        row[0]
        for row in db.query(models.Notification.dedup_key)
        .filter(models.Notification.dismissed_at.isnot(None))
        .filter(models.Notification.dedup_key.isnot(None))
        .all()
    }

    def _add(kind: str, title: str, body: str, action_url: str, dedup_key: str):
        nonlocal created
        if dedup_key in existing_unread or dedup_key in dismissed_keys:
            return
        db.add(models.Notification(
            kind=kind, title=title, body=body,
            action_url=action_url, dedup_key=dedup_key,
            created_at=now,
        ))
        existing_unread.add(dedup_key)
        created += 1

    # 1. Dormant favorite — most-played game not played in 6+ months
    session_counts = (
        db.query(
            models.PlaySession.game_id,
            func.count(models.PlaySession.id).label("play_count"),
            func.max(models.PlaySession.played_at).label("last_played"),
        )
        .group_by(models.PlaySession.game_id)
        .all()
    )
    if session_counts:
        top_game = max(session_counts, key=lambda r: r.play_count)
        if top_game.last_played:
            months_since = (today - top_game.last_played).days / 30.44
            if months_since >= 6:
                game = db.query(models.Game).filter(models.Game.id == top_game.game_id).first()
                if game:
                    _add(
                        "dormant_favorite",
                        f"{game.name} hasn't hit the table in {int(months_since)} months",
                        f"It's your most-played game ({top_game.play_count} plays) but hasn't been played since {top_game.last_played.strftime('%b %Y')}.",
                        f"/game/{game.id}",
                        f"dormant_favorite:{game.id}",
                    )

    # 2. Unplayed owned games (only if 5+ owned and <50% played)
    owned_games = (
        db.query(models.Game)
        .filter(models.Game.status == "owned")
        .all()
    )
    owned_count = len(owned_games)
    if owned_count >= 5:
        played_ids = {r.game_id for r in session_counts if r.play_count > 0}
        unplayed_owned = [g for g in owned_games if g.id not in played_ids]
        played_owned = owned_count - len(unplayed_owned)
        play_pct = round((played_owned / owned_count) * 100) if owned_count else 0
        if unplayed_owned and play_pct < 50:
            _add(
                "unplayed_owned",
                f"{len(unplayed_owned)} owned games have never been played",
                f"Only {play_pct}% of your collection has been played — dust off those boxes!",
                "/?status=owned",
                "unplayed_owned:collection",
            )

    # 3. Goal progress — goals that are 80%+ but not complete
    incomplete_goals = db.query(models.Goal).filter(models.Goal.is_complete == False).all()
    # Only the count-based goal types trigger a goal_progress notification;
    # other types are skipped to match the original behavior.
    eligible_types = {"sessions_total", "sessions_year", "unique_games_year"}
    eligible_goals = [g for g in incomplete_goals if g.type in eligible_types]
    if eligible_goals:
        # Reuse the goals batch helper to avoid N+1 (one query per type/year
        # instead of one per goal) and to avoid duplicating the goal logic here.
        from routers.goals import _compute_goal_values_batch
        current_values = _compute_goal_values_batch(eligible_goals, db)
        for goal in eligible_goals:
            current = current_values.get(goal.id, 0)
            if goal.target_value > 0 and current >= goal.target_value * 0.8 and current < goal.target_value:
                remaining = goal.target_value - current
                _add(
                    "goal_progress",
                    f"Almost there: {goal.title}",
                    f"You're at {current}/{goal.target_value} — just {remaining} to go!",
                    "/?view=stats",
                    f"goal_progress:{goal.id}",
                )

    # 4. Stale collection — no sessions in 3+ weeks (but has play history)
    last_session = (
        db.query(func.max(models.PlaySession.played_at))
        .scalar()
    )
    total_sessions = db.query(func.count()).select_from(models.PlaySession).scalar() or 0
    if last_session and total_sessions >= 10:
        days_since = (today - last_session).days
        if days_since >= 21:
            _add(
                "stale_collection",
                f"No games logged in {days_since} days",
                "Your play streaks have reset. Time to get something to the table!",
                "/?view=add",
                "stale_collection:recent",
            )

    # 5. Loan overdue — games loaned out 60+ days ago
    loaned_games = (
        db.query(models.Game)
        .filter(models.Game.loaned_to.isnot(None))
        .filter(models.Game.loaned_to != "")
        .filter(models.Game.loaned_at.isnot(None))
        .all()
    )
    for g in loaned_games:
        if g.loaned_at:
            days_loaned = (today - g.loaned_at).days
            if days_loaned >= 60:
                _add(
                    "loan_overdue",
                    f"{g.name} has been loaned out for {days_loaned} days",
                    f"Loaned to {g.loaned_to} on {g.loaned_at.strftime('%b %Y')}.",
                    f"/game/{g.id}",
                    f"loan_overdue:{g.id}",
                )

    if created:
        db.commit()
        logger.info("Notification sweep created %d new notifications", created)
    return created


NOTIF_DEFAULT_LIMIT = 50
NOTIF_MAX_LIMIT = 200
NOTIF_RETENTION_DAYS = 90


def _prune_old_notifications(db: Session) -> int:
    """Hard-delete notifications older than the retention window.

    Prunes:
      - Dismissed tombstones (dismissed_at set) older than RETENTION_DAYS.
      - Read notifications (read_at set) older than RETENTION_DAYS.
    Unread notifications are never pruned — the user hasn't seen them yet.

    Returns the number of rows deleted. After a tombstone is pruned, a future
    sweep *could* resurrect the notification (the dedup signal is gone), but the
    90-day window makes this unlikely to recur for the same signal.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=NOTIF_RETENTION_DAYS)
    deleted = (
        db.query(models.Notification)
        .filter(
            models.Notification.read_at.isnot(None)
            | models.Notification.dismissed_at.isnot(None),
            models.Notification.created_at < cutoff,
        )
        .delete(synchronize_session=False)
    )
    if deleted:
        db.commit()
        logger.info("Pruned %d old notifications", deleted)
    return deleted


@router.get("/", response_model=List[schemas.NotificationResponse])
def list_notifications(
    db: Session = Depends(get_db),
    limit: int = Query(NOTIF_DEFAULT_LIMIT, ge=1, le=NOTIF_MAX_LIMIT),
    offset: int = Query(0, ge=0),
):
    """List non-dismissed notifications, newest first, paginated."""
    return (
        db.query(models.Notification)
        .filter(models.Notification.dismissed_at.is_(None))
        .order_by(models.Notification.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )


@router.post("/refresh", response_model=List[schemas.NotificationResponse])
def refresh_notifications(
    db: Session = Depends(get_db),
    limit: int = Query(NOTIF_DEFAULT_LIMIT, ge=1, le=NOTIF_MAX_LIMIT),
    offset: int = Query(0, ge=0),
):
    """Run the notification sweep, prune old notifications, then return paginated list."""
    _sweep_notifications(db)
    _prune_old_notifications(db)
    return (
        db.query(models.Notification)
        .filter(models.Notification.dismissed_at.is_(None))
        .order_by(models.Notification.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )


@router.patch("/{notification_id}/read", response_model=schemas.NotificationResponse)
def mark_notification_read(notification_id: int, db: Session = Depends(get_db)):
    """Mark a notification as read."""
    notif = db.query(models.Notification).filter(models.Notification.id == notification_id).first()
    if not notif:
        raise HTTPException(status_code=404, detail="Notification not found")
    if notif.read_at is None:
        notif.read_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(notif)
    return notif


@router.patch("/read-all", status_code=204)
def mark_all_read(db: Session = Depends(get_db)):
    """Mark all unread notifications as read."""
    db.query(models.Notification).filter(models.Notification.read_at.is_(None)).update(
        {"read_at": datetime.now(timezone.utc)}
    )
    db.commit()


@router.delete("/{notification_id}", status_code=204)
def delete_notification(notification_id: int, db: Session = Depends(get_db)):
    """Dismiss a notification (tombstone — prevents resurrection by the sweep)."""
    notif = db.query(models.Notification).filter(models.Notification.id == notification_id).first()
    if not notif:
        raise HTTPException(status_code=404, detail="Notification not found")
    notif.dismissed_at = datetime.now(timezone.utc)
    db.commit()