"""
Tests for Goals CRUD endpoints.

Goals have auto-complete detection: when current_value >= target_value the goal
is automatically marked is_complete=True with a completed_at timestamp.
"""
import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _create_game(client, name="Test Game"):
    return client.post("/api/games/", json={"name": name}).json()


def _add_session(client, game_id, played_at="2025-01-15", duration=60, winner=""):
    return client.post(
        f"/api/games/{game_id}/sessions",
        json={
            "played_at": played_at,
            "duration_minutes": duration,
            "winner": winner,
        },
    )


# ---------------------------------------------------------------------------
# List (empty)
# ---------------------------------------------------------------------------

def test_list_goals_empty(client):
    r = client.get("/api/goals/")
    assert r.status_code == 200
    assert r.json() == []


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("gtype,target,extra", [
    ("sessions_total", 100, {}),
    ("sessions_year", 365, {"year": 2025}),
    ("play_all_owned", 50, {}),
    ("unique_mechanics", 10, {}),
    ("unique_games_year", 20, {"year": 2025}),
    ("total_hours", 500, {}),
    ("category_coverage", 8, {}),
    ("win_rate_target", 75, {}),
])
def test_create_goal_each_type(client, gtype, target, extra):
    payload = {"title": f"{gtype} goal", "type": gtype, "target_value": target, **extra}
    r = client.post("/api/goals/", json=payload)
    assert r.status_code == 201, f"Failed for type={gtype}: {r.text}"
    data = r.json()
    assert data["title"] == f"{gtype} goal"
    assert data["type"] == gtype
    assert data["target_value"] == target
    assert data["is_complete"] is False
    assert data["current_value"] is not None


def test_create_goal_game_sessions_without_game_id(client):
    r = client.post(
        "/api/goals/",
        json={"title": "No game", "type": "game_sessions", "target_value": 10},
    )
    assert r.status_code == 422


def test_create_goal_game_sessions_nonexistent_game(client):
    r = client.post(
        "/api/goals/",
        json={"title": "Bad ref", "type": "game_sessions", "target_value": 10, "game_id": 9999},
    )
    assert r.status_code == 404


def test_create_goal_invalid_type(client):
    r = client.post(
        "/api/goals/",
        json={"title": "Bad type", "type": "not_a_real_type", "target_value": 10},
    )
    assert r.status_code == 422


def test_create_goal_invalid_target_value(client):
    r = client.post(
        "/api/goals/",
        json={"title": "Zero target", "type": "sessions_total", "target_value": 0},
    )
    assert r.status_code == 422


def test_create_goal_negative_target_value(client):
    r = client.post(
        "/api/goals/",
        json={"title": "Negative target", "type": "sessions_total", "target_value": -1},
    )
    assert r.status_code == 422


def test_create_goal_title_too_long(client):
    r = client.post(
        "/api/goals/",
        json={"title": "A" * 256, "type": "sessions_total", "target_value": 10},
    )
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# List with data
# ---------------------------------------------------------------------------

def test_list_goals_returns_created(client):
    client.post(
        "/api/goals/",
        json={"title": "Play 100", "type": "sessions_total", "target_value": 100},
    )
    client.post(
        "/api/goals/",
        json={"title": "Unique mechanics", "type": "unique_mechanics", "target_value": 5},
    )
    r = client.get("/api/goals/")
    assert r.status_code == 200
    goals = r.json()
    assert len(goals) == 2
    titles = {g["title"] for g in goals}
    assert "Play 100" in titles
    assert "Unique mechanics" in titles


# ---------------------------------------------------------------------------
# Auto-complete detection
# ---------------------------------------------------------------------------

def test_goal_auto_completes_on_create_when_already_reached(client):
    """If current_value >= target_value at create time, goal is auto-completed."""
    # Add enough sessions so sessions_total >= 5
    game = _create_game(client, "Auto game")
    for i in range(5):
        _add_session(client, game["id"], played_at=f"2025-01-{10 + i:02d}")

    r = client.post(
        "/api/goals/",
        json={"title": "Auto complete", "type": "sessions_total", "target_value": 5},
    )
    assert r.status_code == 201
    data = r.json()
    assert data["is_complete"] is True
    assert data["completed_at"] is not None
    assert data["current_value"] >= 5


def test_goal_auto_completes_on_check(client):
    """Goal not complete at create time, but auto-completes on POST /check when threshold met."""
    game = _create_game(client, "Late auto")

    r = client.post(
        "/api/goals/",
        json={"title": "Late complete", "type": "sessions_total", "target_value": 3},
    )
    assert r.status_code == 201
    assert r.json()["is_complete"] is False

    # Now add 3 sessions — goal should still be incomplete until check is called
    for i in range(3):
        _add_session(client, game["id"], played_at=f"2025-02-{10 + i:02d}")

    r = client.post("/api/goals/check")
    goals = r.json()
    late = next(g for g in goals if g["title"] == "Late complete")
    assert late["is_complete"] is True
    assert late["completed_at"] is not None


