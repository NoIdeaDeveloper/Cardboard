"""Add sale_price column to games table

Tracks the price a game was sold for when status is changed to 'sold'.

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-27
"""

from alembic import op
import sqlalchemy as sa

revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    cols = {c['name'] for c in inspector.get_columns('games')}
    if 'sale_price' not in cols:
        op.execute("ALTER TABLE games ADD COLUMN sale_price FLOAT")


def downgrade() -> None:
    op.execute("ALTER TABLE games DROP COLUMN sale_price")
