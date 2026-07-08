"""Migration-drift test.

Asserts that `alembic upgrade head` produces a schema equivalent to
`Base.metadata.create_all` (+ manual FTS5 setup). Catches the bug class where a
model is added without a corresponding migration — migration 0009 historically
fixed exactly this for the `user_settings` table, which existed in the ORM but
not in the migration chain, so a fresh `alembic upgrade head` 500'd every
`/api/settings/*` call.

Compares:
- Table sets (excluding alembic bookkeeping + FTS5 virtual table + its shadow tables)
- Columns per table (name + type + nullable; server defaults excluded since
  migrations legitimately add them while ORM uses Python-side defaults)
- Index coverage: which column-combinations are indexed. Index *names* are
  not compared because SQLAlchemy auto-generates names from `index=True` (e.g.
  `ix_elo_history_session_id`) that differ from hand-crafted migration names
  (e.g. `ix_elo_history_session`). What matters for query plans is coverage.

Known migration-only artifacts excluded from coverage comparison:
- `ix_games_bgg_id_unique`: partial unique index (`WHERE bgg_id IS NOT NULL`)
  that SQLAlchemy cannot declare declaratively.
"""
import os
import subprocess
import sys

import models  # noqa: F401 — registers ORM models with Base.metadata
import pytest
from database import Base
from sqlalchemy import create_engine, inspect
from sqlalchemy import text as sa_text


def _is_excluded_table(name):
    """Skip alembic bookkeeping, the FTS5 virtual table, and its shadow tables.

    FTS5 creates games_fts plus games_fts_config/data/docsize/idx automatically.
    """
    if name == "alembic_version":
        return True
    if name == "games_fts":
        return True
    if name.startswith("games_fts_"):
        return True
    return False


# Index names that exist only in migrations (not declarable via ORM) — excluded
# from coverage comparison. Documented here so future readers understand why.
_MIGRATION_ONLY_INDEXES = {"ix_games_bgg_id_unique"}


def _schema_dict(engine):
    """Return {table: {"columns": [...], "index_cols": set[tuple]}}.

    - columns: sorted [(name, type_lower, nullable)]
    - index_cols: set of column-tuples that have an index (coverage, not names)
    """
    insp = inspect(engine)
    out = {}
    for table in insp.get_table_names():
        if _is_excluded_table(table):
            continue
        cols = []
        for c in insp.get_columns(table):
            cols.append((c["name"], str(c["type"]).lower(), bool(c.get("nullable", True))))
        index_cols = set()
        for i in insp.get_indexes(table):
            if i["name"] in _MIGRATION_ONLY_INDEXES:
                continue
            index_cols.add(tuple(i["column_names"]))
        out[table] = {"columns": sorted(cols), "index_cols": index_cols}
    return out


def _create_fts5(conn):
    """Mirror conftest.py:54-81 — create the FTS5 virtual table + triggers.

    `Base.metadata.create_all` cannot create FTS5 virtual tables, so we do it
    manually to match what migration 0018 produces.
    """
    conn.execute(sa_text(
        "CREATE VIRTUAL TABLE IF NOT EXISTS games_fts USING fts5("
        "name, content='games', content_rowid='id', "
        "tokenize='porter unicode61')"
    ))
    conn.execute(sa_text(
        "CREATE TRIGGER IF NOT EXISTS games_fts_ai AFTER INSERT ON games BEGIN "
        "INSERT INTO games_fts(rowid, name) VALUES (new.id, new.name); END"
    ))
    conn.execute(sa_text(
        "CREATE TRIGGER IF NOT EXISTS games_fts_ad AFTER DELETE ON games BEGIN "
        "INSERT INTO games_fts(games_fts, rowid, name) VALUES ('delete', old.id, old.name); END"
    ))
    conn.execute(sa_text(
        "CREATE TRIGGER IF NOT EXISTS games_fts_au AFTER UPDATE ON games BEGIN "
        "INSERT INTO games_fts(games_fts, rowid, name) VALUES ('delete', old.id, old.name); "
        "INSERT INTO games_fts(rowid, name) VALUES (new.id, new.name); END"
    ))
    conn.commit()


