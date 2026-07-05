"""Add index on session_players.player_id

The composite PK (session_id, player_id) only supports lookups by session_id
(the leading column). Every "given a player, find their sessions" query had to
scan the whole session_players table. This migration adds an index on
player_id, the single hottest unindexed path for player stats, rankings, and
Elo replay.

Revision ID: 0017
Revises: 0016
Create Date: 2026-07-04
"""

from alembic import op
import sqlalchemy as sa


revision = '0017'
down_revision = '0016'
branch_labels = None
depends_on = None


def _index_exists(table, index):
    """Check if an index exists on a table (SQLite-safe)."""
    conn = op.get_bind()
    indexes = conn.execute(sa.text(f"PRAGMA index_list({table})")).fetchall()
    return any(i[1] == index for i in indexes)


def upgrade() -> None:
    if not _index_exists('session_players', 'ix_session_players_player_id'):
        op.create_index('ix_session_players_player_id', 'session_players', ['player_id'])


def downgrade() -> None:
    if _index_exists('session_players', 'ix_session_players_player_id'):
        op.drop_index('ix_session_players_player_id', table_name='session_players')
