"""Tests for share token creation and public collection access."""
import logging
import pytest
from datetime import datetime, timedelta, timezone


@pytest.fixture(autouse=True)
def _clear_wtp_rate_limit():
    """Reset the want-to-play per-IP rate limiter between tests."""
    import routers.sharing as _sharing
    _sharing._wtp_buckets.clear()
    yield
    _sharing._wtp_buckets.clear()


def _make_game(client, name="Shared Game", **extra):
    payload = {"name": name, "status": "owned"}
    payload.update(extra)
    r = client.post("/api/games/", json=payload)
    assert r.status_code == 201
    return r.json()["id"]


def test_create_token_no_expiry(client):
    r = client.post("/api/share/tokens")
    assert r.status_code == 201
    data = r.json()
    assert "token" in data
    assert len(data["token"]) > 0
    assert data["expires_at"] is None
    assert "token_hash" in data
    assert data["token_hash"] is not None
    assert data["token"] != data["token_hash"]


def test_create_token_with_expiry(client):
    r = client.post("/api/share/tokens?expires_in=10")
    assert r.status_code == 201
    data = r.json()
    assert data["expires_at"] is not None


def test_create_token_invalid_expiry(client):
    # 7 is not in ALLOWED_EXPIRY_MINUTES = (10, 30, 60)
    r = client.post("/api/share/tokens?expires_in=7")
    assert r.status_code == 400


def test_list_tokens(client):
    client.post("/api/share/tokens")
    r = client.get("/api/share/tokens")
    assert r.status_code == 200
    assert isinstance(r.json(), list)
    assert len(r.json()) >= 1
    # Listed tokens should not include the raw token or token_hash
    for t in r.json():
        assert "token" in t
        assert t.get("token_hash") is None


def test_shared_games_valid_token(client):
    _make_game(client)
    token = client.post("/api/share/tokens").json()["token"]

    r = client.get(f"/api/share/{token}/games")
    assert r.status_code == 200
    assert isinstance(r.json(), list)
    assert len(r.json()) >= 1


def test_shared_games_invalid_token(client):
    r = client.get("/api/share/notarealtoken/games")
    assert r.status_code == 404


def test_delete_token(client):
    data = client.post("/api/share/tokens").json()
    token = data["token"]
    token_hash = data["token_hash"]
    r = client.delete(f"/api/share/tokens/{token_hash}")
    assert r.status_code == 204
    r2 = client.get(f"/api/share/{token}/games")
    assert r2.status_code == 404


def test_shared_games_exclude_private_fields(client):
    """Share-token responses must not include financial, personal, or internal fields."""
    _make_game(
        client,
        name="Private Game",
        status="owned",
        purchase_price=99.99,
        purchase_location="Friendly Local Game Store",
        sale_price=50.0,
        location="Top shelf",
        user_notes="Birthday gift from Sarah",
        loaned_to="Alex",
        target_price=30.0,
        priority=3,
        condition="Good",
        edition="First Edition",
    )
    token = client.post("/api/share/tokens").json()["token"]

    # Test list endpoint
    r = client.get(f"/api/share/{token}/games")
    assert r.status_code == 200
    games = r.json()
    assert len(games) >= 1
    game = games[-1]

    # Private fields must NOT be present
    for private_field in [
        "purchase_price", "purchase_location", "purchase_date", "sale_price",
        "location", "show_location", "user_notes", "loaned_to", "loaned_at",
        "target_price", "priority", "condition", "edition", "share_hidden",
        "instructions_filename", "image_cached", "image_ext", "image_cache_status",
        "date_added", "date_modified", "last_played", "parent_game_id",
    ]:
        assert private_field not in game, f"Private field '{private_field}' leaked into share response"

    # Share-safe fields SHOULD be present
    for safe_field in ["id", "name", "status", "user_rating", "bgg_id", "session_count"]:
        assert safe_field in game, f"Safe field '{safe_field}' missing from share response"


def test_shared_single_game_excludes_private_fields(client):
    """Single-game share endpoint must also exclude private fields."""
    gid = _make_game(
        client,
        name="Single Private Game",
        purchase_price=42.0,
        user_notes="Secret notes",
        location="Closet",
    )
    token = client.post("/api/share/tokens").json()["token"]

    r = client.get(f"/api/share/{token}/games/{gid}")
    assert r.status_code == 200
    game = r.json()

    for private_field in ["purchase_price", "user_notes", "location", "loaned_to", "target_price"]:
        assert private_field not in game, f"Private field '{private_field}' leaked into single-game share response"


