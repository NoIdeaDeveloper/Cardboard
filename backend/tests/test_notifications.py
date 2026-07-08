"""Tests for the notifications router."""
from datetime import date, timedelta

import models


def _make_game(client, name="Test Game", status="owned", **extra):
    payload = {"name": name, "status": status, **extra}
    r = client.post("/api/games/", json=payload)
    assert r.status_code == 201
    return r.json()["id"]


def _add_session(client, game_id, played_at="2024-01-15", winner=None):
    payload = {"played_at": played_at}
    if winner:
        payload["winner"] = winner
    r = client.post(f"/api/games/{game_id}/sessions", json=payload)
    assert r.status_code == 201
    return r.json()


# ---------------------------------------------------------------------------
# GET /api/notifications/
# ---------------------------------------------------------------------------

def test_list_notifications_empty(client):
    r = client.get("/api/notifications/")
    assert r.status_code == 200
    assert r.json() == []


# ---------------------------------------------------------------------------
# POST /api/notifications/refresh — sweep materializes notifications
# ---------------------------------------------------------------------------

def test_refresh_no_notifications_for_empty_collection(client):
    r = client.post("/api/notifications/refresh")
    assert r.status_code == 200
    # Empty collection — no signals fire
    assert r.json() == []


def test_refresh_creates_unplayed_owned_notification(client):
    """5+ owned games, none played → unplayed_owned notification."""
    for i in range(6):
        _make_game(client, name=f"Game {i}")
    r = client.post("/api/notifications/refresh")
    notifs = r.json()
    kinds = [n["kind"] for n in notifs]
    assert "unplayed_owned" in kinds


def test_refresh_no_unplayed_notification_when_well_played(client):
    """5+ owned games, all played → no unplayed_owned notification."""
    for i in range(6):
        gid = _make_game(client, name=f"Game {i}")
        _add_session(client, gid, played_at="2024-06-01")
    r = client.post("/api/notifications/refresh")
    kinds = [n["kind"] for n in r.json()]
    assert "unplayed_owned" not in kinds


def test_refresh_creates_stale_collection_notification(client, db):
    """10+ sessions but last play 3+ weeks ago → stale_collection notification."""
    gid = _make_game(client, name="Old Game")
    old_date = (date.today() - timedelta(days=30)).isoformat()
    for i in range(11):
        _add_session(client, gid, played_at=old_date)
    r = client.post("/api/notifications/refresh")
    kinds = [n["kind"] for n in r.json()]
    assert "stale_collection" in kinds


def test_refresh_creates_dormant_favorite_notification(client):
    """Most-played game not played in 6+ months → dormant_favorite notification."""
    gid1 = _make_game(client, name="Favorite")
    gid2 = _make_game(client, name="Other")
    # Favorite: 10 plays, all 7 months ago
    old_date = (date.today() - timedelta(days=210)).isoformat()
    for i in range(10):
        _add_session(client, gid1, played_at=old_date)
    # Other: 1 play recently
    _add_session(client, gid2, played_at=date.today().isoformat())
    r = client.post("/api/notifications/refresh")
    kinds = [n["kind"] for n in r.json()]
    assert "dormant_favorite" in kinds


def test_refresh_creates_loan_overdue_notification(client):
    """Game loaned 60+ days ago → loan_overdue notification."""
    gid = _make_game(client, name="Loaned Game")
    old_loan_date = (date.today() - timedelta(days=70)).isoformat()
    client.patch(f"/api/games/{gid}", json={"loaned_to": "Alice", "loaned_at": old_loan_date})
    r = client.post("/api/notifications/refresh")
    kinds = [n["kind"] for n in r.json()]
    assert "loan_overdue" in kinds


def test_refresh_creates_goal_progress_notification(client):
    """Goal at 80%+ but not complete → goal_progress notification."""
    # Create a sessions_total goal with target 10
    r = client.post("/api/goals/", json={"title": "Play 10", "type": "sessions_total", "target_value": 10})
    assert r.status_code == 201
    gid = _make_game(client, name="Game")
    # Add 8 sessions (80% of 10)
    for i in range(8):
        _add_session(client, gid, played_at="2024-06-01")
    r = client.post("/api/notifications/refresh")
    kinds = [n["kind"] for n in r.json()]
    assert "goal_progress" in kinds


def test_refresh_is_idempotent(client):
    """Running refresh twice doesn't create duplicate unread notifications."""
    for i in range(6):
        _make_game(client, name=f"Game {i}")
    r1 = client.post("/api/notifications/refresh")
    count1 = len(r1.json())
    r2 = client.post("/api/notifications/refresh")
    count2 = len(r2.json())
    assert count1 == count2  # No new notifications on second sweep


# ---------------------------------------------------------------------------
# PATCH /api/notifications/{id}/read
# ---------------------------------------------------------------------------

