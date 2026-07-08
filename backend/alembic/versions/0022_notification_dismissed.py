"""Add dismissed_at to notifications for delete-as-dismiss tombstones.

A deleted (dismissed) notification keeps its dedup_key present so the
sweep won't recreate it. Previously hard-deleting removed the dedup_key,
so the next /refresh resurrected the same notification.

Revision ID: 0022
Revises: 0021
Create Date: 2026-07-07
"""

from alembic import op
import sqlalchemy as sa


revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("notifications") as batch_op:
        batch_op.add_column(sa.Column("dismissed_at", sa.DateTime, nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("notifications") as batch_op:
        batch_op.drop_column("dismissed_at")