"""Tests for play session CRUD and last_played syncing."""
from datetime import date

import pytest


def _make_game(client, name="Test Game"):
    r = client.post("/api/games/", json={"name": name})
    assert r.status_code == 201
    return r.json()["id"]


def _add_session(client, game_id, played_at="2024-01-15", **kwargs):
    return client.post(
        f"/api/games/{game_id}/sessions",
        json={"played_at": played_at, **kwargs},
    )


# ---------------------------------------------------------------------------
# Add session
# ---------------------------------------------------------------------------

def test_add_session_basic(client):
    gid = _make_game(client)
    r = _add_session(client, gid)
    assert r.status_code == 201
    data = r.json()
    assert data["game_id"] == gid
    assert data["played_at"] == "2024-01-15"


def test_add_session_game_not_found(client):
    r = _add_session(client, 99999)
    assert r.status_code == 404


def test_add_session_with_players(client):
    gid = _make_game(client)
    r = _add_session(client, gid, player_names=["Alice", "Bob"])
    assert r.status_code == 201
    players = r.json()["players"]
    assert set(players) == {"Alice", "Bob"}


def test_add_session_invalid_date(client):
    gid = _make_game(client)
    r = _add_session(client, gid, played_at="not-a-date")
    assert r.status_code == 422


def test_add_session_updates_last_played(client):
    gid = _make_game(client)
    _add_session(client, gid, played_at="2024-06-01")
    game = client.get(f"/api/games/{gid}").json()
    assert game["last_played"] == "2024-06-01"


# ---------------------------------------------------------------------------
# List sessions
# ---------------------------------------------------------------------------

def test_get_sessions(client):
    gid = _make_game(client)
    _add_session(client, gid, played_at="2024-01-01")
    _add_session(client, gid, played_at="2024-03-15")
    r = client.get(f"/api/games/{gid}/sessions")
    assert r.status_code == 200
    dates = [s["played_at"] for s in r.json()]
    assert dates == sorted(dates, reverse=True)  # newest first


def test_get_sessions_game_not_found(client):
    r = client.get("/api/games/99999/sessions")
    assert r.status_code == 404


def test_get_sessions_empty(client):
    gid = _make_game(client)
    r = client.get(f"/api/games/{gid}/sessions")
    assert r.status_code == 200
    assert r.json() == []


# ---------------------------------------------------------------------------
# Delete session / last_played sync
# ---------------------------------------------------------------------------

def test_delete_session(client):
    gid = _make_game(client)
    session_id = _add_session(client, gid).json()["id"]
    r = client.delete(f"/api/sessions/{session_id}")
    assert r.status_code == 204
    sessions = client.get(f"/api/games/{gid}/sessions").json()
    assert all(s["id"] != session_id for s in sessions)


def test_delete_last_session_clears_last_played(client):
    gid = _make_game(client)
    session_id = _add_session(client, gid, played_at="2024-05-10").json()["id"]
    client.delete(f"/api/sessions/{session_id}")
    game = client.get(f"/api/games/{gid}").json()
    assert game["last_played"] is None


def test_delete_session_promotes_next_last_played(client):
    gid = _make_game(client)
    _add_session(client, gid, played_at="2024-01-01")
    newer_id = _add_session(client, gid, played_at="2024-06-15").json()["id"]
    client.delete(f"/api/sessions/{newer_id}")
    game = client.get(f"/api/games/{gid}").json()
    assert game["last_played"] == "2024-01-01"


def test_delete_session_not_found(client):
    r = client.delete("/api/sessions/99999")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def test_player_names_too_many(client):
    gid = _make_game(client)
    r = _add_session(client, gid, player_names=["Player"] * 51)
    assert r.status_code == 422


def test_player_name_too_long(client):
    gid = _make_game(client)
    r = _add_session(client, gid, player_names=["X" * 256])
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Update session (PATCH /api/sessions/{session_id})
# ---------------------------------------------------------------------------

def test_update_session_date(client):
    gid = _make_game(client)
    session_id = _add_session(client, gid, played_at="2024-01-10").json()["id"]
    r = client.patch(f"/api/sessions/{session_id}", json={"played_at": "2024-06-20"})
    assert r.status_code == 200
    assert r.json()["played_at"] == "2024-06-20"


def test_update_session_not_found(client):
    r = client.patch("/api/sessions/99999", json={"played_at": "2024-06-20"})
    assert r.status_code == 404


