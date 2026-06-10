"""Add loan tracking fields to games table

Adds loaned_to and loaned_at columns to track who a game is loaned to.

Revision ID: 0010
Revises: 0009
Create Date: 2026-06-09
"""

from alembic import op
import sqlalchemy as sa

revision = '0010'
down_revision = '0009'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('games', sa.Column('loaned_to', sa.String(length=255), nullable=True))
    op.add_column('games', sa.Column('loaned_at', sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column('games', 'loaned_at')
    op.drop_column('games', 'loaned_to')
