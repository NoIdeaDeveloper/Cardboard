"""Add winner_player_id FK to play_sessions

Adds a proper foreign key to the players table for session winners,
replacing the string-based winner lookup. Backfills from existing data.

SQLite requires batch mode for adding constraints.

Revision ID: 0012
Revises: 0011
Create Date: 2026-06-09
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = '0012'
down_revision = '0011'
branch_labels = None
depends_on = None


def _column_exists(table, column):
    """Check if a column exists in a table (SQLite-safe)."""
    conn = op.get_bind()
    cols = conn.execute(sa.text(f"PRAGMA table_info({table})")).fetchall()
    return any(c[1] == column for c in cols)


def _index_exists(table, index):
    """Check if an index exists in a table (SQLite-safe)."""
    conn = op.get_bind()
    indexes = conn.execute(sa.text(f"PRAGMA index_list({table})")).fetchall()
    return any(i[1] == index for i in indexes)


def upgrade() -> None:
    # Check if column already exists (from previous failed migration)
    col_exists = _column_exists('play_sessions', 'winner_player_id')
    
    if not col_exists:
        # Add column and index
        op.add_column('play_sessions', sa.Column('winner_player_id', sa.Integer(), nullable=True))
        op.create_index('ix_play_sessions_winner_player', 'play_sessions', ['winner_player_id'])
        
        # SQLite requires batch mode for adding constraints
        with op.batch_alter_table('play_sessions', schema=None) as batch_op:
            batch_op.create_foreign_key(
                'fk_play_sessions_winner_player', 'players',
                ['winner_player_id'], ['id'], ondelete='SET NULL'
            )
    else:
        # Column exists but may be missing index or constraint
        if not _index_exists('play_sessions', 'ix_play_sessions_winner_player'):
            op.create_index('ix_play_sessions_winner_player', 'play_sessions', ['winner_player_id'])
        
        # Check if constraint exists
        conn = op.get_bind()
        fk_rows = conn.execute(sa.text(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='play_sessions'"
        )).fetchall()
        if fk_rows:
            # Check existing foreign keys via PRAGMA
            fk_list = conn.execute(sa.text("PRAGMA foreign_key_list(play_sessions)")).fetchall()
            if not any(fk[3] == 'winner_player_id' for fk in fk_list):
                with op.batch_alter_table('play_sessions', schema=None) as batch_op:
                    batch_op.create_foreign_key(
                        'fk_play_sessions_winner_player', 'players',
                        ['winner_player_id'], ['id'], ondelete='SET NULL'
                    )
    
    # Backfill: match winner name to player name
    conn = op.get_bind()
    conn.execute(sa.text("""
        UPDATE play_sessions
        SET winner_player_id = (
            SELECT players.id FROM players
            WHERE players.name = play_sessions.winner
            LIMIT 1
        )
        WHERE winner IS NOT NULL AND winner != '' AND winner_player_id IS NULL
    """))


def downgrade() -> None:
    # Check if column exists before dropping
    if _column_exists('play_sessions', 'winner_player_id'):
        with op.batch_alter_table('play_sessions', schema=None) as batch_op:
            batch_op.drop_constraint('fk_play_sessions_winner_player', type_='foreignkey')
        op.drop_index('ix_play_sessions_winner_player', table_name='play_sessions')
        op.drop_column('play_sessions', 'winner_player_id')