# ===== RC3: Log redaction tests =====

def test_redact_path_share_games():
    from main import _redact_path
    assert _redact_path("/api/share/abc123token/games") == "/api/share/***/games"
    assert _redact_path("/api/share/abc123token/games/42") == "/api/share/***/games/42"
    assert _redact_path("/api/share/abc123token/games/42/want-to-play") == "/api/share/***/games/42/want-to-play"
    assert _redact_path("/api/share/tokens/abc123token") == "/api/share/tokens/***"
    # Non-share paths are not redacted
    assert _redact_path("/api/games/") == "/api/games/"
    # /api/share/tokens (list endpoint) is not redacted — no token value
    assert _redact_path("/api/share/tokens") == "/api/share/tokens"
    # /api/share/requests is not redacted
    assert _redact_path("/api/share/requests") == "/api/share/requests"


def test_log_redaction_hides_token(client, caplog):
    """Share tokens must not appear in application logs."""
    _make_game(client)
    token = client.post("/api/share/tokens").json()["token"]

    with caplog.at_level(logging.INFO, logger="cardboard"):
        client.get(f"/api/share/{token}/games")

    for record in caplog.records:
        assert token not in record.getMessage(), f"Token leaked in log: {record.getMessage()}"
    assert any("***" in r.getMessage() for r in caplog.records)


# ===== RC3: Header-based endpoint tests =====

def test_shared_games_via_header(client):
    _make_game(client)
    token = client.post("/api/share/tokens").json()["token"]
    r = client.get("/api/share/games", headers={"X-Share-Token": token})
    assert r.status_code == 200
    assert isinstance(r.json(), list)
    assert len(r.json()) >= 1


def test_shared_single_game_via_header(client):
    gid = _make_game(client, name="Header Game")
    token = client.post("/api/share/tokens").json()["token"]
    r = client.get(f"/api/share/games/{gid}", headers={"X-Share-Token": token})
    assert r.status_code == 200
    assert r.json()["name"] == "Header Game"


def test_shared_games_header_missing(client):
    r = client.get("/api/share/games")
    assert r.status_code == 422  # Required header missing


def test_shared_games_header_invalid(client):
    r = client.get("/api/share/games", headers={"X-Share-Token": "notarealtoken"})
    assert r.status_code == 404


def test_want_to_play_via_header(client):
    gid = _make_game(client, name="Want to Play Header Game")
    token = client.post("/api/share/tokens").json()["token"]
    r = client.post(
        f"/api/share/games/{gid}/want-to-play",
        headers={"X-Share-Token": token},
        json={"visitor_name": "Test Visitor", "message": "Looks fun!"},
    )
    assert r.status_code == 201


# ===== S-H3/P-M1: Token hashing at rest + expired token deletion =====

def test_token_hashed_at_rest(client, db):
    """The DB must store sha256(token), not the raw token."""
    import hashlib
    import models

    data = client.post("/api/share/tokens").json()
    raw_token = data["token"]

    tokens = db.query(models.ShareToken).all()
    stored_tokens = [t.token for t in tokens]

    expected_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    assert expected_hash in stored_tokens, "Token hash not found in DB"
    assert raw_token not in stored_tokens, "Raw token found in DB — should be hashed"


def test_expired_token_deleted_on_access(client, db):
    """Expired tokens should be deleted when _validate_token is called."""
    _make_game(client)
    data = client.post("/api/share/tokens?expires_in=10").json()
    raw_token = data["token"]

    import models
    from datetime import datetime, timedelta, timezone

    token_row = db.query(models.ShareToken).first()
    assert token_row is not None
    token_row.expires_at = datetime.now(timezone.utc) - timedelta(hours=1)
    db.commit()

    r = client.get(f"/api/share/{raw_token}/games")
    assert r.status_code == 404

    count = db.query(models.ShareToken).count()
    assert count == 0, "Expired token was not deleted from DB"


# ===== P-H5: Want-to-play DELETE endpoint + retention sweep + IP log =====

