"""Tests for the factory-reset / wipe endpoint."""
import os

import models


def _seed_data(client, db):
    """Insert a game with a session, a player, and a share token."""
    gid = client.post("/api/games/", json={"name": "Wingspan"}).json()["id"]
    client.post("/api/players/", json={"name": "Alice"})
    client.post(f"/api/games/{gid}/sessions", json={"played_at": "2024-01-01", "player_names": ["Alice"]})
    client.post("/api/share/tokens", params={"label": "test"})
    # Add a user setting
    client.put("/api/settings/theme", json={"value": "dark"})
    # Add a goal
    client.post("/api/goals/", json={"title": "Play 10 times", "type": "sessions_total", "target_value": 10})
    return gid


def test_wipe_requires_confirmation(client, db):
    _seed_data(client, db)
    r = client.request("DELETE", "/api/everything", json={"confirm": "wrong"})
    assert r.status_code == 400
    assert "mismatch" in r.json()["detail"].lower()
    # Data should still be there
    assert db.query(models.Game).count() == 1


def test_wipe_clears_all_tables(client, db):
    _seed_data(client, db)
    # Verify data exists before wipe
    assert db.query(models.Game).count() >= 1
    assert db.query(models.Player).count() >= 1
    assert db.query(models.PlaySession).count() >= 1
    assert db.query(models.ShareToken).count() >= 1
    assert db.query(models.UserSetting).count() >= 1
    assert db.query(models.Goal).count() >= 1

    r = client.request("DELETE", "/api/everything", json={"confirm": "DELETE EVERYTHING"})
    assert r.status_code == 200
    data = r.json()
    assert data["message"] == "All data wiped"
    assert data["tables_cleared"] >= 10  # at least the main tables
    assert data["media_dirs_cleared"] == 4

    # All tables should be empty
    assert db.query(models.Game).count() == 0
    assert db.query(models.Player).count() == 0
    assert db.query(models.PlaySession).count() == 0
    assert db.query(models.SessionPlayer).count() == 0
    assert db.query(models.EloHistory).count() == 0
    assert db.query(models.ShareToken).count() == 0
    assert db.query(models.Goal).count() == 0
    assert db.query(models.WantToPlayRequest).count() == 0
    assert db.query(models.UserSetting).count() == 0
    # Tag lookup + junction tables
    assert db.query(models.Category).count() == 0
    assert db.query(models.GameCategory).count() == 0
    assert db.query(models.Mechanic).count() == 0
    assert db.query(models.GameMechanic).count() == 0
    assert db.query(models.Designer).count() == 0
    assert db.query(models.GameDesigner).count() == 0
    assert db.query(models.Publisher).count() == 0
    assert db.query(models.GamePublisher).count() == 0
    assert db.query(models.Label).count() == 0
    assert db.query(models.GameLabel).count() == 0
    assert db.query(models.GameImage).count() == 0


def test_wipe_recreates_media_dirs(client, db):
    _seed_data(client, db)
    data_dir = os.getenv("DATA_DIR")
    subdirs = ["images", "instructions", "gallery", "avatars"]

    # Create some dummy media files
    for subdir in subdirs:
        path = os.path.join(data_dir, subdir, "dummy.txt")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write("test")

    r = client.request("DELETE", "/api/everything", json={"confirm": "DELETE EVERYTHING"})
    assert r.status_code == 200

    # Dirs should exist but be empty
    for subdir in subdirs:
        dir_path = os.path.join(data_dir, subdir)
        assert os.path.isdir(dir_path), f"{subdir} dir should exist"
        assert os.listdir(dir_path) == [], f"{subdir} dir should be empty"


def test_wipe_idempotent(client, db):
    """Wiping an already-empty database should not error."""
    r = client.request("DELETE", "/api/everything", json={"confirm": "DELETE EVERYTHING"})
    assert r.status_code == 200
    # Second wipe should also work
    r = client.request("DELETE", "/api/everything", json={"confirm": "DELETE EVERYTHING"})
    assert r.status_code == 200
