"""Tests for the players CRUD endpoints."""
import models
import pytest


def _make_game(client, name="Test Game"):
    r = client.post("/api/games/", json={"name": name})
    assert r.status_code == 201
    return r.json()["id"]


def _make_player(client, name="Alice"):
    r = client.post("/api/players/", json={"name": name})
    assert r.status_code in (200, 201)
    return r.json()["id"]


def _add_session(client, game_id, player_names=None, played_at="2024-01-15"):
    payload = {"played_at": played_at}
    if player_names:
        payload["player_names"] = player_names
    r = client.post(f"/api/games/{game_id}/sessions", json=payload)
    assert r.status_code == 201
    return r.json()


# ---------------------------------------------------------------------------
# GET /api/players/
# ---------------------------------------------------------------------------

def test_list_players_empty(client):
    r = client.get("/api/players/")
    assert r.status_code == 200
    assert r.json() == []


def test_list_players_sorted_alphabetically(client):
    client.post("/api/players/", json={"name": "Zara"})
    client.post("/api/players/", json={"name": "Alice"})
    client.post("/api/players/", json={"name": "Mike"})
    r = client.get("/api/players/")
    assert r.status_code == 200
    names = [p["name"] for p in r.json()]
    assert names == sorted(names)


def test_list_players_includes_session_count(client):
    gid = _make_game(client)
    _add_session(client, gid, player_names=["Alice", "Bob"])
    r = client.get("/api/players/")
    assert r.status_code == 200
    players = {p["name"]: p["session_count"] for p in r.json()}
    assert players["Alice"] == 1
    assert players["Bob"] == 1


# ---------------------------------------------------------------------------
# POST /api/players/
# ---------------------------------------------------------------------------

def test_create_player(client):
    r = client.post("/api/players/", json={"name": "Alice"})
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == "Alice"
    assert data["session_count"] == 0


def test_create_player_duplicate_returns_existing(client):
    r1 = client.post("/api/players/", json={"name": "Alice"})
    assert r1.status_code == 201
    r2 = client.post("/api/players/", json={"name": "Alice"})
    # Duplicate returns 200 (idempotent), not 409
    assert r2.status_code == 200
    assert r2.json()["id"] == r1.json()["id"]


def test_create_player_strips_whitespace(client):
    r = client.post("/api/players/", json={"name": "  Bob  "})
    assert r.status_code == 201
    assert r.json()["name"] == "Bob"


# ---------------------------------------------------------------------------
# PATCH /api/players/{player_id}
# ---------------------------------------------------------------------------

def test_rename_player(client):
    pid = _make_player(client, "Alice")
    r = client.patch(f"/api/players/{pid}", json={"name": "Alicia"})
    assert r.status_code == 200
    assert r.json()["name"] == "Alicia"


def test_rename_player_empty_name(client):
    pid = _make_player(client, "Alice")
    r = client.patch(f"/api/players/{pid}", json={"name": "   "})
    assert r.status_code == 422


def test_rename_player_conflict(client):
    pid = _make_player(client, "Alice")
    _make_player(client, "Bob")
    r = client.patch(f"/api/players/{pid}", json={"name": "Bob"})
    assert r.status_code == 409


def test_rename_player_not_found(client):
    r = client.patch("/api/players/99999", json={"name": "Ghost"})
    assert r.status_code == 404


def test_rename_player_preserves_session_count(client):
    gid = _make_game(client)
    _add_session(client, gid, player_names=["Alice"])
    players = client.get("/api/players/").json()
    pid = next(p["id"] for p in players if p["name"] == "Alice")
    r = client.patch(f"/api/players/{pid}", json={"name": "Alicia"})
    assert r.status_code == 200
    assert r.json()["session_count"] == 1


# ---------------------------------------------------------------------------
# DELETE /api/players/{player_id}
# ---------------------------------------------------------------------------

def test_delete_player(client):
    pid = _make_player(client, "Alice")
    r = client.delete(f"/api/players/{pid}")
    assert r.status_code == 204
    names = [p["name"] for p in client.get("/api/players/").json()]
    assert "Alice" not in names


