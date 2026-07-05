"""Add index on play_sessions.played_at

The only index on played_at was the trailing column of the composite
ix_play_sessions_game_played (game_id, played_at), which cannot be used when
a query filters on played_at alone (no leading game_id constraint). Every
time-bucketed stats query (monthly sessions, recent sessions, day-of-week,
52-week heatmap, play projection) and several goals/players queries fell back
to a full-table scan.

Revision ID: 0015
Revises: 0014
Create Date: 2026-07-04
"""

from alembic import op
import sqlalchemy as sa


revision = '0015'
down_revision = '0014'
branch_labels = None
depends_on = None


def _index_exists(table, index):
    """Check if an index exists on a table (SQLite-safe)."""
    conn = op.get_bind()
    indexes = conn.execute(sa.text(f"PRAGMA index_list({table})")).fetchall()
    return any(i[1] == index for i in indexes)


def upgrade() -> None:
    if not _index_exists('play_sessions', 'ix_play_sessions_played_at'):
        op.create_index('ix_play_sessions_played_at', 'play_sessions', ['played_at'])


def downgrade() -> None:
    if _index_exists('play_sessions', 'ix_play_sessions_played_at'):
        op.drop_index('ix_play_sessions_played_at', table_name='play_sessions')
