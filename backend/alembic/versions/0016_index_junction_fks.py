"""Add indexes on junction-table non-leading FKs

All five tag junction tables (game_categories, game_mechanics, game_designers,
game_publishers, game_labels) had composite PKs (game_id, *_id) only. The
composite PK index efficiently supports "given a game, find its tags" but not
the reverse direction used by every aggregation query: JOIN pivot ON
pivot.*_id = tag.id. SQLite had to scan the entire pivot table to find rows
matching a given tag id. This migration adds indexes on the non-leading FK
column of each junction table.

Revision ID: 0016
Revises: 0015
Create Date: 2026-07-04
"""

from alembic import op
import sqlalchemy as sa


revision = '0016'
down_revision = '0015'
branch_labels = None
depends_on = None


_INDEXES = [
    ("ix_game_categories_category_id", "game_categories", "category_id"),
    ("ix_game_mechanics_mechanic_id",  "game_mechanics",  "mechanic_id"),
    ("ix_game_designers_designer_id",  "game_designers",  "designer_id"),
    ("ix_game_publishers_publisher_id","game_publishers", "publisher_id"),
    ("ix_game_labels_label_id",        "game_labels",     "label_id"),
]


def _index_exists(table, index):
    """Check if an index exists on a table (SQLite-safe)."""
    conn = op.get_bind()
    indexes = conn.execute(sa.text(f"PRAGMA index_list({table})")).fetchall()
    return any(i[1] == index for i in indexes)


def upgrade() -> None:
    for index_name, table, column in _INDEXES:
        if not _index_exists(table, index_name):
            op.create_index(index_name, table, [column])


def downgrade() -> None:
    for index_name, table, _column in _INDEXES:
        if _index_exists(table, index_name):
            op.drop_index(index_name, table_name=table)
