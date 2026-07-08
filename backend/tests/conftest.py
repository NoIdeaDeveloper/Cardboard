"""
Test fixtures for the Cardboard v2 backend.

Environment variables must be set BEFORE importing main/database, because they are
read at module level. conftest.py is the right place to do this.
"""
import atexit
import os
import shutil
import sys
import tempfile

# Add backend directory to path so imports work when running `pytest` from backend/
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_test_tmp = tempfile.mkdtemp(prefix="cardboard_test_")
atexit.register(shutil.rmtree, _test_tmp, ignore_errors=True)

os.environ.setdefault("DATABASE_URL", "sqlite://")          # in-memory SQLite
os.environ.setdefault("DATA_DIR", _test_tmp)
os.environ.setdefault("IMAGES_DIR", os.path.join(_test_tmp, "images"))
os.environ.setdefault("INSTRUCTIONS_DIR", os.path.join(_test_tmp, "instructions"))
os.environ.setdefault("GALLERY_DIR", os.path.join(_test_tmp, "gallery"))
os.environ.setdefault("FRONTEND_PATH", "")     # skip frontend static mount
os.environ.setdefault("LOG_LEVEL", "WARNING")  # quiet during tests

import pytest
from database import Base, get_db
from fastapi.testclient import TestClient
from main import app
from sqlalchemy import StaticPool, create_engine, event
from sqlalchemy import text as sa_text
from sqlalchemy.orm import sessionmaker

# Single shared in-memory engine for the whole test session.
# StaticPool ensures all connections share the same in-memory database.
_engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)

# Enable FK enforcement to match production behaviour (database.py does the same).
@event.listens_for(_engine, "connect")
def _set_sqlite_pragmas(dbapi_conn, connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()

Base.metadata.create_all(bind=_engine)

# Create FTS5 virtual table + triggers for game name search (mirrors migration 0018).
# Base.metadata.create_all() can't create FTS5 virtual tables, so we do it manually.
with _engine.connect() as _fts_conn:
    _fts_conn.execute(
        sa_text(
            "CREATE VIRTUAL TABLE IF NOT EXISTS games_fts USING fts5("
            "name, content='games', content_rowid='id', "
            "tokenize='porter unicode61')"
        )
    )
    _fts_conn.execute(
        sa_text(
            "CREATE TRIGGER IF NOT EXISTS games_fts_ai AFTER INSERT ON games BEGIN "
            "INSERT INTO games_fts(rowid, name) VALUES (new.id, new.name); END"
        )
    )
    _fts_conn.execute(
        sa_text(
            "CREATE TRIGGER IF NOT EXISTS games_fts_ad AFTER DELETE ON games BEGIN "
            "INSERT INTO games_fts(games_fts, rowid, name) VALUES ('delete', old.id, old.name); END"
        )
    )
    _fts_conn.execute(
        sa_text(
            "CREATE TRIGGER IF NOT EXISTS games_fts_au AFTER UPDATE ON games BEGIN "
            "INSERT INTO games_fts(games_fts, rowid, name) VALUES ('delete', old.id, old.name); "
            "INSERT INTO games_fts(rowid, name) VALUES (new.id, new.name); END"
        )
    )
    _fts_conn.commit()

_TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=_engine)


@pytest.fixture(scope="function")
def db():
    """Yield a DB session that is rolled back after each test.

    Uses a savepoint so that tests which call db.commit() themselves (e.g. CSV
    import, BGG import) don't leak data across tests.  The outer transaction
    is always rolled back.
    """
    connection = _engine.connect()
    connection.begin()  # outer transaction — always rolled back
    connection.begin_nested()  # savepoint — any db.commit() inside the test lands here
    session = _TestingSession(bind=connection)
    try:
        yield session
    finally:
        session.close()
        connection.rollback()
        connection.close()


@pytest.fixture(scope="function")
def client(db):
    """TestClient with get_db overridden to use the test session."""
    def _override_get_db():
        try:
            yield db
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c
    app.dependency_overrides.pop(get_db, None)