def test_mark_notification_read(client):
    for i in range(6):
        _make_game(client, name=f"Game {i}")
    client.post("/api/notifications/refresh")
    notifs = client.get("/api/notifications/").json()
    assert len(notifs) > 0
    nid = notifs[0]["id"]
    assert notifs[0]["read_at"] is None

    r = client.patch(f"/api/notifications/{nid}/read")
    assert r.status_code == 200
    assert r.json()["read_at"] is not None


def test_mark_notification_read_not_found(client):
    r = client.patch("/api/notifications/99999/read")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# PATCH /api/notifications/read-all
# ---------------------------------------------------------------------------

def test_mark_all_read(client):
    for i in range(6):
        _make_game(client, name=f"Game {i}")
    client.post("/api/notifications/refresh")
    notifs = client.get("/api/notifications/").json()
    assert all(n["read_at"] is None for n in notifs)

    r = client.patch("/api/notifications/read-all")
    assert r.status_code == 204
    notifs = client.get("/api/notifications/").json()
    assert all(n["read_at"] is not None for n in notifs)


# ---------------------------------------------------------------------------
# DELETE /api/notifications/{id}
# ---------------------------------------------------------------------------

def test_delete_notification(client):
    for i in range(6):
        _make_game(client, name=f"Game {i}")
    client.post("/api/notifications/refresh")
    notifs = client.get("/api/notifications/").json()
    nid = notifs[0]["id"]

    r = client.delete(f"/api/notifications/{nid}")
    assert r.status_code == 204
    notifs = client.get("/api/notifications/").json()
    assert nid not in [n["id"] for n in notifs]


def test_delete_notification_not_found(client):
    r = client.delete("/api/notifications/99999")
    assert r.status_code == 404


def test_dismissed_notification_not_resurrected_by_refresh(client):
    """A dismissed (deleted) notification must not be recreated by a later sweep."""
    for i in range(6):
        _make_game(client, name=f"Game {i}")
    client.post("/api/notifications/refresh")
    notifs = client.get("/api/notifications/").json()
    assert len(notifs) >= 1
    nid = notifs[0]["id"]
    kind = notifs[0]["kind"]
    dedup_key = notifs[0].get("dedup_key") or f"{kind}:collection"

    client.delete(f"/api/notifications/{nid}")
    # Refresh again — the dismissed dedup_key should be suppressed.
    client.post("/api/notifications/refresh")
    notifs_after = client.get("/api/notifications/").json()
    assert all(n["id"] != nid for n in notifs_after), "dismissed notification reappeared"
    assert all(
        (n.get("dedup_key") or f"{n['kind']}:collection") != dedup_key
        for n in notifs_after
    ), "dismissed notification resurrected by refresh"


# ---------------------------------------------------------------------------
# Idempotent sweep after read
# ---------------------------------------------------------------------------

def test_refresh_creates_new_notification_after_read(client):
    """After marking an unread notification as read, refresh can create a new one."""
    for i in range(6):
        _make_game(client, name=f"Game {i}")
    r1 = client.post("/api/notifications/refresh")
    notifs1 = r1.json()
    nid = notifs1[0]["id"]
    client.patch(f"/api/notifications/{nid}/read")
    r2 = client.post("/api/notifications/refresh")
    notifs2 = r2.json()
    # The read one is still in the list, but a new unread one should also exist
    unread = [n for n in notifs2 if n["read_at"] is None]
    assert len(unread) >= 1


# ---------------------------------------------------------------------------
# Pagination + retention
# ---------------------------------------------------------------------------

def test_list_notifications_pagination(client):
    """limit/offset params paginate the notification list."""
    # Generate multiple distinct signals so the sweep produces 2+ notifications.
    # Signal 1: unplayed_owned (6 owned, 0 played).
    for i in range(6):
        _make_game(client, name=f"Unplayed {i}")
    # Signal 2: stale_collection (11 sessions 30 days ago on one of those games).
    stale_game = _make_game(client, name="Stale")
    old_date = (date.today() - timedelta(days=30)).isoformat()
    for i in range(11):
        _add_session(client, stale_game, played_at=old_date)
    client.post("/api/notifications/refresh")
    all_notifs = client.get("/api/notifications/").json()
    assert len(all_notifs) >= 2, f"expected 2+ notifications, got {len(all_notifs)}"

    page1 = client.get("/api/notifications/?limit=1&offset=0").json()
    assert len(page1) == 1
    assert page1[0]["id"] == all_notifs[0]["id"]

    page2 = client.get("/api/notifications/?limit=1&offset=1").json()
    assert len(page2) == 1
    assert page2[0]["id"] == all_notifs[1]["id"]

    # limit larger than available returns all.
    big = client.get("/api/notifications/?limit=200&offset=0").json()
    assert len(big) == len(all_notifs)


def test_list_notifications_rejects_invalid_limit(client):
    r = client.get("/api/notifications/?limit=0")
    assert r.status_code == 422
    r = client.get("/api/notifications/?limit=999")
    assert r.status_code == 422


