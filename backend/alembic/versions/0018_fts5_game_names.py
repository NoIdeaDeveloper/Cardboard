"""Add FTS5 full-text search index over game names.

Replaces the LIKE '%token%' full-scan search with FTS5 MATCH queries.
The FTS table is external-content (references games.rowid) and kept in sync
by triggers on INSERT/UPDATE/DELETE of games.

Revision ID: 0018
Revises: 0017
Create Date: 2026-07-04
"""

from alembic import op
import sqlalchemy as sa


revision = '0018'
down_revision = '0017'
branch_labels = None
depends_on = None


def _table_exists(conn, name):
    return conn.execute(
        sa.text("SELECT 1 FROM sqlite_master WHERE type='table' AND name=:n"),
        {"n": name},
    ).fetchone() is not None


def upgrade() -> None:
    conn = op.get_bind()
    if _table_exists(conn, 'games_fts'):
        return

    # External-content FTS5 table: stores only the index, references games.rowid.
    op.execute(
        "CREATE VIRTUAL TABLE games_fts USING fts5("
        "name, "
        "content='games', content_rowid='id', "
        "tokenize='porter unicode61')"
    )

    # Populate from existing rows.
    op.execute("INSERT INTO games_fts(rowid, name) SELECT id, name FROM games")

    # Triggers to keep the FTS table in sync.
    op.execute(
        "CREATE TRIGGER games_fts_ai AFTER INSERT ON games BEGIN "
        "INSERT INTO games_fts(rowid, name) VALUES (new.id, new.name); "
        "END"
    )
    op.execute(
        "CREATE TRIGGER games_fts_ad AFTER DELETE ON games BEGIN "
        "INSERT INTO games_fts(games_fts, rowid, name) VALUES ('delete', old.id, old.name); "
        "END"
    )
    op.execute(
        "CREATE TRIGGER games_fts_au AFTER UPDATE ON games BEGIN "
        "INSERT INTO games_fts(games_fts, rowid, name) VALUES ('delete', old.id, old.name); "
        "INSERT INTO games_fts(rowid, name) VALUES (new.id, new.name); "
        "END"
    )


def downgrade() -> None:
    conn = op.get_bind()
    op.execute("DROP TRIGGER IF EXISTS games_fts_au")
    op.execute("DROP TRIGGER IF EXISTS games_fts_ad")
    op.execute("DROP TRIGGER IF EXISTS games_fts_ai")
    if _table_exists(conn, 'games_fts'):
        op.execute("DROP TABLE games_fts")