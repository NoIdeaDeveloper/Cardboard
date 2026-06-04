"""Create user_settings table

The UserSetting model existed without a creating migration, so a fresh
`alembic upgrade head` (the container's startup command) produced a database
without this table and every /api/settings/* call 500'd. Create it here,
guarded so deployments that already have the table (e.g. from an older
create_all path) upgrade cleanly.

Revision ID: 0009
Revises: 0008
Create Date: 2026-06-03
"""

from alembic import op
import sqlalchemy as sa

revision = '0009'
down_revision = '0008'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if 'user_settings' not in inspector.get_table_names():
        op.create_table(
            'user_settings',
            sa.Column('key', sa.String(length=255), primary_key=True),
            sa.Column('value', sa.Text(), nullable=False, server_default=''),
        )


def downgrade() -> None:
    op.drop_table('user_settings')