def test_update_session_partial_fields(client):
    gid = _make_game(client)
    session_id = _add_session(client, gid, duration_minutes=45).json()["id"]
    r = client.patch(f"/api/sessions/{session_id}", json={"duration_minutes": 90})
    assert r.status_code == 200
    data = r.json()
    assert data["duration_minutes"] == 90
    # date should be unchanged
    assert data["played_at"] == "2024-01-15"


def test_update_session_players(client):
    gid = _make_game(client)
    session_id = _add_session(client, gid, player_names=["Alice"]).json()["id"]
    r = client.patch(f"/api/sessions/{session_id}", json={"player_names": ["Bob", "Carol"]})
    assert r.status_code == 200
    assert set(r.json()["players"]) == {"Bob", "Carol"}


def test_update_session_date_persists(client):
    gid = _make_game(client)
    session_id = _add_session(client, gid, played_at="2024-01-01").json()["id"]
    r = client.patch(f"/api/sessions/{session_id}", json={"played_at": "2024-12-31"})
    assert r.status_code == 200
    assert r.json()["played_at"] == "2024-12-31"


def test_update_session_notes_and_winner(client):
    gid = _make_game(client)
    session_id = _add_session(client, gid).json()["id"]
    r = client.patch(f"/api/sessions/{session_id}", json={"notes": "great game", "winner": "Alice"})
    assert r.status_code == 200
    data = r.json()
    assert data["notes"] == "great game"
    assert data["winner"] == "Alice"


# ---------------------------------------------------------------------------
# Cooperative sessions
# ---------------------------------------------------------------------------

def test_add_cooperative_session(client):
    gid = _make_game(client)
    r = _add_session(client, gid, cooperative=True, outcome="win", scenario="Scenario 3")
    assert r.status_code == 201
    data = r.json()
    assert data["cooperative"] is True
    assert data["outcome"] == "win"
    assert data["scenario"] == "Scenario 3"


def test_cooperative_session_clears_winner(client):
    gid = _make_game(client)
    r = _add_session(client, gid, cooperative=True, winner="Alice", outcome="win")
    assert r.status_code == 201
    data = r.json()
    assert data["cooperative"] is True
    assert data["winner"] is None


def test_cooperative_session_invalid_outcome(client):
    gid = _make_game(client)
    r = _add_session(client, gid, cooperative=True, outcome="victory")
    assert r.status_code == 422


def test_cooperative_session_skips_elo(client, db):
    import models
    gid = _make_game(client)
    # Create players first
    client.post("/api/players/", json={"name": "Alice"})
    client.post("/api/players/", json={"name": "Bob"})
    # Co-op session with scores — Elo should NOT be applied
    r = _add_session(client, gid, cooperative=True, outcome="win",
                     player_names=["Alice", "Bob"], scores={"Alice": 10, "Bob": 10})
    assert r.status_code == 201
    # Check that Elo ratings are still default (1500)
    alice = db.query(models.Player).filter(models.Player.name == "Alice").first()
    bob = db.query(models.Player).filter(models.Player.name == "Bob").first()
    assert alice.elo_rating == 1500.0
    assert bob.elo_rating == 1500.0
    assert alice.games_played == 0
    assert bob.games_played == 0


def test_update_session_to_cooperative_clears_winner(client):
    gid = _make_game(client)
    session_id = _add_session(client, gid, winner="Alice").json()["id"]
    r = client.patch(f"/api/sessions/{session_id}", json={"cooperative": True, "outcome": "loss"})
    assert r.status_code == 200
    data = r.json()
    assert data["cooperative"] is True
    assert data["winner"] is None
    assert data["outcome"] == "loss"


def test_bulk_session_cooperative(client):
    g1 = _make_game(client, "Game 1")
    g2 = _make_game(client, "Game 2")
    r = client.post("/api/sessions/bulk", json={
        "game_ids": [g1, g2],
        "played_at": "2024-07-01",
        "cooperative": True,
        "outcome": "win",
        "scenario": "Campaign Ch.1",
    })
    assert r.status_code == 201
    sessions = r.json()
    assert len(sessions) == 2
    for s in sessions:
        assert s["cooperative"] is True
        assert s["outcome"] == "win"
        assert s["scenario"] == "Campaign Ch.1"
        assert s["winner"] is None