def test_list_goals_does_not_mutate(client):
    """GET /api/goals/ must not modify goal state (no side effects)."""
    game = _create_game(client, "No mutate")

    client.post(
        "/api/goals/",
        json={"title": "No mutate", "type": "sessions_total", "target_value": 3},
    )

    for i in range(3):
        _add_session(client, game["id"], played_at=f"2025-03-{10 + i:02d}")

    # GET should not mark the goal complete
    r = client.get("/api/goals/")
    goals = r.json()
    g = next(goal for goal in goals if goal["title"] == "No mutate")
    assert g["is_complete"] is False
    assert g["completed_at"] is None


def test_goal_play_all_owned_progress(client):
    """play_all_owned counts distinct owned games played at least once."""
    g1 = _create_game(client, "Owned A")
    g2 = _create_game(client, "Owned B")
    g3 = _create_game(client, "Owned C")
    _add_session(client, g1["id"])
    _add_session(client, g2["id"])
    # g3 is unplayed

    r = client.post(
        "/api/goals/",
        json={"title": "Play all three", "type": "play_all_owned", "target_value": 3},
    )
    assert r.json()["current_value"] == 2  # only 2 of 3 played
    assert r.json()["is_complete"] is False


def test_goal_total_hours_progress(client):
    """total_hours sums duration_minutes across all sessions, converted to hours."""
    game = _create_game(client)
    _add_session(client, game["id"], duration=90)
    _add_session(client, game["id"], duration=30)

    r = client.post(
        "/api/goals/",
        json={"title": "Hours goal", "type": "total_hours", "target_value": 2},
    )
    assert r.json()["current_value"] == 2  # 120 minutes = 2 hours
    assert r.json()["is_complete"] is True


def test_goal_win_rate_target_progress(client):
    """win_rate_target counts sessions won by 'Me' as percentage of total with winners."""
    game = _create_game(client)
    _add_session(client, game["id"], winner="Me")
    _add_session(client, game["id"], winner="Me")
    _add_session(client, game["id"], winner="Alice")

    r = client.post(
        "/api/goals/",
        json={"title": "Win rate", "type": "win_rate_target", "target_value": 60},
    )
    current = r.json()["current_value"]
    # 2 wins out of 3 sessions with winners = ~66%
    assert 65 <= current <= 67


def test_goal_win_rate_target_no_sessions(client):
    """win_rate_target with no sessions should give current_value=0, not an error."""
    r = client.post(
        "/api/goals/",
        json={"title": "Win rate empty", "type": "win_rate_target", "target_value": 50},
    )
    assert r.status_code == 201
    assert r.json()["current_value"] == 0
    assert r.json()["is_complete"] is False


def test_goal_sessions_year_filters_by_year(client):
    """sessions_year only counts sessions played within the specified year."""
    game = _create_game(client, "Year filter game")
    _add_session(client, game["id"], played_at="2024-06-01")
    _add_session(client, game["id"], played_at="2025-06-01")
    _add_session(client, game["id"], played_at="2025-12-31")
    _add_session(client, game["id"], played_at="2026-01-01")

    r = client.post(
        "/api/goals/",
        json={"title": "2025 only", "type": "sessions_year", "target_value": 100, "year": 2025},
    )
    assert r.status_code == 201
    assert r.json()["current_value"] == 2


def test_goal_game_sessions_with_ref(client):
    """game_sessions with game_id only counts that specific game's sessions."""
    g1 = _create_game(client, "Target Game")
    g2 = _create_game(client, "Other Game")
    _add_session(client, g1["id"])
    _add_session(client, g1["id"])
    _add_session(client, g2["id"])

    r = client.post(
        "/api/goals/",
        json={
            "title": "Play Target twice",
            "type": "game_sessions",
            "target_value": 2,
            "game_id": g1["id"],
        },
    )
    data = r.json()
    assert data["current_value"] == 2
    assert data["is_complete"] is True
    assert data["game_id"] == g1["id"]
    assert data["game_name"] == "Target Game"


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------

def test_delete_goal(client):
    r = client.post(
        "/api/goals/",
        json={"title": "Delete me", "type": "sessions_total", "target_value": 999},
    )
    goal_id = r.json()["id"]

    d = client.delete(f"/api/goals/{goal_id}")
    assert d.status_code == 204

    # Verify it's gone
    goals = client.get("/api/goals/").json()
    assert all(g["id"] != goal_id for g in goals)


def test_delete_goal_not_found(client):
    r = client.delete("/api/goals/9999")
    assert r.status_code == 404


def test_goal_game_deleted_goal_survives(client):
    """Deleting a game with game_id FK SET NULL — the goal must remain, with game_id=None."""
    game = _create_game(client, "Doomed Game")
    _add_session(client, game["id"])
    r = client.post(
        "/api/goals/",
        json={"title": "Track Doomed", "type": "game_sessions", "target_value": 5, "game_id": game["id"]},
    )
    assert r.status_code == 201
    goal_id = r.json()["id"]

    client.delete(f"/api/games/{game['id']}")

    goals = client.get("/api/goals/").json()
    surviving = next((g for g in goals if g["id"] == goal_id), None)
    assert surviving is not None
    assert surviving["game_id"] is None