def _run_alembic_upgrade(backend_dir, db_path):
    """Run `alembic upgrade head` against a fresh file-based SQLite DB."""
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{db_path}"}
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=backend_dir,
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        f"alembic upgrade head failed (rc={result.returncode}):\n"
        f"--- stderr ---\n{result.stderr}\n--- stdout ---\n{result.stdout}"
    )
    return result


@pytest.fixture()
def backend_dir():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_alembic_upgrade_head_matches_create_all(tmp_path, backend_dir):
    """`alembic upgrade head` and `Base.metadata.create_all` must produce the
    same set of tables, columns (name+type+nullable), and indexes.

    This is the classic autogenerate-drift check. If a model gains a column
    without a migration, the create_all DB will have it but the alembic DB
    won't — and vice versa.
    """
    # --- DB-A: alembic upgrade head ---
    db_a = str(tmp_path / "alembic.db")
    _run_alembic_upgrade(backend_dir, db_a)
    engine_a = create_engine(f"sqlite:///{db_a}")
    schema_a = _schema_dict(engine_a)
    # Assert FTS5 virtual table exists in the alembic-upgraded DB
    with engine_a.connect() as conn:
        fts_exists = conn.execute(sa_text(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='games_fts'"
        )).fetchone() is not None
    assert fts_exists, "alembic upgrade head did not create games_fts"
    engine_a.dispose()

    # --- DB-B: Base.metadata.create_all + manual FTS5 ---
    db_b = str(tmp_path / "createall.db")
    engine_b = create_engine(f"sqlite:///{db_b}")
    Base.metadata.create_all(bind=engine_b)
    with engine_b.connect() as conn:
        _create_fts5(conn)
    schema_b = _schema_dict(engine_b)
    engine_b.dispose()

    # --- Compare table sets ---
    tables_a = set(schema_a)
    tables_b = set(schema_b)
    assert tables_a == tables_b, (
        "Table set drift:\n"
        f"  Only in alembic:    {sorted(tables_a - tables_b)}\n"
        f"  Only in create_all: {sorted(tables_b - tables_a)}"
    )

    # --- Compare columns and index coverage per table ---
    for table in sorted(tables_a):
        a_cols = schema_a[table]["columns"]
        b_cols = schema_b[table]["columns"]
        assert a_cols == b_cols, (
            f"Column drift on '{table}':\n"
            f"  Only in alembic:    {set(a_cols) - set(b_cols)}\n"
            f"  Only in create_all: {set(b_cols) - set(a_cols)}"
        )
        a_idx = schema_a[table]["index_cols"]
        b_idx = schema_b[table]["index_cols"]
        assert a_idx == b_idx, (
            f"Index coverage drift on '{table}':\n"
            f"  Only in alembic:    {sorted(a_idx - b_idx)}\n"
            f"  Only in create_all: {sorted(b_idx - a_idx)}"
        )


def test_alembic_head_revision_is_latest(tmp_path, backend_dir):
    """The alembic_version table after `upgrade head` must contain the latest
    revision, proving the migration chain is complete and unbroken."""
    db = str(tmp_path / "revcheck.db")
    _run_alembic_upgrade(backend_dir, db)
    engine = create_engine(f"sqlite:///{db}")
    with engine.connect() as conn:
        rev = conn.execute(sa_text("SELECT version_num FROM alembic_version")).scalar()
    engine.dispose()

    # Derive the expected head revision from the latest migration file name.
    versions_dir = os.path.join(backend_dir, "alembic", "versions")
    revs = sorted(
        f.split("_")[0] for f in os.listdir(versions_dir)
        if f.endswith(".py") and not f.startswith("__") and f[0].isdigit()
    )
    expected = revs[-1]
    assert rev == expected, f"alembic head is {rev!r}, expected {expected!r}"


def test_create_all_includes_fts5_table(tmp_path):
    """Sanity check: the create_all DB (with manual FTS5) has games_fts, so the
    comparison in the drift test is apples-to-apples."""
    db = str(tmp_path / "fts.db")
    engine = create_engine(f"sqlite:///{db}")
    Base.metadata.create_all(bind=engine)
    with engine.connect() as conn:
        _create_fts5(conn)
        fts_exists = conn.execute(sa_text(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='games_fts'"
        )).fetchone() is not None
    engine.dispose()
    assert fts_exists, "create_all + manual FTS5 did not create games_fts"