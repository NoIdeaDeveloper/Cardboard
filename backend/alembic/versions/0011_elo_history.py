"""Add elo_history table for exact Elo recalculation

Stores per-player Elo snapshots after each scored session, enabling
exact replay without rating drift from concurrent player activity.

Revision ID: 0011
Revises: 0010
Create Date: 2026-06-09
"""

from alembic import op
import sqlalchemy as sa

revision = '0011'
down_revision = '0010'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'elo_history',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('session_id', sa.Integer(), sa.ForeignKey('play_sessions.id', ondelete='CASCADE'), nullable=False),
        sa.Column('player_id', sa.Integer(), sa.ForeignKey('players.id', ondelete='CASCADE'), nullable=False),
        sa.Column('elo_after', sa.Float(), nullable=False),
        sa.Column('games_played_after', sa.Integer(), nullable=False),
    )
    op.create_index('ix_elo_history_session', 'elo_history', ['session_id'])
    op.create_index('ix_elo_history_player', 'elo_history', ['player_id'])
    op.create_index('ix_elo_history_player_session', 'elo_history', ['player_id', 'session_id'])


def downgrade() -> None:
    op.drop_table('elo_history')