def test_delete_player_not_found(client):
    r = client.delete("/api/players/99999")
    assert r.status_code == 404


def test_delete_player_scrubs_winner_string(client, db):
    """A deleted player's name must be removed from the free-text `winner` column."""
    gid = _make_game(client, "Wingspan")
    pid = _make_player(client, "Alice")
    _add_session(client, gid, player_names=["Alice"], played_at="2024-03-10")
    # Set Alice as the winner via a PATCH (add_session helper doesn't set winner)
    sessions = client.get(f"/api/games/{gid}/sessions").json()
    sid = sessions[0]["id"]
    r = client.patch(f"/api/sessions/{sid}", json={"winner": "Alice"})
    assert r.status_code == 200
    assert r.json()["winner"] == "Alice"

    # Delete Alice
    r = client.delete(f"/api/players/{pid}")
    assert r.status_code == 204

    # The winner string should be scrubbed (null), and winner_player_id should be
    # null via the FK ondelete=SET NULL cascade.
    row = db.query(models.PlaySession).filter(models.PlaySession.id == sid).first()
    assert row is not None
    assert row.winner is None
    assert row.winner_player_id is None


def test_delete_player_scrubs_winner_from_multiple_sessions(client, db):
    """All sessions with the deleted player's name as winner are scrubbed."""
    gid = _make_game(client, "Catan")
    pid = _make_player(client, "Bob")
    # Create 3 sessions, set Bob as winner on each
    for i in range(3):
        _add_session(client, gid, player_names=["Bob"], played_at=f"2024-0{i+1}-10")
    sessions = client.get(f"/api/games/{gid}/sessions").json()
    for s in sessions:
        r = client.patch(f"/api/sessions/{s['id']}", json={"winner": "Bob"})
        assert r.status_code == 200

    r = client.delete(f"/api/players/{pid}")
    assert r.status_code == 204

    rows = db.query(models.PlaySession).filter(models.PlaySession.game_id == gid).all()
    assert len(rows) == 3
    assert all(row.winner is None for row in rows)


def test_delete_player_preserves_other_winners(client, db):
    """Deleting Alice must not affect sessions where Bob is the winner."""
    gid = _make_game(client, "Chess")
    alice_id = _make_player(client, "Alice")
    bob_id = _make_player(client, "Bob")
    # Session 1: Alice wins
    _add_session(client, gid, player_names=["Alice", "Bob"], played_at="2024-01-01")
    # Session 2: Bob wins
    _add_session(client, gid, player_names=["Alice", "Bob"], played_at="2024-01-02")
    sessions = client.get(f"/api/games/{gid}/sessions").json()
    s1, s2 = sessions[0], sessions[1]
    client.patch(f"/api/sessions/{s1['id']}", json={"winner": "Alice"})
    client.patch(f"/api/sessions/{s2['id']}", json={"winner": "Bob"})

    # Delete Alice
    client.delete(f"/api/players/{alice_id}")

    row1 = db.query(models.PlaySession).filter(models.PlaySession.id == s1["id"]).first()
    row2 = db.query(models.PlaySession).filter(models.PlaySession.id == s2["id"]).first()
    assert row1.winner is None       # Alice's session scrubbed
    assert row2.winner == "Bob"      # Bob's session untouched


def test_delete_player_recalculates_opponent_elo(client, db):
    """Deleting a player must reset Elo for opponents whose only scored
    sessions involved the deleted player."""
    gid = _make_game(client, "Solo Opponent Game")
    alice_id = _make_player(client, "Alice")
    bob_id = _make_player(client, "Bob")
    # Alice beats Bob — Bob's Elo drops below 1500
    client.post(
        f"/api/games/{gid}/sessions",
        json={
            "played_at": "2024-01-01",
            "player_names": ["Alice", "Bob"],
            "scores": {"Alice": 100, "Bob": 50},
        },
    )
    players = client.get("/api/players/").json()
    bob_before = next(p for p in players if p["name"] == "Bob")
    assert bob_before["elo_rating"] < 1500.0
    assert bob_before["games_played"] == 1

    # Delete Alice — Bob's only remaining scored session has a single player,
    # so his rating and games_played must be reset to the default.
    r = client.delete(f"/api/players/{alice_id}")
    assert r.status_code == 204

    players = client.get("/api/players/").json()
    bob = next(p for p in players if p["name"] == "Bob")
    assert bob["elo_rating"] == 1500.0
    assert bob["games_played"] == 0


