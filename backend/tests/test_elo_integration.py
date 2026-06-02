import pytest


def test_add_session_with_scores_updates_elo(client, db):
    # Create a game
    resp = client.post("/api/games/", json={"name": "Elo Test Game"})
    assert resp.status_code == 201
    game_id = resp.json()["id"]

    # Create a scored session
    resp = client.post(
        f"/api/games/{game_id}/sessions",
        json={
            "played_at": "2024-01-01",
            "player_names": ["Alice", "Bob"],
            "scores": {"Alice": 100, "Bob": 50},
        },
    )
    assert resp.status_code == 201

    # Check player Elo ratings
    players = client.get("/api/players/").json()
    alice = next(p for p in players if p["name"] == "Alice")
    bob = next(p for p in players if p["name"] == "Bob")

    assert alice["elo_rating"] > 1500.0
    assert bob["elo_rating"] < 1500.0
    assert alice["games_played"] == 1
    assert bob["games_played"] == 1


def test_update_session_recalculates_elo(client, db):
    # Create a game
    resp = client.post("/api/games/", json={"name": "Elo Update Game"})
    game_id = resp.json()["id"]

    # Create session
    resp = client.post(
        f"/api/games/{game_id}/sessions",
        json={
            "played_at": "2024-01-01",
            "player_names": ["Alice", "Bob"],
            "scores": {"Alice": 100, "Bob": 50},
        },
    )
    session_id = resp.json()["id"]

    # Update scores (swap winner)
    resp = client.patch(
        f"/api/sessions/{session_id}",
        json={
            "scores": {"Alice": 50, "Bob": 100},
        },
    )
    assert resp.status_code == 200

    players = client.get("/api/players/").json()
    alice = next(p for p in players if p["name"] == "Alice")
    bob = next(p for p in players if p["name"] == "Bob")

    # After swap, Alice should be below 1500 and Bob above
    assert alice["elo_rating"] < 1500.0
    assert bob["elo_rating"] > 1500.0


def test_delete_session_recalculates_elo(client, db):
    # Create a game
    resp = client.post("/api/games/", json={"name": "Elo Delete Game"})
    game_id = resp.json()["id"]

    # Create session
    resp = client.post(
        f"/api/games/{game_id}/sessions",
        json={
            "played_at": "2024-01-01",
            "player_names": ["Alice", "Bob"],
            "scores": {"Alice": 100, "Bob": 50},
        },
    )
    session_id = resp.json()["id"]

    # Delete session
    resp = client.delete(f"/api/sessions/{session_id}")
    assert resp.status_code == 204

    players = client.get("/api/players/").json()
    alice = next(p for p in players if p["name"] == "Alice")
    bob = next(p for p in players if p["name"] == "Bob")

    assert alice["elo_rating"] == 1500.0
    assert bob["elo_rating"] == 1500.0
    assert alice["games_played"] == 0
    assert bob["games_played"] == 0


def test_rankings_endpoint(client, db):
    # Create a game
    resp = client.post("/api/games/", json={"name": "Rankings Game"})
    game_id = resp.json()["id"]

    # Create sessions with different winners
    client.post(
        f"/api/games/{game_id}/sessions",
        json={
            "played_at": "2024-01-01",
            "player_names": ["Alice", "Bob"],
            "scores": {"Alice": 100, "Bob": 50},
        },
    )
    client.post(
        f"/api/games/{game_id}/sessions",
        json={
            "played_at": "2024-01-02",
            "player_names": ["Alice", "Bob"],
            "scores": {"Alice": 100, "Bob": 50},
        },
    )

    rankings = client.get("/api/players/rankings").json()
    assert len(rankings) == 2
    assert rankings[0]["player_name"] == "Alice"
    assert rankings[0]["rank"] == 1
    assert rankings[0]["elo_rating"] > rankings[1]["elo_rating"]
    assert rankings[1]["player_name"] == "Bob"
    assert rankings[1]["rank"] == 2


def test_unscored_session_does_not_affect_elo(client, db):
    resp = client.post("/api/games/", json={"name": "Unscored Game"})
    game_id = resp.json()["id"]

    resp = client.post(
        f"/api/games/{game_id}/sessions",
        json={
            "played_at": "2024-01-01",
            "player_names": ["Alice", "Bob"],
        },
    )
    assert resp.status_code == 201

    players = client.get("/api/players/").json()
    alice = next(p for p in players if p["name"] == "Alice")
    assert alice["elo_rating"] == 1500.0
    assert alice["games_played"] == 0


def test_admin_recalculate_elo(client, db):
    # Create a game and session
    resp = client.post("/api/games/", json={"name": "Recalc Game"})
    game_id = resp.json()["id"]

    client.post(
        f"/api/games/{game_id}/sessions",
        json={
            "played_at": "2024-01-01",
            "player_names": ["Alice", "Bob"],
            "scores": {"Alice": 100, "Bob": 50},
        },
    )

    # Manually reset Elo to simulate pre-backfill state
    players = client.get("/api/players/").json()
    for p in players:
        assert p["elo_rating"] != 1500.0

    # Recalculate
    resp = client.post("/api/players/admin/recalculate-elo")
    assert resp.status_code == 200
    data = resp.json()
    assert data["players_updated"] == 2

    players = client.get("/api/players/").json()
    alice = next(p for p in players if p["name"] == "Alice")
    bob = next(p for p in players if p["name"] == "Bob")
    assert alice["elo_rating"] > 1500.0
    assert bob["elo_rating"] < 1500.0
