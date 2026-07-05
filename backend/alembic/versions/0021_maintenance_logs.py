"""Add maintenance_logs table for tracking missing pieces, sleeves, damage.

Revision ID: 0021
Revises: 0020
Create Date: 2026-07-04
"""

from alembic import op
import sqlalchemy as sa


revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "maintenance_logs",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("game_id", sa.Integer, sa.ForeignKey("games.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("status", sa.String(10), nullable=False, server_default="open"),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.current_timestamp()),
        sa.Column("resolved_at", sa.DateTime, nullable=True),
    )
    op.create_index("ix_maintenance_logs_game_id", "maintenance_logs", ["game_id"])


def downgrade() -> None:
    op.drop_index("ix_maintenance_logs_game_id", table_name="maintenance_logs")
    op.drop_table("maintenance_logs")