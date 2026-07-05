"""Add cooperative, outcome, scenario columns to play_sessions.

Supports logging cooperative/team game sessions with a group outcome
(win/loss/draw/incomplete) and an optional scenario name, instead of
forcing an individual winner.

Revision ID: 0019
Revises: 0018
Create Date: 2026-07-04
"""

from alembic import op
import sqlalchemy as sa


revision = '0019'
down_revision = '0018'
branch_labels = None
depends_on = None


def _column_exists(table: str, column: str) -> bool:
    conn = op.get_bind()
    result = conn.execute(sa.text(f"PRAGMA table_info({table})"))
    return any(row[1] == column for row in result)


def upgrade():
    if not _column_exists('play_sessions', 'cooperative'):
        op.add_column('play_sessions', sa.Column('cooperative', sa.Boolean(), nullable=False, server_default=sa.text('0')))
    if not _column_exists('play_sessions', 'outcome'):
        op.add_column('play_sessions', sa.Column('outcome', sa.String(20), nullable=True))
    if not _column_exists('play_sessions', 'scenario'):
        op.add_column('play_sessions', sa.Column('scenario', sa.String(255), nullable=True))


def downgrade():
    op.drop_column('play_sessions', 'scenario')
    op.drop_column('play_sessions', 'outcome')
    op.drop_column('play_sessions', 'cooperative')