"""Tests for the stats endpoint."""
import pytest


def _make_game(client, name="Stats Game", status="owned", **kwargs):
    r = client.post("/api/games/", json={"name": name, "status": status, **kwargs})
    assert r.status_code == 201
    return r.json()["id"]


def _add_session(client, game_id, played_at="2024-01-15", duration_minutes=60):
    r = client.post(
        f"/api/games/{game_id}/sessions",
        json={"played_at": played_at, "duration_minutes": duration_minutes},
    )
    assert r.status_code == 201
    return r.json()["id"]


def test_stats_empty_db(client):
    r = client.get("/api/stats/")
    assert r.status_code == 200
    data = r.json()
    assert data["total_games"] == 0
    assert data["total_sessions"] == 0
    assert data["total_hours"] == 0.0
    assert data["by_status"]["owned"] == 0
    assert data["by_status"]["wishlist"] == 0


def test_stats_with_data(client):
    _make_game(client, name="Game 1", status="owned")
    _make_game(client, name="Game 2", status="wishlist")
    gid3 = _make_game(client, name="Game 3", status="owned")
    _add_session(client, gid3, duration_minutes=120)

    r = client.get("/api/stats/")
    assert r.status_code == 200
    data = r.json()

    assert data["total_games"] == 3
    assert data["by_status"]["owned"] == 2
    assert data["by_status"]["wishlist"] == 1
    assert data["total_sessions"] == 1
    assert data["total_hours"] == 2.0


def test_stats_never_played_count(client):
    gid1 = _make_game(client, name="Played Game")
    _make_game(client, name="Unplayed Game")
    _add_session(client, gid1)

    r = client.get("/api/stats/")
    data = r.json()
    assert data["never_played_count"] == 1


def test_stats_avg_rating(client):
    _make_game(client, name="Rated Game 1", user_rating=8.0)
    _make_game(client, name="Rated Game 2", user_rating=6.0)

    r = client.get("/api/stats/")
    data = r.json()
    assert data["avg_rating"] == pytest.approx(7.0, abs=0.1)


# ---------------------------------------------------------------------------
# Most played
# ---------------------------------------------------------------------------

def test_stats_most_played(client):
    gid1 = _make_game(client, name="Popular Game")
    gid2 = _make_game(client, name="Rare Game")
    _add_session(client, gid1, played_at="2024-01-01")
    _add_session(client, gid1, played_at="2024-02-01")
    _add_session(client, gid1, played_at="2024-03-01")
    _add_session(client, gid2, played_at="2024-01-15")

    r = client.get("/api/stats/")
    most_played = r.json()["most_played"]
    assert most_played[0]["name"] == "Popular Game"
    assert most_played[0]["count"] == 3
    assert most_played[1]["name"] == "Rare Game"


# ---------------------------------------------------------------------------
# Spending
# ---------------------------------------------------------------------------

def test_stats_total_spent(client):
    _make_game(client, name="Game A", purchase_price=29.99)
    _make_game(client, name="Game B", purchase_price=49.99)

    r = client.get("/api/stats/")
    data = r.json()
    assert data["total_spent"] == pytest.approx(79.98, abs=0.01)


def test_stats_total_spent_none_when_no_prices(client):
    _make_game(client, name="Free Game")
    r = client.get("/api/stats/")
    assert r.json()["total_spent"] is None


# ---------------------------------------------------------------------------
# Rating distribution
# ---------------------------------------------------------------------------

def test_stats_rating_distribution(client):
    _make_game(client, name="Low", user_rating=1.0)
    _make_game(client, name="Mid-Low", user_rating=3.0)
    _make_game(client, name="Mid", user_rating=5.0)
    _make_game(client, name="High", user_rating=7.0)
    _make_game(client, name="Top", user_rating=9.0)

    r = client.get("/api/stats/")
    dist = r.json()["ratings_distribution"]
    assert dist["1\u20132"] == 1
    assert dist["3\u20134"] == 1
    assert dist["5\u20136"] == 1
    assert dist["7\u20138"] == 1
    assert dist["9\u201310"] == 1


# ---------------------------------------------------------------------------
# Recent sessions
# ---------------------------------------------------------------------------

def test_stats_recent_sessions(client):
    gid = _make_game(client, name="Played Game")
    _add_session(client, gid, played_at="2024-06-01")
    _add_session(client, gid, played_at="2024-07-01")

    r = client.get("/api/stats/")
    recent = r.json()["recent_sessions"]
    assert len(recent) == 2
    # Ordered newest first
    assert recent[0]["played_at"] >= recent[1]["played_at"]
    assert all(s["game_name"] == "Played Game" for s in recent)


def test_stats_recent_sessions_capped_at_10(client):
    gid = _make_game(client, name="Marathon Game")
    for day in range(1, 15):
        _add_session(client, gid, played_at=f"2024-01-{day:02d}")

    r = client.get("/api/stats/")
    assert len(r.json()["recent_sessions"]) == 10


# ---------------------------------------------------------------------------
# avg_session_minutes
# ---------------------------------------------------------------------------

def test_stats_avg_session_minutes(client):
    gid = _make_game(client, name="Timed Game")
    _add_session(client, gid, played_at="2024-01-01", duration_minutes=60)
    _add_session(client, gid, played_at="2024-02-01", duration_minutes=120)

    r = client.get("/api/stats/")
    assert r.json()["avg_session_minutes"] == pytest.approx(90.0, abs=0.1)


# ---------------------------------------------------------------------------
# total_expansions
# ---------------------------------------------------------------------------

def test_stats_total_expansions(client):
    parent_id = _make_game(client, name="Base Game")
    client.post("/api/games/", json={"name": "Expansion 1", "parent_game_id": parent_id})
    client.post("/api/games/", json={"name": "Expansion 2", "parent_game_id": parent_id})

    r = client.get("/api/stats/")
    assert r.json()["total_expansions"] == 2
