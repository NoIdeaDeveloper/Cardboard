"""Add date_modified column to players table.

Player-only writes (rename, avatar changes, Elo recalculations) previously
left no trace in the data the collection ETag is derived from, so the stats
dashboard and collection ETags did not change — serving stale payloads from
the TTL cache. The column mirrors games.date_modified: it is set on insert and
touched on any ORM-level update, so the ETag inputs can include it.

Revision ID: 0024
Revises: 0023
Create Date: 2026-08-21
"""

from alembic import op
import sqlalchemy as sa


revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    cols = {c["name"] for c in inspector.get_columns("players")}
    if "date_modified" not in cols:
        # SQLite requires a default when adding a NOT NULL column to a
        # populated table; existing rows get the migration timestamp, which is
        # a fine baseline (any later write bumps it via the ORM onupdate).
        op.execute(
            "ALTER TABLE players ADD COLUMN date_modified DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    cols = {c["name"] for c in inspector.get_columns("players")}
    if "date_modified" in cols:
        op.execute("ALTER TABLE players DROP COLUMN date_modified")
