"""Add elo_rating and games_played columns to players table

Revision ID: 0008
Revises: 0007
Create Date: 2026-06-02
"""

from alembic import op
import sqlalchemy as sa

revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    cols = {c['name'] for c in inspector.get_columns('players')}
    if 'elo_rating' not in cols:
        op.execute("ALTER TABLE players ADD COLUMN elo_rating FLOAT NOT NULL DEFAULT 1500.0")
    if 'games_played' not in cols:
        op.execute("ALTER TABLE players ADD COLUMN games_played INTEGER NOT NULL DEFAULT 0")


def downgrade() -> None:
    op.execute("ALTER TABLE players DROP COLUMN games_played")
    op.execute("ALTER TABLE players DROP COLUMN elo_rating")