def test_delete_player_recalculates_elo_from_remaining_sessions(client, db):
    """Deleting one player must recompute opponents' Elo from the sessions
    that remain, and must not touch players who never shared a session with
    the deleted player."""
    gid = _make_game(client, "Multi Game")
    alice_id = _make_player(client, "Alice")
    bob_id = _make_player(client, "Bob")
    charlie_id = _make_player(client, "Charlie")

    # Session 1: Alice beats Bob
    client.post(
        f"/api/games/{gid}/sessions",
        json={
            "played_at": "2024-01-01",
            "player_names": ["Alice", "Bob"],
            "scores": {"Alice": 100, "Bob": 50},
        },
    )
    # Session 2: Bob beats Charlie
    client.post(
        f"/api/games/{gid}/sessions",
        json={
            "played_at": "2024-01-02",
            "player_names": ["Bob", "Charlie"],
            "scores": {"Bob": 100, "Charlie": 50},
        },
    )
    players = client.get("/api/players/").json()
    bob_before = next(p for p in players if p["name"] == "Bob")
    assert bob_before["games_played"] == 2

    # Delete Alice — Bob's Elo must be recomputed from the Bob/Charlie session
    # alone; Charlie never played Alice, so his rating must be untouched.
    client.delete(f"/api/players/{alice_id}")

    players = client.get("/api/players/").json()
    bob = next(p for p in players if p["name"] == "Bob")
    charlie = next(p for p in players if p["name"] == "Charlie")
    assert bob["games_played"] == 1
    assert bob["elo_rating"] > 1500.0  # he won his remaining session
    assert bob["elo_rating"] != bob_before["elo_rating"]
    assert charlie["games_played"] == 1
    assert charlie["elo_rating"] < 1500.0  # unchanged by Alice's deletion


# ---------------------------------------------------------------------------
# GET /api/players/{player_id}/rankings (per-game rankings)
# ---------------------------------------------------------------------------

def _add_scored_session(client, game_id, scores, played_at="2024-01-15"):
    """Create a session with scores dict (player_name -> score)."""
    payload = {
        "played_at": played_at,
        "player_names": list(scores.keys()),
        "scores": scores,
    }
    r = client.post(f"/api/games/{game_id}/sessions", json=payload)
    assert r.status_code == 201
    return r.json()["id"]


def test_per_game_rankings_empty(client):
    """Player with no scored sessions returns empty rankings."""
    pid = _make_player(client, "Alice")
    r = client.get(f"/api/players/{pid}/rankings")
    assert r.status_code == 200
    assert r.json() == []


def test_per_game_rankings_returns_rank(client):
    """Rankings include the player's rank for each game they've scored in."""
    gid = _make_game(client, "Catan")
    alice_id = _make_player(client, "Alice")
    bob_id = _make_player(client, "Bob")
    # Alice scores 10, Bob scores 20 → Bob rank 1, Alice rank 2
    _add_scored_session(client, gid, {"Alice": 10, "Bob": 20})

    r = client.get(f"/api/players/{alice_id}/rankings")
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 1
    assert data[0]["player_id"] == alice_id
    assert data[0]["player_name"] == "Alice"
    assert data[0]["rank"] == 2
    assert data[0]["avg_score"] == 10.0