def test_delete_want_to_play_request(client, db):
    """Owner can delete a want-to-play request."""
    import models

    gid = _make_game(client, name="Delete Me Game")
    token = client.post("/api/share/tokens").json()["token"]
    r = client.post(
        f"/api/share/games/{gid}/want-to-play",
        headers={"X-Share-Token": token},
        json={"visitor_name": "Visitor", "message": "Pick this!"},
    )
    assert r.status_code == 201

    reqs = client.get("/api/share/requests").json()
    assert len(reqs) == 1
    req_id = reqs[0]["id"]

    r = client.delete(f"/api/share/requests/{req_id}")
    assert r.status_code == 204

    assert db.query(models.WantToPlayRequest).count() == 0
    reqs = client.get("/api/share/requests").json()
    assert len(reqs) == 0


def test_delete_want_to_play_request_not_found(client):
    r = client.delete("/api/share/requests/99999")
    assert r.status_code == 404


def test_want_to_play_stores_visitor_ip(client, db):
    """The visitor's IP must be captured and returned in the requests list."""
    import models

    gid = _make_game(client, name="IP Capture Game")
    token = client.post("/api/share/tokens").json()["token"]
    r = client.post(
        f"/api/share/games/{gid}/want-to-play",
        headers={"X-Share-Token": token},
        json={"visitor_name": "IP Visitor"},
    )
    assert r.status_code == 201

    row = db.query(models.WantToPlayRequest).first()
    assert row is not None
    assert row.visitor_ip is not None  # TestClient uses 127.0.0.1 or similar

    reqs = client.get("/api/share/requests").json()
    assert len(reqs) == 1
    assert reqs[0]["visitor_ip"] is not None


def test_want_to_play_per_ip_rate_limit(client):
    """Submitting more than 10 requests/hour from one IP should be rate-limited."""
    # The TestClient uses a single source IP, so all requests share a bucket.
    gid = _make_game(client, name="Rate Limit Game")
    token = client.post("/api/share/tokens").json()["token"]
    # Use different visitor_names to avoid the per-(token,game,name) cap
    for i in range(10):
        r = client.post(
            f"/api/share/games/{gid}/want-to-play",
            headers={"X-Share-Token": token},
            json={"visitor_name": f"Visitor{i}"},
        )
        assert r.status_code == 201, f"Request {i} failed: {r.status_code}"
    # 11th request from the same IP should be rate-limited
    r = client.post(
        f"/api/share/games/{gid}/want-to-play",
        headers={"X-Share-Token": token},
        json={"visitor_name": "Visitor10"},
    )
    assert r.status_code == 429


def test_retention_sweep_deletes_old_requests(client, db):
    """Requests older than the retention window are deleted when the owner views them."""
    import models
    import os

    gid = _make_game(client, name="Old Request Game")
    token = client.post("/api/share/tokens").json()["token"]
    r = client.post(
        f"/api/share/games/{gid}/want-to-play",
        headers={"X-Share-Token": token},
        json={"visitor_name": "Old Visitor"},
    )
    assert r.status_code == 201

    # Manually age the request beyond the default 90-day retention
    row = db.query(models.WantToPlayRequest).first()
    assert row is not None
    row.created_at = datetime.now(timezone.utc) - timedelta(days=91)
    db.commit()

    # Trigger the sweep by listing requests
    reqs = client.get("/api/share/requests").json()
    assert len(reqs) == 0, "Old request was not swept"

    assert db.query(models.WantToPlayRequest).count() == 0


def test_retention_sweep_keeps_recent_requests(client, db):
    """Requests within the retention window are NOT deleted."""
    import models

    gid = _make_game(client, name="Recent Request Game")
    token = client.post("/api/share/tokens").json()["token"]
    r = client.post(
        f"/api/share/games/{gid}/want-to-play",
        headers={"X-Share-Token": token},
        json={"visitor_name": "Recent Visitor"},
    )
    assert r.status_code == 201

    # Age the request to just under the 90-day window
    row = db.query(models.WantToPlayRequest).first()
    row.created_at = datetime.now(timezone.utc) - timedelta(days=89)
    db.commit()

    reqs = client.get("/api/share/requests").json()
    assert len(reqs) == 1, "Recent request was incorrectly swept"
