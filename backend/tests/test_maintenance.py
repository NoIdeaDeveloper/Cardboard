"""Tests for the maintenance log endpoints."""


def _make_game(client, name="Test Game"):
    r = client.post("/api/games/", json={"name": name})
    assert r.status_code == 201
    return r.json()["id"]


def _add_entry(client, game_id, kind="missing_piece", description="Lost red meeple"):
    r = client.post(f"/api/games/{game_id}/maintenance", json={"kind": kind, "description": description})
    assert r.status_code == 201
    return r.json()["id"]


def test_add_maintenance_entry(client):
    gid = _make_game(client)
    r = client.post(f"/api/games/{gid}/maintenance", json={"kind": "missing_piece", "description": "Lost red meeple"})
    assert r.status_code == 201
    data = r.json()
    assert data["id"] > 0
    assert data["game_id"] == gid
    assert data["kind"] == "missing_piece"
    assert data["description"] == "Lost red meeple"
    assert data["status"] == "open"
    assert data["resolved_at"] is None


def test_add_maintenance_invalid_kind(client):
    gid = _make_game(client)
    r = client.post(f"/api/games/{gid}/maintenance", json={"kind": "invalid", "description": "test"})
    assert r.status_code == 422


def test_list_maintenance_for_game(client):
    gid = _make_game(client)
    _add_entry(client, gid, "missing_piece", "Lost meeple")
    _add_entry(client, gid, "damage", "Box corner crushed")
    r = client.get(f"/api/games/{gid}/maintenance")
    assert r.status_code == 200
    entries = r.json()
    assert len(entries) == 2
    # Newest first
    assert entries[0]["description"] == "Box corner crushed"


def test_update_maintenance_resolve(client):
    gid = _make_game(client)
    eid = _add_entry(client, gid, "sleeve", "Needs premium sleeves")
    r = client.patch(f"/api/games/maintenance/{eid}", json={"status": "resolved"})
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "resolved"
    assert data["resolved_at"] is not None


def test_update_maintenance_reopen(client):
    gid = _make_game(client)
    eid = _add_entry(client, gid, "damage", "Torn board")
    client.patch(f"/api/games/maintenance/{eid}", json={"status": "resolved"})
    r = client.patch(f"/api/games/maintenance/{eid}", json={"status": "open"})
    assert r.status_code == 200
    assert r.json()["status"] == "open"
    assert r.json()["resolved_at"] is None


def test_update_maintenance_description(client):
    gid = _make_game(client)
    eid = _add_entry(client, gid, "other", "Original note")
    r = client.patch(f"/api/games/maintenance/{eid}", json={"description": "Updated note"})
    assert r.status_code == 200
    assert r.json()["description"] == "Updated note"


def test_update_maintenance_not_found(client):
    r = client.patch("/api/games/maintenance/99999", json={"status": "resolved"})
    assert r.status_code == 404


def test_delete_maintenance(client):
    gid = _make_game(client)
    eid = _add_entry(client, gid)
    r = client.delete(f"/api/games/maintenance/{eid}")
    assert r.status_code == 204
    # List should be empty now
    r = client.get(f"/api/games/{gid}/maintenance")
    assert r.json() == []


def test_delete_maintenance_not_found(client):
    r = client.delete("/api/games/maintenance/99999")
    assert r.status_code == 404


def test_list_open_maintenance(client):
    g1 = _make_game(client, "Game A")
    g2 = _make_game(client, "Game B")
    _add_entry(client, g1, "missing_piece", "Lost dice")
    _add_entry(client, g2, "damage", "Broken box")
    # Resolve one
    eid_open = _add_entry(client, g1, "sleeve", "Needs sleeves")
    client.patch(f"/api/games/maintenance/{eid_open}", json={"status": "resolved"})
    r = client.get("/api/games/maintenance/open")
    assert r.status_code == 200
    entries = r.json()
    # 2 open (lost dice + broken box), 1 resolved excluded
    assert len(entries) == 2
    assert all(e["status"] == "open" for e in entries)


def test_maintenance_cascades_on_game_delete(client):
    gid = _make_game(client)
    _add_entry(client, gid, "missing_piece", "Lost pawn")
    client.delete(f"/api/games/{gid}")
    r = client.get(f"/api/games/{gid}/maintenance")
    assert r.status_code == 404  # game gone