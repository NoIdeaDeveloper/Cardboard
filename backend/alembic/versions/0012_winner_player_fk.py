"""Add winner_player_id FK to play_sessions

Adds a proper foreign key to the players table for session winners,
replacing the string-based winner lookup. Backfills from existing data.

Revision ID: 0012
Revises: 0011
Create Date: 2026-06-09
"""

from alembic import op
import sqlalchemy as sa

revision = '0012'
down_revision = '0011'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('play_sessions', sa.Column('winner_player_id', sa.Integer(), nullable=True))
    op.create_index('ix_play_sessions_winner_player', 'play_sessions', ['winner_player_id'])
    op.create_foreign_key(
        'fk_play_sessions_winner_player', 'play_sessions', 'players',
        ['winner_player_id'], ['id'], ondelete='SET NULL',
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
        WHERE winner IS NOT NULL AND winner != ''
    """))


def downgrade() -> None:
    op.drop_constraint('fk_play_sessions_winner_player', 'play_sessions', type_='foreignkey')
    op.drop_index('ix_play_sessions_winner_player', table_name='play_sessions')
    op.drop_column('play_sessions', 'winner_player_id')