def test_per_game_rankings_multiple_games(client):
    """Rankings are returned for each game the player has scored in."""
    g1 = _make_game(client, "Catan")
    g2 = _make_game(client, "Wingspan")
    alice_id = _make_player(client, "Alice")
    bob_id = _make_player(client, "Bob")
    _add_scored_session(client, g1, {"Alice": 10, "Bob": 20})
    _add_scored_session(client, g2, {"Alice": 30, "Bob": 25})

    r = client.get(f"/api/players/{alice_id}/rankings")
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 2
    # Alice is rank 2 in g1 (10 < 20), rank 1 in g2 (30 > 25)
    ranks = {e["avg_score"]: e["rank"] for e in data}
    assert ranks[10.0] == 2
    assert ranks[30.0] == 1


def test_per_game_rankings_includes_wins(client):
    """Win counts and win rate are computed from the winner field."""
    gid = _make_game(client, "Chess")
    alice_id = _make_player(client, "Alice")
    bob_id = _make_player(client, "Bob")
    # Two scored sessions, Alice wins both
    s1 = _add_scored_session(client, gid, {"Alice": 10, "Bob": 5}, played_at="2024-01-01")
    s2 = _add_scored_session(client, gid, {"Alice": 15, "Bob": 8}, played_at="2024-01-02")
    client.patch(f"/api/sessions/{s1}", json={"winner": "Alice"})
    client.patch(f"/api/sessions/{s2}", json={"winner": "Alice"})

    r = client.get(f"/api/players/{alice_id}/rankings")
    data = r.json()
    assert len(data) == 1
    assert data[0]["wins"] == 2
    assert data[0]["win_rate"] == 100
    assert data[0]["rank"] == 1  # Alice has higher avg score


# ---------------------------------------------------------------------------
# GET /api/players/{player_id}/sessions (pagination)
# ---------------------------------------------------------------------------

def test_player_sessions_returns_x_total_count(client):
    """The sessions endpoint must include X-Total-Count for pagination."""
    gid = _make_game(client, "Catan")
    pid = _make_player(client, "Alice")
    for i in range(5):
        _add_session(client, gid, player_names=["Alice"], played_at=f"2024-0{i+1}-01")
    r = client.get(f"/api/players/{pid}/sessions")
    assert r.status_code == 200
    assert r.headers["X-Total-Count"] == "5"
    assert len(r.json()) == 5


def test_player_sessions_pagination(client):
    """limit + offset return a slice and correct total count."""
    gid = _make_game(client, "Catan")
    pid = _make_player(client, "Alice")
    for i in range(10):
        _add_session(client, gid, player_names=["Alice"], played_at=f"2024-{i+1:02d}-01")
    # Page 1: limit=4, offset=0
    r = client.get(f"/api/players/{pid}/sessions?limit=4&offset=0")
    assert r.status_code == 200
    assert r.headers["X-Total-Count"] == "10"
    assert len(r.json()) == 4
    # Page 2: limit=4, offset=4
    r = client.get(f"/api/players/{pid}/sessions?limit=4&offset=4")
    assert len(r.json()) == 4
    # Last page: limit=4, offset=8
    r = client.get(f"/api/players/{pid}/sessions?limit=4&offset=8")
    assert len(r.json()) == 2


def test_player_sessions_default_limit(client):
    """Default limit is 50, not unbounded."""
    gid = _make_game(client, "Catan")
    pid = _make_player(client, "Alice")
    for i in range(3):
        _add_session(client, gid, player_names=["Alice"], played_at=f"2024-0{i+1}-01")
    r = client.get(f"/api/players/{pid}/sessions")
    assert r.status_code == 200
    assert len(r.json()) == 3
    assert r.headers["X-Total-Count"] == "3"


def test_player_sessions_empty(client):
    """A player with no sessions returns empty list with X-Total-Count 0."""
    pid = _make_player(client, "Alice")
    r = client.get(f"/api/players/{pid}/sessions")
    assert r.status_code == 200
    assert r.json() == []
    assert r.headers["X-Total-Count"] == "0"


def test_player_sessions_limit_validation(client):
    """limit > 200 is rejected."""
    pid = _make_player(client, "Alice")
    r = client.get(f"/api/players/{pid}/sessions?limit=201")
    assert r.status_code == 422
