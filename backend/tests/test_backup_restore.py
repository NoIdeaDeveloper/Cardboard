"""Tests for backup download and restore endpoints.

These tests use a real file-based SQLite database (not in-memory) because the
backup endpoint reads the database via sqlite3.connect(db_path) which requires
an actual file on disk. A separate fixture sets up an isolated temp directory
with a real schema and a seeded game, then wires a fresh TestClient to it.
"""
import io
import os
import sqlite3
import tempfile
import zipfile

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models
from database import Base, get_db
from main import app


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def file_env(tmp_path):
    """
    Set up a real file-based environment in tmp_path:
      db_path     – path to a populated cardboard.db
      data_dir    – root data dir (== tmp_path)
      images_dir  – tmp_path/images
    """
    db_path = str(tmp_path / "cardboard.db")
    data_dir = str(tmp_path)
    images_dir = str(tmp_path / "images")
    os.makedirs(images_dir, exist_ok=True)

    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(bind=engine)
    TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    # Seed one game so the backup is non-trivial
    session = TestingSession()
    session.add(models.Game(name="Catan", status="owned"))
    session.commit()
    session.close()

    engine.dispose()

    yield {"db_path": db_path, "data_dir": data_dir, "images_dir": images_dir}


@pytest.fixture()
def backup_client(file_env, monkeypatch):
    """
    TestClient wired to a real file-based SQLite DB for backup/restore testing.

    Monkeypatches env vars so the backup/restore endpoints resolve the correct
    paths, and patches the module-level IMAGES_DIR constant in routers.games
    (which is captured at import time from os.getenv).
    """
    db_path = file_env["db_path"]
    data_dir = file_env["data_dir"]
    images_dir = file_env["images_dir"]

    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_path}")
    monkeypatch.setenv("DATA_DIR", data_dir)
    monkeypatch.setenv("IMAGES_DIR", images_dir)

    import routers.games as _games_mod
    monkeypatch.setattr(_games_mod, "IMAGES_DIR", images_dir)

    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    def _override_get_db():
        session = TestingSession()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c
    app.dependency_overrides.pop(get_db, None)
    engine.dispose()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_backup_zip(client) -> bytes:
    r = client.get("/api/games/backup")
    assert r.status_code == 200, r.text
    return r.content


def _post_restore(client, zip_bytes: bytes, filename: str = "backup.zip"):
    return client.post(
        "/api/games/restore",
        files={"file": (filename, io.BytesIO(zip_bytes), "application/zip")},
    )


