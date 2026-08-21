"""Tests for optional X-API-Key gating on destructive endpoints.

When CARDBOARD_API_KEY is set, DELETE /api/everything, POST /api/games/restore,
and POST /api/players/admin/recalculate-elo require an X-API-Key header that
matches (constant-time, hashed at rest). When unset, all endpoints behave as
before (no auth). These tests monkeypatch ``utils._API_KEY_HASH`` to simulate
the configured state without leaking a real key into the environment.
"""
import utils


def _set_key(monkeypatch, key: str):
    """Simulate CARDBOARD_API_KEY being set by populating the hashed form."""
    import hashlib
    monkeypatch.setattr(utils, "_API_KEY_HASH", hashlib.sha256(key.encode()).hexdigest())


def _clear_key(monkeypatch):
    """Simulate CARDBOARD_API_KEY being unset (auth disabled)."""
    monkeypatch.setattr(utils, "_API_KEY_HASH", None)


def test_wipe_requires_api_key_when_configured(client, db, monkeypatch):
    _set_key(monkeypatch, "secret-key")
    r = client.request("DELETE", "/api/everything", json={"confirm": "DELETE EVERYTHING"})
    assert r.status_code == 401
    assert "X-API-Key" in r.json()["detail"]


def test_wipe_accepts_correct_api_key(client, db, monkeypatch):
    _set_key(monkeypatch, "secret-key")
    r = client.request(
        "DELETE", "/api/everything",
        json={"confirm": "DELETE EVERYTHING"},
        headers={"X-API-Key": "secret-key"},
    )
    assert r.status_code == 200


def test_wipe_rejects_wrong_api_key(client, db, monkeypatch):
    _set_key(monkeypatch, "secret-key")
    r = client.request(
        "DELETE", "/api/everything",
        json={"confirm": "DELETE EVERYTHING"},
        headers={"X-API-Key": "wrong-key"},
    )
    assert r.status_code == 401


def test_wipe_no_auth_when_unconfigured(client, db, monkeypatch):
    """When CARDBOARD_API_KEY is unset, wipe works without a header."""
    _clear_key(monkeypatch)
    r = client.request("DELETE", "/api/everything", json={"confirm": "DELETE EVERYTHING"})
    assert r.status_code == 200


def test_recalculate_elo_requires_api_key_when_configured(client, db, monkeypatch):
    _set_key(monkeypatch, "secret-key")
    client.post("/api/players/", json={"name": "Alice"})
    r = client.post("/api/players/admin/recalculate-elo")
    assert r.status_code == 401


def test_recalculate_elo_accepts_correct_api_key(client, db, monkeypatch):
    _set_key(monkeypatch, "secret-key")
    client.post("/api/players/", json={"name": "Alice"})
    r = client.post(
        "/api/players/admin/recalculate-elo",
        headers={"X-API-Key": "secret-key"},
    )
    assert r.status_code == 200


def test_recalculate_elo_no_auth_when_unconfigured(client, db, monkeypatch):
    _clear_key(monkeypatch)
    client.post("/api/players/", json={"name": "Alice"})
    r = client.post("/api/players/admin/recalculate-elo")
    assert r.status_code == 200


def test_restore_requires_api_key_when_configured(client, db, monkeypatch):
    """Send a minimal valid multipart body so FastAPI parses the file param,
    then the in-body auth gate rejects with 401."""
    _set_key(monkeypatch, "secret-key")
    r = client.post(
        "/api/games/restore",
        files={"file": ("b.zip", b"PK\x03\x04", "application/zip")},
        headers={"X-API-Key": "wrong"},
    )
    assert r.status_code == 401


def test_create_share_token_requires_api_key_when_configured(client, db, monkeypatch):
    """Share-token creation grants full read access to the collection, so it
    must be gated like the other destructive endpoints."""
    _set_key(monkeypatch, "secret-key")
    r = client.post("/api/share/tokens")
    assert r.status_code == 401


def test_create_share_token_accepts_correct_api_key(client, db, monkeypatch):
    _set_key(monkeypatch, "secret-key")
    r = client.post("/api/share/tokens", headers={"X-API-Key": "secret-key"})
    assert r.status_code == 201
    assert r.json()["token"]


def test_create_share_token_no_auth_when_unconfigured(client, db, monkeypatch):
    _clear_key(monkeypatch)
    r = client.post("/api/share/tokens")
    assert r.status_code == 201


def test_create_share_token_rejects_oversized_label(client, db, monkeypatch):
    r = client.post("/api/share/tokens", params={"label": "x" * 300})
    assert r.status_code == 422