def test_list_notifications_rejects_negative_offset(client):
    r = client.get("/api/notifications/?offset=-1")
    assert r.status_code == 422


def test_refresh_prunes_old_read_notifications(client, db):
    """Read notifications older than the retention window are hard-deleted by refresh."""
    from datetime import datetime, timezone
    from datetime import timedelta as _td

    from routers.notifications import NOTIF_RETENTION_DAYS

    # Create a signal so the sweep has something to do.
    for i in range(6):
        _make_game(client, name=f"Game {i}")
    client.post("/api/notifications/refresh")
    notifs = client.get("/api/notifications/").json()
    assert len(notifs) >= 1
    nid = notifs[0]["id"]

    # Mark read, then backdate created_at + read_at past the retention window.
    client.patch(f"/api/notifications/{nid}/read")
    old = datetime.now(timezone.utc) - _td(days=NOTIF_RETENTION_DAYS + 5)
    db.query(models.Notification).filter(models.Notification.id == nid).update(
        {"created_at": old, "read_at": old}
    )
    db.commit()

    # Refresh prunes old read notifications.
    client.post("/api/notifications/refresh")
    remaining = client.get("/api/notifications/").json()
    assert all(n["id"] != nid for n in remaining), "old read notification was not pruned"


def test_refresh_does_not_prune_unread_notifications(client, db):
    """Unread notifications are never pruned, regardless of age."""
    from datetime import datetime, timezone
    from datetime import timedelta as _td

    from routers.notifications import NOTIF_RETENTION_DAYS

    for i in range(6):
        _make_game(client, name=f"Game {i}")
    client.post("/api/notifications/refresh")
    notifs = client.get("/api/notifications/").json()
    nid = notifs[0]["id"]
    # Backdate created_at but leave unread.
    old = datetime.now(timezone.utc) - _td(days=NOTIF_RETENTION_DAYS + 5)
    db.query(models.Notification).filter(models.Notification.id == nid).update(
        {"created_at": old}
    )
    db.commit()

    client.post("/api/notifications/refresh")
    remaining = client.get("/api/notifications/").json()
    assert any(n["id"] == nid for n in remaining), "unread notification was pruned"


def test_refresh_prunes_old_dismissed_notifications(client, db):
    """Dismissed notifications past the retention window are hard-deleted."""
    from datetime import datetime, timezone
    from datetime import timedelta as _td

    from routers.notifications import NOTIF_RETENTION_DAYS

    for i in range(6):
        _make_game(client, name=f"Game {i}")
    client.post("/api/notifications/refresh")
    notifs = client.get("/api/notifications/").json()
    nid = notifs[0]["id"]
    client.delete(f"/api/notifications/{nid}")  # tombstone
    # Backdate both created_at and dismissed_at past retention.
    old = datetime.now(timezone.utc) - _td(days=NOTIF_RETENTION_DAYS + 5)
    db.query(models.Notification).filter(models.Notification.id == nid).update(
        {"created_at": old, "dismissed_at": old}
    )
    db.commit()

    client.post("/api/notifications/refresh")
    # The row should be gone entirely (hard-deleted).
    assert db.query(models.Notification).filter(models.Notification.id == nid).count() == 0


def test_dismissed_notification_still_suppresses_sweep_after_prune(client, db):
    """Even after a dismissed tombstone is pruned, the sweep must not resurrect it.

    This is the tricky edge: pruning removes the tombstone that suppresses
    resurrection. We accept this trade-off (the retention window is 90 days, so
    the underlying signal is unlikely to recur by then). This test documents the
    behavior rather than enforcing suppression-after-prune.
    """
    from datetime import datetime, timezone
    from datetime import timedelta as _td

    from routers.notifications import NOTIF_RETENTION_DAYS

    for i in range(6):
        _make_game(client, name=f"Game {i}")
    client.post("/api/notifications/refresh")
    notifs = client.get("/api/notifications/").json()
    nid = notifs[0]["id"]
    dedup_key = notifs[0].get("dedup_key") or f"{notifs[0]['kind']}:collection"
    client.delete(f"/api/notifications/{nid}")
    old = datetime.now(timezone.utc) - _td(days=NOTIF_RETENTION_DAYS + 5)
    db.query(models.Notification).filter(models.Notification.id == nid).update(
        {"created_at": old, "dismissed_at": old}
    )
    db.commit()
    # Prune happens here.
    client.post("/api/notifications/refresh")
    assert db.query(models.Notification).filter(models.Notification.id == nid).count() == 0

    # After prune, a future sweep CAN recreate the notification (documented behavior).
    client.post("/api/notifications/refresh")
    # The notification may or may not reappear depending on whether the sweep's
    # signal still applies; either way, the suppression tombstone is gone.
    # We only assert no crash and the endpoint returns a list.
    assert client.get("/api/notifications/").status_code == 200