def _make_zip(files: dict) -> bytes:
    """Build an in-memory ZIP from {arcname: bytes_or_str}."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for arcname, content in files.items():
            if isinstance(content, str):
                content = content.encode()
            zf.writestr(arcname, content)
    return buf.getvalue()


def _empty_sqlite_db() -> bytes:
    """Return the raw bytes of a valid but empty SQLite database."""
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    try:
        conn = sqlite3.connect(tmp.name)
        conn.execute("PRAGMA user_version = 1")
        conn.close()
        with open(tmp.name, "rb") as f:
            return f.read()
    finally:
        os.unlink(tmp.name)


# ---------------------------------------------------------------------------
# Backup endpoint
# ---------------------------------------------------------------------------

def test_backup_returns_200(backup_client):
    r = backup_client.get("/api/games/backup")
    assert r.status_code == 200


def test_backup_content_type_is_zip(backup_client):
    r = backup_client.get("/api/games/backup")
    assert "zip" in r.headers.get("content-type", "")


def test_backup_content_disposition_has_filename(backup_client):
    r = backup_client.get("/api/games/backup")
    disposition = r.headers.get("content-disposition", "")
    assert "cardboard-backup-" in disposition
    assert ".zip" in disposition


def test_backup_zip_contains_cardboard_db(backup_client):
    raw = _get_backup_zip(backup_client)
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        assert "cardboard.db" in zf.namelist()


def test_backup_db_has_sqlite_magic_header(backup_client):
    raw = _get_backup_zip(backup_client)
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        db_bytes = zf.read("cardboard.db")
    assert db_bytes[:16] == b"SQLite format 3\x00"


def test_backup_includes_images(backup_client, file_env):
    img_path = os.path.join(file_env["images_dir"], "42.jpg")
    with open(img_path, "wb") as f:
        f.write(b"FAKEJPEG")

    raw = _get_backup_zip(backup_client)
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        names = zf.namelist()
    assert any("42.jpg" in n for n in names)


# ---------------------------------------------------------------------------
# Restore endpoint — happy path
# ---------------------------------------------------------------------------

def test_restore_valid_backup_returns_200(backup_client):
    raw = _get_backup_zip(backup_client)
    r = _post_restore(backup_client, raw)
    assert r.status_code == 200


def test_restore_response_contains_success_message(backup_client):
    raw = _get_backup_zip(backup_client)
    r = _post_restore(backup_client, raw)
    assert "Restore successful" in r.json()["detail"]


def test_restore_roundtrip_preserves_data(backup_client, file_env):
    """Games survive a full backup → restore cycle, verified directly on disk."""
    raw = _get_backup_zip(backup_client)
    r = _post_restore(backup_client, raw)
    assert r.status_code == 200

    conn = sqlite3.connect(file_env["db_path"])
    rows = conn.execute("SELECT name FROM games").fetchall()
    conn.close()
    assert any(row[0] == "Catan" for row in rows)


def test_restore_with_images_extracts_to_data_dir(backup_client, file_env):
    """Images bundled in a backup ZIP land in DATA_DIR/images/."""
    zip_bytes = _make_zip({
        "cardboard.db": _empty_sqlite_db(),
        "images/99.jpg": b"FAKEIMG",
    })
    r = _post_restore(backup_client, zip_bytes)
    assert r.status_code == 200
    assert os.path.isfile(os.path.join(file_env["images_dir"], "99.jpg"))


def test_restore_with_gallery_and_instructions(backup_client, file_env):
    """gallery/ and instructions/ subdirs in the ZIP are also restored."""
    zip_bytes = _make_zip({
        "cardboard.db": _empty_sqlite_db(),
        "gallery/1_cover.jpg": b"GALLERY",
        "instructions/1_manual.pdf": b"PDF",
    })
    r = _post_restore(backup_client, zip_bytes)
    assert r.status_code == 200
    assert os.path.isfile(os.path.join(file_env["data_dir"], "gallery", "1_cover.jpg"))
    assert os.path.isfile(os.path.join(file_env["data_dir"], "instructions", "1_manual.pdf"))


def test_double_roundtrip(backup_client):
    """backup → restore → backup → restore should all succeed."""
    raw1 = _get_backup_zip(backup_client)
    assert _post_restore(backup_client, raw1).status_code == 200

    raw2 = _get_backup_zip(backup_client)
    assert _post_restore(backup_client, raw2).status_code == 200


# ---------------------------------------------------------------------------
# Restore endpoint — error cases
# ---------------------------------------------------------------------------

def test_restore_missing_cardboard_db_returns_422(backup_client):
    zip_bytes = _make_zip({"other.txt": "hello"})
    r = _post_restore(backup_client, zip_bytes)
    assert r.status_code == 422
    assert "cardboard.db" in r.json()["detail"]


def test_restore_corrupt_db_returns_422(backup_client):
    zip_bytes = _make_zip({"cardboard.db": b"this is not a sqlite database"})
    r = _post_restore(backup_client, zip_bytes)
    assert r.status_code == 422


def test_restore_non_zip_file_returns_4xx(backup_client):
    r = backup_client.post(
        "/api/games/restore",
        files={"file": ("backup.txt", io.BytesIO(b"not a zip at all"), "text/plain")},
    )
    assert r.status_code in (400, 422)


def test_restore_empty_zip_returns_422(backup_client):
    zip_bytes = _make_zip({})
    r = _post_restore(backup_client, zip_bytes)
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Security: path traversal in ZIP entries
# ---------------------------------------------------------------------------

def test_restore_path_traversal_does_not_escape_data_dir(backup_client, file_env):
    """A ZIP entry like images/../../../etc/evil.txt must not write outside data_dir."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("cardboard.db", _empty_sqlite_db())
        # Craft a ZipInfo with a traversal path
        info = zipfile.ZipInfo("images/../../../tmp/evil_cardboard.txt")
        zf.writestr(info, b"EVIL")
    buf.seek(0)

    r = _post_restore(backup_client, buf.read())
    evil_path = os.path.normpath(os.path.join(file_env["data_dir"], "images", "..", "..", "..", "tmp", "evil_cardboard.txt"))
    assert not os.path.exists(evil_path)


def test_restore_skips_unknown_subdirs(backup_client, file_env):
    """Files outside images/gallery/instructions are silently ignored."""
    zip_bytes = _make_zip({
        "cardboard.db": _empty_sqlite_db(),
        "secrets/token.txt": b"SECRET",
    })
    r = _post_restore(backup_client, zip_bytes)
    assert r.status_code == 200
    assert not os.path.exists(os.path.join(file_env["data_dir"], "secrets", "token.txt"))


# ---------------------------------------------------------------------------
# Restore preview endpoint
# ---------------------------------------------------------------------------

def test_restore_preview_returns_counts(backup_client):
    """Preview endpoint reports game and session counts without modifying data."""
    raw = _get_backup_zip(backup_client)
    r = backup_client.post(
        "/api/games/restore/preview",
        files={"file": ("backup.zip", io.BytesIO(raw), "application/zip")},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["game_count"] >= 1  # at least Catan seeded in fixture
    assert "games_preview" in data
    assert "Catan" in data["games_preview"]


def test_restore_preview_does_not_modify_db(backup_client, file_env):
    """Calling preview must not alter the live database."""
    raw = _get_backup_zip(backup_client)

    conn_before = sqlite3.connect(file_env["db_path"])
    count_before = conn_before.execute("SELECT COUNT(*) FROM games").fetchone()[0]
    conn_before.close()

    backup_client.post(
        "/api/games/restore/preview",
        files={"file": ("backup.zip", io.BytesIO(raw), "application/zip")},
    )

    conn_after = sqlite3.connect(file_env["db_path"])
    count_after = conn_after.execute("SELECT COUNT(*) FROM games").fetchone()[0]
    conn_after.close()
    assert count_before == count_after


def test_restore_preview_corrupt_db_returns_error(backup_client):
    """Preview must reject a corrupt cardboard.db with a 422."""
    zip_bytes = _make_zip({"cardboard.db": b"this is not a sqlite database"})
    r = backup_client.post(
        "/api/games/restore/preview",
        files={"file": ("backup.zip", io.BytesIO(zip_bytes), "application/zip")},
    )
    assert r.status_code == 422


def test_restore_preview_missing_db_returns_422(backup_client):
    """Preview must return 422 when cardboard.db is absent from the ZIP."""
    zip_bytes = _make_zip({"other.txt": "no db here"})
    r = backup_client.post(
        "/api/games/restore/preview",
        files={"file": ("backup.zip", io.BytesIO(zip_bytes), "application/zip")},
    )
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Temp file leak regression
# ---------------------------------------------------------------------------

def test_backup_registers_and_cleans_temp_files(backup_client, file_env):
    """The _cleanup_temp_backups function must remove tracked files from disk
    and from the tracking set.  (Background tasks run synchronously in
    TestClient, so _temp_backup_files is already clean after a normal request.)"""
    import routers.games as _gmod
    _gmod._temp_backup_files.clear()

    # Create a dummy temp file and register it manually, simulating what the
    # backup endpoint does internally.
    import tempfile
    tmp = tempfile.NamedTemporaryFile(dir=file_env["data_dir"], delete=False, suffix=".zip")
    tmp.write(b"fake backup")
    tmp.close()

    _gmod._temp_backup_files.add(tmp.name)
    assert len(_gmod._temp_backup_files) == 1

    # The cleanup function must remove the file and clear the tracking set
    _gmod._cleanup_temp_backups()
    assert len(_gmod._temp_backup_files) == 0, "Cleanup did not clear tracking set"
    assert not os.path.exists(tmp.name), f"Temp file was not removed: {tmp.name}"
